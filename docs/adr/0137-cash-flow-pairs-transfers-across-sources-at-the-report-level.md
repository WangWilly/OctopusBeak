# Cash flow pairs transfers across sources at the report level

Status: accepted

The Cash flow page shows a move between two of a person's accounts, such as Cathay to Fubon or a Fubon payment of an E.SUN card bill, as one internal transfer. The two sides usually come from different source connections. A Transaction Relation cannot join them: it stays inside one source connection, it comes only from source evidence, and a person cannot create one. The first version also does no cross-source reconciliation.

**A Cash-flow transfer link joins the two sides only at the report level.** It follows the Spending deduplication link. It is revocable and traceable, and it never merges identities or rewrites a source fact. Reliable evidence establishes it automatically: both sides carry internal-transfer Kinds, with equal amount and currency, on close dates. Otherwise a link is a candidate until the person confirms it. A candidate needs equal amount and currency, opposite directions, and two owned non-preview accounts, at most 3 days apart. The person may also pair two such transactions that are further apart themselves.

**A confirmed link decides inclusion only where no evidence does.** A transfer with an opaque bank note gets the fallback Kinds: `purchase` on the outflow and `receipt` on the inflow. Both sides would then count, and inflow and outflow would each grow by the transfer amount. A confirmed link keeps both sides out of inflow and outflow when neither side has an evidence-backed Kind. An evidence-backed Kind always decides its side. An unpaired `transfer.internal` side stays out, and a link never excludes an evidenced purchase.

**Close dates are at most 3 calendar days apart, the same window as a candidate.** A transfer made on a Friday settles by Monday. Evidence links a pair only when it is each side's only candidate and the person has never decided on it; when one side has several candidates, all of them are shown and none is linked. A bank-side `payment.credit_card` has no evidence-backed card-side Kind to meet yet, because a card inflow gets its Kind from direction alone, so a card bill payment is only ever a candidate.

Decisions are stored like Spending deduplication decisions: an append-only history of confirm, deny, and revoke, and a table of current links. A link from evidence is derived when Cash flow is read and is never stored; revoking one records the revocation, and the pair is then only a candidate. A denied pair is never proposed again and cannot be paired by hand. Manual Account transactions are never a side: a Manual Account transfer already records both sides with the Kinds the person entered.

## Considered options

- **Pair automatically on amount and time, as the draft shows.** Rejected. Similarity alone would then establish a financial association, which the Spending deduplication link already refuses.
- **Make the pairing a Transaction Relation.** Rejected. It would break the one-source-connection rule and the rule that a person cannot assert financial relations.
- **Do not pair; let Kinds exclude transfers.** Rejected. Opaque transfers would inflate both inflow and outflow, and the page could not show both sides of a transfer.
- **Let a link never affect inclusion.** Rejected for the same inflation. Financial report inclusion already lists relations as an input, and a confirmed Spending deduplication link already changes a total.
- **Let any confirmed link exclude both sides.** Rejected. A person's confirmation would override evidence-backed Kinds.

## Consequences

- A wrong confirmation can remove a real purchase and a real receipt from the totals. The person can revoke it, and the transfer panel lists every confirmed link.
