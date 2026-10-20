import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { aggregate, dedupe, localDay } from "../src/aggregate.js";
import { priceRow, normalizeModel } from "../src/pricing.js";
import { mergeRows } from "../src/store.js";
import { parseFixtures, tmpDir } from "./helpers.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cc-logbook.js");

const row = (o) => ({ k: "r:m", t: "2026-10-20T10:00:00.000Z", m: "claude-opus-5-5", p: "proj", s: "s1", a: "default", sub: false, in: 0, cw: 0, cw1h: 0, cr: 0, out: 0, ...o });

test("same key on two machines counts once, machine of the earliest row", () => {
  const entries = [
    { machine: "laptop", row: row({ t: "2026-10-20T10:00:05.000Z", out: 100 }) },
    { machine: "vm", row: row({ t: "2026-10-20T10:00:00.000Z", out: 40, in: 9 }) },
  ];
  const d = dedupe(entries);
  assert.equal(d.length, 1);
  assert.equal(d[0].machine, "vm");
  assert.equal(d[0].out, 100);
  assert.equal(d[0].in, 9);

  const data = aggregate(entries, { timezone: "UTC" });
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].responses, 1);
  assert.equal(data.days[0].machine, "vm");
  assert.equal(data.machines.length, 2, "both machines still listed");
});

test("a row at 2026-10-20T20:00Z lands on 2026-10-21 in Asia/Kolkata", () => {
  assert.equal(localDay("2026-10-20T20:00:00.000Z", "Asia/Kolkata"), "2026-10-21");
  assert.equal(localDay("2026-10-20T20:00:00.000Z", "UTC"), "2026-10-20");
  const data = aggregate([{ machine: "a", row: row({ t: "2026-10-20T20:00:00.000Z", out: 1 }) }], { timezone: "Asia/Kolkata" });
  assert.equal(data.days[0].date, "2026-10-21");
});

test("aliases from config apply at build time; sessions are distinct per bucket", () => {
  const entries = [
    { machine: "a", row: row({ k: "1", p: "ai-automated-protecto-ml-service-llm", s: "x", out: 1 }) },
    { machine: "a", row: row({ k: "2", p: "ai-automated-protecto-ml-service-llm", s: "x", out: 1 }) },
    { machine: "a", row: row({ k: "3", p: "ai-automated-protecto-ml-service-llm", s: "y", out: 1 }) },
  ];
  const data = aggregate(entries, { aliases: { "ai-automated-protecto-ml-service-llm": "protecto" } });
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].project, "protecto");
  assert.equal(data.days[0].sessions, 2);
  assert.equal(data.days[0].responses, 3);
});

test("pricing: 1h vs 5m cache writes", () => {
  // opus-5.5: input $4 → 5m write $5, 1h write $8 per MTok
  const fiveMin = priceRow(row({ cw: 1_000_000, cw1h: 0 }));
  const oneHour = priceRow(row({ cw: 1_000_000, cw1h: 1_000_000 }));
  const half = priceRow(row({ cw: 1_000_000, cw1h: 500_000 }));
  assert.equal(fiveMin, 5);
  assert.equal(oneHour, 8);
  assert.equal(half, 6.5);
});

test("pricing: all token types", () => {
  // opus-5.5: in 4, cr 0.2, out 20
  assert.equal(priceRow(row({ in: 1e6, cr: 1e6, out: 1e6 })), 4 + 0.2 + 20);
});

test("pricing: Haiku 5.5 long-prompt tier switch", () => {
  const m = "claude-haiku-5-5";
  const small = priceRow(row({ m, in: 100_000, out: 1_000_000 }));
  assert.ok(Math.abs(small - (0.01 + 0.5)) < 1e-9, `small=${small}`);
  const big = priceRow(row({ m, in: 100_001, out: 1_000_000 }));
  assert.ok(Math.abs(big - (100_001 * 0.5 / 1e6 + 2.5)) < 1e-9, `big=${big}`);
  // Cache tokens count toward the prompt size.
  const viaCache = priceRow(row({ m, in: 1, cr: 100_000 }));
  assert.ok(Math.abs(viaCache - (0.5 / 1e6 + 100_000 * 0.05 / 1e6)) < 1e-12);
});

test("pricing: unknown model → cost null, listed as unpriced", () => {
  assert.equal(priceRow(row({ m: "claude-mystery-9", out: 5 })), null);
  const data = aggregate([
    { machine: "a", row: row({ k: "1", m: "claude-mystery-9", out: 5 }) },
    { machine: "a", row: row({ k: "2", out: 5 }) },
  ]);
  const mystery = data.days.find((d) => d.model === "claude-mystery-9");
  assert.equal(mystery.cost, null);
  assert.ok(data.days.find((d) => d.model === "claude-opus-5-5").cost > 0);
  assert.deepEqual(data.unpricedModels, ["claude-mystery-9"]);
});

test("model id normalization", () => {
  assert.equal(normalizeModel("claude-opus-5-5[1m]"), "opus-5.5");
  assert.equal(normalizeModel("claude-opus-5-5"), "opus-5.5");
  assert.equal(normalizeModel("claude-sonnet-4-5-20250929"), "sonnet-4.5");
  assert.equal(normalizeModel("claude-opus-4-20250514"), "opus-4");
  assert.equal(normalizeModel("claude-3-5-haiku-20241022"), "haiku-3.5");
  assert.equal(normalizeModel("claude-3-7-sonnet-20250219"), "sonnet-3.7");
  assert.equal(normalizeModel("us.anthropic.claude-opus-4-1-20250805-v1:0"), "opus-4.1");
  assert.equal(normalizeModel("claude-fable-5-1"), "fable-5.1");
});

test("cc-logbook build: shards on disk → site/data.json + index.html; aliases override at build time", () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "cc-logbook.config.json"), JSON.stringify({ timezone: "Asia/Kolkata", aliases: { "ai-automated": "auto" } }));
  const { rows } = parseFixtures();
  mergeRows(root, "laptop", rows);
  mergeRows(root, "vm-copy", rows); // copied ~/.claude onto a VM must not double count

  const r = spawnSync(process.execPath, [BIN, "build", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(root, "site", "data.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(root, "site", "index.html")));
  assert.equal(data.mode, "sync");
  assert.equal(data.timezone, "Asia/Kolkata");
  assert.equal(data.days.reduce((s, d) => s + d.responses, 0), rows.length);
  assert.ok(data.days.some((d) => d.project === "auto"));
  assert.ok(!data.days.some((d) => d.project === "ai-automated"));
  assert.deepEqual(data.unpricedModels, ["claude-mystery-9"]);
  assert.deepEqual(data.machines.map((m) => m.name), ["laptop", "vm-copy"]);
});

test("cc-logbook build outside a data repo fails clearly", () => {
  const r = spawnSync(process.execPath, [BIN, "build", "--root", tmpDir()], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't look like a cc-logbook data repo/);
});
