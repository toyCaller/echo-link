// Phone link manager.
// Every few seconds: find phones that adb knows (USB cable, or Wireless debugging found on the network),
// connect any phone Android announces, and open the tunnel phone:47025 -> laptop:47025 on each one.
// This works without opening the laptop's firewall. Only phones that already trust this laptop appear.
import { execFile } from "node:child_process";
import { PORT, log } from "./core.mjs";

const run = (args, timeout = 8000) => new Promise((resolve) =>
  execFile("adb", args, { timeout }, (err, out) => resolve(err ? "" : String(out))));

export const links = new Map(); // serial -> { serial, kind, since, tunnel }
let enabled = process.env.ECHOLINK_ADB !== "0";

export async function scan() {
  if (!enabled) return [];
  // 1) connect phones announced over Wi-Fi (already trusted phones only)
  const svc = await run(["mdns", "services"]);
  for (const line of svc.split("\n")) {
    const m = line.match(/_adb-tls-connect\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+:\d+)/);
    if (m) await run(["connect", m[1]], 5000);
  }
  // 1b) fallback: Wireless debugging doesn't always announce itself. If no phone is linked,
  //     look for the debug port on phones seen before (same Wi-Fi only, quick TCP probes).
  if (!(await run(["devices"])).split("\n").slice(1).some((l) => /\tdevice$/.test(l))) await probeKnown();
  // 2) every phone that is ready: make sure the tunnel is open
  const devs = (await run(["devices"])).split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  const seen = new Set();
  for (const serial of devs) {
    const kind = /:\d+$/.test(serial) || serial.includes("_adb-tls") ? "wifi-debug" : "usb";
    const list = await run(["-s", serial, "reverse", "--list"]);
    let tunnel = list.includes(`tcp:${PORT} tcp:${PORT}`);
    if (!tunnel) { tunnel = (await run(["-s", serial, "reverse", `tcp:${PORT}`, `tcp:${PORT}`])).trim() !== "" || (await run(["-s", serial, "reverse", "--list"])).includes(`tcp:${PORT}`); if (tunnel) log({ type: "tunnel-open", serial, kind }); }
    const prev = links.get(serial);
    links.set(serial, { serial, kind, tunnel, since: prev?.since ?? new Date().toISOString() });
    rememberIp(serial);
    seen.add(serial);
  }
  for (const s of [...links.keys()]) if (!seen.has(s)) { links.delete(s); log({ type: "tunnel-gone", serial: s }); }
  return [...links.values()];
}

/** echolink phone-pair <code>: first-time trust, using the phone's "Pair device with pairing code". */
export async function pairPhone(code) {
  const svc = await run(["mdns", "services"]);
  const m = svc.match(/_adb-tls-pairing\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+:\d+)/);
  if (!m) throw new Error('On the phone open Wireless debugging > "Pair device with pairing code" and keep that screen open.');
  const out = await run(["pair", m[1], String(code)], 15000);
  if (!/Successfully paired/i.test(out)) throw new Error("Pairing failed: " + (out.trim() || "no answer"));
  return { paired: m[1] };
}

export function startLinkLoop() {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await scan(); } finally { busy = false; } };
  tick();
  return setInterval(tick, 6000);
}

// ---------- fallback discovery ----------
import { createConnection } from "node:net";
import { readFileSync as rf, writeFileSync as wf } from "node:fs";
import { join as pj } from "node:path";
import { STATE } from "./core.mjs";
const KNOWN = pj(STATE, "phones-seen.json");
const knownIps = () => { try { return JSON.parse(rf(KNOWN, "utf8")); } catch { return []; } };
export function rememberIp(serial) {
  const ip = (serial.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/) || [])[1];
  if (!ip) return;
  const list = [ip, ...knownIps().filter((x) => x !== ip)].slice(0, 5);
  try { wf(KNOWN, JSON.stringify(list), { mode: 0o600 }); } catch {}
}
const open = (ip, port) => new Promise((res) => {
  const s = createConnection({ host: ip, port, timeout: 350 });
  s.once("connect", () => { s.destroy(); res(port); });
  s.once("timeout", () => { s.destroy(); res(null); });
  s.once("error", () => res(null));
});
let lastProbe = 0;
async function probeKnown() {
  if (Date.now() - lastProbe < 60000) return; // at most once a minute
  lastProbe = Date.now();
  for (const ip of knownIps()) {
    const found = [];
    for (let base = 30000; base < 50000; base += 500) {
      const batch = await Promise.all(Array.from({ length: 500 }, (_, i) => open(ip, base + i)));
      found.push(...batch.filter(Boolean));
    }
    for (const port of found) {
      const out = await run(["connect", `${ip}:${port}`], 5000);
      if (/connected to/.test(out)) { log({ type: "phone-found", ip, port }); return; }
    }
  }
}
