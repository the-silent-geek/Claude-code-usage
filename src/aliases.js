// Project folder name → display alias. Never returns a real path.
import crypto from "node:crypto";
import os from "node:os";

export function encodePath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

export function shortHash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/**
 * `-home-uday` → `home`, `-home-uday-ai-automated` → `ai-automated`,
 * anything outside home → `other-<hash>`.
 */
export function aliasFor(folder, home = os.homedir()) {
  const enc = encodePath(home);
  // Case-insensitive so Windows drive letters ("C--Users" vs "c--Users") still match.
  const f = folder.toLowerCase();
  const e = enc.toLowerCase();
  if (f === e) return "home";
  if (f.startsWith(e + "-") && folder.length > enc.length + 1) return folder.slice(enc.length + 1);
  return `other-${shortHash(folder)}`;
}

/** True if the alias passes the `--include` prefixes (or there are none). */
export function included(alias, include = []) {
  return !include.length || include.some((p) => alias.startsWith(p));
}
