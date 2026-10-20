// Claude Code transcripts → deduped usage rows.
// Parsing approach adapted from cc-spend (src/parser.js, MIT). See LICENSE.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { aliasFor, included } from "./aliases.js";

export const TOKEN_FIELDS = ["in", "cw", "cw1h", "cr", "out"];

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Usage tokens from one transcript entry, or null if the entry should be skipped. */
export function usageOf(entry) {
  if (!entry || entry.type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || !msg.usage || typeof msg.usage !== "object") return null;
  if (msg.model === "<synthetic>") return null;
  const u = msg.usage;
  const cw = num(u.cache_creation_input_tokens);
  return {
    in: num(u.input_tokens),
    cw,
    cw1h: Math.min(cw, num(u.cache_creation?.ephemeral_1h_input_tokens)),
    cr: num(u.cache_read_input_tokens),
    out: num(u.output_tokens),
  };
}

/** Merge `b` into `a` in place: max per token field, earliest timestamp. Returns true if `a` changed. */
export function mergeInto(a, b) {
  let changed = false;
  for (const f of TOKEN_FIELDS) {
    if (b[f] > a[f]) {
      a[f] = b[f];
      changed = true;
    }
  }
  if (b.t && (!a.t || b.t < a.t)) {
    a.t = b.t;
    changed = true;
  }
  return changed;
}

function toIso(ts) {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : ts;
}

/**
 * Parse transcripts into rows.
 * @param {ReturnType<import("./sources.js").listTranscripts>} files
 * @param {{home?: string, include?: string[]}} opts
 */
export function parseTranscripts(files, { home = os.homedir(), include = [] } = {}) {
  const byKey = new Map();
  let scanned = 0;
  for (const f of files) {
    const p = aliasFor(f.projectFolder, home);
    if (!included(p, include)) continue;
    let text;
    try {
      text = fs.readFileSync(f.file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const tokens = usageOf(entry);
      if (!tokens) continue;
      const t = toIso(entry.timestamp);
      if (!t) continue;
      scanned++;
      const msgId = entry.message.id;
      const k = msgId
        ? `${entry.requestId || ""}:${msgId}`
        : `nokey:${crypto.createHash("sha256").update(line).digest("hex")}`;
      const row = {
        k,
        t,
        m: typeof entry.message.model === "string" ? entry.message.model : "unknown",
        p,
        s: f.sessionId,
        a: f.account,
        sub: f.sub,
        ...tokens,
      };
      const prev = byKey.get(k);
      if (prev) mergeInto(prev, row);
      else byKey.set(k, row);
    }
  }
  return { rows: [...byKey.values()], scanned };
}
