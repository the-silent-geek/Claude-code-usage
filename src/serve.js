// Local-mode dashboard server. node:http only, bound to 127.0.0.1.
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

export const HOST = "127.0.0.1";
const INDEX = new URL("../site/index.html", import.meta.url);

/**
 * @param {{load: () => object, port?: number, tries?: number}} opts load() returns data.json; called on start and /refresh
 * @returns {Promise<{server: http.Server, port: number, url: string}>}
 */
export async function startServer({ load, port = 4545, tries = 11 }) {
  let data = load();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(200, "text/html; charset=utf-8", fs.readFileSync(INDEX));
      }
      if (url.pathname === "/data.json") return send(200, "application/json", JSON.stringify(data));
      if (url.pathname === "/refresh") {
        data = load();
        return send(200, "application/json", JSON.stringify(data));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      send(500, "text/plain", String(e.message || e));
    }
  });

  for (let i = 0; i < tries; i++) {
    const p = port + i;
    const ok = await new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" || e.code === "EACCES") resolve(false);
        else reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, HOST);
    });
    if (ok) {
      const actual = server.address().port;
      return { server, port: actual, url: `http://localhost:${actual}/` };
    }
  }
  throw new Error(`ports ${port}–${port + tries - 1} are all in use; pick another with --port`);
}

/** True when opening a browser makes sense on this machine. */
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return true;
}

export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
