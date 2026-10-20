import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findConfigDirs, listTranscripts } from "../src/sources.js";
import { parseTranscripts } from "../src/parse.js";
import { mergeRows, shardPath, readShard } from "../src/store.js";
import { FIXTURES, FIXTURE_HOME, tmpDir, copyDir } from "./helpers.js";

function parseFrom(claudeDir) {
  const dirs = findConfigDirs({ dirs: [{ label: "default", path: claudeDir }] });
  return parseTranscripts(dirs.flatMap(listTranscripts), { home: FIXTURE_HOME }).rows;
}

function snapshot(repo) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(repo, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(repo);
  return out;
}

test("rows are written to monthly shards sorted by t then k", () => {
  const repo = tmpDir();
  const res = mergeRows(repo, "box", parseFrom(path.join(FIXTURES, "claude")));
  assert.deepEqual(res.months, ["2026-09", "2026-10"]);
  assert.equal(res.added, 6);
  const lines = fs.readFileSync(shardPath(repo, "box", "2026-10"), "utf8").trim().split("\n").map(JSON.parse);
  const ts = lines.map((r) => r.t);
  assert.deepEqual(ts, [...ts].sort());
});

test("pushing after source logs are deleted keeps old rows; re-running is byte-identical", () => {
  const repo = tmpDir();
  const src = path.join(tmpDir(), "claude");
  copyDir(path.join(FIXTURES, "claude"), src);

  mergeRows(repo, "box", parseFrom(src));
  const first = snapshot(repo);

  // Same logs again → no change at all.
  const again = mergeRows(repo, "box", parseFrom(src));
  assert.deepEqual(again.months, []);
  assert.equal(again.added + again.updated, 0);
  assert.deepEqual(snapshot(repo), first);

  // Logs vanish (VM deleted / rotated) → nothing is lost.
  fs.rmSync(path.join(src, "projects"), { recursive: true });
  fs.mkdirSync(path.join(src, "projects"));
  const after = mergeRows(repo, "box", parseFrom(src));
  assert.deepEqual(after.months, []);
  assert.deepEqual(snapshot(repo), first);
});

test("a later copy of a key with higher out updates the row", () => {
  const repo = tmpDir();
  const base = { k: "r:m", t: "2026-10-20T10:00:00.000Z", m: "claude-opus-5-5", p: "x", s: "s1", a: "default", sub: false, in: 1, cw: 0, cw1h: 0, cr: 0, out: 10 };
  mergeRows(repo, "box", [base]);
  const res = mergeRows(repo, "box", [{ ...base, t: "2026-10-20T10:00:02.000Z", s: "s2", out: 500 }]);
  assert.equal(res.updated, 1);
  assert.deepEqual(res.months, ["2026-10"]);
  const row = readShard(shardPath(repo, "box", "2026-10")).get("r:m");
  assert.equal(row.out, 500);
  assert.equal(row.t, base.t, "keeps earliest t");
  assert.equal(row.s, "s1", "keeps original session");

  // Lower counts never shrink a row.
  const res2 = mergeRows(repo, "box", [{ ...base, out: 3 }]);
  assert.equal(res2.updated, 0);
  assert.deepEqual(res2.months, []);
});

test("months without new rows are not touched", () => {
  const repo = tmpDir();
  const row = (k, t) => ({ k, t, m: "m", p: "p", s: "s", a: "default", sub: false, in: 1, cw: 0, cw1h: 0, cr: 0, out: 1 });
  mergeRows(repo, "box", [row("a", "2026-09-01T00:00:00Z"), row("b", "2026-10-01T00:00:00Z")]);
  const septFile = shardPath(repo, "box", "2026-09");
  const mtime = fs.statSync(septFile).mtimeMs;
  const res = mergeRows(repo, "box", [row("c", "2026-10-02T00:00:00Z")]);
  assert.deepEqual(res.months, ["2026-10"]);
  assert.equal(fs.statSync(septFile).mtimeMs, mtime);
});

test("dry run writes nothing", () => {
  const repo = tmpDir();
  const res = mergeRows(repo, "box", parseFrom(path.join(FIXTURES, "claude")), { dryRun: true });
  assert.equal(res.added, 6);
  assert.equal(fs.existsSync(path.join(repo, "data")), false);
});
