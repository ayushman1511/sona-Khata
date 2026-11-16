// Offline persistence in IndexedDB. CryptoKey objects are stored directly (structured clone), and
// private keys are generated non-extractable, so their raw bytes cannot be read out by app code.
const DB = 'karigar-ledger', STORE = 'kv', VERSION = 1;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
}
export const load = (key) => tx('readonly', (s) => s.get(key));
export const save = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const clearAll = () => tx('readwrite', (s) => s.clear());
