/**
 * Capture mobile : overlay GPS/heure sur canvas portrait, WHIP → MediaMTX, MediaRecorder local.
 */

const preview = document.getElementById("preview");
const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const whipInput = document.getElementById("whip-url");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnBackup = document.getElementById("btn-backup");
const gpsEl = document.getElementById("gps");
const clockEl = document.getElementById("clock");
const backupSizeEl = document.getElementById("backup-size");

/** Sortie portrait marathon (9:16) */
const OUT_WIDTH = 720;
const OUT_HEIGHT = 1280;
const TARGET_FPS = 30;
const VIDEO_BITRATE = 3_000_000;
const RECORDER_TIMESLICE_MS = 60_000;
const CAPTURE_COOKIE = "capture_token";

const params = new URLSearchParams(window.location.search);

function persistCaptureToken(token) {
  if (!token) return;
  sessionStorage.setItem("captureToken", token);
  document.cookie = `${CAPTURE_COOKIE}=${encodeURIComponent(token)}; Path=/capture; Max-Age=86400; Secure; SameSite=Strict`;
}

function bootstrapAuthFromUrl() {
  const fromQuery = params.get("token");
  if (fromQuery) {
    persistCaptureToken(fromQuery);
    params.delete("token");
    const clean = params.toString()
      ? `${location.pathname}?${params}`
      : location.pathname;
    history.replaceState({}, "", clean);
  }
}

bootstrapAuthFromUrl();

function getCaptureToken() {
  return sessionStorage.getItem("captureToken") || "";
}

function defaultWhipUrl() {
  if (params.get("whip")) return params.get("whip");
  const { protocol, hostname, port } = window.location;
  const base = `${protocol}//${hostname}/live/whip`;
  if (port === "80" || port === "443" || port === "") {
    return base;
  }
  return base;
}

whipInput.value = defaultWhipUrl();
whipInput.readOnly = true;

let cameraStream = null;
let composedStream = null;
let pc = null;
let recorder = null;
let backupChunks = [];
let drawTimer = null;
let geoWatchId = null;
let lastPosition = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function formatBytes(n) {
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function updateBackupSize() {
  const total = backupChunks.reduce((a, b) => a + b.size, 0);
  backupSizeEl.textContent = formatBytes(total);
}

function drawOverlayFrame(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);

  const scale = Math.min(OUT_WIDTH / vw, OUT_HEIGHT / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (OUT_WIDTH - dw) / 2;
  const dy = (OUT_HEIGHT - dh) / 2;
  ctx.drawImage(videoEl, dx, dy, dw, dh);

  const now = new Date();
  const lines = [
    now.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    lastPosition
      ? `GPS ${lastPosition.coords.latitude.toFixed(5)}, ${lastPosition.coords.longitude.toFixed(5)} ±${Math.round(lastPosition.coords.accuracy)}m`
      : "GPS en attente…",
  ];
  const boxH = lines.length * 28 + 16;
  const boxW = Math.min(OUT_WIDTH - 24, 620);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(12, OUT_HEIGHT - 12 - boxH, boxW, boxH);
  ctx.fillStyle = "#fff";
  ctx.font = "22px system-ui, sans-serif";
  lines.forEach((line, i) => {
    ctx.fillText(line, 24, OUT_HEIGHT - 24 - (lines.length - 1 - i) * 28);
  });
  clockEl.textContent = lines[0];
  gpsEl.textContent = lines[1];
}

async function startGeolocation() {
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

async function getCameraStream() {
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: OUT_WIDTH },
      height: { ideal: OUT_HEIGHT },
      frameRate: { ideal: TARGET_FPS },
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function buildComposedStream() {
  const canvasStream = canvas.captureStream(TARGET_FPS);
  const tracks = [...canvasStream.getVideoTracks()];
  const audioTracks = cameraStream.getAudioTracks();
  if (audioTracks.length) {
    tracks.push(audioTracks[0]);
  }
  return new MediaStream(tracks);
}

async function applyVideoBitrate(sender) {
  if (!sender?.getParameters) return;
  const p = sender.getParameters();
  if (!p.encodings?.length) {
    p.encodings = [{}];
  }
  p.encodings[0].maxBitrate = VIDEO_BITRATE;
  await sender.setParameters(p);
}

async function publishWhip(stream, whipUrl) {
  const whipEndpoint = whipUrl.split("?")[0];
  const icePc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  stream.getTracks().forEach((track) => icePc.addTrack(track, stream));

  const offer = await icePc.createOffer();
  await icePc.setLocalDescription(offer);

  const headers = {
    "Content-Type": "application/sdp",
  };
  const token = getCaptureToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(whipEndpoint, {
    method: "POST",
    headers,
    body: offer.sdp,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WHIP ${response.status}: ${text}`);
  }

  const answerSdp = await response.text();
  await icePc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  const videoSender = icePc.getSenders().find((s) => s.track?.kind === "video");
  await applyVideoBitrate(videoSender);

  icePc.onconnectionstatechange = () => {
    if (icePc.connectionState === "failed" || icePc.connectionState === "disconnected") {
      setStatus(
        `WebRTC : ${icePc.connectionState} — pare-feu UDP 8189 / ICE (stream.iznac.com)`,
      );
    } else if (icePc.connectionState === "connected") {
      setStatus("Diffusion WebRTC active");
    }
  };

  return icePc;
}

function startLocalRecorder(stream) {
  backupChunks = [];
  const mimeCandidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    setStatus("MediaRecorder : aucun codec supporté");
    return null;
  }
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITRATE,
  });
  rec.ondataavailable = (ev) => {
    if (ev.data?.size) {
      backupChunks.push(ev.data);
      updateBackupSize();
    }
  };
  rec.onerror = () => setStatus("Erreur MediaRecorder");
  rec.start(RECORDER_TIMESLICE_MS);
  return rec;
}

async function startCapture() {
  const whipUrl = whipInput.value.trim();
  if (!whipUrl) {
    setStatus("Indiquez l’URL WHIP");
    return;
  }

  btnStart.disabled = true;
  setStatus("Accès caméra…");

  try {
    await startGeolocation();
    cameraStream = await getCameraStream();
    preview.srcObject = cameraStream;
    await preview.play();

    drawTimer = window.setInterval(() => drawOverlayFrame(preview), 1000 / TARGET_FPS);
    composedStream = buildComposedStream();

    setStatus("Connexion WHIP…");
    pc = await publishWhip(composedStream, whipUrl);

    recorder = startLocalRecorder(composedStream);
    btnStop.disabled = false;
    btnBackup.disabled = false;
    if (recorder) {
      setStatus("Live + sauvegarde locale");
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err));
    await stopCapture();
    btnStart.disabled = false;
  }
}

async function stopCapture() {
  btnStop.disabled = true;
  if (drawTimer) {
    clearInterval(drawTimer);
    drawTimer = null;
  }
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  recorder = null;
  if (pc) {
    pc.close();
    pc = null;
  }
  if (composedStream) {
    composedStream.getTracks().forEach((t) => t.stop());
    composedStream = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  preview.srcObject = null;
  stopGeolocation();
  btnStart.disabled = false;
  setStatus("Arrêté");
}

function downloadBackup() {
  if (!backupChunks.length) {
    setStatus("Aucune sauvegarde locale");
    return;
  }
  const blob = new Blob(backupChunks, { type: backupChunks[0].type || "video/mp4" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `marathon-backup-${stamp}.mp4`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Sauvegarde téléchargée");
}

btnStart.addEventListener("click", () => startCapture());
btnStop.addEventListener("click", () => stopCapture());
btnBackup.addEventListener("click", () => downloadBackup());

if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  setStatus("HTTPS requis pour caméra + WebRTC");
}
