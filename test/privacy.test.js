import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { aggregate, readShards } from "../src/aggregate.js";
import { mergeRows } from "../src/store.js";
import { parseFixtures, tmpDir } from "./helpers.js";

test("no exported row or built data contains a path, home dir, username or prompt text", () => {
  const repo = tmpDir();
  const { rows } = parseFixtures();
  mergeRows(repo, "box", rows);
  const shards = fs
    .readdirSync(path.join(repo, "data", "box"))
    .map((f) => fs.readFileSync(path.join(repo, "data", "box", f), "utf8"))
    .join("");
  const built = JSON.stringify(aggregate(readShards(path.join(repo, "data"))));

  for (const [name, text] of [["shards", shards], ["data.json", built]]) {
    assert.ok(!text.includes("/"), `${name} contains "/"`);
    assert.ok(!text.includes("\\"), `${name} contains "\\"`);
    assert.ok(!/SECRET|PROMPT|notes\.md|uday|home-uday|cwd|gitBranch|file_path/i.test(text), `${name} leaks content`);
  }

  const allowed = new Set(["k", "t", "m", "p", "s", "a", "sub", "in", "cw", "cw1h", "cr", "out"]);
  for (const line of shards.trim().split("\n")) {
    for (const key of Object.keys(JSON.parse(line))) assert.ok(allowed.has(key), `unexpected key ${key}`);
  }
});
