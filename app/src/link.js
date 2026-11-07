// The link to the laptop. Every message is sealed with this phone's pairing key (AES-256-GCM).

const STORE = "echolink.pair";
const TUNNEL = "127.0.0.1"; // the USB / Wireless debugging tunnel opened by echolinkd
let cfg = null, key = null, host = null;

const enc = (s) => new TextEncoder().encode(s);
// base64 in slices: spreading a whole file into fromCharCode overflows the stack
export const b64 = (buf) => {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const unb64u = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

// A hard time limit: Android's native HTTP bridge ignores AbortController, so a firewall that
// silently drops packets would otherwise keep the app waiting for minutes.
const within = (ms, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export const saved = () => { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch { return null; } };
export function forget() { try { localStorage.removeItem(STORE); } catch {} cfg = key = host = null; }
function remember() { try { localStorage.setItem(STORE, JSON.stringify({ ...cfg, last: host })); } catch {} }

export async function use(c) {
  cfg = c;
  key = await crypto.subtle.importKey("raw", unb64u(c.k), "AES-GCM", false, ["encrypt", "decrypt"]);
  host = c.last ?? null;
}

let onTrying = null;
export const setOnTrying = (fn) => { onTrying = fn; };

async function post(h, path, body, ms) {
  const r = await within(ms, fetch(`http://${h}:${cfg?.p ?? 47025}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, json: await within(ms, r.json()) };
}

/** call(method, params): seal, send, open the answer. The last good route is tried first, then the tunnel, then Wi-Fi. */
export async function call(m, p = {}, { timeout = 15000 } = {}) {
  if (!key) throw new Error("Not paired");
  const n = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc(JSON.stringify({ m, p, t: Date.now(), n })));
  const body = { d: cfg.d, iv: b64(iv), c: b64(c) };
  const hosts = [...new Set([host, TUNNEL, ...(cfg.h || [])].filter(Boolean))];
  for (const h of hosts) {
    try {
      onTrying?.(h);
      const { status, json } = await post(h, "/rpc", body, h === host ? timeout : Math.min(timeout, 4000));
      if (status === 401) throw Object.assign(new Error("The laptop no longer knows this phone. Pair again."), { fatal: true });
      if (!json.iv) throw new Error(json.error || `Laptop answered ${status}`);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(json.iv) }, key, unb64(json.c));
      const res = JSON.parse(new TextDecoder().decode(pt));
      if (res.n !== n) throw new Error("Answer did not match the question");
      if (host !== h) { host = h; remember(); }
      if (!res.ok) throw Object.assign(new Error(res.error), { remote: true });
      return res.r;
    } catch (e) { if (e.fatal || e.remote) throw e; }
  }
  throw Object.assign(new Error(`Can't reach ${cfg.n ?? "the laptop"}.`), { offline: true });
}

// ---------- pairing with a QR code ----------
export function parsePairing(text) {
  const m = String(text).trim().match(/^echolink:1:([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("That is not an Echo Link code.");
  const c = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
  if (!c.d || !c.k || !c.p) throw new Error("The code is incomplete.");
  return c;
}
export async function pairWith(text) {
  await use(parsePairing(text));
  try { const s = await call("hello"); remember(); return s; }
  catch (e) { if (e.offline) throw new Error(unreachable()); throw e; }
}

// ---------- pairing with a PIN: the PIN never travels ----------
async function hmac(pin, text) {
  const k = await crypto.subtle.importKey("raw", enc("echolink-pin:" + pin), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(text)));
}
/** Finds the laptop by itself: the debug tunnel first, then a remembered or typed address. */
export async function pairWithPin(pin, address = "") {
  pin = String(pin).replace(/\D/g, "");
  if (pin.length !== 6) throw new Error("The PIN has 6 digits.");
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
  const mac = b64(await hmac(pin, "phone|" + pub));
  const typed = String(address).trim();
  const candidates = [...new Set([typed && (typed.includes(":") ? typed : `${typed}:47025`), `${TUNNEL}:47025`, ...((saved()?.h) || []).map((h) => `${h}:47025`)].filter(Boolean))];
  let a = null, reached = null, lastErr = null;
  for (const hp of candidates) {
    const [h, port] = hp.split(":");
    onTrying?.(h);
    try {
      const r = await within(5000, fetch(`http://${h}:${port}/pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pub, mac }) }));
      const j = await within(5000, r.json());
      if (!r.ok) throw Object.assign(new Error(j.error || `Laptop answered ${r.status}`), { answered: true });
      a = j; reached = { h, port: Number(port) }; break;
    } catch (e) { if (e.answered) throw e; lastErr = e; }
  }
  if (!a) throw new Error(unreachable());
  const want = b64(await hmac(pin, `laptop|${pub}|${a.pub}|${a.d}`));
  if (want !== a.mac) throw new Error("The laptop's answer didn't match the PIN. Pairing stopped.");
  const peer = await crypto.subtle.importKey("raw", unb64(a.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, kp.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc(pin), info: enc("echolink v1 " + a.d) }, hk, 256);
  const k = b64(bits).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await use({ v: 1, d: a.d, k, h: [...new Set([reached.h, ...a.h])], p: reached.port, n: a.n });
  host = reached.h;
  const s = await call("hello");
  remember();
  return s;
}

const unreachable = () =>
  "This phone can't reach the laptop. Turn on Wireless debugging or plug in USB (Echo Link opens the link by itself), or allow port 47025 in the laptop's firewall.";

export const currentHost = () => host;
export const laptopName = () => cfg?.n ?? "Laptop";
export const linkKind = () => (host === TUNNEL ? "USB / debug link" : host ? "Wi-Fi" : "—");
