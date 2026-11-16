import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/core/gate.js';
import { planActions, evidencePack } from '../src/core/agent.js';
import { deriveState, proposeSettlementFigures } from '../src/core/ledger.js';
import * as upi from '../src/mocks/upi.js';
import * as huid from '../src/mocks/huid.js';
import * as speech from '../src/mocks/speech.js';
import * as wa from '../src/mocks/whatsapp.js';
import { setup, ISSUE_10G, RETURN_FULL } from './helpers.js';

test('gate: an action never runs before every required human approves', async () => {
  const g = new ApprovalGate();
  let ran = 0;
  const p = g.propose({ kind: 'PAY_VIA_UPI_MOCK', key: 'k', summary: 's', requires: ['jeweller', 'karigar'], goldOrMoney: true, run: async () => { ran++; return 'ok'; } });
  assert.equal(p.status, 'awaiting_approval');
  await g.approve(p.id, 'jeweller');
  assert.equal(ran, 0);
  assert.equal(p.status, 'awaiting_approval');
  await g.approve(p.id, 'karigar');
  assert.equal(ran, 1);
  assert.equal(p.status, 'done');
  await assert.rejects(g.approve(p.id, 'jeweller'), /done/); // cannot run twice
  assert.equal(ran, 1);
});

test('gate: rejection stops it; outsiders cannot approve; empty approver lists are refused', async () => {
  const g = new ApprovalGate();
  let ran = 0;
  const p = g.propose({ kind: 'X', key: 'a', summary: 's', requires: ['jeweller'], run: async () => ran++ });
  await assert.rejects(g.approve(p.id, 'karigar'), /not an approver/);
  g.reject(p.id, 'jeweller', 'not now');
  await assert.rejects(g.approve(p.id, 'jeweller'));
  assert.equal(ran, 0);
  assert.throws(() => g.propose({ kind: 'X', key: 'b', summary: 's', requires: [], run: async () => {} }), /approver/);
});

test('gate: a failure is kept, and a retry needs a NEW approval', async () => {
  const g = new ApprovalGate();
  let attempts = 0;
  const p = g.propose({ kind: 'PAY_VIA_UPI_MOCK', key: 'k', summary: 's', requires: ['jeweller'], goldOrMoney: true,
    run: () => upi.mockUpiPay({ amountPaise: 100, payeeVpa: 'karigar@mock', simulateFailure: attempts++ === 0 }) });
  await g.approve(p.id, 'jeweller');
  assert.equal(p.status, 'failed');
  assert.match(p.error, /simulated timeout/);
  g.reopen(p.id);
  assert.equal(p.status, 'awaiting_approval');
  assert.equal(attempts, 1); // reopening did not run anything
  await g.approve(p.id, 'jeweller');
  assert.equal(p.status, 'done');
  assert.match(p.result.reference, /^MOCK-UPI-/);
});

test('gate: the same situation is not proposed twice', () => {
  const g = new ApprovalGate();
  const a = g.propose({ kind: 'X', key: 'same', summary: 's', requires: ['jeweller'], run: async () => {} });
  const b = g.propose({ kind: 'X', key: 'same', summary: 's', requires: ['jeweller'], run: async () => {} });
  assert.equal(a, b);
  assert.equal(g.list().length, 1);
});

test('agent: proposes the next steps of the case, and every gold/money step requires a human', async () => {
  const L = await setup();
  const job = await L.add('jeweller', 'ISSUE', { ...ISSUE_10G, wastageBp: 50, dueDate: '2026-11-18' });
  let acts = planActions(deriveState(L.chain, { today: '2026-11-17' }), { today: '2026-11-17' });
  assert.deepEqual(acts.map((a) => a.kind), ['CHASE_APPROVAL']); // waiting for the karigar to acknowledge

  await L.approve('karigar', job);
  acts = planActions(deriveState(L.chain, { today: '2026-11-17' }), { today: '2026-11-17' });
  assert.ok(acts.some((a) => a.kind === 'REMIND_DEADLINE'));

  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const s = deriveState(L.chain, { today: '2026-11-17' });
  acts = planActions(s, { today: '2026-11-17' });
  const kinds = acts.map((a) => a.kind);
  assert.ok(kinds.includes('REVIEW_WASTAGE'));
  assert.ok(kinds.includes('REFINER_FOLLOWUP'));
  assert.ok(kinds.includes('PROPOSE_SETTLEMENT'));
  for (const a of acts) assert.ok(a.requires.includes('jeweller'), `${a.kind} must need a human`);
  for (const a of acts.filter((x) => ['REVIEW_WASTAGE', 'PROPOSE_SETTLEMENT', 'PAY_VIA_UPI_MOCK', 'REFINER_FOLLOWUP'].includes(x.kind))) assert.equal(a.goldOrMoney, true);
  assert.match(acts.find((a) => a.kind === 'REVIEW_WASTAGE').summary, /not an accusation/);
});

test('agent: after settlement it proposes a MOCK UPI payment, then stops once paid', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const st = await L.both('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain)));
  let acts = planActions(deriveState(L.chain), {});
  const pay = acts.find((a) => a.kind === 'PAY_VIA_UPI_MOCK');
  assert.ok(pay);
  assert.equal(pay.data.amountPaise, 372_750);
  assert.match(pay.summary, /MOCK UPI/);
  assert.ok(!acts.some((a) => a.kind === 'PROPOSE_SETTLEMENT')); // nothing new to settle
  await L.both('jeweller', 'PAYMENT', { settlement: st, amountPaise: 372_750, method: 'UPI_MOCK', reference: 'MOCK-UPI-X' });
  acts = planActions(deriveState(L.chain), {});
  assert.ok(!acts.some((a) => a.kind === 'PAY_VIA_UPI_MOCK'));
});

test('agent: evidence pack lists only signed facts', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, wastageBp: 50 });
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const ev = evidencePack(deriveState(L.chain), job);
  assert.equal(ev.entryIds.length, 2);
  assert.ok(ev.lines.some((l) => l.includes('0.008 g'))); // 8.423 mg above the allowance
});

test('mocks are labelled as mocks', async () => {
  for (const m of [upi, huid, speech, wa]) { assert.equal(m.IS_MOCK, true); assert.match(m.LABEL, /^MOCK/); }
  const r = await upi.mockUpiPay({ amountPaise: 1, payeeVpa: 'a@b' });
  assert.equal(r.mock, true);
  assert.match(r.reference, /^MOCK-UPI-/);
  assert.equal((await huid.mockHuidLookup('AB12CD')).mock, true);
  assert.equal(huid.isHuidFormat('AB12C'), false);
  assert.equal(wa.messageFor('hi', 'PAYMENT', { amountPaise: 100, method: 'UPI_MOCK' }).mock, true);
  assert.match(wa.messageFor('hi', 'PAYMENT', { amountPaise: 100, method: 'UPI_MOCK' }).text, /नकली UPI/);
});

test('mock speech keyword matcher: "no" wins over "yes"', () => {
  assert.equal(speech.mockUnderstand('haan').intent, 'approve');
  assert.equal(speech.mockUnderstand('हाँ, सही है').intent, 'approve');
  assert.equal(speech.mockUnderstand('nahi').intent, 'reject');
  assert.equal(speech.mockUnderstand('theek nahi hai').intent, 'reject');
  assert.equal(speech.mockUnderstand('नहीं').intent, 'reject');
  assert.equal(speech.mockUnderstand('do din aur lagenge, 6.2 gram ho gaya').intent, 'progress');
  assert.equal(speech.mockUnderstand('do din aur lagenge, 6.2 gram ho gaya').gramsMentioned, '6.2');
  assert.equal(speech.mockUnderstand('').intent, 'unknown');
});

test('agent: no settlement proposal when nothing is owed and the gold is only in open jobs', async () => {
  const L = await setup();
  await L.both('jeweller', 'ISSUE', ISSUE_10G); // open job, no labour earned yet
  const acts = planActions(deriveState(L.chain), {});
  assert.ok(!acts.some((a) => a.kind === 'PROPOSE_SETTLEMENT'));
});

test('agent: a resolved wastage review is not proposed again', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, wastageBp: 50 });
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const d = await L.add('jeweller', 'DISPUTE', { target: job, reason: 'joint review' });
  await L.both('jeweller', 'DISPUTE_RESOLUTION', { dispute: d, outcome: 'agreed_as_recorded', note: 'ok' });
  assert.ok(!planActions(deriveState(L.chain), {}).some((a) => a.kind === 'REVIEW_WASTAGE'));
});
