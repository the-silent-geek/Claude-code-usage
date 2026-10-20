import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURES, tmpDir, copyDir } from "./helpers.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cc-logbook.js");
const hasGit = spawnSync("git", ["--version"]).status === 0;

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

test("init + push against a bare remote; second push is a no-op; history survives log deletion", { skip: !hasGit }, () => {
  const root = tmpDir();
  const remote = path.join(root, "remote.git");
  sh("git", ["init", "--bare", "-b", "main", remote]);
  // Seed the remote like "Use this template" would.
  const seed = path.join(root, "seed");
  sh("git", ["clone", remote, seed]);
  fs.writeFileSync(path.join(seed, "cc-logbook.config.json"), "{}\n");
  sh("git", ["add", "."], { cwd: seed });
  sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: seed });
  sh("git", ["push", "origin", "HEAD:main"], { cwd: seed });

  const claude = path.join(root, "claude");
  copyDir(path.join(FIXTURES, "claude"), claude);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "cfg"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "share"),
    CC_LOGBOOK_MACHINE: "",
  };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });

  const init = run("init", "--yes", "--repo", remote, "--machine", "Test Box", "--schedule", "none", "--dir", `default=${claude}`);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /\[test-box\] \d+ rows scanned, 6 new, 0 updated, months touched: 2026-09 2026-10/);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, "cfg", "cc-logbook", "config.json"), "utf8"));
  assert.equal(cfg.machine, "test-box");

  const log = () => sh("git", ["--git-dir", remote, "log", "--format=%s", "main"]).trim().split("\n");
  assert.match(log()[0], /^data\(test-box\): 6 new rows, \d{4}-\d{2}-\d{2}$/);

  // Nothing new → no commit.
  const again = run("push");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /0 new, 0 updated, months touched: none/);
  assert.equal(log().length, 2);

  // Logs gone → rows stay in the remote.
  fs.rmSync(path.join(claude, "projects"), { recursive: true });
  fs.mkdirSync(path.join(claude, "projects"));
  assert.equal(run("push").status, 0);
  const shard = sh("git", ["--git-dir", remote, "show", "main:data/test-box/2026-10.jsonl"]);
  assert.equal(shard.trim().split("\n").length, 5);

  // Concurrent push is skipped quietly while the lock is held.
  fs.writeFileSync(path.join(root, "state", "cc-logbook", "push.lock"), "123");
  const locked = run("push");
  assert.equal(locked.status, 0);
  assert.equal(locked.stdout, "");
});
