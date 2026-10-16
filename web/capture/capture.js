/**
 * Capture mobile : caméra -> canvas (cadrage + incrustation GPS/heure) -> WHIP + sauvegarde locale.
 *
 * Accès : la page est publique mais verrouillée par un mot de passe vérifié côté serveur
 * (POST /capture-auth, en-tête Authorization: Bearer). Le secret n'apparaît jamais dans une URL.
 */

const $ = (id) => document.getElementById(id);

const gate = $("gate");
const gateForm = $("gate-form");
const gatePassword = $("gate-password");
const gateRemember = $("gate-remember");
const gateSubmit = $("gate-submit");
const gateError = $("gate-error");
const app = $("app");

const camera = $("camera");
const canvas = $("overlay-canvas");
const ctx = canvas.getContext("2d");
const previewFrame = $("preview-frame");
const previewPlaceholder = $("preview-placeholder");
const statusEl = $("status");
const framingEl = $("framing");
const whipInput = $("whip-url");
const orientationSelect = $("orientation");
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const btnBackup = $("btn-backup");
const btnLock = $("btn-lock");
const gpsEl = $("gps");
const clockEl = $("clock");
const backupSizeEl = $("backup-size");
const netError = $("net-error");
const netConnection = $("net-connection");
const netIce = $("net-ice");
const netPath = $("net-path");
const netSend = $("net-send");
const netCandidates = $("net-candidates");

const TARGET_FPS = 30;
const LONG_SIDE = 1280;
const SHORT_SIDE = 720;
const VIDEO_BITRATE = 3_000_000;
const RECORDER_TIMESLICE_MS = 60_000;
const ICE_TIMEOUT_MS = 15_000;
const ICE_GATHER_TIMEOUT_MS = 2_500;
const DISCONNECT_GRACE_MS = 6_000;
const RETRY_DELAY_MS = 3_000;
const TOKEN_KEY = "captureToken";
const ORIENTATION_KEY = "captureOrientation";
const WHIP_ENDPOINT = `${location.origin}/live/whip`;

const ICE_TIMEOUT_MESSAGE =
  "La connexion vidéo n’aboutit pas (15 s). Le téléphone n’arrive pas à joindre le serveur " +
  "sur le port 8189 (UDP, puis TCP). Vérifiez le pare-feu du serveur (8189/udp et 8189/tcp), " +
  "essayez en Wi-Fi puis en 4G/5G. La sauvegarde locale continue et une nouvelle tentative " +
  "démarre automatiquement.";

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

function showGate(message = "") {
  app.hidden = true;
  gate.hidden = false;
  gateError.textContent = message;
  gatePassword.value = "";
}

function unlock() {
  gate.hidden = true;
  app.hidden = false;
  gateError.textContent = "";
  setStatus("Prêt");
}

async function lockPage(message = "") {
  await stopCapture();
  clearToken();
  showGate(message);
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
    showGate();
    return;
  }
  const result = await verifyToken(token);
  if (result === "ok") {
    unlock();
  } else if (result === "denied" || result === "invalid") {
    clearToken();
    showGate("Mot de passe expiré ou modifié. Saisissez-le à nouveau.");
  } else {
    showGate("Impossible de joindre le serveur. Saisissez le mot de passe pour réessayer.");
  }
}

// ---------------------------------------------------------------- orientation / cadrage

function orientationOf(width, height) {
  return height > width ? "portrait" : "landscape";
}

function desiredOrientation() {
  const mode = orientationSelect.value;
  if (mode === "portrait" || mode === "landscape") return mode;
  return window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Taille de sortie qui épouse le ratio réel des images, dans une boîte 1280x720. */
function fitOutputSize(width, height) {
  const scale = Math.min(LONG_SIDE / Math.max(width, height), SHORT_SIDE / Math.min(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

function standardOutputSize(orientation) {
  return orientation === "portrait"
    ? { width: SHORT_SIDE, height: LONG_SIDE }
    : { width: LONG_SIDE, height: SHORT_SIDE };
}

const ASPECT_TOLERANCE = 0.02;

function sameAspect(a, b) {
  return Math.abs(a - b) / b <= ASPECT_TOLERANCE;
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

/**
 * Ouvre la caméra en 1280x720 puis, si l'orientation livrée ne correspond pas à celle voulue,
 * redemande avec largeur/hauteur échangées. Si la caméra s'obstine, on garde ses images et le
 * dessin les recadre (jamais d'étirement).
 */
async function acquireCamera(wanted) {
  let first;
  let micMissing = false;
  try {
    first = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: videoConstraints(LONG_SIDE, SHORT_SIDE),
    });
  } catch (err) {
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") throw err;
    first = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(LONG_SIDE, SHORT_SIDE),
    });
    micMissing = true;
  }

  const audioTrack = first.getAudioTracks()[0] || null;
  let videoTrack = first.getVideoTracks()[0];
  let size = await measureTrack(videoTrack);

  if (orientationOf(size.width, size.height) !== wanted) {
    const [w, h] = wanted === "portrait" ? [SHORT_SIDE, LONG_SIDE] : [LONG_SIDE, SHORT_SIDE];
    for (const constraints of [videoConstraints(w, h, { ratio: true }), videoConstraints(w, h, { exact: true })]) {
      videoTrack.stop();
      try {
        const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
        videoTrack = next.getVideoTracks()[0];
      } catch (err) {
        console.debug("[capture] contrainte refusée", err?.name);
        const back = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints(LONG_SIDE, SHORT_SIDE),
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

/** Fixe la taille du canvas UNE seule fois, avant captureStream (jamais redimensionné ensuite). */
function configureCanvas(cameraSize, wanted) {
  const matches = orientationOf(cameraSize.width, cameraSize.height) === wanted;
  const out = matches ? fitOutputSize(cameraSize.width, cameraSize.height) : standardOutputSize(wanted);
  canvas.width = out.width;
  canvas.height = out.height;
  setPreviewAspect(out.width, out.height);
  const cropped =
    !matches || !sameAspect(cameraSize.width / cameraSize.height, out.width / out.height);
  return { out, matches, cropped };
}

function describeFraming(cameraSize, framing, wanted) {
  const base = `Caméra ${cameraSize.width}x${cameraSize.height} → sortie ${framing.out.width}x${framing.out.height}`;
  if (!framing.matches) {
    const wish = wanted === "portrait" ? "verticale" : "horizontale";
    return `${base} (recadrage centré : la caméra ne fournit pas d’image ${wish})`;
  }
  if (framing.cropped) return `${base} (léger recadrage centré)`;
  return base;
}

// ---------------------------------------------------------------- dessin (canvas)

let lastPosition = null;
let lastInfoSecond = 0;

function overlayLines() {
  const now = new Date();
  return [
    now.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    lastPosition
      ? `GPS ${lastPosition.coords.latitude.toFixed(5)}, ${lastPosition.coords.longitude.toFixed(5)} ±${Math.round(lastPosition.coords.accuracy)} m`
      : "GPS en attente…",
  ];
}

function drawFrame() {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = camera.videoWidth;
  const vh = camera.videoHeight;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  if (vw > 0 && vh > 0) {
    // « cover » : remplit tout le cadre, recadre au centre si besoin, ne déforme jamais.
    const scale = Math.max(cw / vw, ch / vh);
    const sw = cw / scale;
    const sh = ch / scale;
    ctx.drawImage(camera, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, ch);
  }

  const unit = Math.min(cw, ch);
  const fontPx = Math.max(16, Math.round(unit * 0.034));
  const pad = Math.round(fontPx * 0.5);
  const margin = Math.round(unit * 0.025);
  const lines = overlayLines();
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const lineH = Math.round(fontPx * 1.3);
  const boxW = Math.min(cw - 2 * margin, Math.ceil(textWidth + 2 * pad));
  const boxH = lines.length * lineH + pad;
  const boxX = margin;
  const boxY = ch - margin - boxH;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#fff";
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + pad, boxY + pad * 0.5 + fontPx + i * lineH, boxW - 2 * pad);
  });

  const second = Math.floor(Date.now() / 1000);
  if (second !== lastInfoSecond) {
    lastInfoSecond = second;
    clockEl.textContent = lines[0];
    gpsEl.textContent = lines[1];
  }
}

// ---------------------------------------------------------------- état

let cameraStream = null;
let composedStream = null;
let drawTimer = null;
let recorder = null;
let backupChunks = [];
let geoWatchId = null;
let wakeLock = null;
let publishToken = 0;
let activeSession = null;
let statsTimer = null;
let capturing = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function setNetError(message) {
  netError.textContent = message || "";
}

function formatBytes(n) {
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function updateBackupSize() {
  backupSizeEl.textContent = formatBytes(backupChunks.reduce((a, b) => a + b.size, 0));
}

function resetNetPanel() {
  netConnection.textContent = "—";
  netIce.textContent = "—";
  netPath.textContent = "—";
  netSend.textContent = "—";
  netCandidates.textContent = "—";
  setNetError("");
}

// ---------------------------------------------------------------- GPS, écran allumé

function startGeolocation() {
  if (!navigator.geolocation) {
    gpsEl.textContent = "Géolocalisation indisponible";
    return;
  }
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastPosition = pos;
    },
    () => {
      gpsEl.textContent = "Permission GPS refusée";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function stopGeolocation() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) || null;
  } catch {
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && capturing) requestWakeLock();
});

// ---------------------------------------------------------------- WHIP / WebRTC

function preferH264(pc) {
  const caps = window.RTCRtpSender?.getCapabilities?.("video");
  if (!caps) return;
  const isH264 = (c) => /h264/i.test(c.mimeType);
  const h264 = caps.codecs.filter((c) => isH264(c) && /packetization-mode=1/.test(c.sdpFmtpLine || ""));
  if (!h264.length) return;
  const rest = caps.codecs.filter((c) => !h264.includes(c));
  for (const t of pc.getTransceivers()) {
    if (t.sender.track?.kind === "video" && t.setCodecPreferences) {
      try {
        t.setCodecPreferences([...h264, ...rest]);
      } catch (err) {
        console.debug("[capture] setCodecPreferences", err);
      }
    }
  }
}

function waitIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function parseServerCandidates(sdp) {
  const found = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = line.match(/^a=candidate:\S+ \d+ (\w+) \d+ (\S+) (\d+) typ (\w+)/i);
    if (m) found.push(`${m[1].toLowerCase()} ${m[2]}:${m[3]} (${m[4]})`);
  }
  return [...new Set(found)];
}

class AuthRejectedError extends Error {}

async function whipOffer(pc, token) {
  const headers = { "Content-Type": "application/sdp", Authorization: `Bearer ${token}` };
  const response = await fetch(WHIP_ENDPOINT, {
    method: "POST",
    headers,
    body: pc.localDescription.sdp,
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthRejectedError("Mot de passe refusé par le serveur.");
  }
  if (!response.ok) {
    throw new Error(`Le serveur a refusé le direct (HTTP ${response.status}).`);
  }
  const location = response.headers.get("Location");
  return {
    answer: await response.text(),
    resourceUrl: location ? new URL(location, WHIP_ENDPOINT).toString() : null,
  };
}

async function deleteWhipSession(resourceUrl, token) {
  if (!resourceUrl) return;
  try {
    await fetch(resourceUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    });
  } catch {
    /* session déjà fermée côté serveur */
  }
}

async function applyVideoBitrate(pc) {
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (!sender?.getParameters) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = VIDEO_BITRATE;
  try {
    // Résolution constante (on réduit plutôt la cadence) : flou et HLS supportent mal
    // les changements de taille en cours de direct.
    await sender.setParameters({ ...params, degradationPreference: "maintain-resolution" });
  } catch {
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.debug("[capture] setParameters", err);
    }
  }
}

function describeConnection(state) {
  return (
    {
      new: "initialisation",
      connecting: "connexion en cours…",
      connected: "connecté",
      disconnected: "coupé (reprise…)",
      failed: "échec",
      closed: "fermé",
    }[state] || state
  );
}

function renderNet(pc) {
  netConnection.textContent = describeConnection(pc.connectionState);
  netIce.textContent = pc.iceConnectionState;
}

async function readStats(pc, previous) {
  const stats = await pc.getStats();
  let pairId = null;
  stats.forEach((r) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
  });
  let pair = pairId ? stats.get(pairId) : null;
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = r;
    });
  }
  if (pair) {
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    netPath.textContent =
      `${(local?.protocol || "?").toUpperCase()} (local ${local?.candidateType || "?"}` +
      ` → serveur ${remote?.candidateType || "?"})`;
  }
  let outbound = null;
  stats.forEach((r) => {
    if (r.type === "outbound-rtp" && r.kind === "video") outbound = r;
  });
  let sample = previous;
  if (outbound) {
    const now = performance.now();
    let rate = "";
    if (previous && now > previous.at) {
      const kbps = ((outbound.bytesSent - previous.bytes) * 8) / (now - previous.at);
      rate = ` ${(kbps / 1000).toFixed(1)} Mb/s`;
    }
    const size = outbound.frameWidth ? `${outbound.frameWidth}x${outbound.frameHeight}` : "—";
    const fps = outbound.framesPerSecond ? ` ${Math.round(outbound.framesPerSecond)} i/s` : "";
    netSend.textContent = `${size}${fps}${rate}`;
    sample = { at: now, bytes: outbound.bytesSent };
  }
  return sample;
}

function startStatsLoop(pc) {
  clearInterval(statsTimer);
  let sample = null;
  statsTimer = setInterval(async () => {
    try {
      sample = await readStats(pc, sample);
    } catch {
      /* connexion fermée entre-temps */
    }
  }, 2000);
}

/** Une tentative WHIP. Résout quand la connexion tombe ; rejette si impossible d'établir. */
async function runPublishAttempt(stream, token, myToken) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  const session = { pc, resourceUrl: null, abort: () => {} };
  const aborted = new Promise((resolve) => {
    session.abort = () => resolve("aborted");
  });
  activeSession = session;
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  preferH264(pc);

  const connected = new Promise((resolve) => {
    const onState = () => {
      renderNet(pc);
      if (pc.connectionState === "connected") resolve("connected");
      if (pc.connectionState === "failed") resolve("failed");
    };
    pc.addEventListener("connectionstatechange", onState);
    pc.addEventListener("iceconnectionstatechange", onState);
  });
  const lost = new Promise((resolve) => {
    let timer = null;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") resolve("lost");
      if (pc.connectionState === "disconnected") {
        timer = setTimeout(() => resolve("lost"), DISCONNECT_GRACE_MS);
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  });

  try {
    setStatus("Enregistrement local actif — connexion au serveur…");
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
    const { answer, resourceUrl } = await whipOffer(pc, token);
    session.resourceUrl = resourceUrl;
    netCandidates.textContent = parseServerCandidates(answer).join(" · ") || "aucun candidat annoncé";
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    renderNet(pc);

    const outcome = await Promise.race([
      connected,
      aborted,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), ICE_TIMEOUT_MS)),
    ]);
    if (myToken !== publishToken) return;
    if (outcome !== "connected") {
      setNetError(ICE_TIMEOUT_MESSAGE);
      setStatus("Pas de connexion au serveur — sauvegarde locale seule");
      return;
    }

    setNetError("");
    setStatus("EN DIRECT — connexion WebRTC établie");
    await applyVideoBitrate(pc);
    startStatsLoop(pc);
    await Promise.race([lost, aborted]);
    if (myToken === publishToken) {
      setNetError("Connexion perdue. Reconnexion automatique…");
      setStatus("Connexion perdue — sauvegarde locale seule");
    }
  } finally {
    clearInterval(statsTimer);
    pc.close();
    await deleteWhipSession(session.resourceUrl, token);
    if (activeSession === session) activeSession = null;
  }
}

async function publishLoop(stream, token, myToken) {
  while (myToken === publishToken) {
    try {
      await runPublishAttempt(stream, token, myToken);
    } catch (err) {
      if (myToken !== publishToken) return;
      if (err instanceof AuthRejectedError) {
        await lockPage("Mot de passe refusé par le serveur. Saisissez-le à nouveau.");
        return;
      }
      console.error(err);
      setNetError(`${err.message || err} Nouvelle tentative…`);
      setStatus("Pas de connexion au serveur — sauvegarde locale seule");
    }
    if (myToken !== publishToken) return;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

// ---------------------------------------------------------------- sauvegarde locale

let recorderMime = "";

function startLocalRecorder(stream) {
  backupChunks = [];
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  recorderMime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  if (!recorderMime) {
    setNetError("Sauvegarde locale impossible : aucun codec d’enregistrement supporté.");
    return null;
  }
  const rec = new MediaRecorder(stream, { mimeType: recorderMime, videoBitsPerSecond: VIDEO_BITRATE });
  rec.ondataavailable = (ev) => {
    if (ev.data?.size) {
      backupChunks.push(ev.data);
      updateBackupSize();
    }
  };
  rec.onerror = () => setNetError("Erreur de la sauvegarde locale (MediaRecorder).");
  rec.start(RECORDER_TIMESLICE_MS);
  return rec;
}

function downloadBackup() {
  if (!backupChunks.length) {
    setStatus("Aucune sauvegarde locale pour l’instant");
    return;
  }
  const type = (backupChunks[0].type || recorderMime || "video/mp4").split(";")[0];
  const extension = type.includes("webm") ? "webm" : "mp4";
  const url = URL.createObjectURL(new Blob(backupChunks, { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `marathon-sauvegarde-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  setStatus("Sauvegarde téléchargée");
}

// ---------------------------------------------------------------- démarrage / arrêt

function cameraErrorMessage(err) {
  if (err?.name === "NotAllowedError") {
    return "Accès caméra/micro refusé : autorisez-le dans les réglages du navigateur.";
  }
  if (err?.name === "NotFoundError") return "Aucune caméra détectée.";
  if (err?.name === "NotReadableError") return "La caméra est utilisée par une autre application.";
  return err?.message || String(err);
}

async function startCapture() {
  const token = storedToken();
  if (!token) {
    await lockPage("Saisissez le mot de passe.");
    return;
  }
  capturing = true;
  btnStart.disabled = true;
  orientationSelect.disabled = true;
  localStorage.setItem(ORIENTATION_KEY, orientationSelect.value);
  resetNetPanel();
  setStatus("Accès caméra…");

  try {
    startGeolocation();
    const wanted = desiredOrientation();
    const { stream, size, micMissing } = await acquireCamera(wanted);
    cameraStream = stream;
    camera.srcObject = new MediaStream(stream.getVideoTracks());
    await camera.play().catch(() => {});

    const framing = configureCanvas(size, wanted);
    previewPlaceholder.hidden = true;
    drawFrame();
    drawTimer = window.setInterval(drawFrame, 1000 / TARGET_FPS);

    const canvasStream = canvas.captureStream(TARGET_FPS);
    composedStream = new MediaStream([...canvasStream.getVideoTracks(), ...stream.getAudioTracks()]);

    recorder = startLocalRecorder(composedStream);
    btnStop.disabled = false;
    btnBackup.disabled = false;
    requestWakeLock();

    const framingText = describeFraming(size, framing, wanted);
    framingEl.textContent = framingText;
    if (micMissing) setNetError("Micro indisponible : le direct sera sans son.");

    publishToken += 1;
    const myToken = publishToken;
    window.__capture.framing = framingText;
    publishLoop(composedStream, token, myToken);
  } catch (err) {
    console.error(err);
    await stopCapture();
    setStatus(cameraErrorMessage(err));
  }
}

async function stopCapture() {
  publishToken += 1;
  capturing = false;
  btnStop.disabled = true;
  clearInterval(drawTimer);
  drawTimer = null;
  clearInterval(statsTimer);
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  activeSession?.abort();
  composedStream?.getTracks().forEach((t) => t.stop());
  composedStream = null;
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  camera.srcObject = null;
  stopGeolocation();
  wakeLock?.release?.().catch?.(() => {});
  wakeLock = null;
  previewPlaceholder.hidden = false;
  btnStart.disabled = false;
  orientationSelect.disabled = false;
  resetNetPanel();
  framingEl.textContent = "";
  setStatus("Arrêté");
}

btnStart.addEventListener("click", () => startCapture());
btnStop.addEventListener("click", () => stopCapture());
btnBackup.addEventListener("click", () => downloadBackup());

orientationSelect.value = localStorage.getItem(ORIENTATION_KEY) || "auto";
if (!orientationSelect.value) orientationSelect.value = "auto";

function syncIdlePreviewAspect() {
  if (capturing) return;
  const o = desiredOrientation();
  const size = standardOutputSize(o);
  setPreviewAspect(size.width, size.height);
}
orientationSelect.addEventListener("change", syncIdlePreviewAspect);
window.matchMedia("(orientation: portrait)").addEventListener("change", syncIdlePreviewAspect);
syncIdlePreviewAspect();

whipInput.value = WHIP_ENDPOINT;

window.__capture = {
  fitOutputSize,
  orientationOf,
  framing: "",
  get canvasSize() {
    return { width: canvas.width, height: canvas.height };
  },
  get composedStream() {
    return composedStream;
  },
};

if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  gateError.textContent = "HTTPS requis pour la caméra et le direct.";
}

bootGate();
