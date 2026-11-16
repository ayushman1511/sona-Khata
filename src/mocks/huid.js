// MOCK hallmarking/HUID lookup. It does NOT contact BIS or any hallmarking centre, and the results are fabricated placeholders.
// The only real thing here is the format check: a HUID is a 6-character alphanumeric code.
// The HUID is not used in any reconciliation maths. It is stored as a label on a returned piece.

export const IS_MOCK = true;
export const LABEL = 'MOCK HUID: no BIS lookup, placeholder result';

export function isHuidFormat(code) {
  return /^[A-Z0-9]{6}$/.test(String(code ?? '').toUpperCase());
}

export async function mockHuidLookup(code) {
  const huid = String(code ?? '').toUpperCase();
  if (!isHuidFormat(huid)) return { mock: true, ok: false, huid, message: 'Not a 6-character alphanumeric HUID' };
  return { mock: true, ok: true, huid, message: 'MOCK: format valid. No real hallmark record was checked.' };
}
