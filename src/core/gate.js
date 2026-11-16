// Human approval gate for anything the agent wants to DO in the outside world.
//
// The ledger already makes gold and money ENTRIES need both parties' signatures. This gate covers
// the ACTIONS around them: sending a payment (mock UPI), drafting and signing a settlement, opening
// a wastage review, or messaging the karigar. The agent can only *propose*. Nothing runs until
// every required human has approved, and a failed action stays visible so it can be retried.

import { LedgerError } from './units.js';

let counter = 0;

export class ApprovalGate {
  constructor({ onChange = () => {}, now = () => new Date().toISOString() } = {}) {
    this.proposals = new Map();
    this.onChange = onChange;
    this.now = now;
  }

  /**
   * @param {object} p
   * @param {string}   p.kind       e.g. 'PAY_VIA_UPI_MOCK'
   * @param {string}   p.key        de-duplication key (the same situation must not be proposed twice)
   * @param {string}   p.summary    plain-language description shown to the approver
   * @param {string[]} p.requires   parties who must approve, e.g. ['jeweller'] or ['jeweller','karigar']
   * @param {boolean}  p.goldOrMoney  true if gold or money moves or is committed
   * @param {Function} p.run        async () => result. Called only after full approval.
   */
  propose({ kind, key, summary, requires, goldOrMoney, run, evidence }) {
    if (!requires?.length) throw new LedgerError('NO_APPROVER', 'every action needs at least one human approver');
    if (typeof run !== 'function') throw new LedgerError('NO_RUN', 'run must be a function');
    for (const p of this.proposals.values()) if (p.key === key && ['awaiting_approval', 'running', 'failed'].includes(p.status)) return p;
    const id = `act-${++counter}`;
    const p = { id, kind, key, summary, requires: [...requires], goldOrMoney: !!goldOrMoney, evidence, approvals: [], status: 'awaiting_approval', createdAt: this.now(), history: [], run };
    this.proposals.set(id, p);
    this.onChange();
    return p;
  }

  get(id) {
    const p = this.proposals.get(id);
    if (!p) throw new LedgerError('NO_PROPOSAL', `no proposal ${id}`);
    return p;
  }

  list() { return [...this.proposals.values()]; }

  /** Approve as `party`. When the last required approval arrives, the action runs. */
  async approve(id, party) {
    const p = this.get(id);
    if (p.status !== 'awaiting_approval') throw new LedgerError('NOT_AWAITING', `proposal is ${p.status}`);
    if (!p.requires.includes(party)) throw new LedgerError('NOT_AN_APPROVER', `${party} is not an approver for this action`);
    if (!p.approvals.includes(party)) p.approvals.push(party);
    p.history.push({ at: this.now(), event: 'approved', by: party });
    if (p.requires.every((r) => p.approvals.includes(r))) await this.#execute(p);
    this.onChange();
    return p;
  }

  reject(id, party, reason = '') {
    const p = this.get(id);
    if (p.status !== 'awaiting_approval' && p.status !== 'failed') throw new LedgerError('NOT_AWAITING', `proposal is ${p.status}`);
    p.status = 'rejected';
    p.history.push({ at: this.now(), event: 'rejected', by: party, reason });
    this.onChange();
    return p;
  }

  /** Retry after a failure. A retry is a new execution, so a human must approve again. */
  reopen(id) {
    const p = this.get(id);
    if (p.status !== 'failed') throw new LedgerError('NOT_FAILED', 'only failed actions can be reopened');
    p.status = 'awaiting_approval';
    p.approvals = [];
    p.history.push({ at: this.now(), event: 'reopened', previousError: p.error });
    delete p.error;
    this.onChange();
    return p;
  }

  async #execute(p) {
    p.status = 'running';
    try {
      p.result = await p.run();
      p.status = 'done';
      p.history.push({ at: this.now(), event: 'done' });
    } catch (e) {
      p.status = 'failed';
      p.error = e.message;
      p.history.push({ at: this.now(), event: 'failed', error: e.message });
    }
  }
}
