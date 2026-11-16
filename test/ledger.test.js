import { test } from 'node:test';
import assert from 'node:assert/strict';
import { append, verifyChain, deriveState, mergeChains, divergence, createItem, proposeSettlementFigures } from '../src/core/ledger.js';
import { generateKeyPair } from '../src/core/crypto.js';
import { setup, ISSUE_10G, RETURN_FULL, CONSENT, TERMS } from './helpers.js';

const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

test('account must start with OPEN_ACCOUNT and be accepted by the karigar before anything else', async () => {
  const keys = { jeweller: await generateKeyPair(), karigar: await generateKeyPair() };
  const mk = (author, type, payload) => createItem({ account: 'a', author, type, payload, privateKey: keys[author].privateKey });
  await rejects(append([], await mk('jeweller', 'ISSUE', ISSUE_10G)), 'NO_GENESIS');
  const open = await mk('jeweller', 'OPEN_ACCOUNT', { parties: { jeweller: { name: 'J', publicJwk: keys.jeweller.publicJwk }, karigar: { name: 'K', publicJwk: keys.karigar.publicJwk } }, terms: TERMS, consent: CONSENT });
  const chain = await append([], open);
  await rejects(append(chain, await mk('jeweller', 'ISSUE', ISSUE_10G)), 'ACCOUNT_NOT_OPEN');
  assert.equal(deriveState(chain).accountOpen, false);
});

test('an issue has NO effect on balances until the karigar approves it', async () => {
  const L = await setup();
  const job = await L.add('jeweller', 'ISSUE', ISSUE_10G);
  let s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, 0);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].waitingFor, 'karigar');
  await L.approve('karigar', job);
  s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, 9_950_000);
  assert.equal(s.pending.length, 0);
});

test('only the jeweller can issue gold; nobody can approve their own entry or approve twice', async () => {
  const L = await setup();
  await assert.rejects(L.item('karigar', 'ISSUE', ISSUE_10G), (e) => e.code === 'NOT_ALLOWED');
  const job = await L.add('jeweller', 'ISSUE', ISSUE_10G);
  await rejects(L.approve('jeweller', job), 'SELF_APPROVAL');
  await L.approve('karigar', job);
  await rejects(L.approve('karigar', job), 'ALREADY_DECIDED');
});

test('a rejected issue never counts, and the reason is kept', async () => {
  const L = await setup();
  const job = await L.add('jeweller', 'ISSUE', ISSUE_10G);
  await L.add('karigar', 'REJECT', { target: job, reason: 'I received 9.950 g, not 10.000 g' });
  const s = deriveState(L.chain);
  assert.equal(s.statusOf(job), 'rejected');
  assert.equal(s.goldBalanceUg, 0);
  assert.match(s.get(job).rejected.reason, /9.950/);
  await rejects(L.add('jeweller', 'RETURN', RETURN_FULL(job)), 'JOB_NOT_ACTIVE');
});

test('full cycle: issue -> return -> reconcile -> settle -> pay, with exact balances', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  let s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, -186_685);   // karigar in credit 186.685 mg fine (unused allowance)
  assert.equal(s.cashBalancePaise, 372_750); // ₹3,727.50 labour owed to the karigar
  await rejects(L.add('jeweller', 'RETURN', RETURN_FULL(job)), 'JOB_CLOSED');

  const figs = proposeSettlementFigures(s);
  const settle = await L.both('jeweller', 'SETTLEMENT', figs);
  s = deriveState(L.chain);
  assert.equal(s.settlements.length, 1);
  assert.equal(s.settlements[0].payablePaise, 372_750);
  assert.equal(s.goldBalanceUg, -186_685); // carried forward, not lost

  await rejects(L.add('jeweller', 'PAYMENT', { settlement: settle, amountPaise: 372_751, method: 'UPI_MOCK', reference: 'MOCK-UPI-1' }), 'OVERPAYMENT');
  const pay = await L.add('jeweller', 'PAYMENT', { settlement: settle, amountPaise: 372_750, method: 'UPI_MOCK', reference: 'MOCK-UPI-1' });
  assert.equal(deriveState(L.chain).cashBalancePaise, 372_750); // not counted until the karigar confirms receipt
  await L.approve('karigar', pay);
  s = deriveState(L.chain);
  assert.equal(s.cashBalancePaise, 0);
  assert.equal(s.settlements[0].paidPaise, 372_750);
  assert.ok((await verifyChain(L.chain)).ok);
});

test('settlement must match the ledger exactly: stale or altered figures are refused', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const figs = proposeSettlementFigures(deriveState(L.chain));
  await rejects(L.add('jeweller', 'SETTLEMENT', { ...figs, cashBalancePaise: figs.cashBalancePaise - 1, payablePaise: figs.payablePaise - 1 }), 'SETTLEMENT_MISMATCH');
  await L.both('jeweller', 'OPENING_BALANCE', { goldUg: 0, cashPaise: 10_000, source: 'verbal', note: 'old advance' });
  await rejects(L.add('jeweller', 'SETTLEMENT', figs), 'STALE_SETTLEMENT');
});

test('settlement is blocked while entries are pending or a dispute is open', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  const ret = await L.add('jeweller', 'RETURN', RETURN_FULL(job));
  await rejects(L.add('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain))), 'PENDING_ENTRIES');
  await L.approve('karigar', ret);
  const d = await L.add('karigar', 'DISPUTE', { target: ret, reason: 'Stone weight was 0.300 g, not 0.250 g' });
  await rejects(L.add('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain))), 'OPEN_DISPUTE');
  await L.both('jeweller', 'DISPUTE_RESOLUTION', { dispute: d, outcome: 'agreed_as_recorded', note: 'Re-weighed together: 0.250 g' });
  await L.both('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain)));
});

test('converting a gold balance to cash at a human-entered rate', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, wastageBp: 50 });
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  let s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, 8_423); // karigar owes 8.423 mg fine
  const figs = proposeSettlementFigures(s, 'convert_to_cash', 750_000); // ₹7,500 per g fine (entered by a human)
  assert.equal(figs.convertPaise, 6_317);   // 0.008423 × 750 000 = 6 317.25 -> 6 317 paise
  assert.equal(figs.payablePaise, 372_750 - 6_317);
  await L.both('jeweller', 'SETTLEMENT', figs);
  s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, 0);
  assert.equal(s.cashBalancePaise, 366_433);
});

test('only the latest settlement can be paid against (no double payment)', async () => {
  const L = await setup();
  const j1 = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(j1));
  const s1 = await L.both('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain)));
  const j2 = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, design: 'Second job' });
  await L.both('jeweller', 'RETURN', RETURN_FULL(j2));
  const s2 = await L.both('jeweller', 'SETTLEMENT', proposeSettlementFigures(deriveState(L.chain)));
  await rejects(L.add('jeweller', 'PAYMENT', { settlement: s1, amountPaise: 1, method: 'CASH', reference: 'cash' }), 'SUPERSEDED_SETTLEMENT');
  assert.equal(deriveState(L.chain).settlements.at(-1).payablePaise, 745_500); // both jobs' labour
  await L.both('jeweller', 'PAYMENT', { settlement: s2, amountPaise: 745_500, method: 'CASH', reference: 'cash' });
});

test('mistakes are voided by both parties, never edited', async () => {
  const L = await setup();
  const wrong = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, gold: [{ grossMg: 1_000, fineness: 995 }] });
  const v = await L.add('jeweller', 'VOID', { target: wrong, reason: 'typed 1 g instead of 10 g' });
  assert.equal(deriveState(L.chain).goldBalanceUg, 995_000); // still counts until the karigar agrees
  await L.approve('karigar', v);
  const s = deriveState(L.chain);
  assert.equal(s.goldBalanceUg, 0);
  assert.equal(s.jobs[0].issueStatus, 'voided');
  assert.equal(L.chain.length, 6); // open+approve, issue+approve, void+approve: nothing removed
});

test('refiner result replaces provisional scrap once both approve', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  const ret = await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  assert.ok(deriveState(L.chain).jobs[0].flags.some((f) => f.code === 'PROVISIONAL_SCRAP'));
  await L.both('jeweller', 'REFINER_RESULT', { job, returnId: ret, scrapIndex: 0, recoveredFineUg: 130_000, refiner: 'Test refinery' });
  const s = deriveState(L.chain);
  assert.equal(s.jobs[0].lossUg, 64_600);
  assert.ok(!s.jobs[0].flags.some((f) => f.code === 'PROVISIONAL_SCRAP'));
});

test('flags: excess wastage, overdue, customer date risk (rule-based, phrased as "please review")', async () => {
  const L = await setup();
  const late = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, design: 'late', dueDate: '2026-11-10', customerDate: '2026-11-19' });
  const j = await L.both('jeweller', 'ISSUE', { ...ISSUE_10G, wastageBp: 50 });
  await L.both('jeweller', 'RETURN', RETURN_FULL(j));
  const s = deriveState(L.chain, { today: '2026-11-17' });
  const codes = (id) => s.jobs.find((x) => x.id === id).flags.map((f) => f.code);
  assert.deepEqual(codes(late).sort(), ['CUSTOMER_DATE_RISK', 'OVERDUE']);
  assert.ok(codes(j).includes('EXCESS_WASTAGE'));
  assert.match(s.jobs.find((x) => x.id === j).flags.find((f) => f.code === 'EXCESS_WASTAGE').text, /Please review/);
});

test('karigar has full access: his device derives exactly the same state from the same chain', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const karigarCopy = structuredClone(L.chain);
  const a = deriveState(L.chain), b = deriveState(karigarCopy);
  assert.equal(a.goldBalanceUg, b.goldBalanceUg);
  assert.equal(a.cashBalancePaise, b.cashBalancePaise);
  assert.deepEqual((await verifyChain(karigarCopy)).head, (await verifyChain(L.chain)).head);
});

// ---- tamper evidence ----

test('tampering with any weight is detected (hash and signature)', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  assert.ok((await verifyChain(L.chain)).ok);
  const t = structuredClone(L.chain);
  t[2].item.statement.payload.gold[0].grossMg = 9_999; // shave off 1 mg
  const v = await verifyChain(t);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'BAD_ID'));
});

test('re-signing with a different key, deleting or reordering records is detected', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  // forged: valid-looking item signed by an attacker key
  const attacker = await generateKeyPair();
  const forged = await createItem({ account: L.account, author: 'karigar', type: 'APPROVE', payload: { target: job }, privateKey: attacker.privateKey });
  await assert.rejects(append(L.chain.slice(0, 3), forged), (e) => e.code === 'BAD_SIGNATURE');
  // deletion
  const del = [...L.chain.slice(0, 3), ...L.chain.slice(4)];
  assert.ok((await verifyChain(del)).errors.some((e) => e.code === 'BROKEN_LINK' || e.code === 'BAD_SEQ'));
  // reorder
  const re = [...L.chain]; [re[3], re[4]] = [re[4], re[3]];
  assert.equal((await verifyChain(re)).ok, false);
});

// ---- offline ----

test('offline: both sides write while disconnected, then merge without re-signing', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  const shared = L.chain;
  // jeweller, offline: records a second issue
  const jIssue = await L.item('jeweller', 'ISSUE', { ...ISSUE_10G, design: 'Chain, offline' });
  const jChain = await append(shared, jIssue);
  // karigar, offline: records his return and a progress note
  const kRet = await L.item('karigar', 'RETURN', RETURN_FULL(job));
  const kNote = await L.item('karigar', 'NOTE', { text: 'Second job started', job });
  const kChain = await append(await append(shared, kRet), kNote);
  assert.equal(divergence(jChain, kChain), shared.length);

  const { chain, added, conflicts } = await mergeChains(jChain, kChain);
  assert.deepEqual(added, [kRet.id, kNote.id]);
  assert.equal(conflicts.length, 0);
  assert.ok((await verifyChain(chain)).ok);
  assert.equal(divergence(chain, jChain), -1); // the jeweller's history is unchanged; new items only appended
  // karigar adopts the merged chain; merging again is a no-op
  assert.equal((await mergeChains(chain, kChain)).added.length, 0);
  assert.equal(deriveState(chain).pending.length, 2); // jeweller's offline issue + karigar's return still need the other side
});

test('offline conflict: a stale settlement is returned for a human to redo, never silently dropped', async () => {
  const L = await setup();
  const job = await L.both('jeweller', 'ISSUE', ISSUE_10G);
  await L.both('jeweller', 'RETURN', RETURN_FULL(job));
  const shared = L.chain;
  const kSettle = await L.item('karigar', 'SETTLEMENT', proposeSettlementFigures(deriveState(shared)));
  const kChain = await append(shared, kSettle);
  // meanwhile the jeweller (offline) recorded an opening balance the karigar approves later
  const ob = await L.item('jeweller', 'OPENING_BALANCE', { goldUg: 0, cashPaise: 5_000, source: 'bahi_page', note: 'old page' });
  const ap = await L.item('karigar', 'APPROVE', { target: ob.id });
  const jChain = await append(await append(shared, ob), ap);
  const { conflicts } = await mergeChains(jChain, kChain);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, 'STALE_SETTLEMENT');
});

test('a tampered incoming copy is refused at merge time', async () => {
  const L = await setup();
  await L.both('jeweller', 'ISSUE', ISSUE_10G);
  const bad = structuredClone(L.chain);
  bad[2].item.statement.payload.wastageBp = 1_000;
  await assert.rejects(mergeChains(L.chain, bad), (e) => e.code === 'INCOMING_INVALID');
});
