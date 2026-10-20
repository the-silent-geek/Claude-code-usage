// Fake shards for the public demo: 3 machines × 5 projects × 60 days.
//   node demo/generate.mjs [outDir]   (default: demo/out → writes <outDir>/data/<machine>/<YYYY-MM>.jsonl)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || path.join(here, "out"));
const DAYS = 60;

// Deterministic PRNG so the demo looks the same on every build.
let seed = 0x5eed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (arr, weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < arr.length; i++) if ((x -= weights[i]) < 0) return arr[i];
  return arr[arr.length - 1];
};
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const MACHINES = [
  { name: "laptop", activity: 1.0, weekend: 0.35, stopsAt: null, projects: ["web-app", "api-gateway", "dotfiles", "data-pipeline"] },
  { name: "workstation", activity: 1.4, weekend: 0.1, stopsAt: null, projects: ["data-pipeline", "ml-eval", "api-gateway"] },
  // A short-lived GPU VM that stops reporting halfway through.
  { name: "gpu-vm-a100", activity: 1.2, weekend: 0.8, stopsAt: Math.floor(DAYS / 2), projects: ["ml-eval", "data-pipeline"] },
];
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5[1m]"];
const MODEL_W = [0.55, 0.3, 0.12, 0.03];

const rowsByShard = new Map();
const now = new Date();
const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (DAYS - 1) * 86400e3;

for (const m of MACHINES) {
  for (let day = 0; day < DAYS; day++) {
    if (m.stopsAt !== null && day >= m.stopsAt) break;
    const dayStart = startUtc + day * 86400e3;
    const dow = new Date(dayStart).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (weekend && rand() > m.weekend) continue;
    if (rand() < 0.06) continue; // occasional day off
    const sessions = Math.max(1, Math.round((1 + rand() * 4) * m.activity * (weekend ? 0.5 : 1)));
    for (let s = 0; s < sessions; s++) {
      const sid = uuid();
      const project = m.projects[Math.floor(rand() * m.projects.length)];
      const model = pick(MODELS, MODEL_W);
      const sub = rand() < 0.2;
      const responses = 5 + Math.floor(rand() * 60);
      let t = dayStart + (3 + rand() * 14) * 3600e3; // 03:00–17:00 UTC
      let context = 8000 + Math.floor(rand() * 12000);
      for (let r = 0; r < responses; r++) {
        t += (5 + rand() * 90) * 1000;
        const cw = r === 0 ? context : Math.floor(rand() * 4000);
        const cw1h = rand() < 0.15 ? Math.floor(cw * rand()) : 0;
        const row = {
          k: `req_${hex(16)}:msg_${hex(16)}`,
          t: new Date(t).toISOString(),
          m: model,
          p: project,
          s: sid,
          a: m.name === "workstation" && rand() < 0.3 ? "work" : "default",
          sub,
          in: Math.floor(rand() * 40),
          cw,
          cw1h,
          cr: r === 0 ? 0 : context,
          out: Math.floor(50 + rand() * rand() * 3000),
        };
        context += cw + row.out;
        if (context > 180000) context = 20000; // compaction
        const key = `${m.name}/${row.t.slice(0, 7)}`;
        if (!rowsByShard.has(key)) rowsByShard.set(key, []);
        rowsByShard.get(key).push(row);
      }
    }
  }
}

let total = 0;
for (const [key, rows] of rowsByShard) {
  const file = path.join(outDir, "data", `${key}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.k < b.k ? -1 : 1));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  total += rows.length;
}
console.log(`wrote ${total} rows in ${rowsByShard.size} shards to ${outDir}/data`);
