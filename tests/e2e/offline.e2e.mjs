/**
 * E2E hors-ligne : Chromium (caméra factice, GPS simulé) -> Caddy -> API -> processeur deface -> page publique.
 * Démarre lui-même les services (pas de Docker) : api, blur/processor, admin et Caddy (Caddyfile réel,
 * sans le bloc de production TLS).
 *
 *   PYTHON=~/venv/bin/python npm test                 # rapide : segments de 15 s
 *   E2E_SEGMENT_SECONDS=60 E2E_RECORD_SECONDS=140 npm test   # grandeur nature
 *
 * Prérequis : ffmpeg/ffprobe, caddy, deface (venv), tesseract (OCR du texte incrusté).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3";
const SEGMENT_SECONDS = Number(process.env.E2E_SEGMENT_SECONDS || 15);
const RECORD_SECONDS = Number(process.env.E2E_RECORD_SECONDS || 50);
const PORT = Number(process.env.E2E_PORT || 18080);
const API_PORT = PORT + 1;
const ADMIN_PORT = PORT + 2;
const BASE = `http://localhost:${PORT}`;
const CAPTURE_TOKEN = "capture-token-for-e2e-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-for-e2e-0123456789abcdef";
const GEO = { latitude: 48.8584, longitude: 2.2945, accuracy: 12 };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "svu-e2e-"));
const STORAGE = path.join(WORK, "storage");
const ARTIFACTS = path.join(ROOT, "tests/e2e/artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.mkdirSync(STORAGE, { recursive: true });

const results = [];
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "  OK   " : "  ECHEC"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(fn, { timeout = 60_000, interval = 500, desc = "condition" } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() - started > timeout) throw new Error(`délai dépassé : ${desc} (${last?.message || last})`);
    await sleep(interval);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function startService(name, cmd, args, env) {
  const log = fs.createWriteStream(path.join(WORK, `${name}.log`));
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}

function stopAll() {
  for (const { child } of children) child.kill("SIGTERM");
}

async function http(pathname, { method = "GET", token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

function probe(file) {
  const r = run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file]);
  const data = JSON.parse(r.out || "{}");
  const v = (data.streams || []).find((s) => s.codec_type === "video") || {};
  const a = (data.streams || []).find((s) => s.codec_type === "audio");
  return { width: v.width, height: v.height, vcodec: v.codec_name, acodec: a?.codec_name, duration: Number(data.format?.duration || 0) };
}

function maxPacketGap(file, stream = "v:0") {
  const r = run("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]);
  const times = r.out
    .split("\n")
    .map((l) => Number(l.trim().replace(/,$/, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < times.length; i += 1) max = Math.max(max, times[i] - times[i - 1]);
  return { frames: times.length, maxGap: max, span: times.length ? times[times.length - 1] - times[0] : 0 };
}

function ocrOverlay(videoFile, atSeconds, name) {
  const png = path.join(ARTIFACTS, `${name}.png`);
  run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(atSeconds), "-i", videoFile, "-frames:v", "1", png]);
  const crop = path.join(ARTIFACTS, `${name}-overlay.png`);
  // Bandeau d'incrustation : bas gauche de l'image portrait.
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", "crop=iw:iw*0.40:0:ih-iw*0.40-10,scale=iw*2:-1,format=gray,negate", crop]);
  const t = run("tesseract", [crop, "-", "--psm", "6"]);
  return { png, text: t.out.replace(/\s+/g, " ").trim(), ok: t.code === 0 };
}

async function startStack({ publicPage = true } = {}) {
  const base = { STORAGE_DIR: STORAGE, PUBLIC_PAGE_ENABLED: String(publicPage) };
  startService("api", PYTHON, [path.join(ROOT, "services/api/server.py")], { ...base, API_PORT: String(API_PORT), API_BIND: "127.0.0.1", MIN_FREE_GB: "0" });
  // nice 19 : Chromium (sans encodeur matériel) partage le CPU avec le floutage et perdrait des images sinon.
  startService("processor", "nice", ["-n", "19", PYTHON, path.join(ROOT, "services/blur/processor.py")], {
    ...base,
    SEGMENT_SECONDS: String(SEGMENT_SECONDS),
    BLUR_PROCESSOR_WORKERS: "2",
    OMP_NUM_THREADS: "2",
    PATH: `${path.dirname(PYTHON)}:${process.env.PATH}`,
  });
  startService("admin", PYTHON, [path.join(ROOT, "services/admin/server.py")], {
    ...base,
    ADMIN_TOKEN,
    ADMIN_PORT: String(ADMIN_PORT),
    ADMIN_BIND: "127.0.0.1",
    PROJECT_DIR: WORK,
  });
  await startCaddy(publicPage);
}

let caddyChild = null;
async function startCaddy(publicPage) {
  const src = fs.readFileSync(path.join(ROOT, "caddy/Caddyfile"), "utf8");
  const trimmed = src.split("# Production : TLS automatique")[0];
  const caddyfile = path.join(WORK, "Caddyfile");
  fs.writeFileSync(caddyfile, trimmed);
  caddyChild = startService("caddy", "caddy", ["run", "--config", caddyfile, "--adapter", "caddyfile"], {
    ACME_EMAIL: "e2e@example.test",
    HTTP_PORT: String(PORT),
    WEB_DIR: path.join(ROOT, "web"),
    STORAGE_DIR: STORAGE,
    API_UPSTREAM: `127.0.0.1:${API_PORT}`,
    ADMIN_UPSTREAM: `127.0.0.1:${ADMIN_PORT}`,
    CAPTURE_TOKEN,
    ADMIN_TOKEN,
    PUBLIC_PAGE_ENABLED: String(publicPage),
    XDG_DATA_HOME: path.join(WORK, "caddy-data"),
    XDG_CONFIG_HOME: path.join(WORK, "caddy-config"),
  });
  await waitFor(async () => (await http("/api/public/videos").catch(() => ({ status: 0 }))).status === (publicPage ? 200 : 404), {
    desc: "Caddy + API prêts",
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------- scénarios navigateur

async function unlock(page, password = CAPTURE_TOKEN) {
  await page.fill("#gate-password", password);
  await page.click("#gate-submit");
}

async function pendingParts(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("safevideoupload-capture");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction("partmeta").objectStore("partmeta").getAll();
          req.onsuccess = () => resolve(req.result.map((m) => ({ idx: m.idx, session: m.session, state: m.state, size: m.size })));
        };
      }),
  );
}

async function serverStatus(sid) {
  const r = await http(`/api/upload/${sid}/status`, { token: CAPTURE_TOKEN });
  return r.json;
}

async function adminSessions() {
  return (await http("/admin/api/sessions", { token: ADMIN_TOKEN })).json.sessions;
}

async function newPage(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("   [console.error]", m.text().slice(0, 200));
  });
  return page;
}

async function selectFormat(page, value) {
  await page.evaluate((v) => {
    document.querySelector(".settings").open = true;
    const sel = document.getElementById("format");
    sel.value = v;
  }, value);
}

async function scenarioOffline(context, { format }) {
  console.log(`\n=== Scénario A : enregistrement + coupure réseau (format ${format}) ===`);
  const page = await newPage(context);
  await page.goto(`${BASE}/capture/`);
  await page.waitForSelector("#gate:not([hidden])");
  const bodyText = await page.textContent("body");
  check("A0 la page n'affiche ni hôte ni port du serveur", !bodyText.includes("localhost") && !bodyText.includes(String(PORT)) && !/\d+\.\d+\.\d+\.\d+/.test(bodyText));
  check("A1 case « se souvenir » décochée par défaut", (await page.isChecked("#gate-remember")) === false);

  await unlock(page, "mauvais-mot-de-passe");
  await page.waitForFunction(() => document.getElementById("gate-error").textContent.includes("incorrect"));
  check("A2 mauvais mot de passe refusé", true);
  await unlock(page);
  await page.waitForSelector("#app:not([hidden])");
  const stored = await page.evaluate(() => ({ s: sessionStorage.getItem("captureToken"), l: localStorage.getItem("captureToken"), url: location.href }));
  check("A3 jeton en sessionStorage seulement, jamais dans l'URL", stored.s === CAPTURE_TOKEN && !stored.l && !stored.url.includes(CAPTURE_TOKEN));

  // Les « Parties » étant de 10 s, le scénario dure RECORD_SECONDS ; la coupure réseau couvre 2 parties.
  await selectFormat(page, format);
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__capture.debug.recording, null, { timeout: 30_000 });
  const t0 = Date.now();
  const sid = await page.evaluate(() => window.__capture.sessionId);
  const size = await page.evaluate(() => window.__capture.canvasSize);
  const dbg = await page.evaluate(() => window.__capture.debug);
  check("A4 canvas 1080x1920 (portrait)", size.width === 1080 && size.height === 1920, `${size.width}x${size.height}, ${dbg.framing}`);
  check("A5 format d'enregistrement", dbg.mime.includes(format === "mp4" ? "mp4" : "webm"), dbg.mime);
  await page.screenshot({ path: path.join(ARTIFACTS, `capture-${format}-recording.png`) });

  // Échecs d'envoi simulés : une coupure franche et une erreur 502 sur la partie 1.
  let injected = 0;
  await page.route("**/api/upload/*/part/1", async (route) => {
    injected += 1;
    if (injected === 1) return route.abort("connectionreset");
    if (injected === 2) return route.fulfill({ status: 502, body: "bad gateway" });
    return route.continue();
  });

  await waitFor(async () => (await page.evaluate(() => window.__capture.debug.uploaded)) >= 1, { timeout: 45_000, desc: "première partie envoyée" });
  const serverAfterFirst = await serverStatus(sid);
  check("A6 envoi continu pendant l'enregistrement (partie 0 reçue)", serverAfterFirst.next_part >= 1, `next_part=${serverAfterFirst.next_part}`);

  await context.setOffline(true);
  const offlineFrom = Date.now();
  await page.waitForFunction(() => document.getElementById("m-net").textContent.includes("HORS LIGNE"));
  const nextAtCut = (await serverStatus(sid).catch(() => serverAfterFirst)).next_part;
  await sleep(24_000);
  const pendOffline = await pendingParts(page);
  const stillRecording = await page.evaluate(() => window.__capture.debug.recording);
  check("A7 hors ligne : l'enregistrement continue et les parties sont gardées sur le téléphone", stillRecording && pendOffline.length >= 2, `${pendOffline.length} parties en attente`);
  const panelOffline = await page.evaluate(() => ({ net: document.getElementById("m-net").textContent, parts: document.getElementById("m-parts").textContent, local: document.getElementById("m-local").textContent, banner: document.getElementById("net-banner").hidden }));
  check("A8 panneau d'état hors ligne", panelOffline.net.includes("HORS LIGNE") && !panelOffline.banner, JSON.stringify(panelOffline));
  await context.setOffline(false);
  const resumeStart = Date.now();
  await waitFor(async () => (await pendingParts(page)).filter((m) => m.state === "pending").length <= 1, { timeout: 90_000, desc: "file d'envoi vidée après retour réseau" });
  check("A9 retour réseau : envoi repris tout seul", true, `${((Date.now() - resumeStart) / 1000).toFixed(0)} s après le retour (nextAtCut=${nextAtCut}, hors ligne ${((resumeStart - offlineFrom) / 1000).toFixed(0)} s)`);
  check("A10 erreurs d'envoi injectées (coupure + 502) rattrapées par les nouveaux essais", injected >= 3, `${injected} tentatives sur la partie 1`);

  const remaining = RECORD_SECONDS * 1000 - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);

  await page.click("#btn-stop");
  await page.waitForSelector("#stop-confirm:not([hidden])");
  check("A11 confirmation avant l'arrêt", true);
  await page.click("#stop-no");
  await sleep(500);
  check("A12 « continuer à filmer » garde l'enregistrement", await page.evaluate(() => window.__capture.debug.recording));
  await page.click("#btn-stop");
  await page.click("#stop-yes");
  await page.waitForFunction(() => !window.__capture.debug.recording);
  const recordedParts = (await page.evaluate(() => window.__capture.debug)).recorded;
  await waitFor(async () => (await pendingParts(page)).length === 0, { timeout: 90_000, desc: "tout envoyé" });
  await waitFor(async () => (await serverStatus(sid)).status === "closed", { timeout: 30_000, desc: "session fermée côté serveur" });
  const finalStatus = await serverStatus(sid);
  check("A13 toutes les parties reçues dans l'ordre, session fermée", finalStatus.next_part === recordedParts && finalStatus.total_parts === recordedParts && finalStatus.pending_parts.length === 0, `${recordedParts} parties`);
  const idbSessions = await page.evaluate(
    () => new Promise((res) => { const o = indexedDB.open("safevideoupload-capture"); o.onsuccess = () => { const q = o.result.transaction("sessions").objectStore("sessions").getAll(); q.onsuccess = () => res(q.result.length); }; }),
  );
  check("A14 téléphone nettoyé après accusé du serveur", idbSessions === 0);
  await page.close();
  return { sid, recordedParts };
}

async function scenarioReload(context) {
  console.log("\n=== Scénario B : rechargement de la page hors ligne, reprise de l'envoi (mp4) ===");
  const page = await newPage(context);
  await page.goto(`${BASE}/capture/`);
  await unlock(page);
  await page.waitForSelector("#app:not([hidden])");
  await selectFormat(page, "mp4");
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__capture.debug.recording, null, { timeout: 30_000 });
  const sid = await page.evaluate(() => window.__capture.sessionId);
  const mime = await page.evaluate(() => window.__capture.debug.mime);
  await waitFor(async () => (await page.evaluate(() => window.__capture.debug.uploaded)) >= 1, { timeout: 45_000, desc: "partie 0 envoyée" });
  await context.setOffline(true);
  await waitFor(async () => (await pendingParts(page)).filter((m) => m.state === "pending").length >= 2, { timeout: 60_000, desc: "2 parties en attente hors ligne" });
  const before = (await pendingParts(page)).filter((m) => m.state === "pending").length;
  await page.reload();
  await page.waitForSelector("#app:not([hidden])", { timeout: 20_000 });
  const reloadedOffline = await page.evaluate(() => document.title);
  check("B1 la page se recharge hors ligne (service worker) et reste déverrouillée", Boolean(reloadedOffline));
  await page.waitForSelector("#resume-banner:not([hidden])", { timeout: 10_000 }).catch(() => {});
  const resumeText = await page.textContent("#resume-text");
  const startLabel = await page.textContent("#btn-start");
  check("B2 bandeau de reprise + proposition d'un nouvel enregistrement dans la même série", /partie/.test(resumeText) && /même série/.test(startLabel), `${resumeText.slice(0, 60)}… / « ${startLabel} »`);
  const afterReload = (await pendingParts(page)).filter((m) => m.state === "pending").length;
  check("B3 les parties non envoyées ont survécu au rechargement", afterReload >= before, `${afterReload} (avant : ${before})`);
  await context.setOffline(false);
  await waitFor(async () => (await pendingParts(page)).length === 0, { timeout: 90_000, desc: "envoi repris après rechargement" });
  await waitFor(async () => (await serverStatus(sid)).status === "closed", { timeout: 30_000, desc: "session fermée automatiquement" });
  const st = await serverStatus(sid);
  check("B4 envoi repris après rechargement, session fermée côté serveur", st.status === "closed" && st.next_part === st.total_parts, `${st.next_part} parties, ${mime}`);

  // Nouvel enregistrement dans la même série (même groupe), depuis la même page.
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__capture.debug.recording, null, { timeout: 30_000 });
  const sid2 = await page.evaluate(() => window.__capture.sessionId);
  await waitFor(async () => (await page.evaluate(() => window.__capture.debug.uploaded)) >= 1, { timeout: 45_000, desc: "partie envoyée du nouvel enregistrement" });
  await page.click("#btn-stop");
  await page.click("#stop-yes");
  await waitFor(async () => (await pendingParts(page)).length === 0, { timeout: 60_000, desc: "tout envoyé" });
  check("B5 nouvel enregistrement lancé après rechargement", sid2 !== sid);
  await page.close();
  return { sid, sid2 };
}

async function scenarioAlerts(context) {
  console.log("\n=== Scénario C : alertes (page masquée, piste coupée) ===");
  const page = await newPage(context);
  await page.goto(`${BASE}/capture/`);
  await unlock(page);
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__capture.debug.recording, null, { timeout: 30_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(1500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForSelector("#alert-banner:not([hidden])", { timeout: 5000 });
  const text1 = await page.textContent("#alert-text");
  check("C1 alerte visuelle quand la page a été masquée", /masquée/.test(text1), text1.slice(0, 80));
  await page.click("#alert-dismiss");
  check("C2 l'alerte se ferme", await page.evaluate(() => document.getElementById("alert-banner").hidden));
  const before = (await page.evaluate(() => window.__capture.debug)).restarts;
  const sidBefore = await page.evaluate(() => window.__capture.sessionId);
  await page.evaluate(() => {
    const stream = document.getElementById("camera").srcObject;
    stream.getVideoTracks()[0].stop();
    stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
  });
  await page.waitForSelector("#alert-banner:not([hidden])", { timeout: 8000 });
  const text2 = await page.textContent("#alert-text");
  check("C3 alerte forte quand la caméra s'arrête", /INTERROMPU|caméra/i.test(text2), text2.slice(0, 90));
  await waitFor(async () => (await page.evaluate(() => window.__capture.debug.restarts)) > before && (await page.evaluate(() => window.__capture.debug.recording)), { timeout: 20_000, desc: "reprise automatique" });
  const sidAfter = await page.evaluate(() => window.__capture.sessionId);
  check("C4 reprise automatique dans une nouvelle session", sidAfter && sidAfter !== sidBefore);
  await page.click("#alert-dismiss");
  await page.click("#btn-stop");
  await page.click("#stop-yes");
  await waitFor(async () => (await pendingParts(page)).length === 0, { timeout: 60_000, desc: "tout envoyé" });
  await page.close();
}

// ---------------------------------------------------------------- vérifications serveur

async function verifyServer({ sid, recordedParts }) {
  console.log("\n=== Vérifications serveur (session A) ===");
  const rawDir = path.join(STORAGE, "raw", sid);
  const rawFile = fs.readdirSync(rawDir).find((f) => f.startsWith("stream."));
  const rawPath = path.join(rawDir, rawFile);
  const rawInfo = probe(rawPath);
  const gap = maxPacketGap(rawPath);
  // Le webm de MediaRecorder n'annonce pas de durée : on la déduit des horodatages d'images.
  rawInfo.duration = gap.span + 1 / 30;
  const audioSpan = maxPacketGap(rawPath, "a:0").span;
  // Chromium sans GPU, en concurrence avec le floutage sur la même machine, perd des images vidéo (pas de l'audio) :
  // la durée « réelle » de l'enregistrement est donc celle de la piste la plus longue.
  rawInfo.fullDuration = Math.max(rawInfo.duration, audioSpan + 0.05);
  console.log(`   (flux brut : vidéo ${gap.span.toFixed(2)} s, audio ${audioSpan.toFixed(2)} s)`);
  check("S1 flux brut recollé lisible", rawInfo.width > 0 && rawInfo.duration > RECORD_SECONDS * 0.8, `${rawFile} ${rawInfo.width}x${rawInfo.height} ${rawInfo.duration.toFixed(1)} s, ${recordedParts} parties`);
  check("S2 aucun trou dans le flux (plus grand écart entre images)", gap.maxGap < 1.0, `${gap.frames} images, écart max ${(gap.maxGap * 1000).toFixed(0)} ms (encodeur VP8 logiciel sur CPU partagé : quelques images perdues tolérées, jamais de trou de plusieurs secondes)`);

  const gps = JSON.parse(fs.readFileSync(path.join(rawDir, "gps.json"), "utf8"));
  const lats = new Set(gps.samples.map((s) => s.lat));
  check("S3 trace GPS JSON jointe à la session", gps.samples.length >= RECORD_SECONDS * 0.7 && lats.has(GEO.latitude), `${gps.samples.length} échantillons ≈ 1/s`);
  const gaps = gps.samples.slice(1).map((s, i) => s.t - gps.samples[i].t);
  check("S4 échantillons GPS ordonnés dans le temps", gaps.every((g) => g >= 0) && Math.max(...gaps) < 5000, `écart max ${Math.max(...gaps)} ms`);

  console.log("   … attente du floutage (deface)");
  const started = Date.now();
  const done = await waitFor(
    async () => {
      const s = (await adminSessions()).find((x) => x.id === sid);
      return s && s.status === "closed" && s.seg_state === "done" && s.segments.length > 0 && s.segments.every((g) => g.status === "blurred") && s.assembled ? s : null;
    },
    { timeout: 600_000, interval: 2000, desc: "segments floutés" },
  );
  const elapsed = (Date.now() - started) / 1000;
  check("S5 segments floutés dans l'ordre", done.segments.length >= Math.max(2, Math.floor(rawInfo.fullDuration / SEGMENT_SECONDS)), `${done.segments.length} segments : ${done.segments.map((g) => `${g.duration}s`).join(", ")}`);
  const status = (await http("/admin/api/status", { token: ADMIN_TOKEN })).json;
  check("S6 admin : disque, file de traitement et rapport temps réel", status.disk.free > 0 && status.queue.segments.blurred >= done.segments.length && status.processor.alive, `libre ${status.disk.free_percent} %, x${(status.processor.avg_ratio || 0).toFixed(2)} temps réel, file ${status.processor.backlog}`);

  const blurDir = path.join(STORAGE, "blurred", sid);
  let total = 0;
  const infos = done.segments.map((g) => {
    const info = probe(path.join(blurDir, `seg_${String(g.idx).padStart(5, "0")}.mp4`));
    total += info.duration;
    return info;
  });
  check("S7 sorties 1080x1920 H.264 + AAC", infos.every((i) => i.width === 1080 && i.height === 1920 && i.vcodec === "h264" && i.acodec === "aac"), infos.map((i) => `${i.width}x${i.height}/${i.vcodec}/${i.acodec}`).slice(0, 1).join());
  check("S8 durées cumulées = durée du flux brut (aucune perte)", Math.abs(total - rawInfo.fullDuration) < 0.6, `flouté ${total.toFixed(2)} s / brut ${rawInfo.fullDuration.toFixed(2)} s`);
  const assembled = probe(path.join(blurDir, "session.mp4"));
  check("S9 MP4 de session assemblé", Math.abs(assembled.duration - total) < 0.6 && assembled.width === 1080, `${assembled.duration.toFixed(1)} s`);
  check("S10 fichier brut privé hors des chemins publics", fs.existsSync(rawPath) && !fs.existsSync(path.join(blurDir, rawFile)));
  console.log(`   (floutage terminé ${elapsed.toFixed(0)} s après la fin de l'envoi)`);

  const first = path.join(blurDir, "seg_00000.mp4");
  const ocr = ocrOverlay(first, 3, `overlay-${sid.slice(0, 6)}`);
  const hasCoords = /48[.,]8584/.test(ocr.text) && /2[.,]2945/.test(ocr.text);
  const hasDate = /\d{2}\/\d{2}\/20\d{2}/.test(ocr.text) && /\d{2}:\d{2}:\d{2}/.test(ocr.text);
  check("S11 incrustation gravée dans l'image (OCR image extraite du flouté)", ocr.ok && hasCoords && hasDate && /12/.test(ocr.text), `« ${ocr.text.slice(0, 110)} »`);
  return { done, total, rawInfo };
}

async function verifyPublic(browser, doneSessions) {
  console.log("\n=== Page publique ===");
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await newPage(ctx);
  await page.goto(`${BASE}/`);
  const expected = (await http("/api/public/videos")).json.videos;
  await page.waitForSelector(".item", { timeout: 15_000 });
  const starts = await page.$$eval(".item", (els) => els.map((e) => Number(e.dataset.start)));
  check("P1 page publique sans mot de passe, vidéos triées par horodatage", starts.length === expected.length && starts.every((s, i) => i === 0 || s >= starts[i - 1]), `${starts.length} vidéos`);
  const noindex = (await http("/")).headers.get("x-robots-tag");
  const meta = await page.getAttribute('meta[name="robots"]', "content");
  check("P2 noindex (meta + X-Robots-Tag)", /noindex/.test(meta) && /noindex/.test(noindex || ""));
  const groups = await page.$$eval("h2.day", (els) => els.map((e) => e.textContent));
  const hours = await page.$$eval("h3.hour", (els) => els.map((e) => e.textContent));
  check("P3 regroupé par date puis par heure", groups.length >= 1 && hours.length >= 1, `${groups.join(" | ")} / ${hours.join(", ")}`);
  const labelOk = await page.$$eval(".item", (els) => els.every((e) => /\d{2}:\d{2}:\d{2}/.test(e.querySelector(".t").textContent) && /\d/.test(e.querySelector(".d").textContent)));
  check("P4 chaque vidéo affiche heure de début et durée", labelOk);

  await page.click(".item >> nth=0");
  await page.waitForFunction(() => { const v = document.getElementById("player"); return v.currentTime > 0.8 && !v.paused; }, null, { timeout: 20_000 });
  const playing = await page.evaluate(() => { const v = document.getElementById("player"); return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime }; });
  check("P5 lecture de la première vidéo (MP4 progressif)", playing.w === 1080 && playing.h === 1920, `${playing.w}x${playing.h} t=${playing.t.toFixed(1)}`);
  await page.screenshot({ path: path.join(ARTIFACTS, "public-page.png") });

  const firstSrc = await page.evaluate(() => document.getElementById("player").src);
  await page.evaluate(() => { const v = document.getElementById("player"); v.currentTime = Math.max(0, v.duration - 1.2); });
  await page.waitForFunction((src) => document.getElementById("player").src !== src, firstSrc, { timeout: 20_000 });
  const second = await page.evaluate(() => document.querySelector('.item[aria-current="true"]').dataset.start);
  check("P6 lecture continue : enchaîne sur la vidéo suivante", Number(second) === starts[1], `début suivant ${new Date(Number(second)).toISOString()}`);

  const url = expected[0].url;
  const range = await fetch(BASE + url, { headers: { Range: "bytes=0-99" } });
  check("P7 HTTP Range servi (206 + Content-Range)", range.status === 206 && /bytes 0-99\//.test(range.headers.get("content-range") || ""), `${range.status}`);
  const sid = url.split("/")[2];
  const probes = {
    raw: (await http(`/media/${sid}/stream.webm`)).status,
    gps: (await http(`/media/${sid}/gps.json`)).status,
    traversal: (await http(`/media/..%2Fraw/${sid}/gps.json`)).status,
    rawDownload: (await http(`/storage-download/raw/${sid}/gps.json`)).status,
    api: (await http("/api/upload/session", { method: "POST", body: "{}" })).status,
    adminNoToken: (await http("/admin/api/sessions")).status,
  };
  check("P8 brut, GPS JSON et API privés introuvables ou 401 sans jeton", probes.raw === 404 && probes.gps === 404 && probes.traversal !== 200 && probes.rawDownload === 401 && probes.api === 401 && probes.adminNoToken === 401, JSON.stringify(probes));
  const pubJson = JSON.stringify(expected);
  check("P9 la liste publique n'expose ni GPS ni fichier brut", !/gps|raw|stream\./i.test(pubJson));
  await ctx.close();
}

async function verifyPublicDisabled() {
  console.log("\n=== PUBLIC_PAGE_ENABLED=false ===");
  const sessions = await adminSessions();
  const sid = sessions[0].id;
  caddyChild.kill("SIGTERM");
  await sleep(1000);
  const api = children.find((c) => c.name === "api");
  api.child.kill("SIGTERM");
  await sleep(500);
  startService("api2", PYTHON, [path.join(ROOT, "services/api/server.py")], { STORAGE_DIR: STORAGE, PUBLIC_PAGE_ENABLED: "false", API_PORT: String(API_PORT), API_BIND: "127.0.0.1", MIN_FREE_GB: "0" });
  await startCaddy(false);
  const r = {
    root: (await http("/")).status,
    videos: (await http("/videos/")).status,
    api: (await http("/api/public/videos")).status,
    media: (await http(`/media/${sid}/seg_00000.mp4`)).status,
    capture: (await http("/capture/")).status,
  };
  check("P10 flag PUBLIC_PAGE_ENABLED=false : accueil, liste et médias en 404, capture intacte", r.root === 404 && r.api === 404 && r.media === 404 && r.capture === 200, JSON.stringify(r));
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Espace de travail : ${WORK}\nSegments ${SEGMENT_SECONDS} s, enregistrement ${RECORD_SECONDS} s`);
  await startStack();
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "microphone", "geolocation"],
    geolocation: GEO,
  });
  let exitCode = 0;
  try {
    const a = await scenarioOffline(context, { format: "webm" });
    const b = await scenarioReload(context);
    await scenarioAlerts(context);
    const server = await verifyServer(a);
    console.log("\n=== Session B (mp4, rechargement) ===");
    const sB = await waitFor(async () => (await adminSessions()).find((x) => x.id === b.sid && x.seg_state === "done" && x.segments.length && x.segments.every((g) => g.status === "blurred")), { timeout: 300_000, interval: 2000, desc: "floutage session mp4" });
    const rawB = fs.readdirSync(path.join(STORAGE, "raw", b.sid)).find((f) => f.startsWith("stream."));
    const infoB = probe(path.join(STORAGE, "blurred", b.sid, "seg_00000.mp4"));
    check("B6 le chemin mp4 (Chromium) est reçu, découpé et flouté", rawB.endsWith(".mp4") && infoB.width === 1080 && infoB.height === 1920 && infoB.acodec === "aac", `${rawB} → ${infoB.width}x${infoB.height}, ${sB.segments.length} segment(s)`);
    await verifyPublic(browser, [a.sid, b.sid]);
    await verifyPublicDisabled();
    void server;
  } catch (err) {
    console.error("\nERREUR :", err);
    check("exécution du scénario", false, err.message);
  } finally {
    await browser.close();
    stopAll();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies. Journaux : ${WORK}`);
  fs.writeFileSync(path.join(ARTIFACTS, "results.json"), JSON.stringify(results, null, 2));
  for (const f of failed) console.log(`  ECHEC : ${f.name} — ${f.detail}`);
  process.exit(failed.length || exitCode ? 1 : 0);
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});
main();
