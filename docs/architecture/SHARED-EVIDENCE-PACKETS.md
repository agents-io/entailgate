# Shared evidence packets

Status: architecture contract for WordFire drafting, advocacy uplift, and final
verification. External-legal scope routing, content-addressed extraction reuse,
authority locks, and packet-key identity are implemented as an internal alpha.
Authority cards, contextual packet assembly, and the calibrated semantic checker are
still pending.

## Decision

Do not pay for two full legal reads.

Raw documents are ingested, chunked, hashed, and indexed once. The system compiles
small, claim-scoped evidence packets. The drafting agent and uplift agent use those
packets before release. The independent verifier then checks the final integrated
draft against the cited packet contents. It expands to more source context only when a
claim cannot be resolved safely from the packet.

The normal path is:

```text
raw sources
    ↓ ingest / OCR / hash / index once
authority cards + claim evidence packets
    ↓                         ↓
draft agent              uplift agent
    └──────── final integrated draft ────────┐
                                              ↓
                                final semantic verifier
                                              ↓
                                  release or minimal repair
                                              ↓
                                  changed claims only reverify
```

The default WordFire profile routes only external legal authorities into this path.
Private case evidence and first-party facts are not reread by the legal verifier unless
the caller explicitly opts in to a separate local review. See
[`EXTERNAL-LEGAL-AUTHORITY-PIPELINE.md`](EXTERNAL-LEGAL-AUTHORITY-PIPELINE.md).

There is no full semantic verification of an intermediate draft merely to hand the
same corpus to uplift next. Cheap deterministic checks—source existence, identifiers,
hashes, exact quotations, dates, numbers, jurisdiction, and retrieval closure—may run
before uplift because they do not require a second model read.

## Authority card

One reusable card is keyed by source SHA-256, source identity, jurisdiction, and
effective date. It contains only verified source metadata and reusable extracts:

- canonical citation, title, identifier, date, issuer, authority tier, and URI;
- source SHA-256 and retrieval/effective dates;
- relevant chunks with paragraph/page locators and chunk hashes;
- exact quotations preserved byte-for-byte or under the declared normalization;
- procedural posture and actual disposition;
- favourable propositions reasonably available from the source;
- hard boundaries whose omission would make a proposition materially false;
- pointers for expanding to the surrounding or complete source.

An authority card is a retrieval artifact, not a semantic PASS. It may preserve prior
human or model annotations, but the final verifier receives the underlying cited text
and independently judges the final proposition.

## Claim evidence packet

A packet is assembled for one draft claim or tightly connected claim group. It binds:

- claim text and draft locator;
- material fields such as actors, dates, numbers, legal sections, quotations, modality,
  remedy, jurisdiction, and as-of date;
- the top relevant authority-card chunks and structured facts;
- citation IDs and source/chunk hashes;
- previous trusted attestations, if still valid;
- a token and context-expansion budget.

The packet must include enough surrounding text to preserve conditions, exceptions,
negation, attribution, procedural posture, and remedy scope. A one-sentence snippet is
not sufficient when those features live outside the sentence.

## Consumer views

### Draft view

Prioritizes favourable propositions, exact quotations, strongest available remedy
language, and the facts that establish each element. It does not need unrelated pages
or sources.

### Uplift view

Receives the current material paragraph, its claim packet, relevant authority cards,
and a compact index for discovering one missing authority. It searches for helmets and
underclaims. It does not independently reload every PDF.

If uplift discovers a genuinely new proposition or authority, only that claim triggers
packet expansion or one new source retrieval.

### Final verifier view

Receives the final atomic claim, cited chunks, source metadata, and the context needed
to test legal force and attribution. It does not trust the uplift verdict. It checks
the final wording independently and expands to the complete source when the packet is
insufficient or the claim is high-risk and context-sensitive.

Sharing source bytes and provenance does not compromise independence. Sharing the
uplift agent's semantic conclusion as truth would.

## Token policy

1. Never place the full evidence folder or full case library in a model prompt.
2. Retrieve top-k claim-scoped chunks from the local index.
3. Reuse authority cards across drafts and products by content hash.
4. Send full surrounding sections only when conditions, exceptions, posture, or
   attribution cannot be resolved from the packet.
5. Run source-based uplift only on material paragraphs. A deterministic phrase scan
   handles obvious helmets everywhere else.
6. Verify the final integrated draft once.
7. After a repair or adopted late suggestion, reverify only the changed material claim
   and any claim whose bound context changed.
8. Normalize omitted and explicit ingestion defaults so the same source cannot be
   needlessly extracted twice under equivalent settings.

## Failure boundaries

- Packet absence or insufficient context produces `EXPAND_CONTEXT`, never support.
- A portal outage does not invalidate a cached card whose official source bytes and
  hash are already retained; freshness policy still applies.
- Uplift may not turn a statutory `may` into `must`, an allegation into a finding, or a
  referral into entitlement merely to make prose stronger.
- The final verifier may reject an uplift, but it must not replace a fair favourable
  reading with the least favourable interpretation.
- No consumer may mutate the raw source, authority card, or packet it receives.

## Cost model

For a draft citing 20 authorities, the expensive work is not repeated 20 times per
agent. Ingestion and authority-card construction are one-time and cacheable. Drafting
and uplift read only the cards attached to each material paragraph. Final verification
reads the final claims and their cited chunks. A later `me`/`I` edit reads no legal
source; a changed quotation, legal force, actor, number, section, or remedy reopens only
that claim's packet.
