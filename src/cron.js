// Idempotent crontab install/remove, tagged with a `# cc-logbook` marker.
import { spawnSync } from "node:child_process";

export const MARKER = "# cc-logbook";
export const SCHEDULES = { hourly: "17 * * * *", daily: "17 21 * * *" };

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function cronLine({ schedule = "hourly", nodePath, scriptPath, logFile }) {
  const when = SCHEDULES[schedule] || schedule;
  return `${when} ${shq(nodePath)} ${shq(scriptPath)} push >> ${shq(logFile)} 2>&1 ${MARKER}`;
}

/** Remove cc-logbook lines from crontab text. */
export function stripCron(text) {
  return text
    .split("\n")
    .filter((l) => !l.trimEnd().endsWith(MARKER))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Replace any existing cc-logbook line with `line`. */
export function withCronLine(text, line) {
  const rest = stripCron(text);
  return (rest ? rest + "\n" : "") + line + "\n";
}

function readCrontab() {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (r.error) throw new Error("crontab not available on this system");
  // `crontab -l` exits non-zero when the user has no crontab yet.
  return r.status === 0 ? r.stdout : "";
}

function writeCrontab(text) {
  const r = spawnSync("crontab", ["-"], { input: text, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`failed to write crontab: ${(r.stderr || r.error?.message || "").trim()}`);
}

export function installCron(line) {
  const current = readCrontab();
  const next = withCronLine(current, line);
  if (next !== current) writeCrontab(next);
}

export function removeCron() {
  const current = readCrontab();
  if (!current.includes(MARKER)) return false;
  const next = stripCron(current);
  writeCrontab(next ? next + "\n" : "");
  return true;
}
