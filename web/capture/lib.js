/** Fonctions pures de la page capture (testées sous Node : tests/lib.test.mjs). */

export const PART_SECONDS = 10;
export const VIDEO_BITRATE = 8_000_000;
export const AUDIO_BITRATE = 128_000;
export const TARGET_FPS = 30;

export const QUALITY_LEVELS = [
  { name: "1080p", long: 1920, short: 1080, videoBitrate: VIDEO_BITRATE },
  { name: "720p", long: 1280, short: 720, videoBitrate: 4_000_000 },
];

export const MIME_CANDIDATES = {
  mp4: [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ],
  webm: ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=h264,opus", "video/webm"],
  "webm-h264": ["video/webm;codecs=h264,opus", "video/webm;codecs=avc1,opus"],
};

/**
 * Choisit le format d'enregistrement.
 * - Safari / iOS (WebKit) : mp4 H.264 (fragmenté, recollable par concaténation d'octets).
 * - Chrome Android et autres Chromium : webm (VP8 + Opus), chemin de MediaRecorder le plus éprouvé
 *   en flux continu ; mp4 n'est utilisé sur Chromium que si le webm est introuvable.
 * - `preference` (réglage « Format » de la page) force mp4, webm ou webm-h264.
 */
export function pickMimeType(isTypeSupported, { preference = "auto", chromium = false } = {}) {
  let order;
  if (preference === "mp4") order = ["mp4", "webm"];
  else if (preference === "webm") order = ["webm", "mp4"];
  else if (preference === "webm-h264") order = ["webm-h264", "webm", "mp4"];
  else order = chromium ? ["webm", "mp4"] : ["mp4", "webm"];
  for (const container of order) {
    for (const mime of MIME_CANDIDATES[container]) {
      let ok = false;
      try {
        ok = Boolean(isTypeSupported(mime));
      } catch {
        ok = false;
      }
      if (ok) return { mime, container: container.startsWith("webm") ? "webm" : "mp4", ext: container.startsWith("webm") ? "webm" : "mp4" };
    }
  }
  return null;
}

export function isChromiumEngine(nav) {
  const brands = nav?.userAgentData?.brands || [];
  return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Samsung/i.test(b.brand));
}

export function orientationOf(width, height) {
  return height > width ? "portrait" : "landscape";
}

export function outputSize(orientation, quality = QUALITY_LEVELS[0]) {
  return orientation === "portrait"
    ? { width: quality.short, height: quality.long }
    : { width: quality.long, height: quality.short };
}

/** Rectangle source « cover » : remplit le cadre en recadrant au centre, sans déformer. */
export function coverRect(vw, vh, cw, ch) {
  const scale = Math.max(cw / vw, ch / vh);
  const sw = cw / scale;
  const sh = ch / scale;
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}

/** Attente avant nouvel essai d'upload : 2 s, 4 s, 8 s… plafonné à 60 s, ±25 % de gigue. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function formatDateParis(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(",", "");
}

/** Lignes incrustées dans l'image : date/heure (Paris, secondes), latitude, longitude, précision. */
export function overlayLines(date, position) {
  const lines = [formatDateParis(date)];
  if (position) {
    const c = position.coords;
    lines.push(`Lat ${c.latitude.toFixed(5)}  Lon ${c.longitude.toFixed(5)}`);
    lines.push(`Précision ±${Math.round(c.accuracy)} m`);
  } else {
    lines.push("GPS en attente…");
  }
  return lines;
}

/** Échantillon du fichier GPS joint à la session (~1 par seconde). */
export function gpsSample(position, now = Date.now()) {
  const c = position.coords;
  const sample = {
    t: now,
    fix: position.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    acc: c.accuracy,
  };
  if (Number.isFinite(c.speed)) sample.speed = c.speed;
  if (Number.isFinite(c.heading)) sample.heading = c.heading;
  if (Number.isFinite(c.altitude)) sample.alt = c.altitude;
  return sample;
}

export function randomId(cryptoObj = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(blob, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Niveau d'alerte stockage à partir de storage.estimate() : "ok" | "low" | "critical". */
export function storageLevel(estimate) {
  if (!estimate || !estimate.quota) return "ok";
  const free = estimate.quota - (estimate.usage || 0);
  if (free < 400 * 1024 * 1024) return "critical";
  if (free < 2 * 1024 * 1024 * 1024) return "low";
  return "ok";
}

/** Classe une réponse d'upload : "ok" | "retry" | "auth" | "reregister" | "permanent". */
export function classifyUploadResponse(status, errorCode = "") {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 && errorCode === "unknown_session") return "reregister";
  if ([400, 409, 413, 415].includes(status)) return "permanent";
  return "retry";
}
