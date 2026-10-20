// ~/.config/cc-logbook/config.json and the state/data directories.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function paths(env = process.env, home = os.homedir()) {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return {
    configFile: path.join(configHome, "cc-logbook", "config.json"),
    stateDir: path.join(stateHome, "cc-logbook"),
    defaultRepoPath: path.join(dataHome, "cc-logbook", "data"),
  };
}

export function loadConfig(file = paths().configFile) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(config, file = paths().configFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

export function removeConfig(file = paths().configFile) {
  try {
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeMachine(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** `--machine` › `$CC_LOGBOOK_MACHINE` › config › hostname. */
export function machineLabel({ flag, config = {}, env = process.env } = {}) {
  return sanitizeMachine(flag || env.CC_LOGBOOK_MACHINE || config.machine || os.hostname());
}
