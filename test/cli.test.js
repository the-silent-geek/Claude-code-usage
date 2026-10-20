import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../bin/cc-logbook.js";
import { cronLine, withCronLine, stripCron } from "../src/cron.js";
import { sanitizeMachine, machineLabel } from "../src/config.js";
import { FIXTURES } from "./helpers.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cc-logbook.js");

test("parseArgs handles repeatable and = flags", () => {
  const { command, flags } = parseArgs(["push", "--dir", "a", "--dir=work=/b", "--include", "x", "--dry-run", "--machine=Box"]);
  assert.equal(command, "push");
  assert.deepEqual(flags.dir, ["a", "work=/b"]);
  assert.deepEqual(flags.include, ["x"]);
  assert.equal(flags["dry-run"], true);
  assert.equal(flags.machine, "Box");
  assert.throws(() => parseArgs(["push", "--bogus"]));
  assert.throws(() => parseArgs(["push", "--machine"]));
});

test("machine label sanitizing and precedence", () => {
  assert.equal(sanitizeMachine("ML_Test.GPU a100"), "ml-test-gpu-a100");
  assert.equal(machineLabel({ flag: "X", env: { CC_LOGBOOK_MACHINE: "y" }, config: { machine: "z" } }), "x");
  assert.equal(machineLabel({ env: { CC_LOGBOOK_MACHINE: "Y" }, config: { machine: "z" } }), "y");
  assert.equal(machineLabel({ env: {}, config: { machine: "Z" } }), "z");
});

test("cron install is idempotent and removal keeps other lines", () => {
  const line = cronLine({ nodePath: "/usr/bin/node", scriptPath: "/opt/cc meter/cc-logbook.js", logFile: "/h/.local/state/cc-logbook/push.log" });
  assert.match(line, /^17 \* \* \* \* \/usr\/bin\/node '\/opt\/cc meter\/cc-logbook.js' push >> .* 2>&1 # cc-logbook$/);
  assert.match(cronLine({ schedule: "daily", nodePath: "n", scriptPath: "s", logFile: "l" }), /^17 21 \* \* \* /);
  const existing = "MAILTO=me\n0 1 * * * backup\n";
  const once = withCronLine(existing, line);
  const twice = withCronLine(once, line);
  assert.equal(once, twice);
  assert.equal(once.split("\n").filter((l) => l.includes("# cc-logbook")).length, 1);
  assert.equal(stripCron(once), "MAILTO=me\n0 1 * * * backup");
});

test("preview prints totals and writes nothing; bad usage exits 2", () => {
  const r = spawnSync(process.execPath, [BIN, "preview", "--dir", `default=${path.join(FIXTURES, "claude")}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 responses/);
  assert.match(r.stdout, /Last 30 days/);
  const bad = spawnSync(process.execPath, [BIN, "frobnicate"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});
