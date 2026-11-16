// Fine-gold reconciliation: pure, deterministic functions with no I/O and no AI.
// Inputs are plain payload objects (see ledger.js for the schemas). Outputs are integers.
//
// Sign conventions (also used for account balances):
//   gold balance  > 0  -> the karigar holds that much of the jeweller's fine gold
//   gold balance  < 0  -> the jeweller owes the karigar fine gold (e.g. unused allowance)
//   cash balance  > 0  -> the jeweller owes the karigar money (labour)

import { fineUg, assertMg, assertFineness, assertBp, assertInt, divCeil, divRound, LedgerError } from './units.js';

/** Fine µg of an array of {grossMg, fineness}. */
export function sumFine(items) {
  return items.reduce((s, it) => s + fineUg(it.grossMg, it.fineness), 0);
}

/** Net metal in a returned piece: gross minus stones/enamel/other non-gold weight. */
export function pieceNetMg(piece) {
  assertMg('piece.grossMg', piece.grossMg);
  assertMg('piece.stoneMg', piece.stoneMg ?? 0);
  const net = piece.grossMg - (piece.stoneMg ?? 0);
  if (net < 0) throw new LedgerError('STONE_EXCEEDS_GROSS', `stone weight ${piece.stoneMg} mg exceeds gross ${piece.grossMg} mg`);
  return net;
}

export const pieceFineUg = (piece) => fineUg(pieceNetMg(piece), piece.fineness);

/**
 * Fine µg of one scrap lot. When the lot is provisional (its fineness is only an estimate until
 * the refiner reports), a refiner result for that lot replaces the estimate.
 */
export function scrapFineUg(scrap, refinerFineUg) {
  if (refinerFineUg !== undefined) return assertInt('recoveredFineUg', refinerFineUg, { min: 0 });
  return fineUg(scrap.grossMg, scrap.fineness);
}

/** Wastage allowance in µg. Rounded UP to the next µg, in the karigar's favour (the official
 *  statement says "fairness matters most to the artisan"). At µg scale this is immaterial, but it
 *  is deterministic and documented. */
export function allowanceUg(basisFineUg, wastageBp) {
  assertBp('wastageBp', wastageBp);
  assertInt('basisFineUg', basisFineUg, { min: 0 });
  return divCeil(BigInt(basisFineUg) * BigInt(wastageBp), 10_000);
}

/** Labour in paise for the finished pieces of one return. */
export function labourPaise(labour, pieces) {
  if (!labour) return 0;
  assertInt('labour.ratePaise', labour.ratePaise, { min: 0 });
  if (labour.mode === 'per_piece') return pieces.length * labour.ratePaise;
  if (labour.mode === 'per_gram') {
    const netMg = pieces.reduce((s, p) => s + pieceNetMg(p), 0);
    return divRound(BigInt(netMg) * BigInt(labour.ratePaise), 1000); // rate is per gram of net finished metal
  }
  throw new LedgerError('BAD_LABOUR_MODE', `unknown labour mode ${labour.mode}`);
}

/**
 * Reconcile one job (one ISSUE plus its RETURNs).
 *
 * @param issue    ISSUE payload: { gold:[{grossMg,fineness}], wastageBp, labour, dueDate, ... }
 * @param returns  RETURN payloads, in order: { pieces:[...], scrap:[...], final }
 * @param terms    account terms: { wastageBasis: 'finished_net' | 'issued', allowanceMode: 'fixed' | 'capped' }
 * @param refiner  Map key `${returnIndex}:${scrapIndex}` -> recovered fine µg (optional)
 */
export function reconcileJob(issue, returns, terms, refiner = new Map()) {
  issue.gold.forEach((g, i) => { assertMg(`gold[${i}].grossMg`, g.grossMg); assertFineness(`gold[${i}].fineness`, g.fineness); });
  const issuedFineUg = sumFine(issue.gold);
  const issuedGrossMg = issue.gold.reduce((s, g) => s + g.grossMg, 0);

  let piecesFineUg = 0, scrapFine = 0, piecesNetMg = 0, piecesCount = 0, labour = 0, provisionalLots = 0;
  const isFinal = returns.some((r) => r.final);

  returns.forEach((r, ri) => {
    for (const p of r.pieces) { piecesFineUg += pieceFineUg(p); piecesNetMg += pieceNetMg(p); piecesCount++; }
    r.scrap.forEach((s, si) => {
      const key = `${ri}:${si}`;
      scrapFine += scrapFineUg(s, refiner.get(key));
      if (s.provisional && !refiner.has(key)) provisionalLots++;
    });
    labour += labourPaise(issue.labour, r.pieces);
  });

  const returnedFineUg = piecesFineUg + scrapFine;
  const lossUg = issuedFineUg - returnedFineUg; // actual gold not returned (fine)

  // Allowance basis is a field-research question (plan §2 Q11), so both bases are supported.
  let rawAllowance;
  if (terms.wastageBasis === 'finished_net') rawAllowance = allowanceUg(piecesFineUg, issue.wastageBp);
  else if (terms.wastageBasis === 'issued') rawAllowance = isFinal ? allowanceUg(issuedFineUg, issue.wastageBp) : 0;
  else throw new LedgerError('BAD_TERMS', `unknown wastageBasis ${terms.wastageBasis}`);

  const allowance = terms.allowanceMode === 'capped' ? Math.min(rawAllowance, Math.max(0, lossUg)) : rawAllowance;
  const balanceUg = lossUg - allowance; // contribution to the karigar's gold balance
  const lossBp = issuedFineUg === 0 ? 0 : divRound(BigInt(lossUg) * 10_000n, issuedFineUg);

  return {
    issuedGrossMg, issuedFineUg, piecesFineUg, scrapFineUg: scrapFine, returnedFineUg,
    piecesNetMg, piecesCount, lossUg, lossBp, allowanceUg: allowance, rawAllowanceUg: rawAllowance,
    // excess wastage only means something once the job is closed
    excessUg: isFinal ? Math.max(0, lossUg - rawAllowance) : 0,
    balanceUg, labourPaise: labour, isFinal, provisionalLots,
  };
}

/** Value a fine-gold balance in paise at a human-entered rate (paise per gram of fine gold). */
export function goldValuePaise(goldUg, ratePaisePerG) {
  assertInt('goldUg', goldUg);
  assertInt('ratePaisePerG', ratePaisePerG, { min: 1 });
  return divRound(BigInt(goldUg) * BigInt(ratePaisePerG), 1_000_000); // BigInt product, so no overflow
}
