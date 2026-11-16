import { generateKeyPair } from '../src/core/crypto.js';
import { createItem, append } from '../src/core/ledger.js';

export const TERMS = { wastageBasis: 'finished_net', allowanceMode: 'fixed' };
export const CONSENT = { text: 'Only weights, dates and amounts for our job-work are stored.', language: 'hi' };

/** Two parties with keys, an open and accepted account, and small helpers to write and approve entries. */
export async function setup({ terms = TERMS } = {}) {
  const keys = { jeweller: await generateKeyPair(), karigar: await generateKeyPair() };
  const account = 'acct-test-1';
  const ctx = { keys, account, chain: [] };
  ctx.item = (author, type, payload, ts) => createItem({ account, author, type, payload, privateKey: keys[author].privateKey, ts });
  ctx.add = async (author, type, payload, ts) => { const it = await ctx.item(author, type, payload, ts); ctx.chain = await append(ctx.chain, it); return it.id; };
  ctx.approve = (party, target) => ctx.add(party, 'APPROVE', { target });
  ctx.both = async (author, type, payload, ts) => { const id = await ctx.add(author, type, payload, ts); await ctx.approve(author === 'jeweller' ? 'karigar' : 'jeweller', id); return id; };
  const open = await ctx.add('jeweller', 'OPEN_ACCOUNT', {
    parties: { jeweller: { name: 'Shah Jewellers', publicJwk: keys.jeweller.publicJwk }, karigar: { name: 'Karigar A', publicJwk: keys.karigar.publicJwk } },
    terms, consent: CONSENT,
  });
  await ctx.approve('karigar', open);
  return ctx;
}

// 10.000 g of 995 bar -> 9.950 000 g fine
export const ISSUE_10G = {
  design: 'Bangle pair, test', category: 'bangle', gold: [{ grossMg: 10_000, fineness: 995, form: 'bar' }],
  wastageBp: 250, labour: { mode: 'per_gram', ratePaise: 35_000 }, dueDate: '2026-11-25',
};
// pieces 10.900 g gross, 0.250 g stones, 916 -> 10.650 g net -> 9.755 400 g fine; filings 0.150 g @ 916 (provisional) -> 0.137 400 g fine
export const RETURN_FULL = (job) => ({
  job, final: true,
  pieces: [{ label: 'bangle pair', grossMg: 10_900, stoneMg: 250, fineness: 916 }],
  scrap: [{ kind: 'filings', grossMg: 150, fineness: 916, provisional: true }],
});
