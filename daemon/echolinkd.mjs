#!/usr/bin/env node
// echolinkd · Echo Link laptop service
//
// Phone  -> POST /rpc   sealed with that phone's pairing key (AES-256-GCM)
// Phone  -> POST /pin   PIN pairing (ECDH + HMAC; useless without the PIN shown on this laptop)
// Laptop -> /local/*    127.0.0.1 only, with the admin token (the `echolink` command and the agent hook)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { randomBytes } from "node:crypto";
import { laptopName, PORT, VERSION, devices, saveDevices, newPairing, adminToken, sameToken, seal, open, log, lanAddresses, startPin, pinPair } from "./lib/core.mjs";
import * as Files from "./lib/files.mjs";
import { links, startLinkLoop, pairPhone, scan } from "./lib/phonelink.mjs";

const ADMIN = adminToken();

// ---------- approvals ----------
const approvals = new Map();
let seq = 0;
const listeners = new Set();
function changed() { seq++; for (const f of listeners) f(); listeners.clear(); }
const pending = () => [...approvals.values()].filter((a) => a.state === "pending");
function publicApproval(a) { const { waiters, ...rest } = a; return rest; }
function decide(id, allow, by) {
  const a = approvals.get(id);
  if (!a || a.state !== "pending") return false;
  a.state = allow ? "allowed" : "denied"; a.decidedBy = by; a.decidedAt = new Date().toISOString();
  for (const w of a.waiters) w(a.state);
  a.waiters = [];
  log({ type: "approval", id, tool: a.tool, summary: a.summary, decision: a.state, by });
  changed();
  const done = [...approvals.values()].filter((x) => x.state !== "pending");
  for (const x of done.slice(0, Math.max(0, done.length - 30))) approvals.delete(x.id);
  return true;
}

// ---------- agents started with `echolink run` ----------
const agents = new Map();
function stopAll(by) {
  for (const a of pending()) decide(a.id, false, by + " (stop)");
  for (const pid of agents.keys()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const n = agents.size; agents.clear();
  log({ type: "stop", by, agentsStopped: n });
  changed();
  return { stopped: n };
}

// ---------- status ----------
function battery() {
  try {
    const b = readdirSync("/sys/class/power_supply").find((x) => x.startsWith("BAT"));
    if (!b) return null;
    return { percent: Math.min(100, +readFileSync(`/sys/class/power_supply/${b}/capacity`, "utf8")), status: readFileSync(`/sys/class/power_supply/${b}/status`, "utf8").trim() };
  } catch { return null; }
}
function status() {
  const f = Files.list();
  return {
    name: laptopName(), version: VERSION, uptimeHours: +(uptime() / 3600).toFixed(1), battery: battery(),
    addresses: lanAddresses(), agents: [...agents.values()], pending: pending().length,
    phoneLinks: [...links.values()], files: { toPhone: f.toPhone.length, fromPhone: f.fromPhone.length },
  };
}

// ---------- phone RPC ----------
const seen = new Map();
setInterval(() => { const cut = Date.now() - 300000; for (const [n, t] of seen) if (t < cut) seen.delete(n); }, 60000).unref();

const METHODS = {
  hello: (_p, ctx) => { const d = devices(); d[ctx.id].confirmed = true; saveDevices(d); log({ type: "paired", device: ctx.id, name: d[ctx.id].name }); return status(); },
  status: () => status(),
  "approvals.list": () => ({ seq, pending: pending().map(publicApproval), recent: [...approvals.values()].filter((a) => a.state !== "pending").reverse().slice(0, 10).map(publicApproval) }),
  "approvals.decide": (p, ctx) => ({ ok: decide(String(p.id), Boolean(p.allow), ctx.name) }),
  "events.wait": (p) => new Promise((resolve) => {
    if ((p.since ?? -1) !== seq) return resolve({ seq, pending: pending().length });
    const t = setTimeout(() => { listeners.delete(f); resolve({ seq, pending: pending().length }); }, 20000);
    const f = () => { clearTimeout(t); resolve({ seq, pending: pending().length }); };
    listeners.add(f);
  }),
  stop: (_p, ctx) => stopAll(ctx.name),
  "files.list": () => Files.list(),
  "files.put": (p, ctx) => { const r = Files.put(p); if (r.saved) { log({ type: "file-from-phone", name: r.saved, by: ctx.name }); changed(); } return r; },
  "files.get": (p) => Files.get(p),
  "files.done": (p, ctx) => { log({ type: "file-to-phone", name: p.name, by: ctx.name }); const r = Files.done(p); changed(); return r; },
  forget: (_p, ctx) => { const d = devices(); delete d[ctx.id]; saveDevices(d); log({ type: "forget", device: ctx.id, by: "phone" }); return { ok: true }; },
};

const fails = new Map();
setInterval(() => fails.clear(), 600000).unref();
async function rpc(req, body) {
  const ip = req.socket.remoteAddress;
  if ((fails.get(ip) ?? 0) > 20) return [429, { error: "slow down" }];
  const dev = devices()[body.d];
  let msg;
  try { msg = open(dev.key, body); } catch { fails.set(ip, (fails.get(ip) ?? 0) + 1); return [401, { error: "not paired" }]; }
  if (Math.abs(Date.now() - msg.t) > 120000 || seen.has(msg.n)) return [401, { error: "stale" }];
  seen.set(msg.n, Date.now());
  const d = devices(); d[body.d].lastSeen = new Date().toISOString(); saveDevices(d);
  const fn = METHODS[msg.m];
  let out;
  try { out = fn ? { ok: true, r: await fn(msg.p ?? {}, { id: body.d, name: dev.name }) } : { ok: false, error: "unknown method " + msg.m }; }
  catch (e) { out = { ok: false, error: e.message }; }
  return [200, seal(dev.key, { ...out, n: msg.n })];
}

// ---------- local ----------
const LOCAL = {
  "GET /local/status": () => status(),
  "POST /local/pair": (b) => newPairing(String(b.name || "phone").slice(0, 40)),
  "POST /local/pin": (b) => { log({ type: "pin-start" }); return startPin(String(b.name || "phone").slice(0, 40)); },
  "GET /local/devices": () => Object.entries(devices()).map(([id, d]) => ({ id, name: d.name, created: d.created, lastSeen: d.lastSeen, confirmed: d.confirmed })),
  "POST /local/forget": (b) => { const d = devices(); const ok = Boolean(d[b.id]); delete d[b.id]; saveDevices(d); log({ type: "forget", device: b.id }); return { ok }; },
  "POST /local/stop": () => stopAll("laptop"),
  "GET /local/links": async () => scan(),
  "POST /local/phone-pair": (b) => pairPhone(b.code),
  "POST /local/files-changed": () => { changed(); return { ok: true }; },
  "POST /local/agent/start": (b) => { agents.set(b.pid, { pid: b.pid, task: String(b.task).slice(0, 200), cwd: b.cwd, at: new Date().toISOString() }); log({ type: "agent-start", task: b.task, cwd: b.cwd }); changed(); return { ok: true }; },
  "POST /local/agent/end": (b) => { agents.delete(b.pid); log({ type: "agent-end", pid: b.pid, code: b.code }); changed(); return { ok: true }; },
  "POST /local/approval": (b) => new Promise((resolve) => {
    const id = randomBytes(4).toString("hex");
    const a = { id, tool: String(b.tool), summary: String(b.summary).slice(0, 600), cwd: b.cwd, task: b.task ?? null, at: new Date().toISOString(), state: "pending", waiters: [] };
    approvals.set(id, a);
    log({ type: "approval-asked", id, tool: a.tool, summary: a.summary });
    a.waiters.push((state) => resolve({ id, decision: state }));
    changed();
    setTimeout(() => { if (a.state === "pending") decide(id, false, "timeout (15 min)"); }, 15 * 60000).unref();
  }),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 2_000_000) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad json")); } });
  });
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/rpc" && req.method === "POST") { const [c, o] = await rpc(req, await readBody(req)); return send(c, o); }
    if (url.pathname === "/pin" && req.method === "POST") {
      try { const r = pinPair(await readBody(req)); log({ type: "pin-paired", device: r.d }); return send(200, r); }
      catch (e) { log({ type: "pin-failed", reason: e.message }); return send(e.code || 400, { error: e.message }); }
    }
    if (url.pathname.startsWith("/local/")) {
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      // the phone tunnel also arrives from 127.0.0.1, so the admin token is what separates them
      if (!local || !sameToken(req.headers["x-echolink-admin"] ?? "", ADMIN)) return send(403, { error: "local only" });
      const h = LOCAL[`${req.method} ${url.pathname}`];
      if (!h) return send(404, { error: "no such command" });
      return send(200, await h(req.method === "POST" ? await readBody(req) : {}));
    }
    if (url.pathname === "/" && req.method === "GET") return send(200, { service: "echo-link", v: VERSION });
    send(404, { error: "not found" });
  } catch (e) { send(400, { error: e.message }); }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`echolinkd ${VERSION} on port ${PORT} · ${lanAddresses().join(", ")}`);
  log({ type: "start", port: PORT, version: VERSION });
  startLinkLoop();
});

const mdns = spawn("avahi-publish", ["-s", `Echo Link on ${laptopName()}`, "_echolink._tcp", String(PORT), `v=${VERSION}`], { stdio: "ignore" });
mdns.on("error", () => {});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { mdns.kill(); } catch {} log({ type: "shutdown" }); process.exit(0); });
