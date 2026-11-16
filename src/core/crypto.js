// Canonical JSON, SHA-256 and ECDSA P-256 signatures using only WebCrypto.
// This works unchanged in Node >= 20 and in any modern browser (including Android Chrome),
// so the phone and the tests run exactly the same code.

import { LedgerError } from './units.js';

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('WebCrypto (crypto.subtle) is required; serve the PWA over https or localhost');

/**
 * Deterministic JSON: object keys are sorted, there is no whitespace, and only integers,
 * strings, booleans, null, arrays and plain objects are allowed. Floats are rejected
 * because a float in a gold ledger is a bug.
 */
export function canonical(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new LedgerError('NON_CANONICAL', `non-integer number ${value} in ledger data`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    default:
      throw new LedgerError('NON_CANONICAL', `unsupported type ${typeof value}`);
  }
}

const enc = new TextEncoder();
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

export async function sha256Hex(str) {
  return toHex(await subtle.digest('SHA-256', enc.encode(str)));
}

export const hashOf = (value) => sha256Hex(canonical(value));

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/** New key pair for one party on one device. The private key is non-extractable. */
export async function generateKeyPair() {
  const kp = await subtle.generateKey(ALG, false, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

export async function signHex(privateKey, message) {
  return toHex(await subtle.sign(SIGN, privateKey, enc.encode(message)));
}

const keyCache = new Map();
async function importPublic(jwk) {
  const id = canonical(jwk);
  if (!keyCache.has(id)) keyCache.set(id, subtle.importKey('jwk', { ...jwk, ext: true }, ALG, true, ['verify']));
  return keyCache.get(id);
}

export async function verifyHex(publicJwk, message, sigHex) {
  try {
    return await subtle.verify(SIGN, await importPublic(publicJwk), fromHex(sigHex), enc.encode(message));
  } catch {
    return false;
  }
}

export function randomNonce() {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}
