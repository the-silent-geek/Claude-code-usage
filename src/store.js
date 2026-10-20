// Append-only monthly shards: data/<machine>/<YYYY-MM>.jsonl
import fs from "node:fs";
import path from "node:path";
import { mergeInto } from "./parse.js";

const KEY_ORDER = ["k", "t", "m", "p", "s", "a", "sub", "in", "cw", "cw1h", "cr", "out"];

/** Canonical one-line JSON with a fixed key order, so identical rows serialize identically. */
export function serializeRow(row) {
  const o = {};
  for (const key of KEY_ORDER) if (row[key] !== undefined) o[key] = row[key];
  return JSON.stringify(o);
}

export function monthOf(t) {
  return new Date(t).toISOString().slice(0, 7);
}

export function shardPath(repoPath, machine, month) {
  return path.join(repoPath, "data", machine, `${month}.jsonl`);
}

export function readShard(file) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.k) map.set(row.k, row);
    } catch {}
  }
  return map;
}

export function serializeShard(map) {
  const rows = [...map.values()].sort((a, b) =>
    a.t < b.t ? -1 : a.t > b.t ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : 0
  );
  return rows.map(serializeRow).join("\n") + (rows.length ? "\n" : "");
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Merge parsed rows into the machine's shards. Never removes rows.
 * @returns {{added: number, updated: number, months: string[]}} months = shards whose bytes changed
 */
export function mergeRows(repoPath, machine, rows, { dryRun = false } = {}) {
  const byMonth = new Map();
  for (const r of rows) {
    const m = monthOf(r.t);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  let added = 0;
  let updated = 0;
  const months = [];
  for (const [month, monthRows] of [...byMonth].sort()) {
    const file = shardPath(repoPath, machine, month);
    let before = null;
    try {
      before = fs.readFileSync(file, "utf8");
    } catch {}
    const map = readShard(file);
    for (const r of monthRows) {
      const prev = map.get(r.k);
      if (!prev) {
        map.set(r.k, { ...r });
        added++;
      } else if (mergeInto(prev, r)) {
        updated++;
      }
    }
    const after = serializeShard(map);
    if (after !== before) {
      months.push(month);
      if (!dryRun) writeAtomic(file, after);
    }
  }
  return { added, updated, months };
}
