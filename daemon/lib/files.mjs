// Files both ways. Two plain folders, easy to find in any file manager:
//   ~/EchoLink/From phone   what the phone sends lands here
//   ~/EchoLink/To phone     drop a file here (or `echolink send <file>`) and the phone can save it
import { mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, appendFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { HOME, STATE, config } from "./core.mjs";

export const ROOT = config().folder || join(HOME, "EchoLink");
export const INBOX = join(ROOT, "From phone");
export const OUTBOX = join(ROOT, "To phone");
const SENT = join(OUTBOX, "Sent");
const PARTS = join(STATE, "uploads");
for (const d of [INBOX, OUTBOX, SENT, PARTS]) mkdirSync(d, { recursive: true });

export const CHUNK = 512 * 1024;
const safe = (n) => basename(String(n || "file")).replace(/[\/\\\0]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
function unique(dir, name) {
  let n = safe(name), i = 1;
  const ext = extname(n), stem = n.slice(0, n.length - ext.length);
  while (existsSync(join(dir, n))) n = `${stem} (${++i})${ext}`;
  return n;
}
const listDir = (dir) => readdirSync(dir).filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile())
  .map((f) => { const s = statSync(join(dir, f)); return { name: f, size: s.size, at: s.mtime.toISOString() }; })
  .sort((a, b) => b.at.localeCompare(a.at));

export function list() { return { toPhone: listDir(OUTBOX), fromPhone: listDir(INBOX).slice(0, 20), chunk: CHUNK }; }

/** phone -> laptop, one chunk at a time; the last chunk moves the file into "From phone". */
export function put({ upload, name, index, total, data }) {
  const id = String(upload).replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  if (!id) throw new Error("bad upload id");
  const part = join(PARTS, id + ".part");
  if (index === 0 && existsSync(part)) rmSync(part);
  const buf = Buffer.from(String(data || ""), "base64");
  if (buf.length > CHUNK) throw new Error("chunk too large");
  appendFileSync(part, buf, { mode: 0o600 });
  if (index + 1 < total) return { ok: true, next: index + 1 };
  const final = unique(INBOX, name);
  renameSync(part, join(INBOX, final));
  return { ok: true, saved: final, folder: "~/EchoLink/From phone" };
}

/** laptop -> phone, read a chunk of a file in "To phone". */
export function get({ name, offset = 0 }) {
  const n = safe(name), p = join(OUTBOX, n);
  if (!existsSync(p)) throw new Error("No such file: " + n);
  const size = statSync(p).size, fd = openSync(p, "r");
  const len = Math.min(CHUNK, Math.max(0, size - offset)), buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, offset); closeSync(fd);
  return { name: n, size, offset, data: buf.toString("base64"), done: offset + len >= size };
}

/** after the phone saved it, move it to "To phone/Sent" so the list stays clean. */
export function done({ name }) {
  const n = safe(name), p = join(OUTBOX, n);
  if (existsSync(p)) renameSync(p, join(SENT, unique(SENT, n)));
  return { ok: true };
}
