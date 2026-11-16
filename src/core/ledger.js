// The shared ledger for one jeweller–karigar pair (one "khata").
//
// Structure
//   statement : what a party says, e.g. {v, account, author, type, ts, nonce, payload}
//   item      : { statement, sig }  with  id = sha256(canonical(statement)),  sig = ECDSA(author key, id)
//   record    : { seq, prevHash, item, hash }  with  hash = sha256(canonical({seq, prevHash, id, sig}))
//
// - Append-only and hash-chained, so changing or removing any record breaks every later hash.
// - Authorship is proven by the signature, not by position. Either device (or a later server)
//   can therefore sequence items, and items created offline can be appended when the devices
//   reconnect (see mergeChains).
// - A gold or money entry has NO EFFECT on balances until BOTH parties have approved it.
//   The author's signature is the author's approval; the other party appends APPROVE or REJECT.
// - Nothing is ever edited. Mistakes are fixed with a VOID entry (needs both approvals) plus a new entry.

import { canonical, sha256Hex, signHex, verifyHex, randomNonce } from './crypto.js';
import { LedgerError, assertMg, assertFineness, assertBp, assertInt, assertPaise } from './units.js';
import { reconcileJob, goldValuePaise } from './reconcile.js';

export const PARTIES = ['jeweller', 'karigar'];
export const GENESIS_PREV = '0'.repeat(64);
const other = (p) => (p === 'jeweller' ? 'karigar' : 'jeweller');

/** Entry types. `both`: needs both parties' approval before it counts. `authors`: who may write it. */
export const TYPES = {
  OPEN_ACCOUNT:       { both: true,  authors: ['jeweller'] },
  OPENING_BALANCE:    { both: true,  authors: PARTIES },
  ISSUE:              { both: true,  authors: ['jeweller'] },
  RETURN:             { both: true,  authors: PARTIES },
  REFINER_RESULT:     { both: true,  authors: PARTIES },
  SETTLEMENT:         { both: true,  authors: PARTIES },
  PAYMENT:            { both: true,  authors: ['jeweller'] }, // karigar's approval = "I received it"
  VOID:               { both: true,  authors: PARTIES },
  DISPUTE:            { both: false, authors: PARTIES },      // either side may raise one at any time
  DISPUTE_RESOLUTION: { both: true,  authors: PARTIES },
  NOTE:               { both: false, authors: PARTIES },      // progress updates, voice-note transcripts
  APPROVE:            { both: false, authors: PARTIES },
  REJECT:             { both: false, authors: PARTIES },
};
const GOLD_OR_MONEY = new Set(['OPENING_BALANCE', 'ISSUE', 'RETURN', 'REFINER_RESULT', 'SETTLEMENT', 'PAYMENT']);

// ---------------------------------------------------------------------------------------------
// Payload validation (structure only; meaning is checked against state in checkSemantics)

const isStr = (v, max = 500) => typeof v === 'string' && v.length <= max;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function need(cond, msg) { if (!cond) throw new LedgerError('BAD_PAYLOAD', msg); }

const VALIDATE = {
  OPEN_ACCOUNT(p) {
    for (const r of PARTIES) {
      need(p.parties?.[r] && isStr(p.parties[r].name, 100), `parties.${r}.name required`);
      need(p.parties[r].publicJwk?.kty === 'EC' && p.parties[r].publicJwk?.crv === 'P-256', `parties.${r}.publicJwk must be P-256`);
    }
    need(['finished_net', 'issued'].includes(p.terms?.wastageBasis), 'terms.wastageBasis must be finished_net|issued');
    need(['fixed', 'capped'].includes(p.terms?.allowanceMode), 'terms.allowanceMode must be fixed|capped');
    need(isStr(p.consent?.text, 2000) && isStr(p.consent?.language, 10), 'consent.text and consent.language required');
  },
  OPENING_BALANCE(p) {
    assertInt('goldUg', p.goldUg); assertPaise('cashPaise', p.cashPaise);
    need(['bahi_page', 'verbal', 'other'].includes(p.source), 'source must be bahi_page|verbal|other');
  },
  ISSUE(p) {
    need(isStr(p.design, 200) && isStr(p.category, 60), 'design and category required');
    need(Array.isArray(p.gold) && p.gold.length > 0, 'gold[] required');
    p.gold.forEach((g, i) => { assertMg(`gold[${i}].grossMg`, g.grossMg); need(g.grossMg > 0, 'gold weight must be > 0'); assertFineness(`gold[${i}].fineness`, g.fineness); });
    assertBp('wastageBp', p.wastageBp);
    need(['per_gram', 'per_piece'].includes(p.labour?.mode), 'labour.mode must be per_gram|per_piece');
    assertInt('labour.ratePaise', p.labour.ratePaise, { min: 0 });
    need(isDate(p.dueDate), 'dueDate YYYY-MM-DD required');
    need(p.customerDate === undefined || isDate(p.customerDate), 'customerDate must be YYYY-MM-DD');
  },
  RETURN(p) {
    need(isId(p.job), 'job (ISSUE id) required');
    need(Array.isArray(p.pieces) && Array.isArray(p.scrap), 'pieces[] and scrap[] required');
    need(p.pieces.length + p.scrap.length > 0, 'a return must contain pieces or scrap');
    p.pieces.forEach((x, i) => {
      assertMg(`pieces[${i}].grossMg`, x.grossMg); assertMg(`pieces[${i}].stoneMg`, x.stoneMg ?? 0); assertFineness(`pieces[${i}].fineness`, x.fineness);
      need(x.grossMg >= (x.stoneMg ?? 0), `pieces[${i}]: stone weight exceeds gross weight`);
    });
    p.scrap.forEach((x, i) => {
      assertMg(`scrap[${i}].grossMg`, x.grossMg); assertFineness(`scrap[${i}].fineness`, x.fineness);
      need(['filings', 'dust', 'unused', 'other'].includes(x.kind), `scrap[${i}].kind invalid`);
      need(typeof x.provisional === 'boolean', `scrap[${i}].provisional must be boolean`);
    });
    need(typeof p.final === 'boolean', 'final must be boolean');
  },
  REFINER_RESULT(p) {
    need(isId(p.job) && isId(p.returnId), 'job and returnId required');
    assertInt('scrapIndex', p.scrapIndex, { min: 0 }); assertInt('recoveredFineUg', p.recoveredFineUg, { min: 0 });
    need(isStr(p.refiner, 100), 'refiner name required');
  },
  SETTLEMENT(p) {
    need(Array.isArray(p.covers) && p.covers.every(isId), 'covers[] of ids required');
    assertInt('goldBalanceUg', p.goldBalanceUg); assertPaise('cashBalancePaise', p.cashBalancePaise);
    need(['carry_forward', 'convert_to_cash'].includes(p.goldAction), 'goldAction must be carry_forward|convert_to_cash');
    if (p.goldAction === 'convert_to_cash') { assertInt('goldRatePaisePerG', p.goldRatePaisePerG, { min: 1 }); assertPaise('convertPaise', p.convertPaise); }
    assertPaise('payablePaise', p.payablePaise);
  },
  PAYMENT(p) {
    need(isId(p.settlement), 'settlement id required');
    assertInt('amountPaise', p.amountPaise, { min: 1 });
    need(['UPI_MOCK', 'CASH'].includes(p.method), 'method must be UPI_MOCK|CASH (real UPI is not integrated)');
    need(isStr(p.reference, 100), 'reference required');
  },
  VOID(p) { need(isId(p.target) && isStr(p.reason, 500) && p.reason.length > 0, 'target and reason required'); },
  DISPUTE(p) { need(isId(p.target) && isStr(p.reason, 1000) && p.reason.length > 0, 'target and reason required'); },
  DISPUTE_RESOLUTION(p) {
    need(isId(p.dispute), 'dispute id required');
    need(['agreed_as_recorded', 'corrected', 'withdrawn'].includes(p.outcome), 'outcome invalid');
    need(isStr(p.note, 1000), 'note required');
  },
  NOTE(p) { need(isStr(p.text, 2000), 'text required'); need(p.job === undefined || isId(p.job), 'job must be an id'); },
  APPROVE(p) { need(isId(p.target), 'target required'); },
  REJECT(p) { need(isId(p.target) && isStr(p.reason, 500), 'target and reason required'); },
};

// ---------------------------------------------------------------------------------------------
// Creating items

/**
 * Create and sign a statement. `ts` is the author's device clock: informational only, never trusted for ordering.
 */
export async function createItem({ account, author, type, payload, privateKey, ts = new Date().toISOString() }) {
  if (!PARTIES.includes(author)) throw new LedgerError('BAD_AUTHOR', `author must be jeweller|karigar`);
  if (!TYPES[type]) throw new LedgerError('BAD_TYPE', `unknown type ${type}`);
  if (!TYPES[type].authors.includes(author)) throw new LedgerError('NOT_ALLOWED', `${author} may not write ${type}`);
  VALIDATE[type](payload);
  const statement = { v: 1, account, author, type, ts, nonce: randomNonce(), payload };
  const id = await sha256Hex(canonical(statement));
  return { id, statement, sig: await signHex(privateKey, id) };
}

const recordHash = (seq, prevHash, item) => sha256Hex(canonical({ seq, prevHash, id: item.id, sig: item.sig }));

// ---------------------------------------------------------------------------------------------
// Deriving state from a chain

/**
 * Replay a chain and derive everything: statuses, jobs, reconciliations, balances, flags.
 * Pure (apart from async hashing done elsewhere), so both parties' devices compute identical results.
 */
export function deriveState(chain, { today } = {}) {
  const items = new Map();   // id -> { item, seq, approvals:Set, rejected:{by,reason}|null }
  const order = [];
  for (const rec of chain) {
    const { id, statement: st } = rec.item;
    if (st.type === 'APPROVE' || st.type === 'REJECT') {
      const t = items.get(st.payload.target);
      if (!t) continue; // validated on append; tolerate here
      if (st.type === 'APPROVE') t.approvals.add(st.author);
      else t.rejected = { by: st.author, reason: st.payload.reason, at: st.ts };
      continue;
    }
    items.set(id, { item: rec.item, seq: rec.seq, approvals: new Set([st.author]), rejected: null });
    order.push(id);
  }

  const statusOf = (id) => {
    const e = items.get(id);
    if (!e) return 'missing';
    if (e.rejected) return 'rejected';
    if (!TYPES[e.item.statement.type].both) return 'recorded';
    return e.approvals.size === 2 ? 'approved' : 'pending';
  };
  const voided = new Set();
  for (const id of order) {
    const st = items.get(id).item.statement;
    if (st.type === 'VOID' && statusOf(id) === 'approved') voided.add(st.payload.target);
  }
  const effective = (id) => statusOf(id) === 'approved' && !voided.has(id);

  const genesis = chain[0]?.item.statement;
  const terms = genesis?.payload.terms;
  const parties = genesis?.payload.parties;

  // Jobs
  const jobs = new Map();
  for (const id of order) {
    const st = items.get(id).item.statement;
    if (st.type === 'ISSUE') jobs.set(id, { id, issue: st.payload, issueStatus: statusOf(id), voided: voided.has(id), returns: [], refiner: new Map(), pendingReturns: 0, disputes: [] });
  }
  for (const id of order) {
    const st = items.get(id).item.statement;
    if (st.type === 'RETURN' && jobs.has(st.payload.job)) {
      const j = jobs.get(st.payload.job);
      if (effective(id)) j.returns.push({ id, payload: st.payload });
      else if (statusOf(id) === 'pending') j.pendingReturns++;
    }
  }
  for (const id of order) {
    const st = items.get(id).item.statement;
    if (st.type === 'REFINER_RESULT' && effective(id) && jobs.has(st.payload.job)) {
      const j = jobs.get(st.payload.job);
      const ri = j.returns.findIndex((r) => r.id === st.payload.returnId);
      if (ri >= 0) j.refiner.set(`${ri}:${st.payload.scrapIndex}`, st.payload.recoveredFineUg);
    }
  }

  // Disputes
  const disputes = [];
  for (const id of order) {
    const st = items.get(id).item.statement;
    if (st.type !== 'DISPUTE' || statusOf(id) === 'rejected') continue;
    const resolution = order.find((rid) => {
      const r = items.get(rid).item.statement;
      return r.type === 'DISPUTE_RESOLUTION' && r.payload.dispute === id && statusOf(rid) === 'approved';
    });
    disputes.push({ id, by: st.author, target: st.payload.target, reason: st.payload.reason, open: !resolution, resolution });
  }

  // Balances, computed only from effective entries
  let goldUg = 0, cashPaise = 0;
  const jobViews = [];
  for (const j of jobs.values()) {
    const view = { id: j.id, design: j.issue.design, category: j.issue.category, dueDate: j.issue.dueDate, customerDate: j.issue.customerDate, issueStatus: j.voided ? 'voided' : j.issueStatus, pendingReturns: j.pendingReturns, flags: [] };
    if (j.issueStatus === 'approved' && !j.voided) {
      const rec = reconcileJob(j.issue, j.returns.map((r) => r.payload), terms, j.refiner);
      Object.assign(view, rec);
      goldUg += rec.balanceUg;
      cashPaise += rec.labourPaise;
      view.flags = jobFlags(view, today);
    }
    view.openDisputes = disputes.filter((d) => d.open && (d.target === j.id || j.returns.some((r) => r.id === d.target))).length;
    if (view.openDisputes) view.flags.push({ code: 'DISPUTE_OPEN', text: 'A dispute on this job is open' });
    jobViews.push(view);
  }

  const settlements = [];
  for (const id of order) {
    if (!effective(id)) continue;
    const st = items.get(id).item.statement;
    const p = st.payload;
    if (st.type === 'OPENING_BALANCE') { goldUg += p.goldUg; cashPaise += p.cashPaise; }
    if (st.type === 'SETTLEMENT') {
      if (p.goldAction === 'convert_to_cash') { goldUg -= p.goldBalanceUg; cashPaise -= p.convertPaise; }
      settlements.push({ id, ...p, paidPaise: 0 });
    }
  }
  for (const id of order) {
    if (!effective(id)) continue;
    const st = items.get(id).item.statement;
    if (st.type === 'PAYMENT') {
      cashPaise -= st.payload.amountPaise;
      const s = settlements.find((x) => x.id === st.payload.settlement);
      if (s) s.paidPaise += st.payload.amountPaise;
    }
  }

  const pending = order.filter((id) => statusOf(id) === 'pending').map((id) => {
    const e = items.get(id);
    return { id, type: e.item.statement.type, author: e.item.statement.author, waitingFor: other(e.item.statement.author), ts: e.item.statement.ts, payload: e.item.statement.payload };
  });

  return {
    accountId: genesis?.account, parties, terms,
    accountOpen: chain.length > 0 && statusOf(chain[0].item.id) === 'approved',
    goldBalanceUg: goldUg, cashBalancePaise: cashPaise,
    jobs: jobViews, pending, disputes, settlements,
    effectiveIds: order.filter((id) => effective(id) && GOLD_OR_MONEY.has(items.get(id).item.statement.type)).sort(),
    statusOf, isEffective: effective, get: (id) => items.get(id), order,
  };
}

function jobFlags(v, today) {
  const f = [];
  // Rule-based flags, not AI. Shown as "please review", never as an accusation.
  if (v.isFinal && v.excessUg > 0) f.push({ code: 'EXCESS_WASTAGE', text: 'Wastage is above the agreed allowance. Please review together.' });
  if (v.lossUg < 0) f.push({ code: 'RETURNED_MORE_THAN_ISSUED', text: 'More fine gold came back than was issued. Please check the weights and purities.' });
  if (v.provisionalLots > 0) f.push({ code: 'PROVISIONAL_SCRAP', text: `${v.provisionalLots} scrap lot(s) use an estimated purity until the refiner reports` });
  if (today && !v.isFinal) {
    if (today > v.dueDate) f.push({ code: 'OVERDUE', text: `Was due ${v.dueDate}` });
    else if (daysBetween(today, v.dueDate) <= 2) f.push({ code: 'DUE_SOON', text: `Due ${v.dueDate}` });
    if (v.customerDate && daysBetween(today, v.customerDate) <= 3) f.push({ code: 'CUSTOMER_DATE_RISK', text: `The customer needs it by ${v.customerDate}` });
  }
  return f;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// Checks that need the current state

function checkSemantics(state, item) {
  const st = item.statement;
  const p = st.payload;
  const fail = (code, msg) => { throw new LedgerError(code, msg); };
  const targetEntry = (id) => state.get(id) ?? fail('UNKNOWN_TARGET', `unknown entry ${id.slice(0, 12)}…`);

  if (st.type !== 'OPEN_ACCOUNT' && st.type !== 'APPROVE' && st.type !== 'REJECT' && !state.accountOpen)
    fail('ACCOUNT_NOT_OPEN', 'the karigar must accept the account (and its consent text) first');

  switch (st.type) {
    case 'APPROVE':
    case 'REJECT': {
      const t = targetEntry(p.target);
      const tst = t.item.statement;
      if (!TYPES[tst.type].both) fail('NOT_APPROVABLE', `${tst.type} does not need approval`);
      if (tst.author === st.author) fail('SELF_APPROVAL', 'the author has already signed; the other party must decide');
      if (t.approvals.has(st.author) || t.rejected) fail('ALREADY_DECIDED', 'this entry has already been decided');
      break;
    }
    case 'RETURN': {
      const t = targetEntry(p.job);
      if (t.item.statement.type !== 'ISSUE') fail('NOT_A_JOB', 'job must reference an ISSUE');
      if (!state.isEffective(p.job)) fail('JOB_NOT_ACTIVE', 'the issue must be approved by both parties before a return');
      const job = state.jobs.find((j) => j.id === p.job);
      if (job?.isFinal) fail('JOB_CLOSED', 'this job already has a final return');
      break;
    }
    case 'REFINER_RESULT': {
      const r = targetEntry(p.returnId);
      if (r.item.statement.type !== 'RETURN' || r.item.statement.payload.job !== p.job) fail('BAD_REF', 'returnId must be a RETURN of this job');
      const lot = r.item.statement.payload.scrap[p.scrapIndex];
      if (!lot) fail('BAD_REF', 'no such scrap lot');
      if (!lot.provisional) fail('NOT_PROVISIONAL', 'that scrap lot was not marked provisional');
      break;
    }
    case 'VOID':
    case 'DISPUTE':
      targetEntry(p.target);
      break;
    case 'DISPUTE_RESOLUTION':
      if (targetEntry(p.dispute).item.statement.type !== 'DISPUTE') fail('BAD_REF', 'dispute must reference a DISPUTE');
      break;
    case 'SETTLEMENT': {
      // A settlement must exactly match what the ledger says right now. It cannot be proposed on stale numbers.
      const want = proposeSettlementFigures(state, p.goldAction, p.goldRatePaisePerG);
      if (canonical(p.covers) !== canonical(want.covers)) fail('STALE_SETTLEMENT', 'the ledger changed since this settlement was drawn up; propose it again');
      for (const k of ['goldBalanceUg', 'cashBalancePaise', 'convertPaise', 'payablePaise'])
        if ((p[k] ?? 0) !== (want[k] ?? 0)) fail('SETTLEMENT_MISMATCH', `${k}: proposed ${p[k]}, ledger says ${want[k]}`);
      if (state.pending.some((x) => GOLD_OR_MONEY.has(x.type))) fail('PENDING_ENTRIES', 'approve or reject pending gold/money entries before settling');
      if (state.disputes.some((d) => d.open)) fail('OPEN_DISPUTE', 'resolve open disputes before settling');
      break;
    }
    case 'PAYMENT': {
      const s = state.settlements.find((x) => x.id === p.settlement);
      if (!s) fail('NO_SETTLEMENT', 'payment must reference a settlement both parties approved');
      // A newer settlement already includes anything unpaid on older ones, so only the latest can be paid against (no double payment).
      if (state.settlements.at(-1).id !== s.id) fail('SUPERSEDED_SETTLEMENT', 'a newer settlement exists; pay against that one');
      if (s.paidPaise + p.amountPaise > s.payablePaise) fail('OVERPAYMENT', `only ${s.payablePaise - s.paidPaise} paise remain payable on this settlement`);
      break;
    }
  }
}

/** Figures for a new settlement, computed from the current effective entries. */
export function proposeSettlementFigures(state, goldAction = 'carry_forward', goldRatePaisePerG) {
  const out = { covers: state.effectiveIds, goldBalanceUg: state.goldBalanceUg, cashBalancePaise: state.cashBalancePaise, goldAction };
  let cash = state.cashBalancePaise;
  if (goldAction === 'convert_to_cash') {
    out.goldRatePaisePerG = goldRatePaisePerG;
    out.convertPaise = goldValuePaise(state.goldBalanceUg, goldRatePaisePerG);
    cash -= out.convertPaise;
  }
  out.payablePaise = Math.max(0, cash);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Appending, verifying, merging

async function checkItem(chain, item, state) {
  const st = item.statement;
  if ((await sha256Hex(canonical(st))) !== item.id) throw new LedgerError('BAD_ID', 'item id does not match its content');
  if (chain.length === 0) {
    if (st.type !== 'OPEN_ACCOUNT') throw new LedgerError('NO_GENESIS', 'the first entry must be OPEN_ACCOUNT');
  } else {
    if (st.type === 'OPEN_ACCOUNT') throw new LedgerError('DUP_GENESIS', 'the account is already open');
    if (st.account !== chain[0].item.statement.account) throw new LedgerError('WRONG_ACCOUNT', 'item belongs to another account');
  }
  if (!TYPES[st.type]?.authors.includes(st.author)) throw new LedgerError('NOT_ALLOWED', `${st.author} may not write ${st.type}`);
  VALIDATE[st.type](st.payload);
  const parties = chain.length === 0 ? st.payload.parties : chain[0].item.statement.payload.parties;
  if (!(await verifyHex(parties[st.author].publicJwk, item.id, item.sig))) throw new LedgerError('BAD_SIGNATURE', `signature does not match ${st.author}'s key`);
  if (chain.some((r) => r.item.id === item.id)) throw new LedgerError('DUPLICATE', 'item already in ledger');
  if (chain.length > 0) checkSemantics(state ?? deriveState(chain), item);
}

/** Append one signed item and return a NEW chain array. The input is never mutated. Throws LedgerError if invalid. */
export async function append(chain, item) {
  await checkItem(chain, item);
  const seq = chain.length;
  const prevHash = seq === 0 ? GENESIS_PREV : chain[seq - 1].hash;
  return [...chain, { seq, prevHash, item, hash: await recordHash(seq, prevHash, item) }];
}

/**
 * Verify a whole chain from scratch: hashes, links, signatures and every business rule, replayed in order.
 * Returns { ok, head, length, errors: [{seq, code, message}] }.
 */
export async function verifyChain(chain) {
  const errors = [];
  let rebuilt = [];
  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i];
    const prev = i === 0 ? GENESIS_PREV : chain[i - 1].hash;
    if (rec.seq !== i) errors.push({ seq: i, code: 'BAD_SEQ', message: `seq ${rec.seq} at position ${i}` });
    if (rec.prevHash !== prev) errors.push({ seq: i, code: 'BROKEN_LINK', message: 'prevHash does not match the previous record' });
    if (rec.hash !== (await recordHash(rec.seq, rec.prevHash, rec.item))) errors.push({ seq: i, code: 'BAD_HASH', message: 'record hash does not match its content' });
    try {
      await checkItem(rebuilt, rec.item);
      rebuilt = [...rebuilt, rec];
    } catch (e) {
      errors.push({ seq: i, code: e.code ?? 'ERROR', message: e.message });
      rebuilt = [...rebuilt, rec];
    }
  }
  return { ok: errors.length === 0, head: chain.at(-1)?.hash ?? GENESIS_PREV, length: chain.length, errors };
}

/**
 * Offline sync. `base` is the chain that wins on order (by convention the jeweller's device or a
 * future server). Every item that exists only in `incoming` is re-appended to `base` in incoming's
 * order. Signatures do not cover position, so nothing has to be re-signed. Items that no longer
 * fit (e.g. a settlement drawn up on stale numbers) are returned in `conflicts` for a human to
 * redo; they are never silently dropped.
 */
export async function mergeChains(base, incoming) {
  if (base.length && incoming.length && base[0].item.id !== incoming[0].item.id) throw new LedgerError('DIFFERENT_ACCOUNTS', 'cannot merge two different accounts');
  const v = await verifyChain(incoming);
  if (!v.ok) throw new LedgerError('INCOMING_INVALID', `incoming chain failed verification: ${v.errors[0].message}`);
  const have = new Set(base.map((r) => r.item.id));
  let chain = base;
  const added = [], conflicts = [];
  for (const rec of incoming) {
    if (have.has(rec.item.id)) continue;
    try { chain = await append(chain, rec.item); added.push(rec.item.id); have.add(rec.item.id); }
    catch (e) { conflicts.push({ id: rec.item.id, type: rec.item.statement.type, code: e.code, message: e.message }); }
  }
  return { chain, added, conflicts };
}

/** Find the first position where two copies of the same account diverge (-1 if one is a prefix of the other). */
export function divergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i].hash !== b[i].hash) return i;
  return -1;
}
