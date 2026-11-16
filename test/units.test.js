import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fineUg, parseGramsToMg, parseRupeesToPaise, parsePercentToBp, divRound, divCeil, formatMg, formatFineUg, formatFineUgExact, formatPaise, formatBp } from '../src/core/units.js';
import { canonical } from '../src/core/crypto.js';

test('fine gold is exact in µg: mg × ‰', () => {
  assert.equal(fineUg(10_000, 995), 9_950_000);   // 10 g of 995 -> 9.950 g fine
  assert.equal(fineUg(1, 916), 916);              // 1 mg of 22K -> 0.916 mg fine, no rounding
  assert.equal(fineUg(11_664, 999), 11_652_336);  // one tola (11.664 g) of 999
  assert.throws(() => fineUg(1.5, 916), /integer/);
  assert.throws(() => fineUg(100, 1001), /outside/);
  assert.throws(() => fineUg(-1, 916), /outside/);
});

test('weights parse by string arithmetic, never via float', () => {
  assert.equal(parseGramsToMg('12.345'), 12_345);
  assert.equal(parseGramsToMg('0.5'), 500);
  assert.equal(parseGramsToMg('0.001'), 1);
  assert.equal(parseGramsToMg('7'), 7_000);
  assert.equal(parseGramsToMg('12.345 g'), 12_345);
  assert.equal(parseGramsToMg('12,345'), 12_345); // comma read as decimal separator
  assert.equal(parseGramsToMg('0.1') + parseGramsToMg('0.2'), 300); // the classic float bug cannot happen
  assert.throws(() => parseGramsToMg('12.3456'), /max 3 decimals/);
  assert.throws(() => parseGramsToMg('-1'));
  assert.throws(() => parseGramsToMg('1e3'));
  assert.throws(() => parseGramsToMg(''));
});

test('money and percent parse exactly', () => {
  assert.equal(parseRupeesToPaise('1,250.50'), 125_050);
  assert.equal(parseRupeesToPaise('₹ 99'), 9_900);
  assert.equal(parsePercentToBp('2.5'), 250);
  assert.equal(parsePercentToBp('2.50 %'), 250);
  assert.equal(parsePercentToBp('0.05'), 5);
  assert.throws(() => parsePercentToBp('101'));
  assert.throws(() => parsePercentToBp('2.555'));
});

test('rounding helpers are exact and BigInt-safe', () => {
  assert.equal(divRound(5, 10), 1);     // half away from zero
  assert.equal(divRound(-5, 10), -1);
  assert.equal(divRound(4, 10), 0);
  assert.equal(divCeil(1, 10), 1);
  assert.equal(divCeil(10, 10), 1);
  assert.equal(divCeil(0, 10), 0);
  assert.equal(divRound(9_000_000_000_000_000_500_000n, 1_000_000), 9_000_000_000_000_001); // numerator far above 2^53, handled exactly
  assert.throws(() => divRound(10n ** 17n, 1), /safe integer/); // a result above 2^53 is refused, not silently rounded
});

test('formatting', () => {
  assert.equal(formatMg(12_345), '12.345 g');
  assert.equal(formatMg(-57), '-0.057 g');
  assert.equal(formatFineUg(9_755_400), '9.755 g');
  assert.equal(formatFineUg(57_500), '0.058 g'); // display rounds half away from zero; storage stays exact
  assert.equal(formatFineUgExact(9_755_400), '9.755 400 g');
  assert.equal(formatPaise(372_750), '₹3,727.50');
  assert.equal(formatPaise(12_345_678_90), '₹1,23,45,678.90'); // Indian digit grouping
  assert.equal(formatBp(250), '2.50%');
});

test('canonical JSON is key-order independent and rejects floats', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: true, c: null }] }), '{"a":[2,{"c":null,"d":true}],"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.throws(() => canonical({ w: 0.1 }), /non-integer/);
});
