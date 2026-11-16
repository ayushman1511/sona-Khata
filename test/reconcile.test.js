// Milligram-level reconciliation tests. Every expected number is worked out by hand in the comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileJob, allowanceUg, labourPaise, goldValuePaise, pieceNetMg } from '../src/core/reconcile.js';
import { ISSUE_10G, RETURN_FULL } from './helpers.js';

const NET = { wastageBasis: 'finished_net', allowanceMode: 'fixed' };
const R = RETURN_FULL('x'.repeat(64));

test('full job, finished-net basis, fixed allowance: exact µg', () => {
  const r = reconcileJob(ISSUE_10G, [R], NET);
  assert.equal(r.issuedFineUg, 9_950_000);   // 10 000 mg × 995
  assert.equal(r.piecesNetMg, 10_650);       // 10 900 − 250 stones
  assert.equal(r.piecesFineUg, 9_755_400);   // 10 650 × 916
  assert.equal(r.scrapFineUg, 137_400);      // 150 × 916
  assert.equal(r.returnedFineUg, 9_892_800);
  assert.equal(r.lossUg, 57_200);            // 57.2 mg fine actually lost
  assert.equal(r.lossBp, 57);                // 57 200 / 9 950 000 = 0.5749 % -> 57 bp
  assert.equal(r.allowanceUg, 243_885);      // 9 755 400 × 2.5 % (exact)
  assert.equal(r.excessUg, 0);
  assert.equal(r.balanceUg, -186_685);       // 57 200 − 243 885: karigar is in credit by 186.685 mg fine
  assert.equal(r.labourPaise, 372_750);      // 10.650 g × ₹350 = ₹3,727.50
  assert.equal(r.provisionalLots, 1);
  assert.equal(r.isFinal, true);
});

test('capped allowance: the karigar is credited only the actual loss', () => {
  const r = reconcileJob(ISSUE_10G, [R], { ...NET, allowanceMode: 'capped' });
  assert.equal(r.allowanceUg, 57_200);
  assert.equal(r.balanceUg, 0);
});

test('issued basis: allowance is 2.5 % of issued fine, credited only once the job is final', () => {
  const final = reconcileJob(ISSUE_10G, [R], { ...NET, wastageBasis: 'issued' });
  assert.equal(final.allowanceUg, 248_750); // 9 950 000 × 2.5 %
  assert.equal(final.balanceUg, -191_550);
  const partial = reconcileJob(ISSUE_10G, [{ ...R, final: false }], { ...NET, wastageBasis: 'issued' });
  assert.equal(partial.allowanceUg, 0);
  assert.equal(partial.balanceUg, 57_200);
});

test('excess wastage: 0.5 % agreed, 0.575 % lost -> 8.423 mg fine above the allowance', () => {
  const r = reconcileJob({ ...ISSUE_10G, wastageBp: 50 }, [R], NET);
  assert.equal(r.allowanceUg, 48_777);  // 9 755 400 × 0.5 % = 48 777 exactly
  assert.equal(r.excessUg, 8_423);      // 57 200 − 48 777
  assert.equal(r.balanceUg, 8_423);     // karigar owes 8.423 mg fine
});

test('a single milligram changes the result by exactly its fine content', () => {
  const heavier = { ...R, pieces: [{ ...R.pieces[0], grossMg: 10_901 }] };
  const a = reconcileJob(ISSUE_10G, [R], NET);
  const b = reconcileJob(ISSUE_10G, [heavier], NET);
  assert.equal(a.lossUg - b.lossUg, 916);            // 1 mg of 916 = 916 µg fine
  assert.equal(b.allowanceUg - a.allowanceUg, 23);   // ceil(9 756 316 × 0.025) − 243 885 = 243 908 − 243 885
});

test('partial returns accumulate; the open job keeps the gold on the karigar', () => {
  const r1 = { job: R.job, final: false, pieces: [{ label: 'bangle 1', grossMg: 5_450, stoneMg: 125, fineness: 916 }], scrap: [] };
  const r2 = { job: R.job, final: true, pieces: [{ label: 'bangle 2', grossMg: 5_450, stoneMg: 125, fineness: 916 }], scrap: R.scrap };
  const one = reconcileJob(ISSUE_10G, [r1], NET);
  assert.equal(one.piecesFineUg, 4_877_700);         // 5 325 × 916
  assert.equal(one.balanceUg, 9_950_000 - 4_877_700 - 121_943); // allowance ceil(121 942.5) = 121 943
  assert.equal(one.isFinal, false);
  assert.equal(one.excessUg, 0);                     // not judged while the job is open
  const both = reconcileJob(ISSUE_10G, [r1, r2], NET);
  const whole = reconcileJob(ISSUE_10G, [R], NET);
  assert.equal(both.returnedFineUg, whole.returnedFineUg);
  // The allowance is computed once on the cumulative finished fine weight, so partial returns do not
  // accumulate rounding: 243 885, not 121 943 × 2 = 243 886.
  assert.equal(both.allowanceUg, whole.allowanceUg);
  assert.equal(both.allowanceUg, 243_885);
  assert.equal(both.balanceUg, whole.balanceUg);
  assert.equal(both.labourPaise, 186_375 * 2);       // 5.325 g × ₹350 = ₹1,863.75 each
});

test('a refiner result replaces the provisional scrap estimate', () => {
  const r = reconcileJob(ISSUE_10G, [R], NET, new Map([['0:0', 130_000]]));
  assert.equal(r.scrapFineUg, 130_000);
  assert.equal(r.lossUg, 64_600); // 9 950 000 − 9 755 400 − 130 000
  assert.equal(r.provisionalLots, 0);
});

test('mixed issue: bar + old 22K jewellery', () => {
  const issue = { ...ISSUE_10G, gold: [{ grossMg: 5_000, fineness: 995 }, { grossMg: 3_333, fineness: 916 }] };
  const r = reconcileJob(issue, [], NET);
  assert.equal(r.issuedFineUg, 4_975_000 + 3_053_028);
  assert.equal(r.issuedGrossMg, 8_333);
  assert.equal(r.balanceUg, 8_028_028); // nothing returned yet: karigar holds all of it
});

test('more returned than issued shows as a negative loss (a flag, not an error)', () => {
  const r = reconcileJob({ ...ISSUE_10G, gold: [{ grossMg: 9_000, fineness: 916 }] }, [R], NET);
  assert.ok(r.lossUg < 0);
});

test('allowance rounds UP to the next µg, in the karigar\'s favour', () => {
  assert.equal(allowanceUg(1_001, 250), 26); // 25.025 -> 26
  assert.equal(allowanceUg(1_000, 250), 25);
  assert.equal(allowanceUg(0, 250), 0);
  assert.throws(() => allowanceUg(1_000, 10_001));
});

test('labour: per gram (half away from zero, in paise) and per piece', () => {
  assert.equal(labourPaise({ mode: 'per_gram', ratePaise: 500 }, [{ grossMg: 1, fineness: 916 }]), 1);   // 0.5 paise -> 1
  assert.equal(labourPaise({ mode: 'per_gram', ratePaise: 400 }, [{ grossMg: 1, fineness: 916 }]), 0);   // 0.4 paise -> 0
  assert.equal(labourPaise({ mode: 'per_piece', ratePaise: 50_000 }, [{ grossMg: 1, fineness: 916 }, { grossMg: 2, fineness: 916 }]), 100_000);
  assert.throws(() => labourPaise({ mode: 'per_tola', ratePaise: 1 }, []));
});

test('stones heavier than the piece are rejected', () => {
  assert.throws(() => pieceNetMg({ grossMg: 100, stoneMg: 101, fineness: 916 }), /exceeds/);
});

test('valuing a gold balance in paise at a human-entered rate', () => {
  assert.equal(goldValuePaise(186_685, 750_000), 140_014);   // 0.186685 g × ₹7,500 = ₹1,400.1375
  assert.equal(goldValuePaise(-186_685, 750_000), -140_014);
  assert.equal(goldValuePaise(100_000_000_000, 1_500_000), 150_000_000_000); // 100 kg fine, no overflow
});
