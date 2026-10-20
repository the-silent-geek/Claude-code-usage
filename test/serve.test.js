import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, canOpenBrowser, HOST } from "../src/serve.js";
import { aggregate } from "../src/aggregate.js";
import { parseFixtures } from "./helpers.js";

const get = (port, p, host = "127.0.0.1") =>
  new Promise((resolve, reject) => {
    http.get({ host, port, path: p }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
    }).on("error", reject);
  });

test("serves index, data.json and refresh on 127.0.0.1 only", async () => {
  let loads = 0;
  const load = () => {
    loads++;
    return aggregate(parseFixtures().rows.map((row) => ({ machine: "me", row })), { mode: "local", timezone: "UTC" });
  };
  const { server, port } = await startServer({ load, port: 47000 });
  try {
    assert.equal(server.address().address, HOST);
    const idx = await get(port, "/");
    assert.equal(idx.status, 200);
    assert.match(idx.body, /<canvas id="daily"/);
    const data = await get(port, "/data.json");
    assert.equal(data.status, 200);
    const parsed = JSON.parse(data.body);
    assert.equal(parsed.mode, "local");
    assert.equal(parsed.days.reduce((s, d) => s + d.responses, 0), 6);
    assert.equal(loads, 1);
    const refreshed = await get(port, "/refresh");
    assert.equal(refreshed.status, 200);
    JSON.parse(refreshed.body);
    assert.equal(loads, 2);
    assert.equal((await get(port, "/../../etc/passwd")).status, 404);
  } finally {
    server.close();
  }
});

test("falls through to the next port when busy", async () => {
  const load = () => ({ days: [] });
  const a = await startServer({ load, port: 47100 });
  const b = await startServer({ load, port: a.port });
  try {
    assert.equal(b.port, a.port + 1);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("browser opening is skipped over SSH and on headless Linux", () => {
  assert.equal(canOpenBrowser({ SSH_CONNECTION: "1 2 3 4" }, "darwin"), false);
  assert.equal(canOpenBrowser({}, "linux"), false);
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(canOpenBrowser({}, "win32"), true);
});
