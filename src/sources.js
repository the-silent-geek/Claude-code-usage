// Find Claude Code config dirs and the transcript files inside them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `.claude` → `default`, `.claude-work` → `work`, anything else → its basename. */
export function labelFor(dirPath) {
  const base = path.basename(path.resolve(dirPath));
  if (base === ".claude") return "default";
  if (base.startsWith(".claude-")) return base.slice(".claude-".length) || "default";
  return base.replace(/^\./, "") || "default";
}

/** Parse a `--dir [label=]path` value. */
export function parseDirSpec(spec) {
  const eq = spec.indexOf("=");
  // A Windows drive letter ("C:\...") never contains "=", so this is unambiguous.
  if (eq > 0) return { label: spec.slice(0, eq), path: spec.slice(eq + 1) };
  return { label: labelFor(spec), path: spec };
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function hasProjects(dir) {
  try {
    return fs.statSync(path.join(dir, "projects")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve config dirs, deduped by realpath.
 * @returns {{label: string, path: string}[]}
 */
export function findConfigDirs({ dirs = [], env = process.env, home = os.homedir() } = {}) {
  let candidates;
  if (dirs.length) {
    candidates = dirs.map((d) => (typeof d === "string" ? parseDirSpec(d) : d));
  } else {
    candidates = [];
    if (env.CLAUDE_CONFIG_DIR) candidates.push({ label: labelFor(env.CLAUDE_CONFIG_DIR), path: env.CLAUDE_CONFIG_DIR });
    candidates.push({ label: "default", path: path.join(home, ".claude") });
    let entries = [];
    try {
      entries = fs.readdirSync(home, { withFileTypes: true });
    } catch {}
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".claude-") && (e.isDirectory() || e.isSymbolicLink())) {
        const p = path.join(home, e.name);
        if (hasProjects(p)) candidates.push({ label: labelFor(p), path: p });
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const real = realpathOrNull(c.path);
    if (!real || seen.has(real) || !hasProjects(real)) continue;
    seen.add(real);
    out.push({ label: c.label, path: real });
  }
  return out;
}

function walk(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const r = [...rel, e.name];
    if (e.isDirectory()) walk(full, r, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ full, rel: r });
  }
}

/**
 * List transcripts under `<dir>/projects/<projectFolder>/`, top-level files first.
 * @returns {{file: string, projectFolder: string, sessionId: string, sub: boolean, account: string}[]}
 */
export function listTranscripts(configDir) {
  const root = path.join(configDir.path, "projects");
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const files = [];
  for (const p of projects) {
    const found = [];
    walk(path.join(root, p.name), [], found);
    for (const f of found) {
      const sub = f.rel.length > 1;
      const sessionId = sub ? f.rel[0] : f.rel[0].replace(/\.jsonl$/, "");
      files.push({ file: f.full, projectFolder: p.name, sessionId, sub, account: configDir.label, depth: f.rel.length });
    }
  }
  // Top-level first so rows copied into subagent files stay with the original session.
  files.sort((a, b) => a.depth - b.depth || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return files.map(({ depth, ...f }) => f);
}
