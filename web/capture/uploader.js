/**
 * File d'envoi : parties stockées dans IndexedDB -> serveur, une à la fois, dans l'ordre.
 *
 * - Idempotent : session + index + taille + sha256 ; renvoyer une partie déjà reçue répond OK.
 * - Une partie n'est supprimée du téléphone qu'après l'accusé de réception (HTTP 200) du serveur.
 * - Échecs réseau / 5xx : nouvel essai avec attente exponentielle (2 s … 60 s) ; l'enregistrement
 *   n'est jamais interrompu. L'événement « online » relance immédiatement.
 */

import * as store from "./store.js";
import { backoffDelay, classifyUploadResponse, sha256Hex } from "./lib.js";

const IDLE_POLL_MS = 5_000;
const OFFLINE_POLL_MS = 10_000;
const AUTH_POLL_MS = 3_000;

class RetryableError extends Error {}

function xhrRequest(method, url, body, { headers = {}, onProgress, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = timeoutMs;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    const finish = (networkError) => {
      let json = null;
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        json = null;
      }
      resolve({ status: networkError ? 0 : xhr.status, json, networkError });
    };
    xhr.onload = () => finish(false);
    xhr.onerror = () => finish(true);
    xhr.ontimeout = () => finish(true);
    xhr.onabort = () => finish(true);
    xhr.send(body);
  });
}

export class Uploader {
  /**
   * @param {{getToken: () => string, onChange?: (state: object) => void,
   *          onAuthRejected?: () => void, onPermanentFailure?: (info: object) => void,
   *          onPartAcked?: (info: object) => void}} options
   */
  constructor({ getToken, onChange = () => {}, onAuthRejected = () => {}, onPermanentFailure = () => {}, onPartAcked = () => {} }) {
    this.getToken = getToken;
    this.onChange = onChange;
    this.onAuthRejected = onAuthRejected;
    this.onPermanentFailure = onPermanentFailure;
    this.onPartAcked = onPartAcked;
    this.attempt = 0;
    this.wake = null;
    this.running = false;
    this.rejectedToken = null;
    this.state = {
      status: "idle",
      lastError: "",
      inFlight: null,
      uploadedParts: 0,
      uploadedBytes: 0,
      failedParts: 0,
      lastSuccessAt: 0,
      nextRetryAt: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener("online", () => this.kick(true));
    this._run();
  }

  kick(resetBackoff = false) {
    if (resetBackoff) this.attempt = 0;
    this.wake?.();
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.onChange({ ...this.state });
  }

  _sleep(ms) {
    this._set({ nextRetryAt: ms > 6_000 ? Date.now() + ms : 0 });
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async _run() {
    for (;;) {
      let delay = IDLE_POLL_MS;
      try {
        const progressed = await this._step();
        if (progressed === "work") {
          this.attempt = 0;
          continue;
        }
        if (progressed === "offline") delay = OFFLINE_POLL_MS;
        else if (progressed === "auth") delay = AUTH_POLL_MS;
      } catch (err) {
        this.attempt += 1;
        delay = backoffDelay(this.attempt - 1);
        this._set({ status: "retry", lastError: err.message || "Envoi impossible", inFlight: null });
      }
      await this._sleep(delay);
    }
  }

  async _step() {
    const token = this.getToken();
    if (!token || token === this.rejectedToken) {
      const pending = (await store.listPartMeta()).some((m) => m.state === "pending");
      this._set({ status: pending ? "auth" : "idle", inFlight: null });
      return "auth";
    }
    if (navigator.onLine === false) {
      this._set({ status: "offline", inFlight: null });
      return "offline";
    }
    const sessions = await store.listSessions();
    const metas = await store.listPartMeta();
    this._set({ failedParts: metas.filter((m) => m.state === "failed").length });
    for (const session of sessions) {
      const own = metas.filter((m) => m.session === session.id);
      const pending = own.filter((m) => m.state === "pending");
      if (!session.registered && (pending.length || session.closed)) {
        await this._register(session, token);
        return "work";
      }
      if (pending.length) {
        await this._uploadPart(session, pending[0], token);
        return "work";
      }
      if (session.closed && own.length === 0) {
        if (session.nextIdx === 0) {
          await store.deleteSession(session.id);
        } else {
          await this._close(session, token);
        }
        return "work";
      }
    }
    this._set({ status: "idle", inFlight: null, lastError: "" });
    return "idle";
  }

  _auth(token) {
    return { Authorization: `Bearer ${token}` };
  }

  _handle(res, what) {
    const kind = classifyUploadResponse(res.status, res.json?.error);
    if (res.networkError) throw new RetryableError("Pas de réseau");
    if (kind === "auth") {
      this.rejectedToken = this.getToken();
      this._set({ status: "auth", lastError: "Mot de passe refusé par le serveur" });
      this.onAuthRejected();
      throw new RetryableError("Mot de passe refusé par le serveur");
    }
    if (kind === "retry") {
      const detail = res.json?.message ? ` — ${res.json.message}` : "";
      throw new RetryableError(`Serveur indisponible (HTTP ${res.status})${detail}`);
    }
    return kind;
  }

  async _register(session, token) {
    const body = JSON.stringify({
      session: session.id,
      group: session.group,
      started_at_ms: session.startedAt,
      mime: session.mime,
      width: session.width,
      height: session.height,
      device: session.device,
    });
    const res = await xhrRequest("POST", "/api/upload/session", body, {
      headers: { ...this._auth(token), "Content-Type": "application/json" },
      timeoutMs: 30_000,
    });
    const kind = this._handle(res, "session");
    if (kind === "permanent") throw new RetryableError(`Session refusée par le serveur (${res.json?.error || res.status})`);
    await store.updateSession(session.id, { registered: true });
  }

  async _close(session, token) {
    const res = await xhrRequest("POST", `/api/upload/${session.id}/close`, JSON.stringify({ total_parts: session.nextIdx }), {
      headers: { ...this._auth(token), "Content-Type": "application/json" },
      timeoutMs: 30_000,
    });
    const kind = this._handle(res, "close");
    if (kind === "reregister") {
      await store.updateSession(session.id, { registered: false });
      return;
    }
    await store.deleteSession(session.id);
  }

  async _uploadPart(session, meta, token) {
    const blob = await store.getPartBlob(meta.session, meta.idx);
    if (!blob) {
      await store.deletePart(meta.session, meta.idx);
      return;
    }
    let sha = meta.sha256;
    if (!sha) {
      sha = await sha256Hex(blob);
      await store.updatePartMeta(meta.session, meta.idx, { sha256: sha });
    }
    if (meta.gps?.length && !meta.gpsSent) {
      const gres = await xhrRequest(
        "PUT",
        `/api/upload/${meta.session}/gps/${meta.idx}`,
        JSON.stringify({ samples: meta.gps }),
        { headers: { ...this._auth(token), "Content-Type": "application/json" }, timeoutMs: 30_000 },
      );
      const gkind = this._handle(gres, "gps");
      if (gkind === "reregister") {
        await store.updateSession(session.id, { registered: false });
        return;
      }
      if (gkind === "ok") await store.updatePartMeta(meta.session, meta.idx, { gpsSent: true });
    }
    this._set({ status: "uploading", inFlight: { session: meta.session, idx: meta.idx, loaded: 0, total: blob.size } });
    const timeoutMs = Math.max(120_000, Math.round(blob.size / 20));
    const res = await xhrRequest("PUT", `/api/upload/${meta.session}/part/${meta.idx}`, blob, {
      headers: {
        ...this._auth(token),
        "Content-Type": "application/octet-stream",
        "X-Part-Sha256": sha,
        "X-Part-Size": String(blob.size),
      },
      timeoutMs,
      onProgress: (loaded, total) => this._set({ inFlight: { session: meta.session, idx: meta.idx, loaded, total } }),
    });
    const kind = this._handle(res, "part");
    if (kind === "reregister") {
      await store.updateSession(session.id, { registered: false });
      return;
    }
    if (kind === "permanent") {
      const reason = res.json?.message || res.json?.error || `HTTP ${res.status}`;
      await store.updatePartMeta(meta.session, meta.idx, { state: "failed", error: reason });
      this.onPermanentFailure({ session: meta.session, idx: meta.idx, reason });
      return;
    }
    await store.deletePart(meta.session, meta.idx);
    this._set({
      status: "uploading",
      inFlight: null,
      lastError: "",
      lastSuccessAt: Date.now(),
      uploadedParts: this.state.uploadedParts + 1,
      uploadedBytes: this.state.uploadedBytes + blob.size,
    });
    this.onPartAcked({ session: meta.session, idx: meta.idx, size: blob.size });
  }
}
