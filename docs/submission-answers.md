# Tech4Bharat 2026: submission answers

## Theme
**Jeweltech** (Theme 2). Problem statement **2.2**: *"Gold given to karigars for job-work is tracked on trust, and disputes follow"*, tagged **Agentic AI**.

## Project title
**Sona Khata: a shared, voice-first gold ledger for jewellers and karigars**

*(Sona Khata means "gold account". If the form allows only a short title, use **Sona Khata**.)*

## Brief about the idea

Jewellers hand gold to karigars (artisan goldsmiths) by weight and get finished jewellery back weeks later, minus agreed wastage. Today this is tracked in two separate notebooks that never match. That leads to unexplained gold losses, disputes, missed wedding dates and artisans who wait weeks to be paid.

**Sona Khata gives both sides one shared ledger that neither can quietly change.** Every issue, return and payment is weighed to the milligram, reconciled automatically on pure (fine) gold, and counts only after **both** the jeweller and the karigar approve it. The karigar does this on WhatsApp by voice, in his own language. An AI case agent chases deadlines, flags unusual wastage for a joint review, and drafts settlements and payments, but **it never moves gold or money without a human's approval**.

## Detailed explanation of the idea

### The problem, in plain words
In every jewellery market in India, the shop owner (the **jeweller**) does not make most of the jewellery. He gives raw gold, often a pure 24-carat bar, to a **karigar**, a skilled goldsmith who works from a small workshop or from home. The karigar turns it into bangles, chains or rings and brings them back days or weeks later. A little gold is always lost in the making (filings, dust, melting), so the two agree on an allowance called **wastage**, for example 2.5%.

This sounds simple, but the numbers are hard:
- The gold goes out as 24K and comes back as 22K jewellery with stones set in it. To check that nothing is missing, you have to convert everything to **pure (fine) gold** and subtract the stones.
- A karigar works for **several jewellers at once**, and a jeweller works with many karigars, on many custom orders.
- Each side writes this in **its own notebook (bahi-khata) or on a slip**. Wastage is agreed **verbally**. Deadlines are chased by **phone**. Accounts are squared up at **month end**.

So the notebooks drift apart, and nobody can prove which one is right. The official problem statement names what this costs: *"unexplained gold losses, disputes that sour long relationships, missed wedding dates and artisans waiting weeks to be paid."*

### Who it affects
- **The karigar** has the least power in the relationship. When the numbers disagree, his word is usually weaker. He has no record of his own work that anyone else trusts, and he often waits weeks to be paid. Many karigars are migrants who speak a different language from the jeweller and are not comfortable with text-heavy apps.
- **The jeweller** has a lot of gold out with many karigars and no single picture of who holds how much. Disputes cost him time, money and good artisans.
- **The customer**, often a family with a fixed wedding date, suffers when a piece is late and nobody saw it coming.

### How Sona Khata helps
1. **One shared ledger, not two notebooks.** When the jeweller issues gold, he enters the weight and purity, or will photograph the scale display once the scale reader is built (on the roadmap). The karigar immediately gets a WhatsApp voice note in his language: *"10.000 g of 995 gold received for 2 bangles, wastage 2.5%, due 25 Nov. Is that right?"* He says **"haan"** (yes) or **"nahi"** (no) and why. Nothing counts until he agrees.
2. **Exact gold maths, done for both sides.** When the jewellery comes back, the app subtracts the stones, converts everything to pure gold, counts the scrap and filings, applies the agreed wastage, and shows the balance to the milligram. For example: *"Karigar is 8 mg over the allowance"* or *"Jeweller owes karigar 186 mg of unused allowance."* The calculation is deterministic and tested, not guessed by AI.
3. **A record neither side can quietly change.** Every entry is digitally signed by the person who made it and chained to the entry before it. If anyone edits or deletes an old entry, the chain breaks and both phones can see it. Mistakes are fixed openly, with a correction both sides approve.
4. **The karigar sees his full account.** He keeps his own copy of the ledger on his phone and can check it himself. This is the official boundary of problem 2.2: *"each karigar has full access to his own account."*
5. **An AI case agent that does the chasing, with permission.** It reminds the karigar before a deadline (especially when a customer's wedding date is close). It nudges whoever hasn't confirmed an entry. When wastage looks unusual, it assembles the signed facts into an evidence pack and proposes a joint review, worded as "please review", never as an accusation. It drafts the settlement and prepares the payment. **Every action that touches gold or money waits for a human to approve it**, and **settlements need both parties**, as the official statement requires.
6. **Works with patchy internet.** Both sides keep working offline, and the two copies merge safely when the network returns.
7. **Fair, faster pay.** Once both sides approve a settlement, payment can go out through UPI immediately (shown as a clearly labelled mock in the prototype). The karigar confirms that he received it.

### Why it matters beyond one shop
Over time, every karigar builds a **verified record of work delivered and paid**: what he made, how much wastage, on time or late. In the official statement's words, *"a karigar with a clean record of work delivered looks very different to anyone deciding whether to trust him."* That record can help him get credit, better rates or new jewellers to work with.

### Who pays
The **jeweller** pays a small monthly subscription because he gains control over gold that is out with karigars, and fewer disputes. **The karigar side is free.** We will validate the price with jewellers during field research.

### What exists today (honestly)
- **Working and tested (48 automated tests):**
  - milligram-exact reconciliation
  - signed, tamper-evident shared ledger with two-party approval and offline sync
  - jeweller web app
  - simulated karigar WhatsApp phone
  - rule-based case agent with human approval gates
- **Clearly labelled mocks:** UPI payment, HUID/hallmark lookup, WhatsApp, speech.
- **Next, with real jewellers and karigars:**
  - field interviews
  - AI that reads scale displays and old notebook pages
  - real Indic voice
  - a pilot with 1–2 jeweller–karigar pairs
