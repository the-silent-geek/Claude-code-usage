// Sync-mode auth ladder: existing git access → GitHub CLI → deploy key instructions.
import { spawnSync } from "node:child_process";

export const TEMPLATE_REPO = "the-silent-geek/cc-logbook-data-template";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) return { ok: false, missing: r.error.code === "ENOENT", stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** a. Can we already read the repo with plain git? (non-interactive, never prompts) */
export function hasGitAccess(url) {
  return run("git", ["ls-remote", "--heads", url], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
    timeout: 30_000,
  }).ok;
}

export function hasGh() {
  const r = run("gh", ["--version"]);
  return r.ok;
}

export function ghLoggedIn() {
  return run("gh", ["auth", "status", "--hostname", "github.com"]).ok;
}

/** b. Device-code login (works headless), then make plain `git push` use gh's token. */
export function ghLogin() {
  const login = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"], { stdio: "inherit" });
  if (login.status !== 0) return false;
  return ghSetupGit();
}

export function ghSetupGit() {
  return spawnSync("gh", ["auth", "setup-git"], { stdio: "inherit" }).status === 0;
}

export function ghUser() {
  const r = run("gh", ["api", "user", "--jq", ".login"]);
  return r.ok ? r.stdout.trim() : null;
}

export function ghInstallHint(platform = process.platform) {
  if (platform === "darwin") return "brew install gh";
  if (platform === "win32") return "winget install --id GitHub.cli";
  return "sudo apt install gh   # or see https://github.com/cli/cli#installation";
}

/** Create a private data repo from the template (cloned separately so it can go to any path). */
export function ghCreateRepo(name, { template = TEMPLATE_REPO } = {}) {
  const r = run("gh", ["repo", "create", name, "--private", "--template", template]);
  return { ok: r.ok, stderr: r.stderr.trim() };
}

export function ghRepoUrl(fullName) {
  const r = run("gh", ["repo", "view", fullName, "--json", "url", "--jq", ".url"]);
  return r.ok ? r.stdout.trim() + ".git" : `https://github.com/${fullName}.git`;
}

/**
 * Enable GitHub Pages (Actions build). Returns {ok, url?, reason?}.
 * Fails on private repos for plans without private Pages.
 */
export function ghEnablePages(fullName) {
  const r = run("gh", ["api", "-X", "POST", `repos/${fullName}/pages`, "-f", "build_type=workflow"]);
  if (r.ok || /already enabled|409/i.test(r.stderr)) {
    const info = run("gh", ["api", `repos/${fullName}/pages`, "--jq", ".html_url"]);
    return { ok: true, url: info.ok ? info.stdout.trim() : null };
  }
  return { ok: false, reason: r.stderr.trim() };
}

export function ghRunWorkflow(fullName, workflow = "build.yml") {
  return run("gh", ["workflow", "run", workflow, "--repo", fullName]).ok;
}

/** owner/repo from an SSH or HTTPS GitHub URL (incl. host aliases like github-cc-logbook). */
export function repoSlug(url) {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

export function deployKeyHelp(url) {
  const slug = repoSlug(url) || "<owner>/<repo>";
  return `
Advanced: give only this machine write access to only this repo with a deploy key.

  ssh-keygen -t ed25519 -f ~/.ssh/cc-logbook -N "" -C "cc-logbook@$(hostname)"
  cat ~/.ssh/cc-logbook.pub

Add the public key at https://github.com/${slug}/settings/keys and tick "Allow write access".
Then add to ~/.ssh/config:

  Host github-cc-logbook
    HostName github.com
    User git
    IdentityFile ~/.ssh/cc-logbook
    IdentitiesOnly yes

and re-run:  cc-logbook init --repo git@github-cc-logbook:${slug}.git
`;
}

export function cloudflareHelp(slug) {
  return `
GitHub Pages isn't available for this private repo on your plan. Free alternative, Cloudflare Pages:

  1. dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git → ${slug || "your data repo"}
  2. Build command:  npx cc-logbook build
     Output directory:  site
  3. Optional: protect it with Cloudflare Access (Zero Trust → Access → Applications).
`;
}
