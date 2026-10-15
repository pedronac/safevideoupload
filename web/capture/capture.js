/**
 * Capture Safari iOS 15+ : overlay GPS/heure sur canvas, WHIP → MediaMTX, MediaRecorder local.
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

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;
const VIDEO_BITRATE = 3_000_000;
const RECORDER_TIMESLICE_MS = 60_000;

const params = new URLSearchParams(window.location.search);

function getCaptureToken() {
  const fromQuery = params.get("token");
  if (fromQuery) {
    localStorage.setItem("captureToken", fromQuery);
    return fromQuery;
  }
  return localStorage.getItem("captureToken") || "";
}

function defaultWhipUrl() {
  if (params.get("whip")) return params.get("whip");
  const saved = localStorage.getItem("whipUrl");
  if (saved) return saved;
  const { protocol, hostname, port } = window.location;
  const token = getCaptureToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  if (port === "80" || port === "443" || port === "") {
    return `${protocol}//${hostname}/live/whip${tokenQuery}`;
  }
  return `${protocol}//${hostname}/live/whip${tokenQuery}`;
}

const defaultWhip = defaultWhipUrl();
whipInput.value = defaultWhip;

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
  ctx.drawImage(videoEl, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
  const now = new Date();
  const lines = [
    now.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    lastPosition
      ? `GPS ${lastPosition.coords.latitude.toFixed(5)}, ${lastPosition.coords.longitude.toFixed(5)} ±${Math.round(lastPosition.coords.accuracy)}m`
      : "GPS en attente…",
  ];
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(12, TARGET_HEIGHT - 12 - lines.length * 28, 620, lines.length * 28 + 16);
  ctx.fillStyle = "#fff";
  ctx.font = "22px system-ui, sans-serif";
  lines.forEach((line, i) => {
    ctx.fillText(line, 24, TARGET_HEIGHT - 24 - (lines.length - 1 - i) * 28);
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
      width: { ideal: TARGET_WIDTH },
      height: { ideal: TARGET_HEIGHT },
      frameRate: { ideal: TARGET_FPS },
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function buildComposedStream(videoEl) {
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
  const params = sender.getParameters();
  if (!params.encodings?.length) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = VIDEO_BITRATE;
  await sender.setParameters(params);
}

async function publishWhip(stream, whipUrl) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const headers = {
    "Content-Type": "application/sdp",
  };
  const token = getCaptureToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(whipUrl, {
    method: "POST",
    headers,
    body: offer.sdp,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WHIP ${response.status}: ${text}`);
  }

  const answerSdp = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
  await applyVideoBitrate(videoSender);

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus(`WebRTC : ${pc.connectionState} — vérifiez réseau / ICE`);
    } else if (pc.connectionState === "connected") {
      setStatus("Diffusion WebRTC active");
    }
  };

  return pc;
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
  localStorage.setItem("whipUrl", whipUrl);

  btnStart.disabled = true;
  setStatus("Accès caméra…");

  try {
    await startGeolocation();
    cameraStream = await getCameraStream();
    preview.srcObject = cameraStream;
    await preview.play();

    drawTimer = window.setInterval(() => drawOverlayFrame(preview), 1000 / TARGET_FPS);
    composedStream = buildComposedStream(preview);

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
  setStatus("HTTPS requis pour caméra + WebRTC (Tailscale Funnel ou Caddy)");
}
