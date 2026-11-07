import jsQR from "jsqr";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { call, pairWith, pairWithPin, saved, use, forget, laptopName, linkKind, setOnTrying, b64 } from "./link.js";
import "./style.css";

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

let view = "approve", alive = false, waitSeq = -1, online = null, status = null;

/* ================= pairing ================= */
let scanStream = null;
const stopScan = () => { scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; };

function pairScreen(msg = "") {
  stopScan(); alive = false;
  app.innerHTML = `
    <div class="screen pair">
      <div class="hero"><div class="orb"><i></i><i></i><i></i><b></b></div></div>
      <div class="pair-copy">
        <p class="brand">echo link</p>
        <h1>Pair with your laptop</h1>
        <p class="muted">Run <code>echolink pair</code> on the laptop, then scan. Or use a PIN.</p>
      </div>
      <div class="actions">
        <button class="btn primary" id="aScan">Scan QR code</button>
        <button class="btn" id="aPin">Pair with PIN</button>
        <button class="btn ghost" id="aMore">Other ways</button>
      </div>
      <p class="msg" id="msg" role="status">${esc(msg)}</p>
    </div>
    <div class="sheet" id="more" hidden>
      <div class="sheet-card">
        <p class="label">Other ways</p>
        <label class="btn" for="qrPhoto">Read the code from a photo</label>
        <input id="qrPhoto" type="file" accept="image/*" hidden />
        <textarea id="code" rows="2" placeholder="Paste a code: echolink:1:…"></textarea>
        <div class="row"><button class="btn ghost" id="mClose">Close</button><button class="btn primary" id="mGo">Pair</button></div>
      </div>
    </div>`;
  const say = (t) => { $("msg").textContent = t; };
  const go = async (text) => {
    $("more").hidden = true; say("Pairing…");
    setOnTrying((h) => say(`Reaching the laptop (${h})…`));
    try { status = await pairWith(text); setOnTrying(null); start(); }
    catch (e) { setOnTrying(null); say(e.message); }
  };
  $("aScan").onclick = scanScreen;
  $("aPin").onclick = () => pinScreen();
  $("aMore").onclick = () => { $("more").hidden = false; };
  $("mClose").onclick = () => { $("more").hidden = true; };
  $("mGo").onclick = () => go($("code").value);
  $("qrPhoto").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    say("Reading the photo…");
    try { go(await readQRFromFile(f)); } catch (err) { $("more").hidden = true; say(err.message); }
  };
}

function decode(imgData, w, h) {
  return jsQR(imgData, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
async function readQRFromFile(file) {
  const bmp = await createImageBitmap(file);
  for (const max of [1200, 800, 1800]) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, c.width, c.height);
    const d = decode(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    if (d) return d;
  }
  throw new Error("No code found in that photo. Keep the whole code in view and try again.");
}

async function scanScreen() {
  app.innerHTML = `
    <div class="screen scan">
      <video id="cam" playsinline muted></video>
      <div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="beam"></span></div>
      <div class="scan-bar"><p id="smsg">Point at the code on your laptop</p><button class="btn" id="sCancel">Cancel</button></div>
    </div>`;
  $("sCancel").onclick = () => pairScreen();
  const say = (t) => { const m = $("smsg"); if (m) m.textContent = t; };
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    pairScreen("Camera not available. Allow camera access for Echo Link in Settings, or pair with PIN.");
    return;
  }
  const video = $("cam");
  video.srcObject = scanStream; await video.play().catch(() => {});
  const c = document.createElement("canvas"); const g = c.getContext("2d", { willReadFrequently: true });
  let found = false;
  const tick = async () => {
    if (!scanStream || found) return;
    if (video.readyState >= 2 && video.videoWidth) {
      // scan the centre square at good resolution: faster and more reliable on screens
      const side = Math.min(video.videoWidth, video.videoHeight), s = Math.min(1, 640 / side);
      c.width = c.height = Math.round(side * s);
      g.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, c.width, c.height);
      const data = decode(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      if (data) {
        if (!data.startsWith("echolink:")) { say("That's a different QR code. Point at the one from echolink pair."); }
        else {
          found = true; navigator.vibrate?.(30); stopScan(); say("Code found. Pairing…");
          setOnTrying((h) => say(`Code found · reaching the laptop (${h})…`));
          try { status = await pairWith(data); setOnTrying(null); start(); } catch (e) { setOnTrying(null); pairScreen(e.message); }
          return;
        }
      }
    }
    setTimeout(tick, 90);
  };
  tick();
}

function pinScreen(msg = "") {
  app.innerHTML = `
    <div class="screen pair pinv">
      <button class="back" id="pBack" aria-label="Back">‹ Back</button>
      <div class="pair-copy">
        <p class="brand">echo link</p>
        <h1>Enter the PIN</h1>
        <p class="muted">Run <code>echolink pair --pin</code> on the laptop. The phone finds the laptop by itself.</p>
      </div>
      <form id="pinForm" class="pin-form" autocomplete="off">
        <div class="pin-boxes" id="boxes">${"<span></span>".repeat(6)}</div>
        <input id="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" aria-label="PIN" autocomplete="one-time-code" />
        <details class="addr"><summary>Laptop not found? Enter its address</summary><input id="addr" inputmode="decimal" placeholder="e.g. 192.168.1.20" /></details>
        <button class="btn primary" id="pGo" disabled>Pair</button>
      </form>
      <p class="msg" id="msg" role="status">${esc(msg)}</p>
    </div>`;
  $("pBack").onclick = () => pairScreen();
  const pin = $("pin"), boxes = [...$("boxes").children];
  const paint = () => {
    const d = pin.value.replace(/\D/g, "").slice(0, 6); pin.value = d;
    boxes.forEach((b, i) => { b.textContent = d[i] ?? ""; b.classList.toggle("on", i === d.length); });
    $("pGo").disabled = d.length !== 6;
  };
  pin.addEventListener("input", paint); $("boxes").onclick = () => pin.focus(); paint();
  setTimeout(() => pin.focus(), 150);
  $("pinForm").onsubmit = async (e) => {
    e.preventDefault();
    const say = (t) => { $("msg").textContent = t; };
    $("pGo").disabled = true; say("Pairing…");
    setOnTrying((h) => say(`Reaching the laptop (${h})…`));
    try { status = await pairWithPin(pin.value, $("addr").value); setOnTrying(null); start(); }
    catch (er) { setOnTrying(null); say(er.message); $("pGo").disabled = false; }
  };
}

/* ================= main shell ================= */
function shell() {
  app.innerHTML = `
    <div class="screen main">
      <header class="top">
        <div><p class="brand">echo link</p><p class="laptop" id="lname">${esc(laptopName())}</p></div>
        <span class="pill" id="pill"><i></i><span>Connecting</span></span>
      </header>
      <main class="stage" id="stage"></main>
      <nav class="dock" aria-label="Sections">
        <button data-v="approve"><span class="dot" id="badge" hidden></span>Approve</button>
        <button data-v="files">Files</button>
        <button data-v="laptop">Laptop</button>
      </nav>
    </div>`;
  app.querySelector(".dock").onclick = (e) => { const b = e.target.closest("button"); if (b) { view = b.dataset.v; render(); } };
}
function setOnline(ok) {
  online = ok;
  const p = $("pill"); if (!p) return;
  p.className = "pill " + (ok ? "on" : "off");
  p.querySelector("span").textContent = ok ? linkKind() : "Offline";
}
function badge(n) { const b = $("badge"); if (b) { b.hidden = !n; b.textContent = n || ""; } }
function render() {
  document.querySelectorAll(".dock button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.v === view)));
  ({ approve: renderApprove, files: renderFiles, laptop: renderLaptop })[view]();
}
const offlineCard = (m) => `<div class="calm"><div class="orb dim"><i></i><i></i><i></i><b></b></div><h2>Offline</h2><p class="muted">${esc(m)}</p><button class="btn" id="retry">Try again</button></div>`;
function bindRetry() { const r = $("retry"); if (r) r.onclick = render; }

/* ---------- Approve ---------- */
async function renderApprove() {
  const st = $("stage");
  let d;
  try { d = await call("approvals.list"); status = await call("status"); setOnline(true); }
  catch (e) { setOnline(false); st.innerHTML = offlineCard(e.message); bindRetry(); return; }
  if (view !== "approve") return;
  badge(d.pending.length);
  if (d.pending.length) {
    const a = d.pending[0];
    st.innerHTML = `
      <article class="ask">
        <div class="ask-head"><span class="chip">${esc(a.tool)}</span><span class="muted">${d.pending.length > 1 ? `1 of ${d.pending.length}` : new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
        <p class="ask-q">The agent wants to</p>
        <pre class="ask-body" id="body">${esc(a.summary)}</pre>
        ${a.task ? `<p class="ask-meta">Task · ${esc(a.task)}</p>` : ""}
        <div class="row decide"><button class="btn deny" id="no">Deny</button><button class="btn primary" id="yes">Allow</button></div>
      </article>`;
    $("body").onclick = (e) => e.currentTarget.classList.toggle("open");
    const decide = async (allow) => { $("yes").disabled = $("no").disabled = true; await call("approvals.decide", { id: a.id, allow }).catch(() => {}); renderApprove(); };
    $("yes").onclick = () => decide(true); $("no").onclick = () => decide(false);
    return;
  }
  const agent = status.agents[0];
  const last = d.recent[0];
  st.innerHTML = `
    <div class="calm">
      <div class="orb ${agent ? "busy" : ""}"><i></i><i></i><i></i><b></b></div>
      <h2>${agent ? "Agent at work" : "All clear"}</h2>
      <p class="muted clamp">${agent ? esc(agent.task) : "Nothing needs you. Requests from the laptop appear here."}</p>
      ${last ? `<p class="last"><span class="tag ${last.state}">${last.state}</span>${esc(last.summary.split("\n")[0])}</p>` : ""}
    </div>
    <div class="stopbar" id="stopbar">${agent ? `<button class="btn ghost danger-text" id="stop">Stop the agent</button>` : ""}</div>`;
  const s = $("stop");
  if (s) s.onclick = () => {
    $("stopbar").innerHTML = `<div class="row"><button class="btn ghost" id="sNo">Cancel</button><button class="btn deny" id="sYes">Stop everything</button></div>`;
    $("sNo").onclick = renderApprove;
    $("sYes").onclick = async () => { await call("stop").catch(() => {}); renderApprove(); };
  };
}

/* ---------- Files ---------- */
async function renderFiles() {
  const st = $("stage");
  let d;
  try { d = await call("files.list"); setOnline(true); }
  catch (e) { setOnline(false); st.innerHTML = offlineCard(e.message); bindRetry(); return; }
  if (view !== "files") return;
  const show = d.toPhone.slice(0, 3), more = d.toPhone.length - show.length;
  st.innerHTML = `
    <section class="panel send">
      <p class="label">To the laptop</p>
      <label class="btn primary" for="pick">Choose files</label>
      <input id="pick" type="file" multiple hidden />
      <div id="up" class="up"><p class="muted small">Arrive in <code>~/EchoLink/From phone</code>${d.fromPhone.length ? ` · ${d.fromPhone.length} so far` : ""}</p></div>
    </section>
    <section class="panel recv">
      <p class="label">From the laptop</p>
      ${show.length ? `<ul class="flist">${show.map((f) => `<li><div><b>${esc(f.name)}</b><span>${human(f.size)}</span></div><button class="btn small" data-get="${esc(f.name)}">Save</button></li>`).join("")}</ul>${more > 0 ? `<p class="muted small">+ ${more} more after these</p>` : ""}`
        : `<p class="muted small">Nothing waiting. On the laptop: <code>echolink send &lt;file&gt;</code></p>`}
    </section>`;
  $("pick").onchange = (e) => sendFiles([...e.target.files]);
  st.querySelectorAll("[data-get]").forEach((b) => (b.onclick = () => saveFile(b.dataset.get, b)));
}
async function sendFiles(list) {
  const up = $("up"); up.innerHTML = "";
  for (const f of list.slice(0, 20)) {
    const row = document.createElement("div"); row.className = "prog";
    row.innerHTML = `<span>${esc(f.name)}</span><i><b></b></i>`; up.replaceChildren(row);
    const bar = row.querySelector("b"), chunk = 512 * 1024, total = Math.max(1, Math.ceil(f.size / chunk)), id = crypto.randomUUID();
    try {
      let r;
      for (let i = 0; i < total; i++) {
        const part = new Uint8Array(await f.slice(i * chunk, (i + 1) * chunk).arrayBuffer());
        r = await call("files.put", { upload: id, name: f.name, index: i, total, data: b64(part) }, { timeout: 60000 });
        bar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
      }
      row.classList.add("ok"); row.querySelector("span").textContent = `Sent · ${r.saved}`;
    } catch (e) { row.classList.add("bad"); row.querySelector("span").textContent = `${f.name}: ${e.message}`; return; }
  }
  navigator.vibrate?.(20);
  setTimeout(() => view === "files" && renderFiles(), 1500);
}
async function saveFile(name, btn) {
  btn.disabled = true; btn.textContent = "0%";
  try {
    let off = 0, first = true, g;
    const path = `EchoLink/${name}`;
    do {
      g = await call("files.get", { name, offset: off }, { timeout: 60000 });
      if (first) { await Filesystem.writeFile({ path, data: g.data, directory: Directory.Documents, recursive: true }); first = false; }
      else await Filesystem.appendFile({ path, data: g.data, directory: Directory.Documents });
      off += atob(g.data).length;
      btn.textContent = `${Math.round((off / Math.max(1, g.size)) * 100)}%`;
    } while (!g.done);
    await call("files.done", { name });
    btn.textContent = "Saved ✓";
    setTimeout(() => view === "files" && renderFiles(), 1500);
  } catch (e) { btn.textContent = "Retry"; btn.disabled = false; btn.title = e.message; }
}

/* ---------- Laptop ---------- */
async function renderLaptop() {
  const st = $("stage");
  try { status = await call("status"); setOnline(true); }
  catch (e) { setOnline(false); st.innerHTML = offlineCard(e.message) + unpairBlock(); bindRetry(); bindUnpair(); return; }
  if (view !== "laptop") return;
  const s = status, pct = s.battery?.percent ?? 0;
  st.innerHTML = `
    <div class="laptop-card">
      <div class="ring" style="--p:${pct}"><b>${s.battery ? pct + "%" : "—"}</b><span>${esc(s.battery?.status ?? "battery")}</span></div>
      <dl class="facts">
        <div><dt>Name</dt><dd>${esc(s.name)}</dd></div>
        <div><dt>Link</dt><dd>${esc(linkKind())}</dd></div>
        <div><dt>Agents</dt><dd>${s.agents.length || "none"}</dd></div>
        <div><dt>Files</dt><dd>${s.files.toPhone} waiting · ${s.files.fromPhone} received</dd></div>
        <div><dt>Up</dt><dd>${s.uptimeHours} h</dd></div>
        <div><dt>Version</dt><dd>${esc(s.version)}</dd></div>
      </dl>
    </div>
    ${unpairBlock()}`;
  bindUnpair();
}
const unpairBlock = () => `<div class="stopbar" id="unpair"><button class="btn ghost danger-text" id="u1">Unpair this phone</button></div>`;
function bindUnpair() {
  const u = $("u1"); if (!u) return;
  u.onclick = () => {
    $("unpair").innerHTML = `<div class="row"><button class="btn ghost" id="uNo">Cancel</button><button class="btn deny" id="uYes">Unpair</button></div>`;
    $("uNo").onclick = render;
    $("uYes").onclick = async () => { await call("forget").catch(() => {}); alive = false; forget(); pairScreen("Unpaired. Pair again any time."); };
  };
}

/* ---------- live: the laptop tells us when something changes ---------- */
async function listen() {
  while (alive) {
    try {
      const r = await call("events.wait", { since: waitSeq }, { timeout: 26000 });
      const changed = waitSeq !== -1 && r.seq !== waitSeq;
      waitSeq = r.seq; badge(r.pending); if (online !== true) setOnline(true);
      if (changed) {
        if (r.pending) { navigator.vibrate?.([50, 40, 50]); if (view !== "approve") { view = "approve"; } }
        render();
      }
    } catch { setOnline(false); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

function start() { alive = true; shell(); render(); listen(); }

const s = saved();
if (s) use(s).then(start); else pairScreen();
