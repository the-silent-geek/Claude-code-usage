import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConfigDirs, listTranscripts } from "../src/sources.js";
import { parseTranscripts } from "../src/parse.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const FIXTURE_HOME = "/home/uday";

export function parseFixtures(opts = {}) {
  const dirs = findConfigDirs({ dirs: [{ label: "default", path: path.join(FIXTURES, "claude") }] });
  const files = dirs.flatMap(listTranscripts);
  return parseTranscripts(files, { home: FIXTURE_HOME, ...opts });
}

export function tmpDir(prefix = "cc-logbook-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}
