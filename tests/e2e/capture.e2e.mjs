/**
 * Test e2e de la page capture (Playwright + Chromium, caméra/micro factices).
 *
 *   cd tests/e2e && npm install && npx playwright install chromium && npm test
 *
 * Le serveur WHIP est simulé dans la page (un RTCPeerConnection « récepteur » répond à
 * l'offre) : on vérifie donc aussi que le flux envoyé a bien la taille du canvas.
 * Variable E2E_FAST=1 : saute le test de timeout ICE (15 s).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const captureDir = path.resolve(here, "../../web/capture");
const PASSWORD = "secret-test";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/capture-auth") {
      const ok = req.headers.authorization === `Bearer ${PASSWORD}`;
      res.writeHead(ok ? 204 : 401).end();
      return;
    }
    if (url.pathname.startsWith("/capture/")) {
      const rel = url.pathname === "/capture/" ? "index.html" : url.pathname.slice("/capture/".length);
      const file = path.join(captureDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Simule le serveur WHIP dans la page + (option) force la caméra à livrer un format donné. */
function pageMocks({ forceCamera = null, blackholeIce = false }) {
  return `
    (() => {
      const origFetch = window.fetch.bind(window);
      window.__whipCalls = [];
      window.fetch = async (url, init = {}) => {
        const u = String(url);
        const method = (init.method || "GET").toUpperCase();
        if (u.endsWith("/live/whip") && method === "POST") {
          const auth = new Headers(init.headers).get("Authorization");
          window.__whipCalls.push({ auth, hasCandidates: /a=candidate/.test(init.body || "") });
          if (auth !== "Bearer ${PASSWORD}") return new Response("refusé", { status: 401 });
          const rx = new RTCPeerConnection();
          window.__rx = rx;
          rx.ontrack = (ev) => {
            const v = document.createElement("video");
            v.muted = true; v.autoplay = true; v.playsInline = true;
            v.srcObject = new MediaStream([ev.track]);
            if (ev.track.kind === "video") window.__rxVideo = v;
            document.body.appendChild(v);
          };
          const strip = (text) => text.split(/\\r?\\n/).filter((l) => !l.startsWith("a=candidate") && !l.startsWith("a=end-of-candidates")).join("\\r\\n");
          await rx.setRemoteDescription({ type: "offer", sdp: ${blackholeIce} ? strip(init.body) : init.body });
          await rx.setLocalDescription(await rx.createAnswer());
          if (rx.iceGatheringState !== "complete") {
            await new Promise((r) => {
              rx.addEventListener("icegatheringstatechange", () => rx.iceGatheringState === "complete" && r());
              setTimeout(r, 3000);
            });
          }
          let sdp = rx.localDescription.sdp;
          if (${blackholeIce}) sdp = sdp.split(/\\r?\\n/).filter((l) => !l.startsWith("a=candidate") && !l.startsWith("a=end-of-candidates")).join("\\r\\n");
          return new Response(sdp, { status: 201, headers: { Location: "/live/whip/mock-session" } });
        }
        if (u.includes("/live/whip/") && method === "DELETE") return new Response(null, { status: 200 });
        return origFetch(url, init);
      };
      const forced = ${JSON.stringify(forceCamera)};
      if (forced) {
        const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) =>
          origGum({ ...c, video: c.video ? { width: forced.width, height: forced.height } : false });
      }
    })();
  `;
}

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${String(err.message || err).split("\n").join("\n       ")}`);
  }
}

async function newPage(browser, base, { viewport, mocks = {}, mobile = true }) {
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    permissions: ["camera", "microphone", "geolocation"],
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    locale: "fr-FR",
  });
  const page = await context.newPage();
  await page.addInitScript(pageMocks(mocks));
  page.on("pageerror", (e) => console.log("       [pageerror]", e.message));
  await page.goto(`${base}/capture/`);
  return { context, page };
}

async function unlock(page) {
  await page.fill("#gate-password", PASSWORD);
  await page.click("#gate-submit");
  await page.waitForSelector("#app:not([hidden])");
}

async function startAndMeasure(page, { select } = {}) {
  await unlock(page);
  if (select) await page.selectOption("#orientation", select);
  await page.click("#btn-start");
  await page.waitForFunction(() => document.querySelector("#framing")?.textContent.includes("Caméra"), null, {
    timeout: 20000,
  });
  const info = await page.evaluate(() => {
    const c = document.getElementById("overlay-canvas");
    const frame = document.getElementById("preview-frame");
    return {
      canvas: { width: c.width, height: c.height },
      framing: document.getElementById("framing").textContent,
      aspectRatio: getComputedStyle(frame).aspectRatio,
      track: window.__capture.composedStream.getVideoTracks()[0].getSettings(),
    };
  });
  return info;
}

async function receivedSize(page) {
  await page.waitForFunction(() => window.__rxVideo && window.__rxVideo.videoWidth > 0, null, { timeout: 20000 });
  return page.evaluate(() => ({ width: window.__rxVideo.videoWidth, height: window.__rxVideo.videoHeight }));
}

async function cornerLuma(page) {
  return page.evaluate(() => {
    const c = document.getElementById("overlay-canvas");
    const g = c.getContext("2d");
    const pts = [
      [4, 4],
      [c.width - 5, 4],
      [Math.floor(c.width / 2), Math.floor(c.height * 0.3)],
      [4, Math.floor(c.height / 2)],
      [c.width - 5, Math.floor(c.height / 2)],
    ];
    return pts.map(([x, y]) => {
      const [r, gg, b] = g.getImageData(x, y, 1, 1).data;
      return r + gg + b;
    });
  });
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});

console.log("Page capture — tests e2e");

await test("verrouillage : UI cachée, mot de passe vérifié, jamais dans l'URL", async () => {
  const { context, page } = await newPage(browser, base, { viewport: { width: 390, height: 844 } });
  assert.equal(await page.isVisible("#gate"), true);
  assert.equal(await page.isVisible("#app"), false);
  assert.equal(await page.isChecked("#gate-remember"), false, "« Se souvenir » doit être décoché par défaut");
  await page.fill("#gate-password", "mauvais");
  await page.click("#gate-submit");
  await page.waitForFunction(() => document.getElementById("gate-error").textContent.includes("incorrect"));
  assert.equal(await page.isVisible("#app"), false);
  await unlock(page);
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("captureToken")), PASSWORD);
  assert.equal(await page.evaluate(() => localStorage.getItem("captureToken")), null);
  assert.equal(await page.evaluate(() => document.cookie), "");
  await context.close();
});

await test("« Se souvenir » coché : localStorage, déverrouillage au rechargement", async () => {
  const { context, page } = await newPage(browser, base, { viewport: { width: 390, height: 844 } });
  await page.check("#gate-remember");
  await unlock(page);
  assert.equal(await page.evaluate(() => localStorage.getItem("captureToken")), PASSWORD);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("captureToken")), null);
  const second = await context.newPage();
  await second.goto(`${base}/capture/`);
  await second.waitForSelector("#app:not([hidden])");
  await context.close();
});

await test("sans « Se souvenir » : un nouvel onglet redemande le mot de passe", async () => {
  const { context, page } = await newPage(browser, base, { viewport: { width: 390, height: 844 } });
  await unlock(page);
  const second = await context.newPage();
  await second.goto(`${base}/capture/`);
  await second.waitForSelector("#gate:not([hidden])");
  assert.equal(await second.isVisible("#app"), false);
  await context.close();
});

const scenarios = [
  {
    name: "portrait (390x844, Auto) -> sortie 720x1280 sans bandes",
    viewport: { width: 390, height: 844 },
    expect: { width: 720, height: 1280 },
  },
  {
    name: "paysage (844x390, Auto) -> sortie 1280x720",
    viewport: { width: 844, height: 390 },
    expect: { width: 1280, height: 720 },
  },
  {
    name: "téléphone en portrait + choix Paysage -> 1280x720",
    viewport: { width: 390, height: 844 },
    select: "landscape",
    expect: { width: 1280, height: 720 },
  },
  {
    name: "téléphone en paysage + choix Portrait -> 720x1280",
    viewport: { width: 844, height: 390 },
    select: "portrait",
    expect: { width: 720, height: 1280 },
  },
  {
    name: "caméra qui s'obstine en paysage (cas Android) en portrait -> recadrage centré 720x1280",
    viewport: { width: 390, height: 844 },
    mocks: { forceCamera: { width: 1280, height: 720 } },
    expect: { width: 720, height: 1280 },
    cropped: true,
  },
  {
    name: "caméra 4:3 (640x480) en paysage -> 960x720, aucun recadrage ni déformation",
    viewport: { width: 844, height: 390 },
    mocks: { forceCamera: { width: 640, height: 480 } },
    expect: { width: 960, height: 720 },
  },
];

for (const sc of scenarios) {
  await test(sc.name, async () => {
    const { context, page } = await newPage(browser, base, { viewport: sc.viewport, mocks: sc.mocks });
    const info = await startAndMeasure(page, { select: sc.select });
    assert.deepEqual(info.canvas, sc.expect, `canvas: ${JSON.stringify(info)}`);
    const ratio = sc.expect.width / sc.expect.height;
    const [aw, ah] = info.aspectRatio.split("/").map((n) => Number(n.trim()));
    assert.ok(Math.abs(aw / ah - ratio) < 0.01, `aspect-ratio CSS ${info.aspectRatio}`);
    assert.match(info.framing, new RegExp(`sortie ${sc.expect.width}x${sc.expect.height}`));
    if (sc.cropped) assert.match(info.framing, /recadrage centré/);
    else assert.doesNotMatch(info.framing, /recadrage/);
    assert.ok(Math.abs(info.track.width / info.track.height - ratio) < 0.02, "piste canvas");

    await page.waitForFunction(() => document.getElementById("net-connection").textContent === "connecté", null, {
      timeout: 20000,
    });
    assert.match(await page.textContent("#status"), /EN DIRECT/);
    const rx = await receivedSize(page);
    // WebRTC démarre en résolution réduite (adaptation de débit) : on compare donc le ratio.
    assert.ok(
      Math.abs(rx.width / rx.height - ratio) < 0.02,
      `le flux reçu doit avoir le ratio du canvas (reçu ${rx.width}x${rx.height})`,
    );

    const calls = await page.evaluate(() => window.__whipCalls);
    assert.equal(calls[0].auth, `Bearer ${PASSWORD}`);
    assert.equal(calls[0].hasCandidates, true, "l'offre WHIP doit contenir les candidats ICE");
    assert.doesNotMatch(page.url(), /token|password/i);

    const luma = await cornerLuma(page);
    assert.ok(
      luma.every((v) => v > 30),
      `bandes noires détectées (luma des coins) : ${luma}`,
    );
    await context.close();
  });
}

await test("taille du canvas jamais modifiée en cours de diffusion", async () => {
  const { context, page } = await newPage(browser, base, { viewport: { width: 390, height: 844 } });
  const first = await startAndMeasure(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__capture.canvasSize);
  assert.deepEqual(after, first.canvas);
  await context.close();
});

await test("incrustation GPS/heure visible en portrait et en paysage", async () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const { context, page } = await newPage(browser, base, { viewport });
    await startAndMeasure(page);
    await page.waitForTimeout(800);
    const bright = await page.evaluate(() => {
      const c = document.getElementById("overlay-canvas");
      const g = c.getContext("2d");
      const area = g.getImageData(0, Math.floor(c.height * 0.85), Math.floor(c.width * 0.8), Math.floor(c.height * 0.14));
      let white = 0;
      for (let i = 0; i < area.data.length; i += 4) {
        if (area.data[i] > 235 && area.data[i + 1] > 235 && area.data[i + 2] > 235) white += 1;
      }
      return white;
    });
    assert.ok(bright > 200, `texte blanc introuvable (${bright} px) pour ${JSON.stringify(viewport)}`);
    await context.close();
  }
});

if (!process.env.E2E_FAST) {
  await test("ICE qui n'aboutit pas : état réel + message français après ~15 s, pas de « EN DIRECT »", async () => {
    const { context, page } = await newPage(browser, base, {
      viewport: { width: 390, height: 844 },
      mocks: { blackholeIce: true },
    });
    await startAndMeasure(page);
    await page.waitForFunction(() => document.getElementById("net-error").textContent.includes("8189"), null, {
      timeout: 25000,
    });
    const status = await page.textContent("#status");
    assert.doesNotMatch(status, /EN DIRECT/);
    assert.notEqual(await page.textContent("#net-connection"), "connecté");
    assert.match(await page.textContent("#net-error"), /UDP/);
    await context.close();
  });
}

await test("mot de passe refusé par WHIP : la page se reverrouille", async () => {
  const { context, page } = await newPage(browser, base, { viewport: { width: 390, height: 844 } });
  await unlock(page);
  await page.evaluate((v) => sessionStorage.setItem("captureToken", v), "autre");
  await page.click("#btn-start");
  await page.waitForSelector("#gate:not([hidden])", { timeout: 20000 });
  assert.equal(await page.isVisible("#app"), false);
  await context.close();
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests réussis`);
process.exit(failed.length ? 1 : 0);
