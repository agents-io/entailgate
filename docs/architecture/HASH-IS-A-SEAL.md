# Hash is a seal, not a legal checker

The runtime uses two different identities for two different jobs.

## Artifact identity

When a trusted adapter or ingestion step computes the complete document SHA-256 from the file bytes, it identifies the exact artifact processed. The generic JSON verifier only binds the hash declared in its request and does not reopen `subject.path`; callers must not upgrade that declared value into byte-level assurance. In either path, hashing is a cheap local calculation used for provenance, replay, and detecting that a new artifact exists. It does not decide whether a quotation, citation, or legal proposition is correct.

## Claim identity

The revision planner extracts candidate assertions and gives each one a location-independent fingerprint. It then compares the old and new claim inventories:

- `REUSE`: the exact protected claim fingerprint is unchanged;
- `REVERIFY`: a likely corresponding material claim changed;
- `ADDED` or `REMOVED`: the inventory changed;
- `UNCERTAIN`: correspondence cannot be resolved safely.

Only a deterministic `REUSE` can preserve a claim-scoped attestation. Exact wording is the default. Narrow normalized reuse requires a second explicit policy flag and an identical versioned protected fingerprint. The fingerprint includes semantic role, heading context, and rolling prior context for pronoun-dependent claims; a heading/body conversion or changed antecedent is not harmless. Fuzzy similarity is useful for finding the likely edited sentence, but it can never establish equivalence or inherit a prior pass.

The plan also separates review cost. `SOURCE_SUPPORT` means the affected legal/factual claim and its sources must be checked. `MATERIALITY` means only the changed prose must first be classified as material or immaterial. An unrelated rewrite therefore does not force every citation and authority through the expensive verifier, while an extractor miss still cannot disappear silently.

For example, changing an unrelated introduction does not invalidate an unchanged legal claim. The deterministic baseline also normalizes a narrow set of harmless English variants such as first-person case (`me`/`I`) and discourse connectors. It does not assume that article or possessive changes are harmless. A change to an actor, quotation, citation, section, date, number, deadline, modality, proposition, or remedy routes the affected claim to re-verification.

## Source verification

Once a claim needs checking, citation correctness is decided from the evidence binding, not from either fingerprint:

1. cited source and chunk are inside the retrieved evidence snapshot;
2. a quote-only atomic claim occurs in the cited chunk under the declared normalization; surrounding propositions cannot borrow the quote's exact assurance;
3. structured values and calculations reproduce from cited fields;
4. jurisdiction, authority tier, and effective date satisfy policy;
5. a pinned semantic checker or human attestation evaluates whether the cited material supports the proposition.

The whole-document hash remains in every trace. A trusted adapter that computed it from the draft can therefore prove which exact artifact it processed; the generic verifier proves only which declared hash it bound. Claim-scoped reuse is experimental and opt-in; normalized wording reuse is a separate opt-in; subject-scoped binding remains the default legal gate.
