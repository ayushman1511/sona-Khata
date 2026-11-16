// MOCK UPI. No real payment happens, and no bank, PSP or NPCI system is contacted.
// It returns a fake reference prefixed "MOCK-UPI-" so a mock can never be mistaken for a real payment.
// The organisers allow mock integrations "wherever public or banking systems lack open interfaces",
// provided they are clearly labelled.

export const IS_MOCK = true;
export const LABEL = 'MOCK UPI: simulated, no money moves';

let n = 0;
/** @param {{amountPaise:number, payeeVpa:string, note?:string, simulateFailure?:boolean}} req */
export async function mockUpiPay({ amountPaise, payeeVpa, note = '', simulateFailure = false }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('amountPaise must be a positive integer');
  if (!/^[\w.-]+@[\w.-]+$/.test(payeeVpa ?? '')) throw new Error('payee VPA looks invalid (expected name@handle)');
  await new Promise((r) => setTimeout(r, 50));
  if (simulateFailure) throw new Error('MOCK UPI: simulated timeout from the bank. Nothing was debited; retry after approval');
  n += 1;
  return { mock: true, status: 'SUCCESS', reference: `MOCK-UPI-${Date.now().toString(36).toUpperCase()}-${n}`, amountPaise, payeeVpa, note };
}
