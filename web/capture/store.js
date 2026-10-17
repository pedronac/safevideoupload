/**
 * Stockage local (IndexedDB) : chaque partie enregistrée y reste jusqu'à l'accusé de réception du serveur.
 *
 * - sessions : un enregistrement continu (id, début, format, fermé ou non, nombre de parties produites)
 * - partmeta : petites fiches (taille, sha256, échantillons GPS, état) — listées souvent
 * - partblobs : les octets vidéo, lus uniquement au moment de l'envoi
 */

const DB_NAME = "safevideoupload-capture";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("partmeta", { keyPath: ["session", "idx"] });
      db.createObjectStore("partblobs", { keyPath: ["session", "idx"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction annulée"));
  });
}

export async function putSession(session) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(session);
  await done(tx);
}

export async function getSession(id) {
  const db = await openDb();
  return wrap(db.transaction("sessions").objectStore("sessions").get(id));
}

export async function listSessions() {
  const db = await openDb();
  const all = await wrap(db.transaction("sessions").objectStore("sessions").getAll());
  return all.sort((a, b) => a.startedAt - b.startedAt);
}

export async function updateSession(id, patch) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  const store = tx.objectStore("sessions");
  const current = await wrap(store.get(id));
  if (current) store.put({ ...current, ...patch });
  await done(tx);
}

export async function deleteSession(id) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").delete(id);
  await done(tx);
}

/** Écrit la fiche, les octets et le compteur de la session dans la même transaction. */
export async function putPart(meta, blob) {
  const db = await openDb();
  const tx = db.transaction(["partmeta", "partblobs", "sessions"], "readwrite");
  tx.objectStore("partmeta").put(meta);
  tx.objectStore("partblobs").put({ session: meta.session, idx: meta.idx, blob });
  const sessions = tx.objectStore("sessions");
  const current = await wrap(sessions.get(meta.session));
  if (current) sessions.put({ ...current, nextIdx: Math.max(current.nextIdx || 0, meta.idx + 1) });
  await done(tx);
}

export async function updatePartMeta(session, idx, patch) {
  const db = await openDb();
  const tx = db.transaction("partmeta", "readwrite");
  const store = tx.objectStore("partmeta");
  const current = await wrap(store.get([session, idx]));
  if (current) store.put({ ...current, ...patch });
  await done(tx);
}

export async function listPartMeta() {
  const db = await openDb();
  const all = await wrap(db.transaction("partmeta").objectStore("partmeta").getAll());
  return all.sort((a, b) => (a.session === b.session ? a.idx - b.idx : a.session < b.session ? -1 : 1));
}

export async function getPartBlob(session, idx) {
  const db = await openDb();
  const row = await wrap(db.transaction("partblobs").objectStore("partblobs").get([session, idx]));
  return row ? row.blob : null;
}

export async function deletePart(session, idx) {
  const db = await openDb();
  const tx = db.transaction(["partmeta", "partblobs"], "readwrite");
  tx.objectStore("partmeta").delete([session, idx]);
  tx.objectStore("partblobs").delete([session, idx]);
  await done(tx);
}

export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction(["sessions", "partmeta", "partblobs"], "readwrite");
  for (const name of ["sessions", "partmeta", "partblobs"]) tx.objectStore(name).clear();
  await done(tx);
}
