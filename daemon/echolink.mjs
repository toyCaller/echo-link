#!/usr/bin/env node
// echolink · command line for Echo Link
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PORT, STATE, VERSION, adminToken, config, log } from "./lib/core.mjs";
import { OUTBOX, INBOX, list as listFiles } from "./lib/files.mjs";

const SELF = fileURLToPath(import.meta.url);
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-echolink-admin": adminToken(), "Content-Type": "application/json" };
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const accent = (s) => c("38;5;120", s), dim = (s) => c("2", s), bold = (s) => c("1", s);

async function local(method, path, body) {
  try { const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return await r.json(); }
  catch { return null; }
}
const need = (x) => { if (!x) { console.error("echolinkd is not running. Start it: systemctl --user start echolinkd"); process.exit(1); } return x; };

// Tools the agent may use without asking (they only read).
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "TaskList", "TaskGet"]);
function summarize(tool, input) {
  if (tool === "Bash") return `Run: ${input.command}${input.description ? `\n(${input.description})` : ""}`;
  if (tool === "Write") return `Write file: ${input.file_path} (${String(input.content ?? "").length} chars)`;
  if (tool === "Edit" || tool === "MultiEdit") return `Edit file: ${input.file_path}`;
  if (tool === "WebFetch") return `Open web page: ${input.url}`;
  if (tool === "WebSearch") return `Search the web: ${input.query}`;
  return `${tool}: ${JSON.stringify(input).slice(0, 300)}`;
}

const cmds = {
  async status() {
    const s = need(await local("GET", "/local/status"));
    const phones = need(await local("GET", "/local/devices"));
    const row = (k, v) => console.log(`  ${dim(k.padEnd(9))} ${v}`);
    console.log(`\n  ${accent("●")} ${bold("Echo Link")} ${dim(s.version)} on ${s.name}\n`);
    row("phone", phones.filter((p) => p.confirmed).map((p) => `${p.name}${p.lastSeen ? dim(" · seen " + p.lastSeen.slice(11, 16)) : ""}`).join(", ") || dim("none paired · echolink pair"));
    row("link", s.phoneLinks.length ? s.phoneLinks.map((x) => `${x.kind === "usb" ? "USB" : "Wireless debugging"} ${x.tunnel ? accent("open") : "closed"}`).join(", ") : dim("Wi-Fi only (port " + PORT + ")"));
    row("approve", s.pending ? accent(`${s.pending} waiting`) : dim("nothing waiting"));
    row("agents", s.agents.length ? s.agents.map((a) => a.task).join("; ") : dim("none running"));
    row("files", `${s.files.toPhone} to phone · ${s.files.fromPhone} from phone`);
    row("battery", s.battery ? `${s.battery.percent}% ${dim(s.battery.status)}` : dim("n/a"));
    console.log("");
  },

  async pair(...args) {
    const pin = args.includes("--pin"), show = args.includes("--show");
    const name = args.filter((a) => !a.startsWith("--"))[0] || "phone";
    const s = need(await local("GET", "/local/status"));
    const linkNote = s.phoneLinks.some((x) => x.tunnel)
      ? "The phone will find this laptop by itself (USB / Wireless debugging link is open)."
      : `The phone reaches this laptop over Wi-Fi at ${s.addresses.join(" or ")}, port ${PORT}.`;
    if (pin) {
      const r = need(await local("POST", "/local/pin", { name }));
      console.log(`\n  ${bold("Echo Link · PIN")}\n\n      ${accent(bold(r.pin.slice(0, 3) + " " + r.pin.slice(3)))}\n\n  ${dim("In the app: Pair with PIN. Valid 3 minutes, 5 tries, one phone.")}\n  ${dim(linkNote)}\n`);
      const before = new Set((await local("GET", "/local/devices")).map((d) => d.id));
      const start = Date.now();
      while (Date.now() - start < 185000) {
        await new Promise((r) => setTimeout(r, 1500));
        const fresh = (await local("GET", "/local/devices"))?.find((d) => !before.has(d.id) && d.confirmed);
        if (fresh) { console.log(`  ${accent("●")} Paired: ${fresh.name}\n`); return; }
      }
      console.log("  PIN expired. Run  echolink pair --pin  again.\n");
      return;
    }
    const p = need(await local("POST", "/local/pair", { name }));
    console.log(`\n  ${bold("Echo Link · scan with the app")}\n`);
    try { execFileSync("qrencode", ["-t", "ANSIUTF8", "-m", "2", p.uri], { stdio: ["ignore", "inherit", "inherit"] }); } catch { console.log(p.uri); }
    const png = join(STATE, "pair-qr.png");
    try { execFileSync("qrencode", ["-o", png, "-s", "8", "-m", "10", p.uri]); } catch {}
    console.log(`\n  ${dim("One use, one phone. " + linkNote)}\n`);
    if (show && existsSync(png)) spawn("xdg-open", [png], { detached: true, stdio: "ignore" }).unref();
  },

  async devices() { console.table(need(await local("GET", "/local/devices"))); },
  async forget(id) { console.log(need(await local("POST", "/local/forget", { id }))); },
  async stop() { const r = need(await local("POST", "/local/stop")); console.log(`Stopped. ${r.stopped} agent(s) ended, every waiting approval denied.`); },
  async links() {
    const l = need(await local("GET", "/local/links"));
    console.log(l.length ? l.map((x) => `${x.serial}  ${x.kind}  tunnel ${x.tunnel ? "open" : "closed"}`).join("\n") : "No phone on a USB or Wireless debugging link.");
  },
  async "phone-pair"(code) {
    if (!code) { console.error('usage: echolink phone-pair <code from "Pair device with pairing code">'); process.exit(1); }
    console.log(need(await local("POST", "/local/phone-pair", { code })));
  },

  async send(...files) {
    if (!files.length) { console.error("usage: echolink send <file> [more files]"); process.exit(1); }
    for (const f of files) { copyFileSync(f, join(OUTBOX, basename(f))); console.log(`ready for the phone: ${basename(f)}`); }
    await local("POST", "/local/files-changed");
  },
  async files() {
    const l = listFiles();
    console.log(`To phone   ${dim(OUTBOX)}\n${l.toPhone.map((f) => "  " + f.name).join("\n") || dim("  empty")}`);
    console.log(`From phone ${dim(INBOX)}\n${l.fromPhone.map((f) => "  " + f.name).join("\n") || dim("  empty")}`);
  },

  /** echolink run "task" [folder]: run the agent; every action that changes something waits for the phone. */
  async run(task, dir = ".") {
    if (!task) { console.error('usage: echolink run "what to do" [folder]'); process.exit(1); }
    need(await local("GET", "/local/status"));
    const cwd = resolve(dir);
    const settings = join(mkdtempSync(join(tmpdir(), "echolink-")), "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${JSON.stringify(SELF)} hook`, timeout: 960 }] }] } }));
    const ctxFile = config().contextFile;
    const ctx = ctxFile && existsSync(ctxFile) ? `\n\nContext from the user:\n${readFileSync(ctxFile, "utf8")}` : "";
    const sys = "You are running through Echo Link. Every action that is not read-only is shown on the user's phone and waits for approval. If one is denied, do not retry it; explain and continue." + ctx;
    console.log(`${accent("●")} Agent working in ${cwd}. Approvals go to your phone.\n`);
    const child = spawn("claude", ["-p", task, "--settings", settings, "--append-system-prompt", sys, "--permission-mode", "default"], { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ECHOLINK_TASK: task } });
    await local("POST", "/local/agent/start", { pid: child.pid, task, cwd });
    child.on("exit", async (code) => { await local("POST", "/local/agent/end", { pid: child.pid, code }); process.exit(code ?? 0); });
  },

  /** PreToolUse hook used by `echolink run`. */
  async hook() {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const tool = input.tool_name ?? "?";
    const reply = (decision, reason) => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } })); process.exit(0); };
    if (READ_ONLY.has(tool)) return reply("allow", "read-only");
    const r = await local("POST", "/local/approval", { tool, summary: summarize(tool, input.tool_input ?? {}), cwd: input.cwd, task: process.env.ECHOLINK_TASK });
    if (!r) return reply("deny", "Echo Link is not running, so nothing can be approved.");
    log({ type: "hook", tool, decision: r.decision });
    return r.decision === "allowed" ? reply("allow", "approved on the phone") : reply("deny", "denied on the phone");
  },

  version() { console.log(VERSION); },
  help() {
    console.log(`
  ${bold("echolink")} ${dim(VERSION)} · your phone approves what the agent on this laptop does

  ${accent("status")}                      phone, link, approvals, agents, files
  ${accent("pair")} [name] [--show]         pair a phone with a QR code (--show opens it in a window)
  ${accent("pair --pin")} [name]            pair with a 6-digit PIN instead
  ${accent("run")} "task" [folder]          run the agent; your phone approves each change
  ${accent("stop")}                        end every agent, deny everything waiting
  ${accent("send")} <files>                 make files available to the phone
  ${accent("files")}                       what is waiting and what arrived
  ${accent("links")}                       USB / Wireless debugging links
  ${accent("phone-pair")} <code>            trust a phone for Wireless debugging (one time)
  ${accent("devices")} · ${accent("forget")} <id>          paired phones
`);
  },
};

const [cmd = "help", ...args] = process.argv.slice(2);
await (cmds[cmd] ?? cmds.help)(...args);
