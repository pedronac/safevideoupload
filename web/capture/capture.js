/**
 * Capture mobile hors-ligne : caméra -> canvas (cadrage + incrustation GPS/heure) -> MediaRecorder.
 *
 * Un enregistrement = UNE session MediaRecorder continue (jamais redémarrée, donc aucune image perdue),
 * livrée en parties de ~10 s (timeslice). Chaque partie est stockée dans IndexedDB puis envoyée dès que
 * le réseau le permet ; elle n'est effacée du téléphone qu'après l'accusé de réception du serveur.
 *
 * Accès : mot de passe vérifié côté serveur (POST /capture-auth, en-tête Authorization: Bearer).
 * Le secret n'apparaît jamais dans une URL.
 */

import {
  AUDIO_BITRATE,
  PART_SECONDS,
  QUALITY_LEVELS,
  TARGET_FPS,
  coverRect,
  formatClock,
  formatMB,
  gpsSample,
  isChromiumEngine,
  orientationOf,
  outputSize,
  overlayLines,
  pickMimeType,
  randomId,
  storageLevel,
} from "./lib.js";
import * as store from "./store.js";
import { Uploader } from "./uploader.js";
import { ScreenKeeper } from "./nosleep.js";

const $ = (id) => document.getElementById(id);

const gate = $("gate");
const gateForm = $("gate-form");
const gatePassword = $("gate-password");
const gateRemember = $("gate-remember");
const gateSubmit = $("gate-submit");
const gateError = $("gate-error");
const gatePending = $("gate-pending");
const app = $("app");

const camera = $("camera");
const canvas = $("overlay-canvas");
const ctx = canvas.getContext("2d");
const previewFrame = $("preview-frame");
const previewPlaceholder = $("preview-placeholder");
const recBadge = $("rec-badge");
const recBadgeTime = $("rec-badge-time");
const statusEl = $("status");
const orientationSelect = $("orientation");
const formatSelect = $("format");
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const stopConfirm = $("stop-confirm");
const btnDownload = $("btn-download");
const btnLock = $("btn-lock");
const netError = $("net-error");
const alertBanner = $("alert-banner");
const alertText = $("alert-text");
const resumeBanner = $("resume-banner");
const resumeText = $("resume-text");
const storageBanner = $("storage-banner");
const netBanner = $("net-banner");
const netBannerText = $("net-banner-text");
const reauthForm = $("reauth-form");
const reauthPassword = $("reauth-password");

const TOKEN_KEY = "captureToken";
const ORIENTATION_KEY = "captureOrientation";
const FORMAT_KEY = "captureFormat";
const GROUP_KEY = "captureGroup";
const BASE_TITLE = document.title;
const STALL_MS = PART_SECONDS * 1000 * 2.5 + 5000;

const debugState = { alerts: [], recorded: 0, mime: "", quality: "", restarts: 0, framing: "" };

// ---------------------------------------------------------------- accès (mot de passe)

function storedToken() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

function storeToken(token, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

/** @returns {"ok" | "denied" | "error" | "invalid"} */
async function verifyToken(token) {
  if (!/^[\x20-\x7e]+$/.test(token)) return "invalid";
  try {
    const response = await fetch("/capture-auth", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (response.status === 204) return "ok";
    if (response.status === 401) return "denied";
    return "error";
  } catch {
    return "error";
  }
}

async function pendingSummary() {
  try {
    const metas = (await store.listPartMeta()).filter((m) => m.state === "pending");
    return { count: metas.length, bytes: metas.reduce((a, m) => a + m.size, 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

async function showGate(message = "") {
  app.hidden = true;
  gate.hidden = false;
  gateError.textContent = message;
  gatePassword.value = "";
  const pending = await pendingSummary();
  gatePending.hidden = pending.count === 0;
  if (pending.count) {
    gatePending.textContent =
      `${pending.count} partie(s) vidéo (${formatMB(pending.bytes)}) attendent d’être envoyées depuis ce téléphone. ` +
      "Saisissez le mot de passe pour reprendre l’envoi.";
  }
}

function unlock() {
  gate.hidden = true;
  app.hidden = false;
  gateError.textContent = "";
  setStatus("Prêt");
  startUploader();
  resumeCheck();
}

async function lockPage(message = "") {
  if (rec) await stopRecording({ lock: true });
  clearToken();
  await showGate(message);
}

gateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = gatePassword.value.trim();
  if (!password) return;
  gateSubmit.disabled = true;
  gateError.textContent = "Vérification…";
  const result = await verifyToken(password);
  gateSubmit.disabled = false;
  if (result === "ok") {
    storeToken(password, gateRemember.checked);
    uploader.rejectedToken = null;
    unlock();
  } else if (result === "denied") {
    gateError.textContent = "Mot de passe incorrect.";
    gatePassword.select();
  } else if (result === "invalid") {
    gateError.textContent = "Ce mot de passe contient des caractères non pris en charge.";
  } else {
    gateError.textContent = "Impossible de joindre le serveur. Réessayez.";
  }
});

btnLock.addEventListener("click", () => lockPage());

async function bootGate() {
  const token = storedToken();
  if (!token) {
    await showGate();
    return;
  }
  const result = await verifyToken(token);
  if (result === "ok") {
    unlock();
  } else if (result === "denied" || result === "invalid") {
    clearToken();
    await showGate("Mot de passe expiré ou modifié. Saisissez-le à nouveau.");
  } else {
    // Pas de réseau au chargement : on garde le mot de passe mémorisé pour pouvoir filmer quand même.
    unlock();
    setStatus("Prêt — hors ligne (mot de passe non vérifié)");
  }
}

// ---------------------------------------------------------------- état

let rec = null;
let uploaderStarted = false;
let gpsWatchId = null;
let gpsSamplerTimer = null;
let lastPosition = null;
let lastPositionAt = 0;
let gpsState = "off";
let drawTimer = null;
let statsTimer = null;
let watchdogTimer = null;
let audioCtx = null;
let alarmTimer = null;
let hiddenAt = 0;
let restartTimes = [];
let lastStats = { pendingParts: 0, pendingBytes: 0, failedParts: 0, estimate: null };
let uploaderState = null;
let screenMode = "none";

const screenKeeper = new ScreenKeeper({
  onChange: (mode, active) => {
    screenMode = active ? mode : "none";
    if (!active && rec) {
      raiseAlert("L’écran risque de s’éteindre : touchez l’écran et gardez la page au premier plan.", { beep: false });
    }
  },
});

function setStatus(message) {
  statusEl.textContent = message;
}

function setNetError(message) {
  netError.textContent = message || "";
}

// ---------------------------------------------------------------- alertes (visuel + bip + vibration)

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beepOnce() {
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    for (let i = 0; i < 3; i += 1) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = i % 2 ? 660 : 990;
      gain.gain.setValueAtTime(0.0001, now + i * 0.22);
      gain.gain.exponentialRampToValueAtTime(0.6, now + i * 0.22 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.22);
      osc.stop(now + i * 0.22 + 0.2);
    }
  } catch {
    /* audio indisponible */
  }
}

function raiseAlert(message, { beep = true } = {}) {
  debugState.alerts.push(message);
  alertText.textContent = message;
  alertBanner.hidden = false;
  document.title = `⚠ ${BASE_TITLE}`;
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (beep) {
    clearInterval(alarmTimer);
    beepOnce();
    alarmTimer = setInterval(() => {
      beepOnce();
      navigator.vibrate?.([250, 120, 250]);
    }, 2500);
  }
}

function dismissAlert() {
  clearInterval(alarmTimer);
  alarmTimer = null;
  alertBanner.hidden = true;
  document.title = BASE_TITLE;
}

$("alert-dismiss").addEventListener("click", dismissAlert);

// ---------------------------------------------------------------- GPS

function startGeolocation() {
  if (!navigator.geolocation) {
    gpsState = "unavailable";
    return;
  }
  if (gpsWatchId == null) {
    gpsState = "waiting";
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastPosition = pos;
        lastPositionAt = Date.now();
        gpsState = "ok";
      },
      (err) => {
        gpsState = err.code === 1 ? "denied" : "error";
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  }
  clearInterval(gpsSamplerTimer);
  gpsSamplerTimer = setInterval(() => {
    if (rec && lastPosition) rec.gpsBuffer.push(gpsSample(lastPosition));
  }, 1000);
}

function stopGeolocation() {
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  clearInterval(gpsSamplerTimer);
  gpsSamplerTimer = null;
  gpsState = "off";
}

function describeGps() {
  if (gpsState === "denied") return ["Permission GPS refusée", "bad"];
  if (gpsState === "unavailable") return ["GPS indisponible", "bad"];
  if (gpsState === "off") return ["—", ""];
  if (!lastPosition) return ["Recherche du signal…", ""];
  const age = Math.round((Date.now() - lastPositionAt) / 1000);
  const acc = Math.round(lastPosition.coords.accuracy);
  const stale = age > 30 ? ` · dernier point il y a ${age} s` : "";
  return [`±${acc} m${stale}`, age > 60 ? "bad" : "good"];
}

// ---------------------------------------------------------------- orientation / caméra

function desiredOrientation() {
  const mode = orientationSelect.value;
  if (mode === "portrait" || mode === "landscape") return mode;
  return window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";
}

function setPreviewAspect(width, height) {
  previewFrame.style.setProperty("--ar", String(width / height));
  previewFrame.style.aspectRatio = `${width} / ${height}`;
}

function videoConstraints(width, height, { ratio = false, exact = false } = {}) {
  const video = {
    facingMode: { ideal: "environment" },
    width: exact ? { exact: width } : { ideal: width },
    height: exact ? { exact: height } : { ideal: height },
    frameRate: { ideal: TARGET_FPS },
  };
  if (ratio) video.aspectRatio = { ideal: width / height };
  return video;
}

function waitForVideoSize(videoEl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        resolve({ width: videoEl.videoWidth, height: videoEl.videoHeight });
      } else if (Date.now() - started > timeoutMs) {
        resolve(null);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

/** Dimensions réelles livrées par la piste (élément vidéo d'abord, getSettings en secours). */
async function measureTrack(track) {
  camera.srcObject = new MediaStream([track]);
  await camera.play().catch(() => {});
  const fromElement = await waitForVideoSize(camera);
  const settings = track.getSettings();
  console.debug("[capture] piste vidéo", { settings, element: fromElement });
  if (fromElement) return fromElement;
  if (settings.width && settings.height) return { width: settings.width, height: settings.height };
  throw new Error("Impossible de lire la taille de l’image de la caméra.");
}

const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };

/**
 * Ouvre la caméra à la taille demandée (portrait : largeur 1080 / hauteur 1920) puis, si l'orientation
 * livrée ne correspond pas, redemande avec largeur/hauteur échangées. Si la caméra s'obstine, on garde ses
 * images : le dessin les recadre au centre (« cover »), sans jamais les étirer.
 */
async function acquireCamera(wanted, quality) {
  const size0 = outputSize(wanted, quality);
  let first;
  let micMissing = false;
  try {
    first = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: videoConstraints(size0.width, size0.height),
    });
  } catch (err) {
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") throw err;
    first = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(size0.width, size0.height),
    });
    micMissing = true;
  }

  const audioTrack = first.getAudioTracks()[0] || null;
  let videoTrack = first.getVideoTracks()[0];
  let size = await measureTrack(videoTrack);

  if (orientationOf(size.width, size.height) !== wanted) {
    for (const constraints of [
      videoConstraints(size0.width, size0.height, { ratio: true }),
      videoConstraints(size0.width, size0.height, { exact: true }),
    ]) {
      videoTrack.stop();
      try {
        const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
        videoTrack = next.getVideoTracks()[0];
      } catch (err) {
        console.debug("[capture] contrainte refusée", err?.name);
        const back = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints(size0.width, size0.height),
        });
        videoTrack = back.getVideoTracks()[0];
      }
      size = await measureTrack(videoTrack);
      if (orientationOf(size.width, size.height) === wanted) break;
    }
  }

  const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
  return { stream: new MediaStream(tracks), size, micMissing };
}

// ---------------------------------------------------------------- dessin (canvas)

let framesDrawn = 0;
let lastInfoSecond = 0;

function drawFrame() {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = camera.videoWidth;
  const vh = camera.videoHeight;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  if (vw > 0 && vh > 0) {
    const { sx, sy, sw, sh } = coverRect(vw, vh, cw, ch);
    ctx.drawImage(camera, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  const unit = Math.min(cw, ch);
  const fontPx = Math.max(18, Math.round(unit * 0.036));
  const pad = Math.round(fontPx * 0.5);
  const margin = Math.round(unit * 0.025);
  const lines = overlayLines(new Date(), lastPosition);
  ctx.font = `700 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = "alphabetic";
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const lineH = Math.round(fontPx * 1.3);
  const boxW = Math.min(cw - 2 * margin, Math.ceil(textWidth + 2 * pad));
  const boxH = lines.length * lineH + pad;
  const boxX = margin;
  const boxY = ch - margin - boxH;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#fff";
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + pad, boxY + pad * 0.5 + fontPx + i * lineH, boxW - 2 * pad);
  });
  framesDrawn += 1;

  const second = Math.floor(Date.now() / 1000);
  if (second !== lastInfoSecond) {
    lastInfoSecond = second;
    $("m-clock").textContent = lines[0];
  }
}

// ---------------------------------------------------------------- enregistrement

function cameraErrorMessage(err) {
  if (err?.name === "NotAllowedError") {
    return "Accès caméra/micro refusé : autorisez-le dans les réglages du navigateur.";
  }
  if (err?.name === "NotFoundError") return "Aucune caméra détectée.";
  if (err?.name === "NotReadableError") return "La caméra est utilisée par une autre application.";
  return err?.message || String(err);
}

function currentGroup() {
  let group = localStorage.getItem(GROUP_KEY);
  if (!group || !/^[a-f0-9]{32}$/.test(group)) {
    group = randomId();
    localStorage.setItem(GROUP_KEY, group);
  }
  return group;
}

async function persistPart(r, idx, blob, samples) {
  const meta = {
    session: r.id,
    idx,
    size: blob.size,
    sha256: null,
    gps: samples,
    gpsSent: false,
    t1: Date.now(),
    state: "pending",
  };
  for (;;) {
    try {
      await store.putPart(meta, blob);
      break;
    } catch (err) {
      console.error("[capture] écriture locale", err);
      raiseAlert("Impossible d’écrire sur le téléphone (stockage plein ?). Libérez de la place.");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  debugState.recorded += 1;
  uploader.kick();
}

function onRecorderData(r, ev) {
  r.lastDataAt = performance.now();
  if (!ev.data || ev.data.size === 0) return;
  const idx = r.partIdx++;
  const samples = r.gpsBuffer.splice(0);
  r.chain = r.chain.then(() => persistPart(r, idx, ev.data, samples));
}

async function openRecording(quality, wanted) {
  const { stream, size, micMissing } = await acquireCamera(wanted, quality);
  let composed = null;
  try {
    return await prepareRecording(quality, wanted, stream, size, micMissing, (c) => {
      composed = c;
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    composed?.getTracks().forEach((t) => t.stop());
    throw err;
  }
}

async function prepareRecording(quality, wanted, stream, size, micMissing, onComposed) {
  const out = outputSize(wanted, quality);
  canvas.width = out.width;
  canvas.height = out.height;
  setPreviewAspect(out.width, out.height);
  previewPlaceholder.hidden = true;
  camera.srcObject = new MediaStream(stream.getVideoTracks());
  await camera.play().catch(() => {});
  framesDrawn = 0;
  drawFrame();
  drawTimer = window.setInterval(drawFrame, 1000 / TARGET_FPS);

  const canvasStream = canvas.captureStream(TARGET_FPS);
  const composed = new MediaStream([...canvasStream.getVideoTracks(), ...stream.getAudioTracks()]);
  onComposed(composed);
  const preference = formatSelect.value || "auto";
  const mimeInfo = pickMimeType((m) => MediaRecorder.isTypeSupported(m), {
    preference,
    chromium: isChromiumEngine(navigator),
  });
  if (!mimeInfo) throw new Error("Ce navigateur ne sait pas enregistrer de vidéo (MediaRecorder).");

  const r = {
    id: randomId(),
    group: currentGroup(),
    mimeInfo,
    quality,
    cameraStream: stream,
    composed,
    recorder: null,
    startedPerf: performance.now(),
    startedAt: Date.now(),
    partIdx: 0,
    lastDataAt: performance.now(),
    gpsBuffer: [],
    chain: Promise.resolve(),
    stopped: null,
    markStopped: () => {},
    stopRequested: false,
    dead: false,
    micMissing,
    framing: `Caméra ${size.width}×${size.height} → ${out.width}×${out.height}`,
  };

  await store.putSession({
    id: r.id,
    group: r.group,
    startedAt: r.startedAt,
    mime: mimeInfo.mime,
    ext: mimeInfo.ext,
    width: out.width,
    height: out.height,
    device: navigator.userAgent.slice(0, 180),
    registered: false,
    closed: false,
    nextIdx: 0,
  });

  const recorder = new MediaRecorder(composed, {
    mimeType: mimeInfo.mime,
    videoBitsPerSecond: quality.videoBitrate,
    audioBitsPerSecond: AUDIO_BITRATE,
  });
  r.recorder = recorder;
  r.stopped = new Promise((resolve) => {
    r.markStopped = resolve;
  });
  recorder.ondataavailable = (ev) => onRecorderData(r, ev);
  recorder.onerror = (ev) => handleRecorderFailure(r, `erreur du enregistreur (${ev?.error?.name || "inconnue"})`);
  recorder.onstop = () => {
    r.markStopped();
    onRecorderStopped(r);
  };
  for (const track of composed.getTracks()) {
    track.addEventListener("ended", () => {
      if (!r.stopRequested) handleRecorderFailure(r, `la piste ${track.kind === "video" ? "vidéo" : "audio"} s’est arrêtée`);
    });
  }
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      if (!r.stopRequested) handleRecorderFailure(r, `la ${track.kind === "video" ? "caméra" : "micro"} s’est coupé`);
    });
  }
  recorder.start(PART_SECONDS * 1000);
  return r;
}

async function startRecording({ automatic = false } = {}) {
  if (rec) return;
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    setStatus("Ce navigateur ne peut pas filmer (MediaRecorder / caméra indisponibles).");
    return;
  }
  if (!storedToken()) {
    await lockPage("Saisissez le mot de passe.");
    return;
  }
  if (!automatic) dismissAlert();
  btnStart.disabled = true;
  orientationSelect.disabled = true;
  formatSelect.disabled = true;
  localStorage.setItem(ORIENTATION_KEY, orientationSelect.value);
  localStorage.setItem(FORMAT_KEY, formatSelect.value);
  setNetError("");
  setStatus("Accès caméra…");
  ensureAudio();
  navigator.storage?.persist?.().catch(() => {});
  await screenKeeper.enable();
  startGeolocation();

  const wanted = desiredOrientation();
  let opened = null;
  let lastError = null;
  for (const quality of QUALITY_LEVELS) {
    try {
      opened = await openRecording(quality, wanted);
      break;
    } catch (err) {
      lastError = err;
      console.error("[capture] ouverture", quality.name, err);
      cleanupMedia();
      if (err?.name === "NotAllowedError" || err?.name === "NotFoundError" || err?.name === "NotReadableError") break;
    }
  }
  if (!opened) {
    await screenKeeper.disable();
    stopGeolocation();
    btnStart.disabled = false;
    orientationSelect.disabled = false;
    formatSelect.disabled = false;
    previewPlaceholder.hidden = false;
    setStatus(cameraErrorMessage(lastError));
    return;
  }
  rec = opened;
  debugState.mime = rec.mimeInfo.mime;
  debugState.quality = rec.quality.name;
  debugState.framing = rec.framing;
  btnStop.hidden = false;
  btnStart.hidden = true;
  recBadge.hidden = false;
  const bitrate = (rec.quality.videoBitrate / 1e6).toFixed(0);
  $("m-format").textContent = `${rec.mimeInfo.ext.toUpperCase()} · ${canvas.width}×${canvas.height} · ${bitrate} Mbit/s · parties de ${PART_SECONDS} s`;
  if (rec.micMissing) setNetError("Micro indisponible : la vidéo sera sans son.");
  if (rec.quality !== QUALITY_LEVELS[0]) {
    raiseAlert("Ce téléphone n’a pas pu démarrer en 1080p : enregistrement en 720p.", { beep: false });
  }
  setStatus("● Enregistrement en cours");
  startTimers();
  uploader.kick(true);
}

function startTimers() {
  clearInterval(statsTimer);
  clearInterval(watchdogTimer);
  statsTimer = setInterval(refreshUi, 1000);
  watchdogTimer = setInterval(watchdog, 2000);
  window.addEventListener("beforeunload", beforeUnload);
}

function beforeUnload(event) {
  if (rec) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function cleanupMedia() {
  clearInterval(drawTimer);
  drawTimer = null;
  const stop = (stream) => stream?.getTracks().forEach((t) => t.stop());
  stop(rec?.composed);
  stop(rec?.cameraStream);
  camera.srcObject?.getTracks?.().forEach((t) => t.stop());
  camera.srcObject = null;
}

function onRecorderStopped(r) {
  if (!r.stopRequested) handleRecorderFailure(r, "l’enregistreur s’est arrêté tout seul");
}

async function finishSession(r) {
  if (r.finished) return;
  r.finished = true;
  await store.updateSession(r.id, { closed: true });
  uploader.kick(true);
}

/** Attend la dernière partie (événement « stop » du MediaRecorder) puis l'écriture locale. */
async function drainRecorder(r) {
  if (r.recorder.state !== "inactive") {
    try {
      r.recorder.stop();
    } catch {
      /* déjà arrêté */
    }
  }
  setStatus("Finalisation de l’enregistrement…");
  await Promise.race([r.stopped, new Promise((resolve) => setTimeout(resolve, 120_000))]);
  await r.chain.catch(() => {});
  await finishSession(r);
}

/** Arrêt volontaire (bouton, confirmé) ou verrouillage de la page. */
async function stopRecording({ lock = false } = {}) {
  const r = rec;
  if (!r) return;
  r.stopRequested = true;
  stopConfirm.hidden = true;
  btnStop.disabled = true;
  await drainRecorder(r);
  teardownRecording(r);
  setStatus(lock ? "Verrouillé" : "Arrêté — l’envoi se poursuit");
}

function teardownRecording(r) {
  cleanupMedia();
  rec = null;
  clearInterval(statsTimer);
  clearInterval(watchdogTimer);
  window.removeEventListener("beforeunload", beforeUnload);
  stopGeolocation();
  screenKeeper.disable();
  previewPlaceholder.hidden = false;
  recBadge.hidden = true;
  btnStart.hidden = false;
  btnStart.disabled = false;
  btnStop.hidden = true;
  btnStop.disabled = false;
  orientationSelect.disabled = false;
  formatSelect.disabled = false;
  syncIdlePreviewAspect();
  refreshUi();
  statsTimer = setInterval(refreshUi, 2000);
}

/** Arrêt inattendu : alerte forte, fermeture propre de la session, une reprise automatique (limitée). */
async function handleRecorderFailure(r, reason) {
  if (r.dead || r.stopRequested || rec !== r) return;
  r.dead = true;
  raiseAlert(`ENREGISTREMENT INTERROMPU : ${reason}. Regardez le téléphone !`);
  await drainRecorder(r);
  teardownRecording(r);
  const now = Date.now();
  restartTimes = restartTimes.filter((t) => now - t < 10 * 60 * 1000);
  if (restartTimes.length >= 3) {
    setStatus("Enregistrement interrompu — redémarrez-le à la main");
    return;
  }
  restartTimes.push(now);
  debugState.restarts += 1;
  setStatus("Reprise automatique…");
  await startRecording({ automatic: true });
  if (rec) setStatus("● Enregistrement repris (nouvelle partie de la série)");
}

function watchdog() {
  const r = rec;
  if (!r || r.dead) return;
  if (r.recorder.state !== "recording") {
    handleRecorderFailure(r, `état de l’enregistreur « ${r.recorder.state} »`);
    return;
  }
  if (performance.now() - r.lastDataAt > STALL_MS) {
    handleRecorderFailure(r, "plus aucune donnée vidéo reçue");
    return;
  }
  const frames = framesDrawn;
  if (r.lastFrames === frames) {
    r.stalledTicks = (r.stalledTicks || 0) + 1;
    if (r.stalledTicks >= 2) {
      raiseAlert("L’image est figée (le navigateur ralentit la page). Gardez l’écran allumé au premier plan.", { beep: true });
      r.stalledTicks = -5;
    }
  } else {
    r.stalledTicks = 0;
  }
  r.lastFrames = frames;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (rec) hiddenAt = Date.now();
    return;
  }
  screenKeeper.refresh();
  if (rec && hiddenAt) {
    const seconds = Math.round((Date.now() - hiddenAt) / 1000);
    hiddenAt = 0;
    if (seconds >= 1) {
      raiseAlert(`La page est restée masquée ${seconds} s : l’enregistrement a pu perdre des images. Gardez l’écran allumé au premier plan.`);
    }
  }
});

// ---------------------------------------------------------------- confirmation d'arrêt, boutons

btnStart.addEventListener("click", () => startRecording());
btnStop.addEventListener("click", () => {
  stopConfirm.hidden = false;
  stopConfirm.scrollIntoView({ block: "nearest" });
});
$("stop-no").addEventListener("click", () => {
  stopConfirm.hidden = true;
});
$("stop-yes").addEventListener("click", () => stopRecording());

btnDownload.addEventListener("click", async () => {
  const metas = (await store.listPartMeta()).filter((m) => m.state !== "uploaded");
  const sessions = new Map((await store.listSessions()).map((s) => [s.id, s]));
  const bySession = new Map();
  for (const m of metas) {
    if (!bySession.has(m.session)) bySession.set(m.session, []);
    bySession.get(m.session).push(m);
  }
  let n = 0;
  for (const [sid, list] of bySession) {
    const blobs = [];
    for (const m of list.sort((a, b) => a.idx - b.idx)) {
      const blob = await store.getPartBlob(sid, m.idx);
      if (blob) blobs.push(blob);
    }
    if (!blobs.length) continue;
    const session = sessions.get(sid);
    const ext = session?.ext || "mp4";
    const url = URL.createObjectURL(new Blob(blobs, { type: ext === "webm" ? "video/webm" : "video/mp4" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `marathon-${new Date(session?.startedAt || Date.now()).toISOString().replace(/[:.]/g, "-")}-${sid.slice(0, 8)}-parties-${list[0].idx}-${list[list.length - 1].idx}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    n += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  setStatus(n ? `${n} fichier(s) téléchargé(s)` : "Rien à télécharger");
});

reauthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = reauthPassword.value.trim();
  if (!password) return;
  const result = await verifyToken(password);
  if (result === "ok") {
    const remember = Boolean(localStorage.getItem(TOKEN_KEY));
    storeToken(password, remember);
    uploader.rejectedToken = null;
    reauthPassword.value = "";
    uploader.kick(true);
  } else {
    netBannerText.textContent = result === "denied" ? "Mot de passe incorrect." : "Serveur injoignable, réessayez.";
  }
});

// ---------------------------------------------------------------- envoi

function startUploader() {
  if (uploaderStarted) return;
  uploaderStarted = true;
  uploader.start();
}

const uploader = new Uploader({
  getToken: storedToken,
  onChange: (state) => {
    uploaderState = state;
  },
  onPermanentFailure: ({ idx, reason }) => {
    raiseAlert(`Une partie (n° ${idx}) est refusée par le serveur : ${reason}. Elle reste sur le téléphone (Télécharger).`);
  },
});

/** Après rechargement : les enregistrements sans enregistreur actif sont clos et leur envoi reprend. */
async function resumeCheck() {
  if (rec) return;
  const sessions = await store.listSessions();
  for (const s of sessions) {
    if (!s.closed) await store.updateSession(s.id, { closed: true });
  }
  const pending = await pendingSummary();
  if (pending.count) {
    resumeBanner.hidden = false;
    resumeText.textContent =
      `Envoi repris : ${pending.count} partie(s) (${formatMB(pending.bytes)}) d’un enregistrement précédent ` +
      "sont encore sur ce téléphone. Vous pouvez démarrer un nouvel enregistrement dans la même série.";
    btnStart.textContent = "● Nouvel enregistrement (même série)";
  } else {
    resumeBanner.hidden = true;
    btnStart.textContent = "● Démarrer l’enregistrement";
  }
  uploader.kick(true);
}

// ---------------------------------------------------------------- panneau d'état

function describeUpload() {
  const s = uploaderState;
  if (!s) return ["—", ""];
  if (s.status === "auth") return ["Mot de passe à ressaisir", "bad"];
  if (s.status === "offline") return ["En attente du réseau", ""];
  if (s.status === "uploading" && s.inFlight) {
    const pct = s.inFlight.total ? Math.round((s.inFlight.loaded / s.inFlight.total) * 100) : 0;
    return [`Envoi de la partie ${s.inFlight.idx} (${pct} %)`, "good"];
  }
  if (s.status === "retry") {
    const wait = s.nextRetryAt ? Math.max(0, Math.round((s.nextRetryAt - Date.now()) / 1000)) : 0;
    return [`${s.lastError || "Échec"}${wait ? ` — nouvel essai dans ${wait} s` : ""}`, "bad"];
  }
  if (lastStats.pendingParts === 0) return [rec ? "À jour" : "Tout est envoyé", "good"];
  return ["En attente", ""];
}

async function refreshStats() {
  try {
    const metas = await store.listPartMeta();
    const pending = metas.filter((m) => m.state === "pending");
    lastStats = {
      pendingParts: pending.length,
      pendingBytes: pending.reduce((a, m) => a + m.size, 0),
      failedParts: metas.filter((m) => m.state === "failed").length,
      estimate: (await navigator.storage?.estimate?.()) || null,
    };
  } catch {
    /* IndexedDB indisponible */
  }
}

function setMeta(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

let storageCheckAt = 0;

async function refreshUi() {
  await refreshStats();
  const online = navigator.onLine !== false;
  if (rec) {
    const seconds = (performance.now() - rec.startedPerf) / 1000;
    setMeta("m-rec", `● ${formatClock(seconds)}`, "good");
    recBadgeTime.textContent = formatClock(seconds);
  } else {
    setMeta("m-rec", "arrêté");
  }
  const uploaded = uploaderState?.uploadedParts || 0;
  $("m-parts").textContent = `${debugState.recorded} enregistrées · ${uploaded} envoyées · ${lastStats.pendingParts} en attente`;
  setMeta("m-net", online ? "En ligne" : "HORS LIGNE (l’enregistrement continue)", online ? "good" : "bad");
  const [uploadText, uploadClass] = describeUpload();
  setMeta("m-upload", uploadText, uploadClass);
  const [gpsText, gpsClass] = describeGps();
  setMeta("m-gps", gpsText, gpsClass);
  const free = lastStats.estimate?.quota ? lastStats.estimate.quota - (lastStats.estimate.usage || 0) : null;
  setMeta(
    "m-local",
    `${formatMB(lastStats.pendingBytes)} à envoyer${free != null ? ` · ~${(free / 1024 ** 3).toFixed(1)} Go libres` : ""}`,
    storageLevel(lastStats.estimate) === "ok" ? "" : "bad",
  );
  const screenText = { wakelock: "Maintenu allumé", video: "Maintenu allumé (mode secours)", none: rec ? "Non verrouillé : touchez l’écran" : "—" }[screenMode];
  setMeta("m-screen", screenText, screenMode === "none" && rec ? "bad" : "");

  const level = storageLevel(lastStats.estimate);
  storageBanner.hidden = level === "ok";
  if (level !== "ok") {
    storageBanner.textContent =
      level === "critical"
        ? "Stockage du téléphone presque plein : l’enregistrement peut s’arrêter. Libérez de la place maintenant."
        : "Stockage du téléphone limité : libérez de la place ou rétablissez le réseau pour vider la file d’envoi.";
    if (level === "critical" && rec && Date.now() - storageCheckAt > 60_000) {
      storageCheckAt = Date.now();
      raiseAlert("STOCKAGE DU TÉLÉPHONE PRESQUE PLEIN : libérez de la place.");
    }
  }

  const s = uploaderState;
  if (s?.status === "auth") {
    netBanner.hidden = false;
    netBannerText.textContent = "Mot de passe refusé par le serveur. L’enregistrement continue ; ressaisissez-le pour reprendre l’envoi :";
    reauthForm.hidden = false;
  } else {
    reauthForm.hidden = true;
    const message = !online
      ? "Pas de réseau : l’enregistrement continue sur le téléphone, l’envoi reprendra tout seul."
      : s?.status === "retry"
        ? `Envoi en difficulté : ${s.lastError}. Nouvel essai automatique.`
        : "";
    netBannerText.textContent = message;
    netBanner.hidden = !message;
  }
  btnDownload.hidden = lastStats.pendingParts + lastStats.failedParts === 0;
}

// ---------------------------------------------------------------- démarrage de la page

orientationSelect.value = localStorage.getItem(ORIENTATION_KEY) || "portrait";
if (!orientationSelect.value) orientationSelect.value = "portrait";
formatSelect.value = localStorage.getItem(FORMAT_KEY) || "auto";
if (!formatSelect.value) formatSelect.value = "auto";

function syncIdlePreviewAspect() {
  if (rec) return;
  const out = outputSize(desiredOrientation());
  setPreviewAspect(out.width, out.height);
}
orientationSelect.addEventListener("change", syncIdlePreviewAspect);
window.matchMedia("(orientation: portrait)").addEventListener("change", syncIdlePreviewAspect);
syncIdlePreviewAspect();
statsTimer = setInterval(refreshUi, 2000);

window.__capture = {
  get debug() {
    return { ...debugState, pending: lastStats.pendingParts, uploaded: uploaderState?.uploadedParts || 0, recording: Boolean(rec) };
  },
  get canvasSize() {
    return { width: canvas.width, height: canvas.height };
  },
  get sessionId() {
    return rec?.id || null;
  },
  grabFrame: () => canvas.toDataURL("image/png"),
};

if ("serviceWorker" in navigator && (window.isSecureContext || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  gateError.textContent = "HTTPS requis pour la caméra.";
}

bootGate();
