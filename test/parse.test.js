import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseFixtures, FIXTURES } from "./helpers.js";
import { aliasFor, included } from "../src/aliases.js";
import { findConfigDirs, listTranscripts, labelFor, parseDirSpec } from "../src/sources.js";

const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.k, r]));

test("one response split across multiple rows → one row with max tokens", () => {
  const rows = byKey(parseFixtures().rows);
  const r = rows["req_1:msg_1"];
  assert.ok(r);
  assert.equal(r.out, 912);
  assert.equal(r.in, 12);
  assert.equal(r.cw, 4810);
  assert.equal(r.cr, 120034);
  assert.equal(r.t, "2026-10-20T09:14:03.120Z", "keeps earliest timestamp");
});

test("resumed copy and subagent copy of the same key count once, attributed to top-level session", () => {
  const { rows } = parseFixtures();
  assert.equal(rows.filter((r) => r.k === "req_1:msg_1").length, 1);
  const r2 = byKey(rows)["req_2:msg_2"];
  assert.equal(r2.s, "22222222-bbbb");
  assert.equal(r2.sub, false);
  const r3 = byKey(rows)["req_3:msg_3"];
  assert.equal(r3.s, "11111111-aaaa", "subagent session id is the first path segment");
  assert.equal(r3.sub, true);
});

test("cw1h is capped at cw", () => {
  const r2 = byKey(parseFixtures().rows)["req_2:msg_2"];
  assert.equal(r2.cw, 2000);
  assert.equal(r2.cw1h, 2000);
});

test("<synthetic> model and malformed lines are skipped; rows without message.id are kept", () => {
  const { rows } = parseFixtures();
  assert.ok(!rows.some((r) => r.m === "<synthetic>"));
  const nokey = rows.filter((r) => r.k.startsWith("nokey:"));
  assert.equal(nokey.length, 1);
  assert.match(nokey[0].k, /^nokey:[0-9a-f]{64}$/);
  // req_1, nokey, req_2, req_3, req_4, req_5
  assert.equal(rows.length, 6);
});

test("aliases: home folder, nested project, foreign path → hashed", () => {
  const home = "/home/uday";
  assert.equal(aliasFor("-home-uday", home), "home");
  assert.equal(aliasFor("-home-uday-ai-automated", home), "ai-automated");
  assert.equal(aliasFor("-home-uday-gemma-4", home), "gemma-4");
  assert.match(aliasFor("-opt-foreign-thing", home), /^other-[0-9a-f]{8}$/);
  assert.equal(aliasFor("-opt-foreign-thing", home), aliasFor("-opt-foreign-thing", home));
  // A sibling user whose name shares the prefix is not "inside" home.
  assert.match(aliasFor("-home-udaybhaskar", home), /^other-/);
  // Windows homes
  assert.equal(aliasFor("C--Users-CSC-proj", "C:\\Users\\CSC"), "proj");
  assert.equal(aliasFor("c--Users-CSC", "C:\\Users\\CSC"), "home");
});

test("fixture rows get the expected aliases", () => {
  const rows = byKey(parseFixtures().rows);
  assert.equal(rows["req_1:msg_1"].p, "ai-automated");
  assert.equal(rows["req_4:msg_4"].p, "home");
  assert.match(rows["req_5:msg_5"].p, /^other-[0-9a-f]{8}$/);
});

test("--include filters by alias prefix", () => {
  assert.equal(included("ai-automated", []), true);
  assert.equal(included("ai-automated", ["ai-"]), true);
  assert.equal(included("home", ["ai-"]), false);
  const { rows } = parseFixtures({ include: ["ai-"] });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.p.startsWith("ai-")));
});

test("config dir labels and --dir parsing", () => {
  assert.equal(labelFor("/home/u/.claude"), "default");
  assert.equal(labelFor("/home/u/.claude-work"), "work");
  assert.deepEqual(parseDirSpec("work=/x/.claude-w"), { label: "work", path: "/x/.claude-w" });
  assert.deepEqual(parseDirSpec("/x/.claude-work"), { label: "work", path: "/x/.claude-work" });
});

test("config dirs are deduped by realpath", () => {
  const p = path.join(FIXTURES, "claude");
  const dirs = findConfigDirs({ dirs: [p, `a=${p}`, path.join(p, ".", "")] });
  assert.equal(dirs.length, 1);
});

test("top-level transcripts are listed before nested ones", () => {
  const [dir] = findConfigDirs({ dirs: [path.join(FIXTURES, "claude")] });
  const files = listTranscripts(dir);
  const firstSub = files.findIndex((f) => f.sub);
  assert.ok(firstSub > 0);
  assert.ok(files.slice(firstSub).every((f) => f.sub));
});
