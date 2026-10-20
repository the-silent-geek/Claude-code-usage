// Thin wrappers around the git CLI.
import { spawnSync } from "node:child_process";

export function git(args, { cwd, allowFail = false, verbose = false } = {}) {
  if (verbose) console.error(`$ git ${args.join(" ")}`);
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new Error("git not found on PATH. Install git and try again.");
    throw r.error;
  }
  const res = { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  if (!res.ok && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${(res.stderr || res.stdout).trim()}`);
  }
  return res;
}

export function hasGit() {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

export function clone(url, dest, opts) {
  return git(["clone", url, dest], opts);
}

/** True if the repo has at least one commit. */
export function hasCommits(cwd) {
  return git(["rev-parse", "--verify", "HEAD"], { cwd, allowFail: true }).ok;
}

export function hasUpstream(cwd) {
  return git(["rev-parse", "--abbrev-ref", "@{u}"], { cwd, allowFail: true }).ok;
}

export function pullRebase(cwd, opts = {}) {
  if (!hasUpstream(cwd)) return { ok: true, stdout: "", stderr: "" };
  return git(["pull", "--rebase", "--autostash"], { cwd, allowFail: true, ...opts });
}

export function abortRebase(cwd) {
  git(["rebase", "--abort"], { cwd, allowFail: true });
}

export function canPush(cwd, opts = {}) {
  return git(["push", "--dry-run", "origin", "HEAD"], { cwd, allowFail: true, ...opts });
}

/** Stage `pathspec` and commit if anything changed. Returns true if a commit was made. */
export function commitPath(cwd, pathspec, message, opts = {}) {
  git(["add", "--", pathspec], { cwd, ...opts });
  const diff = git(["diff", "--cached", "--quiet", "--", pathspec], { cwd, allowFail: true });
  if (diff.ok) return false;
  // Fresh VMs often have no git identity; fall back to a neutral one rather than failing.
  const hasIdentity = git(["config", "user.email"], { cwd, allowFail: true }).stdout.trim();
  const identity = hasIdentity ? [] : ["-c", "user.name=cc-logbook", "-c", "user.email=cc-logbook@users.noreply.github.com"];
  git([...identity, "commit", "-m", message, "--", pathspec], { cwd, ...opts });
  return true;
}

export function push(cwd, opts = {}) {
  return git(["push", "origin", "HEAD"], { cwd, allowFail: true, ...opts });
}
