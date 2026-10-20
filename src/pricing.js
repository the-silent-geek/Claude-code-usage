// API-equivalent pricing, USD per million tokens.
// Table structure and model-id normalization adapted from cc-spend (MIT). See LICENSE.
// Rates as published on https://www.anthropic.com/pricing — check there and update when models change.
// This is an estimate of what the same usage would cost on the API, not a Pro/Max/Team bill.

/**
 * Standard rate card: 5m cache writes = 1.25× input, 1h cache writes = 2× input.
 * Cache reads are given explicitly because the multiplier differs by model.
 */
const card = (input, cacheRead, output) => ({
  input,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  output,
});

export const PRICING = {
  "fable-5.1": card(10, 0.25, 50),
  "mythos-5.1": card(10, 0.25, 50),
  "fable-5": card(10, 1, 50),
  "mythos-5": card(10, 1, 50),
  "opus-5.5": card(4, 0.2, 20),
  "opus-5": card(5, 0.5, 25),
  "opus-4.8": card(5, 0.5, 25),
  "opus-4.7": card(5, 0.5, 25),
  "opus-4.6": card(5, 0.5, 25),
  "opus-4.5": card(5, 0.5, 25),
  "opus-4.1": card(15, 1.5, 75),
  "opus-4": card(15, 1.5, 75),
  "sonnet-5.5": card(2, 0.2, 10),
  "sonnet-5": card(2, 0.2, 10),
  "sonnet-4.6": card(3, 0.3, 15),
  "sonnet-4.5": card(3, 0.3, 15),
  "sonnet-4": card(3, 0.3, 15),
  "sonnet-3.7": card(3, 0.3, 15),
  "haiku-5.5": {
    ...card(0.1, 0.01, 0.5),
    // Prompts over 100K tokens (input + cache write + cache read) bill at the long-prompt rate.
    longPrompt: { threshold: 100_000, ...card(0.5, 0.05, 2.5) },
  },
  "haiku-4.5": card(1, 0.1, 5),
  "haiku-3.5": card(0.8, 0.08, 4),
  "haiku-3": card(0.25, 0.03, 1.25),
};

/**
 * Normalize a logged model id to a pricing key.
 * `claude-opus-5-5[1m]` → `opus-5.5`, `claude-sonnet-4-5-20250929` → `sonnet-4.5`,
 * `claude-3-5-haiku-20241022` → `haiku-3.5`, `us.anthropic.claude-opus-4-1-20250805-v1:0` → `opus-4.1`.
 */
export function normalizeModel(id) {
  if (typeof id !== "string") return null;
  let s = id.toLowerCase().trim();
  s = s.replace(/\[.*?\]$/, ""); // [1m] context suffix
  s = s.replace(/^.*?anthropic\./, ""); // bedrock region/provider prefix
  s = s.replace(/^.*\//, ""); // vertex/openrouter style "provider/model"
  s = s.replace(/-v\d+(:\d+)?$/, ""); // bedrock version suffix
  s = s.replace(/@.*$/, ""); // vertex @date
  s = s.replace(/^claude-/, "");
  s = s.replace(/-\d{8}$/, ""); // date snapshot
  let m = /^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(s);
  if (m) return m[3] ? `${m[1]}-${m[2]}.${m[3]}` : `${m[1]}-${m[2]}`;
  m = /^(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/.exec(s);
  if (m) return m[2] ? `${m[3]}-${m[1]}.${m[2]}` : `${m[3]}-${m[1]}`;
  return s || null;
}

export function ratesFor(model) {
  const key = normalizeModel(model);
  return (key && PRICING[key]) || null;
}

/**
 * Cost in USD for one row (`in cw cw1h cr out`), or null for unknown models. Never guessed.
 */
export function priceRow(row) {
  let rates = ratesFor(row.m);
  if (!rates) return null;
  const prompt = row.in + row.cw + row.cr;
  if (rates.longPrompt && prompt > rates.longPrompt.threshold) rates = rates.longPrompt;
  const cw1h = Math.min(row.cw1h || 0, row.cw);
  const cw5m = row.cw - cw1h;
  return (
    (row.in * rates.input +
      cw5m * rates.cacheWrite5m +
      cw1h * rates.cacheWrite1h +
      row.cr * rates.cacheRead +
      row.out * rates.output) /
    1e6
  );
}
