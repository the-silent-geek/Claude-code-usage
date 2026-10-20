// Rows → data.json: global dedupe, aliases, pricing, day buckets. Shared by local and sync mode.
import fs from "node:fs";
import path from "node:path";
import { priceRow } from "./pricing.js";

const TOKEN_FIELDS = ["in", "cw", "cw1h", "cr", "out"];

/** Read data/<machine>/*.jsonl → [{machine, row}] */
export function readShards(dataDir) {
  const out = [];
  let machines = [];
  try {
    machines = fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const m of machines.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(dataDir, m.name);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && row.k && row.t) out.push({ machine: m.name, row });
        } catch {}
      }
    }
  }
  return out;
}

/** Global dedupe by `k`: max per token field; machine and metadata from the earliest row. */
export function dedupe(entries) {
  const byKey = new Map();
  for (const { machine, row } of entries) {
    const prev = byKey.get(row.k);
    if (!prev) {
      byKey.set(row.k, { ...row, machine });
      continue;
    }
    const merged = row.t < prev.t ? { ...row, machine } : prev;
    for (const f of TOKEN_FIELDS) merged[f] = Math.max(prev[f] || 0, row[f] || 0);
    byKey.set(row.k, merged);
  }
  return [...byKey.values()];
}

const formatters = new Map();
export function localDay(t, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Pure aggregation: [{machine, row}] + config → data.json object.
 * @param {{timezone?: string, aliases?: Record<string,string>, title?: string, mode?: "local"|"sync"}} config
 */
export function aggregate(entries, config = {}, now = new Date()) {
  const timezone = config.timezone || "UTC";
  const aliases = config.aliases || {};

  const machines = new Map();
  for (const { machine, row } of entries) {
    const m = machines.get(machine) || { name: machine, lastRowAt: null, rows: 0 };
    m.rows++;
    if (!m.lastRowAt || row.t > m.lastRowAt) m.lastRowAt = row.t;
    machines.set(machine, m);
  }

  const buckets = new Map();
  const unpriced = new Set();
  for (const row of dedupe(entries)) {
    const project = aliases[row.p] || row.p || "unknown";
    const date = localDay(row.t, timezone);
    const key = [date, row.machine, project, row.m].join("\u0000");
    let b = buckets.get(key);
    if (!b) {
      b = { date, machine: row.machine, project, model: row.m, in: 0, cw: 0, cr: 0, out: 0, cost: 0, sessions: new Set(), responses: 0 };
      buckets.set(key, b);
    }
    for (const f of ["in", "cw", "cr", "out"]) b[f] += row[f] || 0;
    const cost = priceRow({ in: 0, cw: 0, cw1h: 0, cr: 0, out: 0, ...row });
    if (cost === null) {
      b.cost = null;
      unpriced.add(row.m);
    } else if (b.cost !== null) b.cost += cost;
    if (row.s) b.sessions.add(row.s);
    b.responses++;
  }

  const days = [...buckets.values()]
    .map((b) => ({ ...b, cost: b.cost === null ? null : round(b.cost), sessions: b.sessions.size }))
    .sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : `${a.machine}\0${a.project}\0${a.model}` < `${b.machine}\0${b.project}\0${b.model}` ? -1 : 1
    );

  return {
    generatedAt: now.toISOString(),
    mode: config.mode || "sync",
    timezone,
    title: config.title || "Claude Code usage",
    pricingNote: "API-equivalent estimate, not your bill",
    machines: [...machines.values()].sort((a, b) => a.name.localeCompare(b.name)),
    days,
    unpricedModels: [...unpriced].sort(),
  };
}

export function readRepoConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "cc-logbook.config.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cc-logbook.config.json: ${e.message}`);
    return {};
  }
}

const SITE_DIR = new URL("../site/", import.meta.url);

/** `cc-logbook build`: aggregate <root>/data into <root>/site (data.json + index.html). */
export function buildSite(root, { out = path.join(root, "site") } = {}) {
  const config = readRepoConfig(root);
  const entries = readShards(path.join(root, "data"));
  const data = aggregate(entries, { ...config, mode: "sync" });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "data.json"), JSON.stringify(data));
  fs.copyFileSync(new URL("index.html", SITE_DIR), path.join(out, "index.html"));
  return { data, entries: entries.length, out };
}
