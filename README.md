# Sona Khata: a shared gold ledger for jewellers and karigars (prototype)

*Sona Khata* means "gold account". Submission material: [answers](docs/submission-answers.md) · [pitch deck (.pptx)](docs/Sona-Khata-pitch.pptx) · [pitch deck (.pdf)](docs/Sona-Khata-pitch.pdf)

**Tech4Bharat 2026 (JanAI Mass Entrepreneurship Challenge), Theme 2 Jeweltech, problem 2.2:**
*"Gold given to karigars for job-work is tracked on trust, and disputes follow."*
The official statement tags 2.2 **AGENTIC AI**. The verbatim text is in [`docs/official-problem-2.2.md`](docs/official-problem-2.2.md).

> Official boundary: *"Settlements go to both parties for approval, and each karigar has full access to his own account."*
> What makes it hard: *"Accuracy has to hold at the level of weight, the audit trail has to be one both parties accept, and fairness matters most to the artisan, who has less power."*

This repo is a **foundation, not a finished product**. Its parts:
- a deterministic, tested gold ledger shared by a jeweller and a karigar
- a minimal jeweller PWA
- a **simulated** karigar WhatsApp/voice phone
- a rule-based case agent whose every action passes a human approval gate

**No field research has happened yet, so every number in the app and the tests is a synthetic test value.**

---

## 1. Setup

You need Node ≥ 20 (for tests; there are no npm dependencies) and Python 3 (any static file server works).

```bash
cd sona-khata        # or wherever you cloned it
npm test                      # 48 tests, node:test, no install step
python3 -m http.server 8766   # then open http://localhost:8766/app/
```

In the app, click **Load synthetic demo**, or open an account yourself. Then:
1. Approve the agent's proposals in **Case agent**.
2. Answer on the right-hand phone with ✔/✖, or type into the 🎤 box (`haan`, `nahi, 9.950 mila tha`, `do din aur`).
3. Untick **phone has network** to test offline use. Both sides keep writing, and the two copies merge when the network comes back.
4. Tick **Make the next MOCK UPI call fail** to see a failure and an approved retry.

---

## 2. What is real, what is mocked, what is not built

| Part | Status | Notes |
|---|---|---|
| Fine-gold reconciliation (issue → returns → scrap → wastage allowance → balance) | **Real**, tested at mg/µg level | `src/core/reconcile.js` |
| Integer units: mg, ‰ fineness, µg fine, basis points, paise | **Real** | no floats anywhere in ledger data; canonical JSON rejects them |
| Hash-chained, append-only ledger | **Real** | SHA-256 over canonical JSON; tampering, deletion and reordering are detected |
| Per-party digital signatures | **Real** crypto (ECDSA P-256, WebCrypto) | **but** in the demo both keys sit in one browser; see §5 |
| Two-party approval (an entry counts only after both parties approve it) | **Real** | rejection reasons are kept; corrections are VOID entries both parties approve, never edits |
| Settlement validation (must exactly match the ledger; blocked by pending entries or open disputes) | **Real** | `STALE_SETTLEMENT`, `SETTLEMENT_MISMATCH`, `PENDING_ENTRIES`, `OPEN_DISPUTE` |
| Payment guards (no overpayment, only the latest settlement can be paid) | **Real** | |
| Offline: separate device copies, merged without re-signing; conflicts surfaced | **Real** logic; **simulated** transport (both "devices" are in one tab) | `mergeChains()` |
| Offline app shell (service worker) and IndexedDB storage | **Real** | |
| Karigar's full account view and JSON export | **Real** | from his own copy, which he verifies himself |
| Human approval gate for agent actions | **Real** | `src/core/gate.js`; retries need fresh approval |
| Case agent (deadline nudges, chasing approvals, wastage review, refiner follow-up, settlement draft, payment) | **Real but rule-based** | there is **no LLM yet**; labelled `RULE-BASED` in the UI |
| Wastage flag | **Rule** (above agreed %), not AI | phrased "please review", never as an accusation |
| UPI payment | **MOCK** | `src/mocks/upi.js`; reference `MOCK-UPI-…`; no bank/PSP contact |
| Hallmarking / HUID lookup | **MOCK** | only the 6-character format check is real; not used in any maths |
| WhatsApp channel | **MOCK** | an in-app "phone"; nothing is sent |
| Speech (ASR / TTS) | **MOCK** | typed text plus a keyword matcher; "voice note" is displayed text |
| Hindi message templates | Written for the prototype | **need a native-speaker check and testing with karigars** |
| Reading weights from scale photos | **Not built** | planned AI component; weights are typed |
| Reading handwritten bahi-khata pages | **Not built** | planned AI component; opening balances are typed |
| Wastage anomaly model per design category | **Not built** | needs real return data first |
| Indic ASR/TTS, real WhatsApp/IVR, LLM planner, server/back-end sync | **Not built** | see §7 |

Each mock is labelled in its file (`IS_MOCK = true`, `LABEL = 'MOCK …'`), in the UI (purple **MOCK** tags) and in this table. A test checks that every mock carries the label.

---

## 3. Architecture

```
                 ┌──────────────────────── src/core (pure, shared by phone + tests) ───────────────────────┐
 Jeweller PWA ──►│ units.js     integer units, string parsing, exact rounding helpers                        │
 (app/)          │ crypto.js    canonical JSON, SHA-256, ECDSA P-256 (WebCrypto)                             │
                 │ reconcile.js fine-gold maths per job (deterministic, no AI)                               │
 Karigar phone ─►│ ledger.js    signed items → hash-chained records; validation; deriveState(); merge        │
 (simulated)     │ agent.js     rule-based planner → proposals (never acts by itself)                        │
                 │ gate.js      human approval gate → runs an action only after approval; keeps failures     │
                 └───────────────────────────────────────────────────────────────────────────────────────────┘
                 src/mocks: upi.js · huid.js · speech.js · whatsapp.js   (all labelled MOCK)
                 app/: index.html · app.js · store.js (IndexedDB) · sw.js (offline shell) · manifest
```

**Ledger model** (`src/core/ledger.js`):
- A *statement* is `{v, account, author, type, ts, nonce, payload}`. Its id is `sha256(canonical(statement))`, and the author signs the id.
- A *record* is `{seq, prevHash, item, hash}`, where `hash = sha256({seq, prevHash, id, sig})`. Changing any record breaks every later hash.
- Signatures cover the content, not the position. So any device can sequence items, and items written offline can be appended later without re-signing.
- `deriveState(chain)` replays everything (statuses, jobs, reconciliation, balances, flags, disputes, settlements). The jeweller's device and the karigar's phone run the same code on the same chain and get identical results.
- Entry types: `OPEN_ACCOUNT` (with consent text), `OPENING_BALANCE`, `ISSUE` (jeweller only), `RETURN`, `REFINER_RESULT`, `SETTLEMENT`, `PAYMENT` (jeweller only; the karigar's approval means "received"), `VOID`, `DISPUTE`, `DISPUTE_RESOLUTION`, `NOTE`, `APPROVE`, `REJECT`. Every gold or money type needs **both** parties.

**Reconciliation rules** (`src/core/reconcile.js`):
- `fineUg = grossMg × fineness‰`. This is exact: 1 mg of 916 is 916 µg fine.
- Returned piece fine = `(gross − stones) × fineness`.
- Scrap fine is the declared weight × purity. When marked *provisional*, it is replaced by the refiner's recovered fine weight once both parties approve that.
- `loss = issued fine − returned fine`, and `allowance = ceil(basis × wastage bp / 10 000)`.
  - The basis is **finished net fine** or **issued fine**, set per account.
  - Rounding up to the next µg favours the karigar.
  - On the issued basis, the allowance is credited only once the job is closed.
- Two allowance modes, both a **field question**: *fixed* (unused allowance stays in the karigar's credit) or *capped* (credited only up to the actual loss).
- Job balance = `loss − allowance`. A positive balance means the karigar holds the jeweller's gold; a negative one means the jeweller owes gold.
- Labour is per gram of net finished metal (half away from zero, in paise) or per piece.
- Converting a gold balance to cash uses a gold rate a **human enters**. Products are computed in BigInt, so there is no overflow.

**Approval gates** (task requirement: one for every gold or money step):
1. Every gold or money **ledger entry** is signed by its author after a confirmation dialog that shows the exact fine-gold maths. It counts only after the **other party** also approves.
2. Every **agent action** (message, review, refiner entry, settlement draft, mock UPI payment) is only a *proposal* until the jeweller approves it in the gate. A failed action stays visible, and a retry needs a fresh approval.
3. The karigar approves or rejects on his phone (button or mock voice "haan"/"nahi"), and a rejection carries his reason.

---

## 4. Tests

`npm test` runs 48 tests in 4 files, all passing as of 17 Nov 2026:

- `test/units.test.js`: exact parsing (`"0.1" + "0.2"` g = 300 mg), rounding, Indian digit grouping, canonical JSON rejecting floats.
- `test/reconcile.test.js`: hand-worked mg/µg cases. These include:
  - 10.000 g @ 995 → 9 950 000 µg
  - a 57.2 mg loss against a 243 885 µg allowance
  - one extra milligram shifting the loss by exactly 916 µg
  - partial returns not accumulating rounding
  - refiner adjustment, mixed purities, and a 100 kg overflow check
- `test/ledger.test.js`: two-party approval; self-approval and double approval refused; tampering, forged keys, deletion and reordering detected; full issue → return → settle → pay cycle with exact balances; stale or altered settlements refused; no double payment; voids; offline merge, conflicts, and refusal of a tampered incoming copy.
- `test/gate-agent.test.js`: nothing runs before approval; rejection and retry; de-duplication; agent proposals require a human; the evidence pack; mock labels; the keyword matcher.

The PWA was also checked by hand in a browser with these flows: demo seed, settlement, karigar voice approval, mock UPI failure → approved retry → karigar confirms receipt, offline issue and note → reconnect → identical heads, wastage review → settlement blocked → resolution → settlement proposed again.

---

## 5. Known limitations (be upfront about these in the pitch)

- **Both signing keys live in one browser** for the demo. In real use the karigar's key must be on his own phone. For karigars without smartphones (IVR or feature phone), **who holds the key is an open design question**. Options include a custodial key at a JanAI Café with voice confirmation recorded, or an OTP-backed key held by a server. Each changes the trust model, and none is built.
- **No key rotation or recovery.** A lost phone means a lost key.
- **No server.** Sync is simulated between two in-memory copies. The planned back-end (FastAPI + Postgres) would be one more copy that verifies everything, not a trusted authority.
- **`ts` is the author's device clock** and is informational only. Ordering is by sequence, and deadlines use the date chosen in the UI.
- IndexedDB is not encrypted at rest.
- The UI records one piece row and one scrap lot per return (record several returns for more). The core supports any number.
- The consent text is a one-line placeholder and has not been reviewed against the DPDP Act.
- Hindi strings are unreviewed. Bengali and other languages are not done.

---

## 6. Field-research gaps: what we do **not** know yet

Nothing below has been observed, and **no field data has been invented**. Every weight, rate and wastage % in the code is a synthetic test value. The data model is **provisional** until these questions are answered with real jewellers and karigars:

1. **How an issue is recorded today:** gross or fine weight, which purities (24K bar, 22K, mixed old gold), who writes it down, and whether the karigar signs. *(The official question is "who holds the record?")*
2. **Wastage:** whether it is a % per design, per gram or per piece; whether it applies to the **finished weight or the issued gold** (`wastageBasis`); whether **unused allowance belongs to the karigar** (`allowanceMode`); and how often it is disputed.
3. **Returns:** pieces, filings and dust (*lalli/bhuka*), unused gold; how stones and enamel are deducted (weighed separately? estimated?).
4. **Refiners:** who sends the scrap, how long the result takes, and who bears the refining loss.
5. **Month-end "squaring up":** what actually happens, who brings which notebook, and how differences are settled today.
6. **Payment:** per gram or per piece, the typical rates (needed for realistic test data), and **how many weeks a karigar waits**.
7. **Scale:** how many karigars and open orders a typical shop has (the official question); how many jewellers each karigar works for.
8. **Phones and languages:** smartphone or feature phone, WhatsApp use, and the karigars' languages compared with the jeweller's.
9. **Willingness to pay:** whether the jeweller would pay, how much per month, and what they would stop doing. (Plan §6 guesses ₹300–1,000. **This is unvalidated.**)
10. **Trust:** would a karigar accept a ledger the jeweller's app runs? What would make him trust it (his own copy, a third party, the association)?
11. **Late pieces for weddings:** what happens today (the official question).
12. **Hallmarking/HUID** after the return, and whether it affects reconciliation.

**Artefacts to collect, with consent and with numbers blurred if asked:** bahi-khata pages, issue slips, the scale model in use, and 300+ photos of scale displays under shop lighting (training and test data for the scale reader).

---

## 7. Next steps

**These need real jewellers and karigars:**
1. Interview 5+ jewellers and 5+ karigars using §6 and `../plan-2.2-karigar.md` §2. Record the workflow map and a field-level data dictionary.
2. Then **freeze the data model**: set the default `wastageBasis`/`allowanceMode`, add any real fields (e.g. *touch*, *ghat*, per-piece wastage), and rewrite the test fixtures as anonymised **real-structure** ledgers (real shapes, synthetic numbers unless consent is given).
3. Collect the scale-display photos and bahi pages to build and *measure* the scale reader and the bahi-page reader.
4. Do a native-speaker review of every karigar-facing string, and test the flow with 2–3 karigars on their own phones. Measure how often a task is completed by voice alone.
5. Answer the karigar-key custody question (§5) together with karigars and, if possible, a JanAI Café operator.
6. Run a 1–2 week pilot with 1–2 real jeweller–karigar pairs, side by side with their notebooks. Count the disagreements found, the time per entry, and whether the jeweller would pay.

**Engineering, which can start now:**
- Real two-device sync (a small server that only stores and verifies), key rotation, and encrypted local storage.
- An LLM tool-calling layer on top of `planActions` that can only emit the existing action kinds, with every action still passing through the gate.
- A WhatsApp Business sandbox or IVR, plus Bhashini/AI4Bharat ASR/TTS, evaluated on real recordings.
