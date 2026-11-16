// Units. Every quantity is an integer, so nothing in the ledger is ever a float.
//
//   weight     -> milligrams (mg), integer >= 0
//   purity     -> fineness in parts per thousand (‰), integer 1..1000
//                 e.g. 999 / 995 (24K bar), 916 (22K), 750 (18K)
//   fine gold  -> micrograms of pure gold (µg), integer.
//                 fineUg = grossMg * fineness, exactly, with no rounding:
//                 mg × (‰/1000) = mg-fine, and ×1000 gives µg.
//   wastage    -> basis points (bp), integer 0..10000 (250 bp = 2.50 %)
//   money      -> paise, integer
//   rates      -> paise per gram (labour per gram, gold rate per gram fine)

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function assertInt(name, v, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isSafeInteger(v)) throw new LedgerError('NOT_INTEGER', `${name} must be a safe integer, got ${v}`);
  if (v < min || v > max) throw new LedgerError('OUT_OF_RANGE', `${name}=${v} outside [${min}, ${max}]`);
  return v;
}

export const assertMg = (name, v) => assertInt(name, v, { min: 0, max: 100_000_000 }); // up to 100 kg
export const assertFineness = (name, v) => assertInt(name, v, { min: 1, max: 1000 });
export const assertBp = (name, v) => assertInt(name, v, { min: 0, max: 10_000 });
export const assertPaise = (name, v) => assertInt(name, v);

/** Exact fine gold in µg. */
export function fineUg(grossMg, fineness) {
  assertMg('grossMg', grossMg);
  assertFineness('fineness', fineness);
  return grossMg * fineness;
}

/**
 * Parse a weight typed or spoken in grams ("12.345", "12,345 g", "0.5") to integer mg.
 * Uses string arithmetic, so "12.345" -> 12345 and floats never touch it.
 * More than 3 decimal places is rejected rather than silently rounded.
 */
export function parseGramsToMg(input) {
  const s = String(input).trim().replace(/\s*(g|gm|gms|gram|grams)$/i, '').replace(/,/g, '.');
  const m = /^(\d{1,6})(?:\.(\d{0,3}))?$/.exec(s);
  if (!m) throw new LedgerError('BAD_WEIGHT', `Cannot read weight "${input}" (max 3 decimals, in grams)`);
  const whole = Number(m[1]);
  const frac = Number((m[2] || '').padEnd(3, '0'));
  return whole * 1000 + frac;
}

/** Parse rupees ("1250", "1250.5", "1,250.50") to integer paise. */
export function parseRupeesToPaise(input) {
  const s = String(input).trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const m = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new LedgerError('BAD_MONEY', `Cannot read amount "${input}"`);
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

/** Parse a percentage ("2.5", "2.50 %") to basis points. */
export function parsePercentToBp(input) {
  const s = String(input).trim().replace(/\s*%$/, '');
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new LedgerError('BAD_PERCENT', `Cannot read percent "${input}"`);
  return assertBp('percent', Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')));
}

/** Integer division rounding half away from zero. Pass a BigInt numerator when the product may exceed 2^53. */
export function divRound(num, den) {
  const n = BigInt(num), d = BigInt(den);
  if (d <= 0n) throw new LedgerError('BAD_DIVISOR', 'divisor must be > 0');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return assertInt('result', Number(neg ? -q : q));
}

/** Integer division rounding up, towards +infinity (BigInt-safe). */
export function divCeil(num, den) {
  const n = BigInt(num), d = BigInt(den);
  if (d <= 0n) throw new LedgerError('BAD_DIVISOR', 'divisor must be > 0');
  const q = n / d;
  const r = Number(n % d > 0n ? q + 1n : q);
  return assertInt('result', r);
}

/** mg -> "12.345 g" */
export function formatMg(mg) {
  const sign = mg < 0 ? '-' : '';
  const a = Math.abs(mg);
  return `${sign}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')} g`;
}

/** µg fine -> "11.308 g" (shown to the nearest mg, half away from zero; the stored value stays exact). */
export function formatFineUg(ug) {
  return formatMg(divRound(ug, 1000));
}

/** µg fine -> "11.308 456 g" (exact, for audit views). */
export function formatFineUgExact(ug) {
  const sign = ug < 0 ? '-' : '';
  const a = Math.abs(ug);
  const g = Math.floor(a / 1_000_000);
  const rest = String(a % 1_000_000).padStart(6, '0');
  return `${sign}${g}.${rest.slice(0, 3)} ${rest.slice(3)} g`;
}

export function formatPaise(p) {
  const sign = p < 0 ? '-' : '';
  const a = Math.abs(p);
  const r = String(Math.floor(a / 100)).replace(/\B(?=(\d{2})+(\d)(?!\d))/g, ','); // Indian grouping
  return `${sign}₹${r}.${String(a % 100).padStart(2, '0')}`;
}

export const formatBp = (bp) => `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;
