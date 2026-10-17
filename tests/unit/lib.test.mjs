import test from "node:test";
import assert from "node:assert/strict";

import {
  backoffDelay,
  classifyUploadResponse,
  coverRect,
  formatClock,
  gpsSample,
  isChromiumEngine,
  outputSize,
  overlayLines,
  pickMimeType,
  QUALITY_LEVELS,
  randomId,
  sha256Hex,
  storageLevel,
} from "../../web/capture/lib.js";

const supports = (list) => (mime) => list.includes(mime);
const SAFARI = supports([
  "video/mp4",
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
]);
const SAFARI_MINIMAL = supports(["video/mp4"]);
const CHROME_ANDROID_OLD = supports(["video/webm", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=h264,opus"]);
const CHROME_NEW = supports([
  "video/webm",
  "video/webm;codecs=vp8,opus",
  "video/mp4",
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
]);

test("Safari (WebKit) : mp4 H.264 choisi en premier", () => {
  const pick = pickMimeType(SAFARI, { chromium: false });
  assert.equal(pick.container, "mp4");
  assert.equal(pick.ext, "mp4");
  assert.equal(pick.mime, "video/mp4;codecs=avc1.42E01E,mp4a.40.2");
});

test("Safari minimal : retombe sur video/mp4 nu", () => {
  assert.equal(pickMimeType(SAFARI_MINIMAL, {}).mime, "video/mp4");
});

test("Chrome Android sans mp4 : repli webm vp8+opus", () => {
  const pick = pickMimeType(CHROME_ANDROID_OLD, { chromium: true });
  assert.deepEqual(pick, { mime: "video/webm;codecs=vp8,opus", container: "webm", ext: "webm" });
});

test("Chromium qui sait aussi le mp4 : webm reste préféré (flux continu éprouvé)", () => {
  assert.equal(pickMimeType(CHROME_NEW, { chromium: true }).container, "webm");
  assert.equal(pickMimeType(CHROME_NEW, { chromium: false }).container, "mp4");
});

test("réglage Format : forcer mp4, webm ou webm-h264", () => {
  assert.equal(pickMimeType(CHROME_NEW, { preference: "mp4", chromium: true }).container, "mp4");
  assert.equal(pickMimeType(SAFARI, { preference: "webm" }).container, "mp4");
  const h264 = pickMimeType(CHROME_ANDROID_OLD, { preference: "webm-h264", chromium: true });
  assert.equal(h264.mime, "video/webm;codecs=h264,opus");
});

test("aucun format : null ; isTypeSupported qui lève une exception est ignoré", () => {
  assert.equal(pickMimeType(() => false, {}), null);
  const throwing = (m) => {
    if (m.startsWith("video/mp4")) throw new Error("boom");
    return m === "video/webm";
  };
  assert.equal(pickMimeType(throwing, {}).mime, "video/webm");
});

test("détection du moteur Chromium via userAgentData", () => {
  assert.equal(isChromiumEngine({ userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Not A;Brand" }] } }), true);
  assert.equal(isChromiumEngine({}), false);
});

test("taille de sortie : portrait 1080x1920, paysage 1920x1080, repli 720p", () => {
  assert.deepEqual(outputSize("portrait"), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize("landscape"), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize("portrait", QUALITY_LEVELS[1]), { width: 720, height: 1280 });
});

test("cover : jamais d'étirement, recadrage centré", () => {
  const exact = coverRect(1080, 1920, 1080, 1920);
  assert.deepEqual(exact, { sx: 0, sy: 0, sw: 1080, sh: 1920 });
  const r = coverRect(1920, 1080, 1080, 1920);
  assert.ok(Math.abs(r.sw / r.sh - 1080 / 1920) < 1e-9);
  assert.ok(Math.abs(r.sx - (1920 - r.sw) / 2) < 1e-9);
  assert.equal(r.sy, 0);
  const wide = coverRect(1440, 1080, 1080, 1920);
  assert.ok(Math.abs(wide.sw / wide.sh - 1080 / 1920) < 1e-9);
});

test("attente exponentielle plafonnée à 60 s avec gigue ±25 %", () => {
  const mid = () => 0.5;
  assert.equal(backoffDelay(0, mid), 2000);
  assert.equal(backoffDelay(1, mid), 4000);
  assert.equal(backoffDelay(3, mid), 16000);
  assert.equal(backoffDelay(10, mid), 60000);
  assert.equal(backoffDelay(10, () => 0), 45000);
  assert.equal(backoffDelay(10, () => 1), 75000);
});

test("classement des réponses d'upload", () => {
  assert.equal(classifyUploadResponse(200), "ok");
  assert.equal(classifyUploadResponse(401), "auth");
  assert.equal(classifyUploadResponse(404, "unknown_session"), "reregister");
  assert.equal(classifyUploadResponse(409, "session_closed"), "permanent");
  assert.equal(classifyUploadResponse(413), "permanent");
  assert.equal(classifyUploadResponse(0), "retry");
  assert.equal(classifyUploadResponse(502), "retry");
  assert.equal(classifyUploadResponse(507), "retry");
  assert.equal(classifyUploadResponse(422), "retry");
});

test("incrustation : date Paris avec secondes, latitude, longitude, précision", () => {
  const date = new Date("2026-10-17T10:36:07Z");
  const lines = overlayLines(date, { coords: { latitude: 48.856614, longitude: 2.352222, accuracy: 7.6 } });
  assert.equal(lines[0], "17/10/2026 12:36:07");
  assert.equal(lines[1], "Lat 48.85661  Lon 2.35222");
  assert.equal(lines[2], "Précision ±8 m");
  assert.equal(overlayLines(date, null)[1], "GPS en attente…");
});

test("échantillon GPS : vitesse et cap seulement s'ils existent", () => {
  const s = gpsSample({ timestamp: 5, coords: { latitude: 1, longitude: 2, accuracy: 3, speed: null, heading: 90, altitude: null } }, 1000);
  assert.deepEqual(s, { t: 1000, fix: 5, lat: 1, lon: 2, acc: 3, heading: 90 });
});

test("niveaux d'alerte stockage", () => {
  const GB = 1024 ** 3;
  assert.equal(storageLevel({ quota: 50 * GB, usage: GB }), "ok");
  assert.equal(storageLevel({ quota: 3 * GB, usage: 2 * GB }), "low");
  assert.equal(storageLevel({ quota: 3 * GB, usage: 2.8 * GB }), "critical");
  assert.equal(storageLevel(undefined), "ok");
});

test("horloge, identifiant de session et sha256", async () => {
  assert.equal(formatClock(75), "01:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.match(randomId(), /^[a-f0-9]{32}$/);
  const blob = new Blob(["abc"]);
  assert.equal(await sha256Hex(blob), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
