# My Claude Code usage

This is a private **[cc-logbook](https://github.com/the-silent-geek/Claude-code-usage) data repo**. Each machine running `cc-logbook push` adds its usage rows to `data/<machine>/<YYYY-MM>.jsonl`. On every push, a GitHub Action runs `npx cc-logbook build`, which merges all machines' rows into `site/` and deploys the dashboard.

## Add a machine

```sh
npx cc-logbook init
```

Choose **existing** and paste this repo's URL. It checks access, schedules an hourly push and sends the first batch of rows.

## Settings

`cc-logbook.config.json`:

```json
{ "timezone": "Asia/Kolkata", "title": "My Claude Code usage", "aliases": { "ai-automated-protecto-ml-service-llm": "protecto" } }
```

- `timezone`: the IANA zone days are counted in. VMs usually log in UTC; this keeps the dashboard on your local days.
- `aliases`: rename projects. Renames apply at build time, so no machine has to re-export.

## Privacy and hosting

- `data.json` contains project aliases and token counts only. No prompts, file paths or usernames ever leave a machine.
- **GitHub Pages sites are publicly reachable even when the repo is private.** Anyone with the URL can see your aliases and token counts. Pages on private repos also needs a paid GitHub plan.
- To keep it private for free, use **Cloudflare Pages** with **Cloudflare Access**:
  1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → this repo.
  2. Build command `npx cc-logbook build`, output directory `site`.
  3. Zero Trust → Access → Applications → protect the site so only you can open it.
  4. Turn off the GitHub Pages workflow (Actions tab → *build dashboard* → Disable).

## Layout

```
data/<machine>/<YYYY-MM>.jsonl   usage rows, append-only, one folder per machine
cc-logbook.config.json           timezone, title, aliases
.github/workflows/build.yml      npx cc-logbook build → GitHub Pages
```
