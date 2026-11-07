// Echo Link · shared pieces: config, state, encryption, pairing.
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual, createECDH, createHmac, hkdfSync, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.ECHOLINK_PORT || 47025); // default port
export const HOME = homedir();
export const STATE = process.env.ECHOLINK_STATE || join(HOME, ".local/share/echo-link");
export const VERSION = "0.2.0";

// Optional user config: ~/.config/echo-link/config.json
//   { "contextFile": "/path/to/notes.md", "folder": "/path/to/EchoLink" }
export const CONFIG_DIR = join(HOME, ".config/echo-link");
export function config() {
  try { return JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")); } catch { return {}; }
}
// The name the phone shows for this laptop.
export const laptopName = () => process.env.ECHOLINK_NAME || config().name || hostname();

mkdirSync(STATE, { recursive: true, mode: 0o700 });

const devicesFile = join(STATE, "devices.json");
const adminFile = join(STATE, "admin.token");

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ---------- devices (paired phones) ----------
export const devices = () => readJson(devicesFile, {});
export function saveDevices(d) { writePrivate(devicesFile, JSON.stringify(d, null, 2)); }

/** Create a pairing for a new phone. The key exists only in the QR shown on this screen and in devices.json. */
export function newPairing(name = "phone") {
  const id = randomBytes(6).toString("hex");
  const key = randomBytes(32).toString("base64url");
  const d = devices();
  d[id] = { name, key, created: new Date().toISOString(), lastSeen: null, confirmed: false };
  saveDevices(d);
  const hosts = lanAddresses();
  const payload = { v: 1, d: id, k: key, h: hosts, p: PORT, n: laptopName() };
  return { id, uri: "echolink:1:" + Buffer.from(JSON.stringify(payload)).toString("base64url"), hosts };
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !name.startsWith("docker") && !name.startsWith("veth")) out.push(a.address);
  }
  return out;
}

// ---------- admin token for the local CLI ----------
export function adminToken() {
  if (!existsSync(adminFile)) writePrivate(adminFile, randomBytes(24).toString("hex"));
  return readFileSync(adminFile, "utf8").trim();
}
export function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- encryption: AES-256-GCM with the pairing key (WebCrypto-compatible: ciphertext || tag) ----------
export function seal(keyB64u, obj) {
  const key = Buffer.from(keyB64u, "base64url");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), c: ct.toString("base64") };
}
export function open(keyB64u, box) {
  const key = Buffer.from(keyB64u, "base64url");
  const buf = Buffer.from(box.c, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"));
}

// ---------- the log: every action and who approved it ----------
export function log(event) {
  appendFileSync(join(STATE, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
}
export const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ---------- PIN pairing ----------
// The PIN never travels. The phone sends an ECDH public key with an HMAC keyed by the PIN; the laptop
// checks it (5 tries, 3 minutes), answers with its own public key and HMAC, and both derive the same
// pairing key from the ECDH secret. Someone listening learns nothing; someone guessing has 5 tries in a million.
let pinSession = null;
export function startPin(name = "phone") {
  pinSession = { pin: String(randomInt(0, 1000000)).padStart(6, "0"), name, tries: 0, until: Date.now() + 180000 };
  return { pin: pinSession.pin, hosts: lanAddresses(), port: PORT, until: new Date(pinSession.until).toISOString() };
}
export const pinActive = () => Boolean(pinSession && Date.now() < pinSession.until);
const mac = (pin, text) => createHmac("sha256", Buffer.from("echolink-pin:" + pin)).update(text).digest();
export function pinPair(body) {
  if (!pinActive()) throw Object.assign(new Error("No PIN pairing is open on the laptop. Run: echolink pair --pin"), { code: 410 });
  const pub = String(body.pub || ""), got = Buffer.from(String(body.mac || ""), "base64");
  const want = mac(pinSession.pin, "phone|" + pub);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    pinSession.tries++;
    if (pinSession.tries >= 5) { pinSession = null; throw Object.assign(new Error("Too many wrong PINs. Start again on the laptop."), { code: 429 }); }
    throw Object.assign(new Error(`Wrong PIN. ${5 - pinSession.tries} tries left.`), { code: 401 });
  }
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const mine = ecdh.getPublicKey().toString("base64");
  const secret = ecdh.computeSecret(Buffer.from(pub, "base64"));
  const id = randomBytes(6).toString("hex");
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.from(pinSession.pin), Buffer.from("echolink v1 " + id), 32)).toString("base64url");
  const d = devices();
  d[id] = { name: pinSession.name, key, created: new Date().toISOString(), lastSeen: null, confirmed: false, via: "pin" };
  saveDevices(d);
  const answer = { d: id, pub: mine, n: laptopName(), h: lanAddresses(), p: PORT };
  answer.mac = mac(pinSession.pin, `laptop|${pub}|${mine}|${id}`).toString("base64");
  pinSession = null; // one pairing per PIN
  return answer;
}
