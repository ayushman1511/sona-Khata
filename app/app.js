// Jeweller PWA plus a simulated karigar phone, running in one browser for the demo.
//
// Each side keeps ITS OWN copy of the ledger (jChain = jeweller's device, kChain = karigar's phone)
// and its own signing key. When "online", the copies are merged with mergeChains(). When the karigar
// is set "offline", each side keeps writing locally and the copies merge on reconnect. This is the
// same code path a real two-device deployment would use; only the transport is simulated.

import * as L from '../src/core/ledger.js';
import { generateKeyPair, randomNonce } from '../src/core/crypto.js';
import { ApprovalGate } from '../src/core/gate.js';
import { planActions } from '../src/core/agent.js';
import * as U from '../src/core/units.js';
import { mockUpiPay, LABEL as UPI_LABEL } from '../src/mocks/upi.js';
import { mockHuidLookup, LABEL as HUID_LABEL } from '../src/mocks/huid.js';
import { mockUnderstand, LABEL as SPEECH_LABEL } from '../src/mocks/speech.js';
import { messageFor, LABEL as WA_LABEL } from '../src/mocks/whatsapp.js';
import { load, save, clearAll } from './store.js';

// ------------------------------------------------------------------ state
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let S = { keys: null, jChain: [], kChain: [], online: true, chat: [], lang: 'hi', vpa: 'karigar@mockupi', today: todayIso(), simFail: false, phoneTab: 'chat', conflicts: [], verify: null };
const gate = new ApprovalGate({ onChange: () => render() });
const seenKeys = new Set();
let busy = false;

const persist = () => save('state', { ...S, verify: null });
const accountId = () => S.jChain[0]?.item.statement.account;

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h) => h ? h.slice(0, 8) : '—';
const fine = (ug) => `<span title="exact: ${U.formatFineUgExact(ug)}">${U.formatFineUg(ug)}</span>`;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), err ? 6000 : 3000);
}

/** Modal dialog. Returns null on cancel, or an object of field values. */
function dialog({ title, lines = [], fields = [], ok = 'OK', note = '', danger = false }) {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog">
    <h3>${esc(title)}</h3>
    ${lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
    ${fields.map((f) => `<label>${esc(f.label)}${f.type === 'select'
      ? `<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select>`
      : `<input name="${f.name}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" ${f.required ? 'required' : ''}/>`}</label>`).join('')}
    ${note ? `<p class="hint">${note}</p>` : ''}
    <div class="row" style="justify-content:flex-end;margin-top:12px">
      <button value="cancel" class="ghost" formnovalidate>Cancel</button>
      <button value="ok" class="${danger ? 'danger' : ''}">${esc(ok)}</button>
    </div></form>`;
  return new Promise((res) => {
    d.onclose = () => {
      if (d.returnValue !== 'ok') return res(null);
      const out = {};
      for (const f of fields) out[f.name] = d.querySelector(`[name="${f.name}"]`).value;
      res(out);
    };
    d.returnValue = '';
    d.showModal();
  });
}

/** Human approval gate for a party signing a gold or money entry. */
const confirmSign = (party, title, lines) => dialog({
  title, lines, ok: `Sign as ${party}`,
  note: `This is signed with the ${party}'s key and added to the shared ledger. <b>It changes no balance until the ${party === 'jeweller' ? 'karigar' : 'jeweller'} also approves.</b>`,
});

async function guarded(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { console.error(e); toast(e.message, true); } finally { busy = false; render(); }
}

// ------------------------------------------------------------------ ledger plumbing
async function signAs(party, type, payload, account = accountId()) {
  const item = await L.createItem({ account, author: party, type, payload, privateKey: S.keys[party].privateKey });
  if (party === 'jeweller') S.jChain = await L.append(S.jChain, item);
  else S.kChain = await L.append(S.kChain, item);
  await sync();
  await persist();
  return item.id;
}

/** Merge both device copies (only while the karigar's phone is "online"). */
async function sync() {
  if (!S.online || !S.jChain.length) return;
  const r = await L.mergeChains(S.jChain, S.kChain);
  for (const c of r.conflicts) {
    S.conflicts.push({ ...c, at: new Date().toISOString() });
    pushChat('system', `⚠ An entry you made offline (${c.type}) could not be added: ${c.message}. Please redo it.`);
  }
  S.jChain = r.chain;
  S.kChain = r.chain;
}

function pushChat(from, text, mock = true) {
  S.chat.push({ from, text, ts: new Date().toISOString(), mock });
}

const parseG = (v, name) => { try { return U.parseGramsToMg(v); } catch { throw new Error(`${name}: enter grams with up to 3 decimals, e.g. 10.250`); } };
const parseInt10 = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number ${min}–${max}`); return n; };

// ------------------------------------------------------------------ boot
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW not registered', e));
  const saved = await load('state').catch(() => null);
  if (saved) S = { ...S, ...saved, verify: null };
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  render();
}

// ------------------------------------------------------------------ render
function render() {
  const root = $('#root');
  if (!S.jChain.length) { root.innerHTML = renderSetup(); return; }
  const js = L.deriveState(S.jChain, { today: S.today });
  const ks = L.deriveState(S.kChain.length ? S.kChain : [], { today: S.today });

  // Agent: plan, then register proposals with the gate (once per situation key).
  const plan = js.accountOpen ? planActions(js, { today: S.today }) : [];
  const live = new Set(plan.map((a) => a.key));
  for (const a of plan) {
    if (seenKeys.has(a.key)) continue;
    seenKeys.add(a.key);
    gate.propose({ ...a, evidence: a.data?.evidence, run: runnerFor(a, js) });
  }
  root.innerHTML = `<div>${renderJeweller(js, live)}</div>${renderPhone(ks)}`;
  const body = $('.phone .body'); if (body) body.scrollTop = body.scrollHeight;
}

function renderSetup() {
  return `<div>
  <section class="card"><h2>Open a shared gold account <span class="sub">jeweller ↔ karigar</span></h2>
    <p class="hint">This prototype runs both devices in one browser: a new signing key is made for the jeweller and one for the karigar's simulated phone.
    In real use the karigar's key would live on his own phone (or with an assisted JanAI Café path; see README §Gaps).</p>
    <form class="grid" data-form="open">
      <label>Shop name<input name="shop" required value="Demo Jewellers" /></label>
      <label>Karigar name<input name="karigar" required value="Demo Karigar" /></label>
      <label>Karigar's language<select name="lang"><option value="hi">Hindi</option><option value="en">English</option></select></label>
      <label>Karigar UPI ID <span class="tag mock">MOCK</span><input name="vpa" value="karigar@mockupi" /></label>
      <label>Wastage applies to<select name="basis"><option value="finished_net">finished net weight</option><option value="issued">gold issued</option></select></label>
      <label>Unused allowance<select name="mode"><option value="fixed">credited to karigar (fixed)</option><option value="capped">not credited (capped at actual loss)</option></select></label>
      <button>Create account</button>
    </form>
    <p class="hint">Wastage basis and allowance handling vary by shop and are <b>open field-research questions</b>. Both are supported.</p>
  </section>
  <section class="card"><h2>Or load a demo <span class="tag bad">SYNTHETIC DATA</span></h2>
    <p class="hint">Makes an account and two jobs (one returned with wastage above the allowance, one overdue) using invented test weights. Not field data.</p>
    <button class="ghost" data-act="seed">Load synthetic demo</button>
  </section></div>
  <aside class="phone"><div class="bar"><div class="title">Karigar's phone</div><div class="s">appears once an account is opened</div></div></aside>`;
}

function balanceText(goldUg, cashPaise, viewer) {
  const g = goldUg === 0 ? 'Settled: 0.000 g' : goldUg > 0
    ? (viewer === 'jeweller' ? `Karigar holds ${U.formatFineUg(goldUg)}` : `You hold ${U.formatFineUg(goldUg)} of the jeweller's gold`)
    : (viewer === 'jeweller' ? `You owe karigar ${U.formatFineUg(-goldUg)}` : `Jeweller owes you ${U.formatFineUg(-goldUg)}`);
  const c = cashPaise === 0 ? 'Nothing owed' : cashPaise > 0
    ? (viewer === 'jeweller' ? `You owe ${U.formatPaise(cashPaise)}` : `Jeweller owes you ${U.formatPaise(cashPaise)}`)
    : (viewer === 'jeweller' ? `Karigar owes ${U.formatPaise(-cashPaise)}` : `You owe ${U.formatPaise(-cashPaise)}`);
  return { g, c };
}

function renderJeweller(s, live) {
  const p = s.parties;
  const b = balanceText(s.goldBalanceUg, s.cashBalancePaise, 'jeweller');
  const openJobs = s.jobs.filter((j) => j.issueStatus === 'approved' && !j.isFinal);
  const v = S.verify;
  const actions = gate.list().filter((a) => (live.has(a.key) && ['awaiting_approval', 'running'].includes(a.status)) || a.status === 'failed');
  const history = gate.list().filter((a) => ['done', 'rejected'].includes(a.status)).slice(-4).reverse();
  const waitingK = s.pending.filter((x) => x.waitingFor === 'karigar');
  const waitingJ = s.pending.filter((x) => x.waitingFor === 'jeweller');

  return `
  ${S.conflicts.length ? `<div class="banner bad"><b>Sync conflicts (${S.conflicts.length}).</b> Entries made offline that no longer fit the ledger were NOT added and must be redone:
    ${S.conflicts.map((c) => `<div class="mono">${esc(c.type)} ${short(c.id)}: ${esc(c.message)}</div>`).join('')} <button class="small ghost" data-act="clear-conflicts">Dismiss</button></div>` : ''}
  ${!s.accountOpen ? `<div class="banner warn">Waiting for <b>${esc(p.karigar.name)}</b> to accept the account and consent text on his phone →</div>` : ''}

  <section class="card">
    <h2>${esc(p.jeweller.name)} ↔ ${esc(p.karigar.name)} <span class="sub">jeweller app · shared ledger</span></h2>
    <div class="balances">
      <div class="bal"><div class="k">Fine gold balance</div><div class="v">${fine(Math.abs(s.goldBalanceUg))}</div><div class="x">${esc(b.g)}</div></div>
      <div class="bal"><div class="k">Cash (labour) balance</div><div class="v">${U.formatPaise(Math.abs(s.cashBalancePaise))}</div><div class="x">${esc(b.c)}</div></div>
      <div class="bal"><div class="k">Ledger</div><div class="v mono" style="font-size:15px">${s.order.length} entries</div>
        <div class="x">head <span class="mono">${short(S.jChain.at(-1)?.hash)}</span> · ${v ? (v.ok ? '<span class="tag ok">verified</span>' : '<span class="tag bad">FAILED</span>') : 'not checked'}
        ${v?.same !== undefined ? (v.same ? ' · both copies identical' : ' · <b>copies differ</b> (karigar offline or unsynced)') : ''}</div>
        <div class="row" style="margin-top:6px"><button class="small ghost" data-act="verify">Verify both copies</button><button class="small ghost" data-act="export-j">Export JSON</button></div></div>
    </div>
    <p class="hint">Only entries <b>both</b> parties approved count. Weights are integer mg, purity in ‰, and fine gold is kept exactly in µg (hover a figure to see it).
      Wastage on <b>${s.terms.wastageBasis === 'finished_net' ? 'finished net weight' : 'gold issued'}</b>, allowance <b>${s.terms.allowanceMode}</b>.</p>
    <div class="row hint">
      <label class="inline">Demo date <input type="date" data-bind="today" value="${esc(S.today)}" /></label>
      <label class="inline">Karigar messages in <select data-bind="lang"><option value="hi" ${S.lang === 'hi' ? 'selected' : ''}>Hindi</option><option value="en" ${S.lang === 'en' ? 'selected' : ''}>English</option></select></label>
      <button class="small danger" data-act="reset">Reset demo</button>
    </div>
  </section>

  <section class="card">
    <h2>Case agent <span class="tag rule">RULE-BASED</span> <span class="sub">proposes next steps; nothing runs without your approval</span></h2>
    ${actions.length ? actions.map(renderAction).join('') : '<p class="hint">Nothing to do right now.</p>'}
    <label class="inline hint"><input type="checkbox" data-bind="simFail" ${S.simFail ? 'checked' : ''}/> Make the next <span class="tag mock">MOCK</span> UPI call fail (to test recovery)</label>
    ${history.length ? `<details style="margin-top:8px"><summary class="hint">Recent agent actions</summary>${history.map((a) => `<div class="hint">${a.status === 'done' ? '✔' : '✖'} ${esc(a.summary)} ${a.result && typeof a.result === 'string' ? `<span class="mono">${esc(a.result)}</span>` : ''}</div>`).join('')}</details>` : ''}
  </section>

  <section class="card">
    <h2>Waiting for approval</h2>
    ${waitingJ.length ? `<p><b>Needs YOUR approval</b> (entered by the karigar):</p>${waitingJ.map((x) => `<div class="action gm"><b>${esc(x.type)}</b> ${describe(x.type, x.payload, s)}
      <div class="row" style="margin-top:6px"><button class="small" data-act="j-approve" data-id="${x.id}">Review &amp; approve</button><button class="small danger" data-act="j-reject" data-id="${x.id}">Reject…</button></div></div>`).join('')}` : ''}
    ${waitingK.length ? `<p><b>Waiting for ${esc(p.karigar.name)}</b>:</p>${waitingK.map((x) => `<div class="hint">• ${esc(x.type)}: ${describe(x.type, x.payload, s)}</div>`).join('')}` : ''}
    ${!waitingJ.length && !waitingK.length ? '<p class="hint">Nothing pending.</p>' : ''}
  </section>

  ${s.disputes.length ? `<section class="card"><h2>Reviews &amp; disputes</h2>${s.disputes.map((d) => `<div class="action ${d.open ? 'gm' : ''}">
    <b>${d.open ? 'Open' : 'Resolved'}</b>, raised by ${esc(d.by)} on entry <span class="mono">${short(d.target)}</span><div class="evidence">${esc(d.reason)}</div>
    ${d.open ? `<button class="small" data-act="resolve" data-id="${d.id}">Propose resolution…</button>` : ''}</div>`).join('')}</section>` : ''}

  <section class="card">
    <h2>Jobs <span class="sub">fine-gold reconciliation per job</span></h2>
    ${s.jobs.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Design</th><th>Status</th><th class="num">Issued (fine)</th><th class="num">Returned (fine)</th><th class="num">Loss</th><th class="num">Allowance</th><th class="num">Balance</th><th class="num">Labour</th><th></th></tr></thead><tbody>
    ${s.jobs.map((j) => `<tr>
      <td><b>${esc(j.design)}</b><div class="hint">${esc(j.category)} · due ${esc(j.dueDate)}${j.customerDate ? ` · customer ${esc(j.customerDate)}` : ''}</div>
        ${(j.flags || []).map((f) => `<span class="flag">⚑ ${esc(f.text)}</span>`).join('')}</td>
      <td>${statusTag(j)}</td>
      ${j.issuedFineUg !== undefined ? `<td class="num">${fine(j.issuedFineUg)}</td><td class="num">${fine(j.returnedFineUg)}</td>
      ${j.isFinal ? `<td class="num">${fine(j.lossUg)}<div class="hint">${U.formatBp(Math.abs(j.lossBp))}</div></td>` : '<td class="num hint">in progress</td>'}<td class="num">${fine(j.allowanceUg)}</td>
      <td class="num">${fine(j.balanceUg)}</td><td class="num">${U.formatPaise(j.labourPaise)}</td>` : '<td colspan="6" class="hint">counts once both parties approve the issue</td>'}
      <td><button class="small ghost" data-act="void" data-id="${j.id}">Void…</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">No jobs yet.</p>'}
  </section>

  ${s.accountOpen ? renderForms(s, openJobs) : ''}

  <section class="card"><details><summary>Audit trail: every record, hash-chained and signed (${S.jChain.length})</summary>
    <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>Type</th><th>By</th><th>Status</th><th>Entry id</th><th>Record hash</th><th>Prev</th></tr></thead><tbody>
    ${S.jChain.map((r) => { const st = r.item.statement; return `<tr><td>${r.seq}</td><td>${esc(st.type)}${st.payload.target ? ` → <span class="mono">${short(st.payload.target)}</span>` : ''}</td><td>${esc(st.author)}</td>
      <td>${['APPROVE', 'REJECT'].includes(st.type) ? '' : esc(s.statusOf(r.item.id))}</td><td class="mono">${short(r.item.id)}</td><td class="mono">${short(r.hash)}</td><td class="mono">${short(r.prevHash)}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${v && !v.ok ? `<div class="banner bad">${v.errors.map((e) => `#${e.seq} ${esc(e.code)}: ${esc(e.message)}`).join('<br>')}</div>` : ''}
  </details></section>`;
}

function statusTag(j) {
  if (j.issueStatus === 'voided') return '<span class="tag void">voided</span>';
  if (j.issueStatus === 'pending') return '<span class="tag pend">awaiting karigar</span>';
  if (j.issueStatus === 'rejected') return '<span class="tag bad">rejected</span>';
  if (j.isFinal) return `<span class="tag ok">returned</span>${j.pendingReturns ? '<div class="hint">+ return pending</div>' : ''}`;
  return `<span class="tag pend">with karigar</span>${j.pendingReturns ? '<div class="hint">return pending approval</div>' : ''}`;
}

function renderAction(a) {
  const ev = a.evidence?.lines;
  return `<div class="action ${a.goldOrMoney ? 'gm' : ''} ${a.status === 'failed' ? 'failed' : ''}">
    <div>${a.goldOrMoney ? '<span class="tag gm">GOLD / MONEY</span> ' : ''}${a.kind === 'PAY_VIA_UPI_MOCK' ? '<span class="tag mock">MOCK UPI</span> ' : ''}${a.kind.match(/CHASE|REMIND/) ? '<span class="tag mock">MOCK WHATSAPP</span> ' : ''}${esc(a.summary)}</div>
    ${ev ? `<div class="evidence">${ev.map(esc).join('<br>')}</div>` : ''}
    <div class="meta">Needs approval from: ${a.requires.join(', ')} · ${esc(a.status.replace('_', ' '))}${a.error ? ` · <b style="color:var(--bad)">${esc(a.error)}</b>` : ''}</div>
    <div class="row">
      ${a.status === 'awaiting_approval' ? `<button class="small" data-act="gate-approve" data-id="${a.id}">Approve &amp; run</button><button class="small danger" data-act="gate-reject" data-id="${a.id}">Reject</button>` : ''}
      ${a.status === 'failed' ? `<button class="small" data-act="gate-reopen" data-id="${a.id}">Retry (asks again)</button><button class="small danger" data-act="gate-reject" data-id="${a.id}">Drop</button>` : ''}
    </div></div>`;
}

function describe(type, p, s) {
  const job = (id) => esc(s.jobs.find((j) => j.id === id)?.design ?? short(id));
  switch (type) {
    case 'OPEN_ACCOUNT': return 'open shared account + consent';
    case 'ISSUE': return `${esc(p.design)}: ${p.gold.map((g) => `${U.formatMg(g.grossMg)} @ ${g.fineness}‰`).join(' + ')} = ${U.formatFineUg(p.gold.reduce((a, g) => a + g.grossMg * g.fineness, 0))} fine, wastage ${U.formatBp(p.wastageBp)}, due ${esc(p.dueDate)}`;
    case 'RETURN': return `${job(p.job)}: ${p.pieces.length} piece(s), ${p.scrap.length} scrap lot(s)${p.final ? ', final' : ''}`;
    case 'SETTLEMENT': return `labour ${U.formatPaise(p.cashBalancePaise)}, gold ${U.formatFineUg(p.goldBalanceUg)} fine (${p.goldAction.replace(/_/g, ' ')}), payable ${U.formatPaise(p.payablePaise)}`;
    case 'PAYMENT': return `${U.formatPaise(p.amountPaise)} via ${esc(p.method)} <span class="mono">${esc(p.reference)}</span>`;
    case 'OPENING_BALANCE': return `gold ${U.formatFineUg(p.goldUg)} fine, cash ${U.formatPaise(p.cashPaise)} (from ${esc(p.source)})`;
    case 'REFINER_RESULT': return `${job(p.job)}: refiner recovered ${U.formatFineUg(p.recoveredFineUg)} fine`;
    case 'VOID': return `cancel entry ${short(p.target)}: ${esc(p.reason)}`;
    case 'DISPUTE_RESOLUTION': return `${esc(p.outcome.replace(/_/g, ' '))}: ${esc(p.note)}`;
    default: return '';
  }
}

function renderForms(s, openJobs) {
  const d = new Date(Date.parse(S.today) + 7 * 864e5).toISOString().slice(0, 10);
  return `
  <section class="card"><h2>Issue gold to karigar <span class="tag gm">GOLD</span></h2>
    <form class="grid" data-form="issue">
      <label>Design / order<input name="design" required placeholder="e.g. 2 bangles, order 118" /></label>
      <label>Category<select name="category">${['bangle', 'chain', 'ring', 'earring', 'necklace', 'other'].map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>Gross weight (g)<input name="gross" inputmode="decimal" required placeholder="10.000" /></label>
      <label>Purity (‰)<input name="fineness" inputmode="numeric" value="995" required /></label>
      <label>Form<select name="form"><option value="bar">bar / pure</option><option value="wire">wire / sheet</option><option value="old_jewellery">old jewellery</option></select></label>
      <label>Agreed wastage (%)<input name="wastage" inputmode="decimal" value="2.5" required /></label>
      <label>Labour<select name="lmode"><option value="per_gram">per gram</option><option value="per_piece">per piece</option></select></label>
      <label>Labour rate (₹)<input name="rate" inputmode="decimal" value="350" required /></label>
      <label>Due date<input type="date" name="due" value="${d}" required /></label>
      <label>Customer's occasion date (optional)<input type="date" name="cust" /></label>
      <button>Review &amp; sign…</button>
    </form>
    <p class="hint">📷 <i>Read weight from a scale photo</i> is <b>not built yet</b> (planned AI component). Weights are typed for now.</p>
  </section>

  <section class="card"><h2>Record a return <span class="tag gm">GOLD</span></h2>
    ${openJobs.length ? `<form class="grid" data-form="return">
      <label>Job<select name="job">${openJobs.map((j) => `<option value="${j.id}">${esc(j.design)} (due ${esc(j.dueDate)})</option>`).join('')}</select></label>
      <label>Piece label<input name="plabel" placeholder="bangle pair" /></label>
      <label>Piece gross (g)<input name="pgross" inputmode="decimal" placeholder="10.900" /></label>
      <label>Stones / enamel (g)<input name="pstone" inputmode="decimal" value="0" /></label>
      <label>Piece purity (‰)<input name="pfine" inputmode="numeric" value="916" /></label>
      <label>HUID <span class="tag mock">MOCK check</span><input name="huid" placeholder="optional, 6 chars" /></label>
      <label>Scrap kind<select name="skind"><option value="filings">filings (lalli/bhuka)</option><option value="dust">dust</option><option value="unused">unused gold</option><option value="other">other</option></select></label>
      <label>Scrap gross (g)<input name="sgross" inputmode="decimal" placeholder="0.150" /></label>
      <label>Scrap purity (‰)<input name="sfine" inputmode="numeric" value="916" /></label>
      <label class="inline"><input type="checkbox" name="sprov" checked /> scrap purity is an estimate (refiner will confirm)</label>
      <label class="inline"><input type="checkbox" name="final" checked /> this closes the job</label>
      <button>Review &amp; sign…</button>
    </form><p class="hint">One piece row and one scrap lot per return in this prototype. Record several returns for more pieces.</p>` : '<p class="hint">No open jobs (an issue counts once the karigar approves it).</p>'}
  </section>

  <section class="card"><details><summary>Opening balance from an old bahi-khata page <span class="tag gm">GOLD / MONEY</span></summary>
    <p class="hint">📷 Reading a handwritten bahi page is <b>not built yet</b> (planned AI component, with a human checking every row). Type the figures for now.</p>
    <form class="grid" data-form="opening">
      <label>Fine gold karigar holds (g, negative if you owe him)<input name="gold" placeholder="0.000" value="0" /></label>
      <label>Cash you owe karigar (₹, negative if he owes you)<input name="cash" value="0" /></label>
      <label>Source<select name="source"><option value="bahi_page">bahi page</option><option value="verbal">verbal</option><option value="other">other</option></select></label>
      <label>Note<input name="note" placeholder="page / date" /></label>
      <button>Review &amp; sign…</button>
    </form></details></section>`;
}

function renderPhone(ks) {
  const p = ks.parties ?? S.jChain[0].item.statement.payload.parties;
  const mine = ks.pending?.filter((x) => x.waitingFor === 'karigar') ?? [];
  const b = balanceText(ks.goldBalanceUg ?? 0, ks.cashBalancePaise ?? 0, 'karigar');
  const tab = S.phoneTab;
  const chat = S.chat.map((m) => m.from === 'system'
    ? `<div class="bubble sys">${esc(m.text)}</div>`
    : `<div class="bubble ${m.from === 'karigar' ? 'me' : ''}"><div class="who">${m.from === 'karigar' ? 'You (karigar)' : esc(p.jeweller.name)} · ${m.ts.slice(11, 16)}</div>${esc(m.text)}</div>`).join('');
  const cards = mine.map((x) => {
    const extra = x.type === 'ISSUE' ? { jeweller: p.jeweller.name, fine: U.formatFineUg(x.payload.gold.reduce((a, g) => a + g.grossMg * g.fineness, 0)) }
      : x.type === 'RETURN' ? { fine: U.formatFineUg(x.payload.pieces.reduce((a, q) => a + (q.grossMg - (q.stoneMg ?? 0)) * q.fineness, 0) + x.payload.scrap.reduce((a, q) => a + q.grossMg * q.fineness, 0)) } : {};
    const m = messageFor(S.lang, x.type, x.payload, extra);
    return `<div class="bubble"><div class="who">${esc(p.jeweller.name)} · 🔊 voice note <span class="tag mock">MOCK TTS</span></div>${esc(m?.text ?? x.type)}
      <div class="acts"><button class="small" data-act="k-approve" data-id="${x.id}">✔ ${S.lang === 'hi' ? 'हाँ' : 'Yes'}</button><button class="small danger" data-act="k-reject" data-id="${x.id}">✖ ${S.lang === 'hi' ? 'नहीं' : 'No'}</button></div></div>`;
  }).join('');

  return `<aside class="phone" aria-label="Simulated karigar phone">
    <div class="bar"><div class="title">${esc(p.karigar.name)}'s phone ${S.online ? '' : '<span class="offline-pill">OFFLINE</span>'}</div>
      <div class="s"><span class="tag mock">MOCK</span> ${esc(WA_LABEL)}</div>
      <label class="inline" style="color:#fff;font-size:12px;margin-top:4px"><input type="checkbox" data-bind="online" ${S.online ? 'checked' : ''}/> phone has network</label></div>
    <div class="tabs"><button class="${tab === 'chat' ? 'on' : ''}" data-act="tab" data-id="chat">WhatsApp</button><button class="${tab === 'khata' ? 'on' : ''}" data-act="tab" data-id="khata">${S.lang === 'hi' ? 'मेरा खाता' : 'My account'}</button></div>
    <div class="body">
    ${tab === 'chat' ? `${chat}${cards}${!S.online ? '<div class="bubble sys">No network. Your replies are saved on this phone and sent when the network returns.</div>' : ''}`
    : `<div class="bubble sys">This is your <b>full account</b>. Your phone keeps its own copy and checks every signature itself.</div>
      <div class="bubble"><div class="who">Gold</div><b>${esc(b.g)}</b> <span class="hint">(fine)</span></div>
      <div class="bubble"><div class="who">Money</div><b>${esc(b.c)}</b></div>
      ${(ks.jobs ?? []).filter((j) => j.issuedFineUg !== undefined).map((j) => `<div class="bubble"><div class="who">${esc(j.design)} · due ${esc(j.dueDate)}</div>
        Issued ${fine(j.issuedFineUg)} · returned ${fine(j.returnedFineUg)}<br>${j.isFinal
          ? `Wastage ${fine(j.lossUg)} (${U.formatBp(Math.abs(j.lossBp))}) · allowed ${fine(j.allowanceUg)}`
          : `In progress: ${fine(j.issuedFineUg - j.returnedFineUg)} fine is with you`}<br>Labour ${U.formatPaise(j.labourPaise)}
        ${(j.flags || []).map((f) => `<span class="flag">⚑ ${esc(f.text)}</span>`).join('')}
        <div class="acts"><button class="small ghost" data-act="k-dispute" data-id="${j.id}">I disagree…</button></div></div>`).join('')}
      ${(ks.settlements ?? []).map((st) => `<div class="bubble"><div class="who">Settlement</div>Payable ${U.formatPaise(st.payablePaise)} · paid ${U.formatPaise(st.paidPaise)}</div>`).join('')}
      <div class="bubble"><button class="small ghost" data-act="export-k">Download my account (JSON)</button></div>`}
    </div>
    <form class="compose" data-form="voice">
      <div class="hint" style="margin-bottom:4px">🎤 <span class="tag mock">MOCK SPEECH</span> type what the karigar says, e.g. "haan", "nahi, 9.950 mila tha", "do din aur"</div>
      <div class="row"><input name="said" autocomplete="off" placeholder="${S.lang === 'hi' ? 'हाँ / नहीं / काम की खबर…' : 'yes / no / progress…'}" /><button>Send</button></div>
    </form>
  </aside>`;
}

// ------------------------------------------------------------------ agent action runners (run only after gate approval)
function runnerFor(a, s) {
  const needPhone = () => { if (!S.online) throw new Error("Karigar's phone is offline, so the message was not delivered. Retry when it is back."); };
  switch (a.kind) {
    case 'CHASE_APPROVAL':
      return async () => { needPhone(); pushChat('jeweller', messageFor(S.lang, 'CHASE_APPROVAL', null, { count: a.data.ids.length }).text); await persist(); return 'sent (mock WhatsApp)'; };
    case 'REMIND_DEADLINE':
      return async () => { needPhone(); const j = s.jobs.find((x) => x.id === a.data.job); pushChat('jeweller', messageFor(S.lang, 'REMIND_DEADLINE', null, { design: j.design, dueDate: j.dueDate }).text); await persist(); return 'sent (mock WhatsApp)'; };
    case 'REVIEW_WASTAGE':
      return async () => {
        await signAs('jeweller', 'DISPUTE', { target: a.data.job, reason: `Joint review requested: wastage above the agreed allowance. ${a.data.evidence.lines.slice(1).join(' | ')}` });
        pushChat('jeweller', S.lang === 'hi' ? 'छीजत तय सीमा से ज़्यादा दिख रही है। साथ में देख लेते हैं, आप अपनी बात "मेरा खाता" में बता सकते हैं।' : 'Wastage looks above the agreed allowance. Let us review together; you can reply from "My account".');
        await persist(); return 'review opened';
      };
    case 'REFINER_FOLLOWUP':
      return async () => {
        const j = s.jobs.find((x) => x.id === a.data.job);
        const rets = s.order.filter((id) => s.get(id).item.statement.type === 'RETURN' && s.get(id).item.statement.payload.job === j.id && s.isEffective(id));
        const lots = rets.flatMap((rid) => s.get(rid).item.statement.payload.scrap.map((lot, i) => ({ rid, i, lot }))).filter((x) => x.lot.provisional);
        const v = await dialog({ title: `Refiner result: ${j.design}`, fields: [
          { name: 'lot', label: 'Scrap lot', type: 'select', options: lots.map((x) => [`${x.rid}:${x.i}`, `${x.lot.kind} ${U.formatMg(x.lot.grossMg)} @ ${x.lot.fineness}‰ (est.)`]) },
          { name: 'fine', label: 'Recovered FINE gold (g)', required: true, placeholder: '0.130' }, { name: 'refiner', label: 'Refiner', required: true, value: '' }], ok: 'Review & sign…' });
        if (!v) throw new Error('Cancelled. Nothing was recorded.');
        const [rid, idx] = v.lot.split(':');
        const payload = { job: j.id, returnId: rid, scrapIndex: Number(idx), recoveredFineUg: parseG(v.fine, 'Recovered fine') * 1000, refiner: v.refiner };
        if (!(await confirmSign('jeweller', 'Sign refiner result?', [describe('REFINER_RESULT', payload, s)]))) throw new Error('Cancelled. Nothing was signed.');
        await signAs('jeweller', 'REFINER_RESULT', payload); return 'recorded';
      };
    case 'PROPOSE_SETTLEMENT':
      return async () => {
        const figs = L.proposeSettlementFigures(L.deriveState(S.jChain)); // recomputed at run time, never stale
        await signAs('jeweller', 'SETTLEMENT', figs); return `settlement sent: payable ${U.formatPaise(figs.payablePaise)}`;
      };
    case 'PAY_VIA_UPI_MOCK':
      return async () => {
        const simulateFailure = S.simFail;
        S.simFail = false; // "fail the NEXT call" only: the retry should go through
        await persist();
        const r = await mockUpiPay({ amountPaise: a.data.amountPaise, payeeVpa: S.vpa, note: 'job-work labour', simulateFailure });
        await signAs('jeweller', 'PAYMENT', { settlement: a.data.settlement, amountPaise: a.data.amountPaise, method: 'UPI_MOCK', reference: r.reference });
        return r.reference;
      };
    default: return async () => { throw new Error(`no runner for ${a.kind}`); };
  }
}

// ------------------------------------------------------------------ events
async function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const s = () => L.deriveState(S.jChain, { today: S.today });
  const H = {
    seed: () => guarded(seedDemo),
    reset: () => guarded(async () => { if (await dialog({ title: 'Reset demo?', lines: ['Deletes both ledger copies and keys from this browser.'], ok: 'Delete everything', danger: true })) { await clearAll(); location.reload(); } }),
    tab: () => { S.phoneTab = id; render(); },
    'clear-conflicts': () => { S.conflicts = []; persist(); render(); },
    verify: () => guarded(async () => {
      const a = await L.verifyChain(S.jChain), b = await L.verifyChain(S.kChain);
      S.verify = { ok: a.ok && b.ok, errors: [...a.errors, ...b.errors], same: a.head === b.head };
      toast(S.verify.ok ? `Both copies verified (${a.length} / ${b.length} records). ${S.verify.same ? 'Identical heads.' : 'Heads differ: sync pending.'}` : 'Verification FAILED', !S.verify.ok);
    }),
    'export-j': () => download(`ledger-jeweller-${accountId()}.json`, S.jChain),
    'export-k': () => download(`my-account-${accountId()}.json`, S.kChain),
    'gate-approve': () => guarded(() => gate.approve(id, 'jeweller')),
    'gate-reject': () => { gate.reject(id, 'jeweller', 'rejected in UI'); },
    'gate-reopen': () => { gate.reopen(id); },
    'j-approve': () => guarded(async () => {
      const x = s().pending.find((p) => p.id === id);
      if (await confirmSign('jeweller', `Approve ${x.type}?`, [describe(x.type, x.payload, s())])) await signAs('jeweller', 'APPROVE', { target: id });
    }),
    'j-reject': () => guarded(async () => {
      const v = await dialog({ title: 'Reject entry', fields: [{ name: 'reason', label: 'Reason (shown to the karigar)', required: true }], ok: 'Reject', danger: true });
      if (v) await signAs('jeweller', 'REJECT', { target: id, reason: v.reason });
    }),
    void: () => guarded(async () => {
      const v = await dialog({ title: 'Void this job?', lines: ['Nothing is deleted. A VOID entry is added, and it only takes effect if the karigar agrees.'], fields: [{ name: 'reason', label: 'Reason', required: true }], ok: 'Sign VOID request', danger: true });
      if (v) await signAs('jeweller', 'VOID', { target: id, reason: v.reason });
    }),
    resolve: () => guarded(async () => {
      const v = await dialog({ title: 'Propose a resolution', fields: [{ name: 'outcome', label: 'Outcome', type: 'select', options: [['agreed_as_recorded', 'Agreed: figures stand as recorded'], ['corrected', 'Corrected (void + re-enter the wrong entry)'], ['withdrawn', 'Withdrawn']] }, { name: 'note', label: 'What was agreed', required: true }], ok: 'Sign & send to karigar' });
      if (v) await signAs('jeweller', 'DISPUTE_RESOLUTION', { dispute: id, outcome: v.outcome, note: v.note });
    }),
    'k-approve': () => guarded(() => karigarDecide(id, true, S.lang === 'hi' ? 'हाँ ✔' : 'Yes ✔')),
    'k-reject': () => guarded(async () => {
      const v = await dialog({ title: 'Karigar says "no". Why?', fields: [{ name: 'reason', label: 'Reason (MOCK SPEECH: typed)', required: true, placeholder: 'e.g. mujhe 9.950 g mila tha' }], ok: 'Send' });
      if (v) await karigarDecide(id, false, v.reason);
    }),
    'k-dispute': () => guarded(async () => {
      const v = await dialog({ title: 'What is wrong? (karigar)', fields: [{ name: 'reason', label: 'Reason (MOCK SPEECH: typed)', required: true }], ok: 'Raise with jeweller' });
      if (v) { await signAs('karigar', 'DISPUTE', { target: id, reason: v.reason }); pushChat('karigar', `⚑ ${v.reason}`); await persist(); }
    }),
  };
  H[act]?.();
}

async function karigarDecide(id, yes, said) {
  pushChat('karigar', said);
  if (yes) await signAs('karigar', 'APPROVE', { target: id });
  else await signAs('karigar', 'REJECT', { target: id, reason: said });
  await persist();
}

function onChange(e) {
  const k = e.target.dataset?.bind;
  if (!k) return;
  if (k === 'online') {
    S.online = e.target.checked;
    guarded(async () => {
      if (S.online) { await sync(); pushChat('system', 'Network back: ledger copies merged.'); toast('Phone back online: copies merged'); }
      else pushChat('system', 'Phone has no network. Both sides keep working on their own copy.');
      await persist();
    });
    return;
  }
  S[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  persist(); render();
}

async function onSubmit(e) {
  const form = e.target.closest('[data-form]');
  if (!form || form.method === 'dialog') return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  await guarded(async () => {
    if (kind === 'open') return openAccount(f);
    if (kind === 'issue') {
      const payload = {
        design: f.design.trim(), category: f.category,
        gold: [{ grossMg: parseG(f.gross, 'Gross weight'), fineness: parseInt10(f.fineness, 'Purity', 1, 1000), form: f.form }],
        wastageBp: U.parsePercentToBp(f.wastage), labour: { mode: f.lmode, ratePaise: U.parseRupeesToPaise(f.rate) }, dueDate: f.due,
        ...(f.cust ? { customerDate: f.cust } : {}),
      };
      const fu = payload.gold[0].grossMg * payload.gold[0].fineness;
      const ok = await confirmSign('jeweller', 'Issue gold?', [
        `${esc(payload.design)} (${esc(payload.category)})`,
        `${U.formatMg(payload.gold[0].grossMg)} × ${payload.gold[0].fineness}‰ = <b>${U.formatFineUg(fu)} fine</b> <span class="hint">(${U.formatFineUgExact(fu)})</span>`,
        `Wastage allowance ${U.formatBp(payload.wastageBp)} · labour ${U.formatPaise(payload.labour.ratePaise)} ${payload.labour.mode.replace('_', ' ')} · due ${esc(payload.dueDate)}`]);
      if (!ok) return;
      const id = await signAs('jeweller', 'ISSUE', payload);
      if (!S.online) toast("Saved. The karigar's phone is offline, so he will see it when it reconnects.");
      form.reset(); return id;
    }
    if (kind === 'return') {
      const pieces = f.pgross ? [{ label: f.plabel || 'piece', grossMg: parseG(f.pgross, 'Piece gross'), stoneMg: parseG(f.pstone || '0', 'Stones'), fineness: parseInt10(f.pfine, 'Piece purity', 1, 1000) }] : [];
      if (pieces[0] && f.huid) {
        const h = await mockHuidLookup(f.huid);
        if (!h.ok) throw new Error(`HUID: ${h.message}`);
        pieces[0].huid = h.huid; toast(`${HUID_LABEL}: ${h.message}`);
      }
      const scrap = f.sgross ? [{ kind: f.skind, grossMg: parseG(f.sgross, 'Scrap gross'), fineness: parseInt10(f.sfine, 'Scrap purity', 1, 1000), provisional: !!f.sprov }] : [];
      const payload = { job: f.job, pieces, scrap, final: !!f.final };
      const pf = pieces.reduce((a, q) => a + (q.grossMg - q.stoneMg) * q.fineness, 0), sf = scrap.reduce((a, q) => a + q.grossMg * q.fineness, 0);
      const ok = await confirmSign('jeweller', 'Record return?', [
        ...pieces.map((q) => `${esc(q.label)}: ${U.formatMg(q.grossMg)} − stones ${U.formatMg(q.stoneMg)} = ${U.formatMg(q.grossMg - q.stoneMg)} × ${q.fineness}‰ = <b>${U.formatFineUg((q.grossMg - q.stoneMg) * q.fineness)} fine</b>${q.huid ? ` · HUID ${esc(q.huid)} <span class="tag mock">MOCK</span>` : ''}`),
        ...scrap.map((q) => `${q.kind}: ${U.formatMg(q.grossMg)} × ${q.fineness}‰ = <b>${U.formatFineUg(q.grossMg * q.fineness)} fine</b>${q.provisional ? ' (estimate until refiner)' : ''}`),
        `Total returned: <b>${U.formatFineUg(pf + sf)} fine</b>${payload.final ? ' · closes the job' : ''}`]);
      if (!ok) return;
      await signAs('jeweller', 'RETURN', payload); form.reset(); return;
    }
    if (kind === 'opening') {
      const neg = (v) => v.trim().startsWith('-');
      const g = parseG(f.gold.replace('-', '') || '0', 'Gold') * 1000 * (neg(f.gold) ? -1 : 1);
      const c = U.parseRupeesToPaise(f.cash.replace('-', '') || '0') * (neg(f.cash) ? -1 : 1);
      const payload = { goldUg: g, cashPaise: c, source: f.source, note: f.note };
      if (await confirmSign('jeweller', 'Record opening balance?', [describe('OPENING_BALANCE', payload)])) await signAs('jeweller', 'OPENING_BALANCE', payload);
      return;
    }
    if (kind === 'voice') {
      const said = f.said?.trim(); if (!said) return;
      form.reset();
      const ks = L.deriveState(S.kChain, { today: S.today });
      const mine = ks.pending.filter((x) => x.waitingFor === 'karigar');
      const u = mockUnderstand(said);
      if ((u.intent === 'approve' || u.intent === 'reject') && mine.length) {
        // Voice yes/no applies to the OLDEST waiting entry only, which is the one shown first on the phone.
        if (u.intent === 'approve') await karigarDecide(mine[0].id, true, said);
        else await karigarDecide(mine[0].id, false, said);
        toast(`${SPEECH_LABEL}: understood "${u.intent}" for ${mine[0].type}`);
      } else {
        pushChat('karigar', said);
        const job = ks.jobs.find((j) => j.issueStatus === 'approved' && !j.isFinal);
        await signAs('karigar', 'NOTE', { text: said, ...(job ? { job: job.id } : {}) });
        toast(`${SPEECH_LABEL}: saved as a progress note`);
      }
      await persist();
    }
  });
}

async function openAccount(f) {
  S.keys = { jeweller: await generateKeyPair(), karigar: await generateKeyPair() };
  S.lang = f.lang; S.vpa = f.vpa || 'karigar@mockupi'; S.chat = []; S.jChain = []; S.kChain = [];
  const consentText = f.lang === 'hi'
    ? 'इसमें सिर्फ़ हमारे काम का वज़न, तारीख और पैसे दर्ज होंगे।'
    : 'Only weights, dates and amounts for our job-work are stored.';
  const payload = { parties: { jeweller: { name: f.shop, publicJwk: S.keys.jeweller.publicJwk }, karigar: { name: f.karigar, publicJwk: S.keys.karigar.publicJwk, language: f.lang } },
    terms: { wastageBasis: f.basis, allowanceMode: f.mode }, consent: { text: consentText, language: f.lang } };
  await signAs('jeweller', 'OPEN_ACCOUNT', payload, `acct-${randomNonce()}`);
  pushChat('system', 'Account created. Waiting for the karigar to accept on his phone.');
  await persist();
}

/** Synthetic demo: invented weights, run through the same signed code paths. Not field data. */
async function seedDemo() {
  await openAccount({ shop: 'Demo Jewellers (synthetic)', karigar: 'Demo Karigar', lang: 'hi', vpa: 'karigar@mockupi', basis: 'finished_net', mode: 'fixed' });
  const k = (id) => signAs('karigar', 'APPROVE', { target: id });
  await k(S.jChain[0].item.id);
  const add = (n) => new Date(Date.parse(S.today) + n * 864e5).toISOString().slice(0, 10);
  const j1 = await signAs('jeweller', 'ISSUE', { design: 'Bangle pair, order D-1', category: 'bangle', gold: [{ grossMg: 10_000, fineness: 995, form: 'bar' }], wastageBp: 50, labour: { mode: 'per_gram', ratePaise: 35_000 }, dueDate: add(-3) });
  await k(j1);
  await signAs('jeweller', 'RETURN', { job: j1, final: true, pieces: [{ label: 'bangle pair', grossMg: 10_900, stoneMg: 250, fineness: 916 }], scrap: [{ kind: 'filings', grossMg: 150, fineness: 916, provisional: true }] });
  await k(S.jChain.at(-1).item.id);
  const j2 = await signAs('jeweller', 'ISSUE', { design: 'Chain, order D-2', category: 'chain', gold: [{ grossMg: 15_500, fineness: 995, form: 'wire' }], wastageBp: 300, labour: { mode: 'per_gram', ratePaise: 25_000 }, dueDate: add(-1), customerDate: add(2) });
  await k(j2);
  pushChat('system', 'SYNTHETIC demo loaded. All weights are invented test values.');
  await persist();
}

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

boot();
