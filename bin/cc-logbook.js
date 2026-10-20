#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findConfigDirs, listTranscripts } from "../src/sources.js";
import { parseTranscripts } from "../src/parse.js";
import { mergeRows } from "../src/store.js";
import { aggregate, buildSite, systemTimezone } from "../src/aggregate.js";
import { priceRow } from "../src/pricing.js";
import { startServer, canOpenBrowser, openBrowser } from "../src/serve.js";
import * as G from "../src/git.js";
import * as A from "../src/auth.js";
import { cronLine, installCron, removeCron, SCHEDULES } from "../src/cron.js";
import { paths, loadConfig, saveConfig, removeConfig, machineLabel, sanitizeMachine } from "../src/config.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SELF = fileURLToPath(import.meta.url);

const HELP = `cc-logbook ${VERSION} — Claude Code token usage dashboard

Usage:
  cc-logbook              local dashboard on http://localhost:4545 (reads ~/.claude, writes nothing)
  cc-logbook preview      print totals in the terminal
  cc-logbook init         set up sync mode on this machine (private GitHub repo + hourly push)
  cc-logbook push         export + commit + push (what cron runs)
  cc-logbook build        aggregate data/**/*.jsonl → site/ (run inside a data repo)
  cc-logbook uninstall    remove cron entry and config (keeps the data repo)

Common flags:
  --dir [label=]path      Claude config dir to read (repeatable)
  --machine <name>        machine label (default: $CC_LOGBOOK_MACHINE, config, hostname)
  --include <prefix>      only read projects whose alias starts with prefix (repeatable)
  --days <n>              only read the last n days
  --verbose               print git commands and file details

Local mode:  --port <n> (default 4545)   --no-open
push:        --dry-run
build:       --root <data repo dir> (default: current dir)
init:        --repo <url> (use existing repo)   --create   --name <repo> (default cc-logbook-data)
             --timezone <IANA>   --schedule hourly|daily|none|"<cron>"   --repo-path <dir>   --yes
`;

class UsageError extends Error {}

const REPEATABLE = new Set(["dir", "include"]);
const VALUED = new Set(["dir", "include", "machine", "days", "port", "repo", "repo-path", "schedule", "name", "timezone", "root"]);
const BOOLEAN = new Set(["dry-run", "verbose", "yes", "help", "version", "no-open", "create"]);
const COMMANDS = new Set(["preview", "init", "push", "build", "uninstall"]);

export function parseArgs(argv) {
  const flags = { dir: [], include: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "-v") {
      flags.version = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    let [name, value] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUED.has(name)) throw new UsageError(`unknown flag --${name}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    }
    if (REPEATABLE.has(name)) flags[name].push(value);
    else flags[name] = value;
  }
  for (const n of ["days", "port"]) {
    if (flags[n] !== undefined && !(Number.isInteger(Number(flags[n])) && Number(flags[n]) > 0)) {
      throw new UsageError(`--${n} must be a positive integer`);
    }
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const fmtCost = (c, known = true) => `$${c.toFixed(2)}${known ? "" : "+"}`;

/** Parse local logs per flags + config. */
function collect(flags, cfg) {
  const dirs = flags.dir.length ? flags.dir : cfg.dirs || [];
  const include = flags.include.length ? flags.include : cfg.include || [];
  const configDirs = findConfigDirs({ dirs });
  const files = configDirs.flatMap(listTranscripts);
  if (flags.verbose) {
    for (const d of configDirs) console.error(`config dir [${d.label}] ${d.path}`);
    console.error(`${files.length} transcript files`);
  }
  let { rows, scanned } = parseTranscripts(files, { include });
  if (flags.days) {
    const since = new Date(Date.now() - Number(flags.days) * 86400e3).toISOString();
    rows = rows.filter((r) => new Date(r.t).toISOString() >= since);
  }
  return { configDirs, rows, scanned };
}

// ---------- local mode ----------

async function local(flags) {
  const cfg = loadConfig();
  const machine = machineLabel({ flag: flags.machine, config: cfg });
  const timezone = systemTimezone();
  let last = null;
  const load = () => {
    const { configDirs, rows } = collect(flags, cfg);
    last = { configDirs, rows };
    return aggregate(
      rows.map((row) => ({ machine, row })),
      { timezone, aliases: cfg.aliases, mode: "local", title: "Claude Code usage" }
    );
  };
  const { url } = await startServer({ load, port: Number(flags.port || 4545) });
  if (!last.configDirs.length) console.log("No Claude Code sessions found in ~/.claude/projects (use --dir to point elsewhere).");
  else console.log(`${last.rows.length} responses from ${last.configDirs.map((d) => d.label).join(", ")}.`);
  console.log(`Dashboard: ${url}   (Ctrl+C to stop)`);
  if (!flags["no-open"] && canOpenBrowser()) openBrowser(url);
  else if (!flags["no-open"]) {
    const port = new URL(url).port;
    console.log(
      `On a remote machine? In VS Code Remote-SSH this port is forwarded automatically; otherwise use \`ssh -L ${port}:localhost:${port} <host>\`.`
    );
  }
  return new Promise(() => {}); // run until interrupted
}

// ---------- preview ----------

function localDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function preview(flags) {
  const cfg = loadConfig();
  const { configDirs, rows, scanned } = collect(flags, cfg);
  if (!configDirs.length) {
    console.log("No Claude Code sessions found in ~/.claude/projects (use --dir to point elsewhere).");
    return 0;
  }
  const today = new Date();
  const dayStart = (back) => localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
  const windows = [
    ["Today", dayStart(0)],
    ["Last 7 days", dayStart(6)],
    ["Last 30 days", dayStart(29)],
  ];
  const sum = (rs) => {
    const t = { in: 0, cw: 0, cr: 0, out: 0, tokens: 0, cost: 0, known: true };
    for (const r of rs) {
      for (const f of ["in", "cw", "cr", "out"]) t[f] += r[f];
      const c = priceRow(r);
      if (c === null) t.known = false;
      else t.cost += c;
    }
    t.tokens = t.in + t.cw + t.cr + t.out;
    return t;
  };
  const line = (name, t) =>
    `  ${name.padEnd(28).slice(0, 28)} ${fmt(t.in).padStart(8)} ${fmt(t.cw).padStart(9)} ${fmt(t.cr).padStart(9)} ${fmt(t.out).padStart(9)} ${fmtCost(t.cost, t.known).padStart(10)}`;
  console.log(`${rows.length} responses (${scanned} usage rows scanned) from ${configDirs.map((d) => d.label).join(", ")}`);
  console.log("Cost is an API-equivalent estimate, not your bill.\n");
  for (const [title, from] of windows) {
    const inWin = rows.filter((r) => localDate(r.t) >= from);
    const total = sum(inWin);
    console.log(`${title}: ${fmt(total.tokens)} tokens, ${fmtCost(total.cost, total.known)}, ${inWin.length} responses`);
    if (!inWin.length) {
      console.log("");
      continue;
    }
    const byModel = new Map();
    for (const r of inWin) byModel.set(r.m, [...(byModel.get(r.m) || []), r]);
    console.log("  model                           input   c.write    c.read    output       cost");
    for (const [m, rs] of [...byModel].map(([m, rs]) => [m, sum(rs)]).sort((a, b) => b[1].tokens - a[1].tokens)) console.log(line(m, rs));
    if (byModel.size > 1) console.log(line("total", total));
    const byProject = new Map();
    for (const r of inWin) byProject.set(r.p, [...(byProject.get(r.p) || []), r]);
    console.log("  top projects:");
    for (const [p, t] of [...byProject].map(([p, rs]) => [p, sum(rs)]).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 5)) {
      console.log(`    ${p.padEnd(40).slice(0, 40)} ${fmt(t.tokens).padStart(9)} ${fmtCost(t.cost, t.known).padStart(10)}`);
    }
    console.log("");
  }
  return 0;
}

// ---------- build ----------

function build(flags) {
  const root = path.resolve(flags.root || process.cwd());
  if (!fs.existsSync(path.join(root, "data")) && !fs.existsSync(path.join(root, "cc-logbook.config.json"))) {
    console.error(`${root} doesn't look like a cc-logbook data repo (no data/ or cc-logbook.config.json).`);
    return 1;
  }
  const { data, entries, out } = buildSite(root);
  console.log(
    `built ${path.relative(process.cwd(), out) || "."}: ${entries} rows from ${data.machines.length} machines → ${data.days.length} day buckets` +
      (data.unpricedModels.length ? `; unpriced models: ${data.unpricedModels.join(", ")}` : "")
  );
  return 0;
}

// ---------- push ----------

const LOCK_STALE_MS = 30 * 60 * 1000;

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(file);
        } catch {}
      };
      process.on("exit", release);
      return release;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(file);
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

function repoPathOf(flags, cfg) {
  return path.resolve(flags["repo-path"] || cfg.repoPath || paths().defaultRepoPath);
}

function push(flags) {
  const cfg = loadConfig();
  const machine = machineLabel({ flag: flags.machine, config: cfg });
  const repoPath = repoPathOf(flags, cfg);
  const opts = { verbose: flags.verbose };
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    console.error(`No data repo at ${repoPath}. Run \`cc-logbook init\` first.`);
    return 1;
  }
  const release = acquireLock(path.join(paths().stateDir, "push.lock"));
  if (!release) {
    if (flags.verbose) console.error("another push is running; exiting");
    return 0;
  }
  try {
    if (!flags["dry-run"]) {
      const pulled = G.pullRebase(repoPath, opts);
      if (!pulled.ok) {
        G.abortRebase(repoPath);
        console.error(`git pull --rebase failed in ${repoPath}:\n${pulled.stderr.trim()}`);
        return 1;
      }
    }
    const { rows, scanned } = collect(flags, cfg);
    const res = mergeRows(repoPath, machine, rows, { dryRun: flags["dry-run"] });
    const summary = `[${machine}] ${scanned} rows scanned, ${res.added} new, ${res.updated} updated, months touched: ${
      res.months.join(" ") || "none"
    }`;
    if (flags["dry-run"] || !res.months.length) {
      console.log(summary + (flags["dry-run"] ? " (dry run)" : ""));
      return 0;
    }
    const pathspec = `data/${machine}`;
    const date = new Date().toISOString().slice(0, 10);
    if (!G.commitPath(repoPath, pathspec, `data(${machine}): ${res.added} new rows, ${date}`, opts)) {
      console.log(summary);
      return 0;
    }
    let pushed = G.push(repoPath, opts);
    if (!pushed.ok) {
      const retry = G.pullRebase(repoPath, opts);
      if (!retry.ok) {
        G.abortRebase(repoPath);
        console.error(
          `Push rejected and rebase hit a conflict. Each machine should only write data/${machine}; ` +
            `check that no other machine uses the label "${machine}".\n${retry.stderr.trim()}`
        );
        return 1;
      }
      pushed = G.push(repoPath, opts);
      if (!pushed.ok) {
        console.error(`git push failed:\n${pushed.stderr.trim()}`);
        return 1;
      }
    }
    console.log(summary);
    return 0;
  } finally {
    release();
  }
}

// ---------- init ----------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function schedulerHelp(nodePath, scriptPath, schedule) {
  if (process.platform === "darwin") {
    const interval =
      schedule === "daily"
        ? "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>17</integer></dict>"
        : "<key>StartInterval</key><integer>3600</integer>";
    return `
macOS alternative to cron: save as ~/Library/LaunchAgents/dev.cc-logbook.push.plist

  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>dev.cc-logbook.push</string>
    <key>ProgramArguments</key><array><string>${nodePath}</string><string>${scriptPath}</string><string>push</string></array>
    ${interval}
  </dict></plist>

then: launchctl load ~/Library/LaunchAgents/dev.cc-logbook.push.plist (and remove the cron line with \`crontab -e\`).
`;
  }
  if (process.platform === "win32") {
    const trigger = schedule === "daily" ? "/sc daily /st 21:17" : "/sc hourly /mo 1";
    return `
Windows has no cron. Schedule the push with Task Scheduler (not automated):

  schtasks /create /tn cc-logbook-push ${trigger} /tr "\\"${nodePath}\\" \\"${scriptPath}\\" push"

Remove it later with: schtasks /delete /tn cc-logbook-push /f
`;
  }
  return "";
}

/** Path to a globally installed cc-logbook, or null. */
function globalInstallPath() {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) return null;
  const p = path.join(r.stdout.trim(), "cc-logbook", "bin", "cc-logbook.js");
  return fs.existsSync(p) ? fs.realpathSync(p) : null;
}

/** A script path that will still exist when cron runs. Offers `npm i -g` when running from the npx cache. */
async function stableScriptPath(ask, flags) {
  const self = fs.realpathSync(SELF);
  if (!/[\\/]_npx[\\/]/.test(self)) return self;
  const existing = globalInstallPath();
  if (existing) return existing;
  console.log("\nYou're running cc-logbook through npx, whose cache can be cleared, which would break the scheduled push.");
  const yes = flags.yes || /^y/i.test(await ask("Install it globally now with `npm i -g cc-logbook`? [Y/n]", "y"));
  if (yes) {
    const r = spawnSync("npm", ["install", "-g", `cc-logbook@${VERSION}`], { stdio: "inherit", shell: process.platform === "win32" });
    const installed = r.status === 0 ? globalInstallPath() : null;
    if (installed) return installed;
    console.warn("Global install failed (you may need sudo or a user-level npm prefix).");
  }
  console.warn("Skipping the scheduled push. Run `npm i -g cc-logbook && cc-logbook init` later to add it.");
  return null;
}

async function ensureGhLogin(ask) {
  if (!A.hasGh()) {
    console.log(`\nThe GitHub CLI (gh) isn't installed. Install it with:\n\n  ${A.ghInstallHint()}\n`);
    return false;
  }
  if (!A.ghLoggedIn()) {
    console.log("\nLog in to GitHub. You'll get a one-time code: open github.com/login/device on any device and enter it.");
    await ask("Press Enter to continue", "");
    if (!A.ghLogin()) return false;
  } else {
    A.ghSetupGit();
  }
  return true;
}

async function init(flags) {
  const cfg = loadConfig();
  const interactive = !flags.yes && process.stdin.isTTY;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def) => {
    if (!rl) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };
  const opts = { verbose: flags.verbose };
  try {
    // 1. git
    if (!G.hasGit()) {
      console.error("git not found on PATH. Install git and re-run `cc-logbook init`.");
      return 1;
    }
    const repoPath = repoPathOf(flags, cfg);

    // 2. existing or create
    let repoUrl = flags.repo || null;
    let create = Boolean(flags.create);
    if (!repoUrl && !create) {
      if (cfg.repoUrl && fs.existsSync(path.join(repoPath, ".git"))) repoUrl = cfg.repoUrl;
      else {
        const choice = await ask("Create a new private data repo, or use an existing one? (create/existing)", "create");
        if (/^e/i.test(choice)) repoUrl = await ask("Data repo URL (HTTPS or SSH)");
        else create = true;
      }
    }
    if (!create && !repoUrl) throw new UsageError("a data repo URL is required (--repo <url>), or use --create");

    let slug = repoUrl ? A.repoSlug(repoUrl) : null;
    let created = false;

    // 3. auth ladder
    if (create) {
      if (!(await ensureGhLogin(ask))) {
        console.log(
          `Creating a repo needs the GitHub CLI. Alternatively create one yourself from https://github.com/${A.TEMPLATE_REPO} ` +
            `("Use this template", private) and run: cc-logbook init --repo <url>`
        );
        return 1;
      }
    } else if (A.hasGitAccess(repoUrl)) {
      if (flags.verbose) console.log("Existing git access works.");
    } else {
      console.log(`Can't access ${repoUrl} with your current git credentials.`);
      let ok = false;
      if (await ensureGhLogin(ask)) {
        ok = A.hasGitAccess(repoUrl);
        if (!ok && /^git@|^ssh:/.test(repoUrl)) {
          console.log(`gh login covers HTTPS URLs. Try: cc-logbook init --repo https://github.com/${slug}.git`);
        }
      }
      if (!ok) {
        console.log(A.deployKeyHelp(repoUrl));
        return 1;
      }
    }

    // 4. create the repo
    if (create) {
      const name = flags.name || (await ask("Name for the new private repo", "cc-logbook-data"));
      const owner = A.ghUser();
      slug = name.includes("/") ? name : `${owner}/${name}`;
      console.log(`Creating private repo ${slug} from ${A.TEMPLATE_REPO}…`);
      const r = A.ghCreateRepo(slug);
      if (!r.ok) {
        console.error(`gh repo create failed: ${r.stderr}`);
        return 1;
      }
      created = true;
      repoUrl = A.ghRepoUrl(slug);
    }

    // clone or update
    if (fs.existsSync(path.join(repoPath, ".git"))) {
      const remote = G.git(["remote", "get-url", "origin"], { cwd: repoPath, allowFail: true }).stdout.trim();
      if (remote && A.repoSlug(remote) !== A.repoSlug(repoUrl)) {
        console.error(`${repoPath} already holds a clone of ${remote}. Pass --repo-path to use another location.`);
        return 1;
      }
      console.log(`Updating existing clone at ${repoPath}`);
      const r = G.pullRebase(repoPath, opts);
      if (!r.ok) console.warn(`warning: git pull failed: ${r.stderr.trim()}`);
    } else {
      console.log(`Cloning ${repoUrl} → ${repoPath}`);
      fs.mkdirSync(path.dirname(repoPath), { recursive: true });
      G.clone(repoUrl, repoPath, opts);
    }
    // A repo generated from a template is filled in asynchronously; wait for the first commit.
    for (let i = 0; created && !G.hasCommits(repoPath) && i < 10; i++) {
      sleep(2000);
      G.git(["pull"], { cwd: repoPath, allowFail: true });
    }

    if (created) {
      const timezone = flags.timezone || (await ask("Timezone for counting days", systemTimezone()));
      const cfgFile = path.join(repoPath, "cc-logbook.config.json");
      let repoCfg = {};
      try {
        repoCfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      } catch {}
      repoCfg = { title: "My Claude Code usage", aliases: {}, ...repoCfg, timezone };
      fs.writeFileSync(cfgFile, JSON.stringify(repoCfg, null, 2) + "\n");
      if (G.commitPath(repoPath, "cc-logbook.config.json", `config: timezone ${timezone}`, opts)) {
        const p = G.push(repoPath, opts);
        if (!p.ok) console.warn(`warning: couldn't push config: ${p.stderr.trim()}`);
      }

      // 5. hosting
      const pages = A.ghEnablePages(slug);
      if (pages.ok) {
        A.ghRunWorkflow(slug);
        console.log(`GitHub Pages enabled. Dashboard: ${pages.url || `https://${slug.split("/")[0]}.github.io/${slug.split("/")[1]}/`}`);
        console.log("Note: Pages sites are publicly reachable even when the repo is private.");
      } else {
        if (flags.verbose) console.log(pages.reason);
        console.log(A.cloudflareHelp(slug));
      }
    } else {
      const check = G.hasCommits(repoPath) ? G.canPush(repoPath, opts) : { ok: true };
      if (!check.ok) {
        console.log("Read access works but push was refused.");
        console.log(A.deployKeyHelp(repoUrl));
        return 1;
      }
    }

    // 6. machine label
    const machine = sanitizeMachine(flags.machine || (await ask("Label for this machine", machineLabel({ config: cfg }))));
    const schedule = flags.schedule || cfg.schedule || "hourly";
    const config = {
      ...cfg,
      machine,
      repoUrl,
      repoPath,
      dirs: flags.dir.length ? flags.dir : cfg.dirs || [],
      include: flags.include.length ? flags.include : cfg.include || [],
      schedule,
    };
    saveConfig(config);

    // 7. schedule
    const nodePath = process.execPath;
    if (schedule !== "none") {
      const scriptPath = await stableScriptPath(ask, flags);
      if (scriptPath && process.platform !== "win32") {
        const logFile = path.join(paths().stateDir, "push.log");
        const line = cronLine({ schedule, nodePath, scriptPath, logFile });
        fs.mkdirSync(paths().stateDir, { recursive: true });
        try {
          installCron(line);
          console.log(`Installed cron (${SCHEDULES[schedule] ? schedule : "custom"}):\n  ${line}`);
        } catch (e) {
          console.warn(`warning: could not install cron: ${e.message}`);
        }
      }
      // 9. launchd / Task Scheduler
      if (scriptPath) {
        const help = schedulerHelp(nodePath, scriptPath, schedule);
        if (help) console.log(help);
      }
    }
    rl?.close();

    // 8. first push
    console.log("Running first push…");
    return push({ ...flags, machine, "repo-path": repoPath });
  } finally {
    rl?.close();
  }
}

// ---------- uninstall ----------

function uninstall(flags) {
  const cfg = loadConfig();
  if (process.platform !== "win32") {
    try {
      console.log(removeCron() ? "Removed cron entry." : "No cron entry found.");
    } catch (e) {
      console.warn(`warning: ${e.message}`);
    }
  } else {
    console.log("On Windows, remove the scheduled task with: schtasks /delete /tn cc-logbook-push /f");
  }
  console.log(removeConfig() ? `Removed ${paths().configFile}.` : "No config file found.");
  console.log(`Kept the data repo clone at ${repoPathOf(flags, cfg)} (delete it manually if you want).`);
  return 0;
}

// ---------- main ----------

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.command && !COMMANDS.has(parsed.command)) throw new UsageError(`unknown command "${parsed.command}"`);
  } catch (e) {
    console.error(`cc-logbook: ${e.message}\n\n${HELP}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  try {
    switch (command) {
      case undefined:
        return await local(flags);
      case "preview":
        return preview(flags);
      case "init":
        return await init(flags);
      case "push":
        return push(flags);
      case "build":
        return build(flags);
      case "uninstall":
        return uninstall(flags);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`cc-logbook: ${e.message}\n\n${HELP}`);
      return 2;
    }
    console.error(`cc-logbook: ${flags.verbose ? e.stack : e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
