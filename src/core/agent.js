// The case agent's planner. It looks at one account's derived state and decides what should happen
// next to move every job from "issued" to "settled and paid".
//
// HONEST STATUS: this planner is RULE-BASED (deterministic if/then). It is not an LLM. The planned
// LLM tool-calling layer (plan §4/§5) will sit on top of these same proposals: the LLM may phrase
// messages and rank work, but it can only emit the action kinds below, and every action still passes
// through ApprovalGate. The planner never writes to the ledger or calls a mock service by itself.

import { proposeSettlementFigures } from './ledger.js';
import { formatFineUg, formatPaise, formatBp, formatMg } from './units.js';

/**
 * @returns {Array<{kind, key, summary, requires, goldOrMoney, data}>}
 */
export function planActions(state, { today } = {}) {
  const out = [];
  if (!state.accountOpen) return out;

  // 1. Entries waiting for the karigar: nudge him (a message only; nothing moves).
  const waitingOnKarigar = state.pending.filter((p) => p.waitingFor === 'karigar');
  if (waitingOnKarigar.length)
    out.push({ kind: 'CHASE_APPROVAL', key: `chase:${waitingOnKarigar.map((p) => p.id.slice(0, 8)).join(',')}`, requires: ['jeweller'], goldOrMoney: false,
      summary: `Send ${state.parties.karigar.name} a reminder: ${waitingOnKarigar.length} entr${waitingOnKarigar.length === 1 ? 'y needs' : 'ies need'} his confirmation`,
      data: { ids: waitingOnKarigar.map((p) => p.id) } });

  for (const j of state.jobs) {
    const codes = new Set(j.flags.map((f) => f.code));
    // 2. Deadline risk: ask for a progress update before it is late, not after.
    if (codes.has('OVERDUE') || codes.has('DUE_SOON') || codes.has('CUSTOMER_DATE_RISK'))
      out.push({ kind: 'REMIND_DEADLINE', key: `deadline:${j.id}:${today}`, requires: ['jeweller'], goldOrMoney: false,
        summary: `Ask for a progress update on "${j.design}" (${j.flags.filter((f) => ['OVERDUE', 'DUE_SOON', 'CUSTOMER_DATE_RISK'].includes(f.code)).map((f) => f.text).join('; ')})`,
        data: { job: j.id } });
    // 3. Wastage above the allowance: assemble evidence and propose a joint review (a gold matter).
    // Not if this job was already reviewed (open or resolved): one review per closed job.
    if (codes.has('EXCESS_WASTAGE') && !state.disputes.some((d) => d.target === j.id))
      out.push({ kind: 'REVIEW_WASTAGE', key: `review:${j.id}`, requires: ['jeweller'], goldOrMoney: true,
        summary: `"${j.design}": wastage ${formatBp(j.lossBp)} is above the agreed allowance by ${formatFineUg(j.excessUg)} fine. Open a joint review (not an accusation)?`,
        data: { job: j.id, evidence: evidencePack(state, j.id) } });
    // 4. Provisional scrap: remind the jeweller to record the refiner's result.
    if (codes.has('PROVISIONAL_SCRAP'))
      out.push({ kind: 'REFINER_FOLLOWUP', key: `refiner:${j.id}`, requires: ['jeweller'], goldOrMoney: true,
        summary: `"${j.design}": scrap purity is still an estimate. Record the refiner's recovered fine weight when it arrives.`, data: { job: j.id } });
  }

  // 5. Settlement: when everything is confirmed and something is owed, draft one for both parties.
  const blocked = state.pending.some((p) => p.type !== 'NOTE') || state.disputes.some((d) => d.open);
  const latest = state.settlements.at(-1);
  const figs = proposeSettlementFigures(state);
  // Worth settling only if money is owed, or every job is closed and a gold balance remains.
  // Gold sitting in open jobs is work in progress, not something to settle.
  const openJobs = state.jobs.some((j) => j.issueStatus === 'approved' && !j.isFinal);
  const worthSettling = state.cashBalancePaise !== 0 || (!openJobs && state.goldBalanceUg !== 0);
  if (!blocked && worthSettling && (!latest || hasNewWork(state, latest)))
    out.push({ kind: 'PROPOSE_SETTLEMENT', key: `settle:${figs.covers.join(',')}`, requires: ['jeweller'], goldOrMoney: true,
      summary: `Draft a settlement: labour owed ${formatPaise(figs.cashBalancePaise)}, gold balance ${formatFineUg(figs.goldBalanceUg)} fine (carried forward). It goes to ${state.parties.karigar.name} for approval.`,
      data: { figures: figs } });

  // 6. Payment: an approved settlement still has money owed. Pay via mock UPI, after jeweller approval.
  if (latest && latest.payablePaise - latest.paidPaise > 0 && !state.pending.some((p) => p.type === 'PAYMENT'))
    out.push({ kind: 'PAY_VIA_UPI_MOCK', key: `pay:${latest.id}:${latest.paidPaise}`, requires: ['jeweller'], goldOrMoney: true,
      summary: `Pay ${state.parties.karigar.name} ${formatPaise(latest.payablePaise - latest.paidPaise)} for the approved settlement (MOCK UPI: no real money moves)`,
      data: { settlement: latest.id, amountPaise: latest.payablePaise - latest.paidPaise } });

  return out;
}

const isPaymentOf = (state, id) => state.get(id)?.item.statement.type === 'PAYMENT';
function hasNewWork(state, latest) {
  const covered = new Set(latest.covers);
  return state.effectiveIds.some((id) => !covered.has(id) && id !== latest.id && !isPaymentOf(state, id));
}

/**
 * Evidence pack for a review or dispute: every fact both parties already signed, laid out side by side.
 * The agent only collects these facts. It does not judge who is right.
 */
export function evidencePack(state, jobId) {
  const j = state.jobs.find((x) => x.id === jobId);
  if (!j) return null;
  const issue = state.get(jobId).item.statement;
  const lines = [
    `Job: ${j.design} (${j.category})`,
    `Issued by ${issue.author} on ${issue.ts.slice(0, 10)}: ${issue.payload.gold.map((g) => `${formatMg(g.grossMg)} at ${g.fineness}‰`).join(' + ')} = ${formatFineUg(j.issuedFineUg)} fine`,
    `Agreed wastage: ${formatBp(issue.payload.wastageBp)} on ${state.terms.wastageBasis === 'finished_net' ? 'finished net weight' : 'gold issued'}`,
    `Returned: pieces ${formatFineUg(j.piecesFineUg)} fine, scrap ${formatFineUg(j.scrapFineUg)} fine${j.provisionalLots ? ' (scrap purity estimated)' : ''}`,
    `Actual loss: ${formatFineUg(j.lossUg)} fine (${formatBp(j.lossBp)} of issued); allowance ${formatFineUg(j.rawAllowanceUg)}; above allowance ${formatFineUg(j.excessUg)}`,
    `Both parties approved the issue and every return listed. Exact µg figures are in the ledger.`,
  ];
  return { jobId, lines, entryIds: [jobId, ...state.order.filter((id) => state.get(id).item.statement.payload?.job === jobId)] };
}
