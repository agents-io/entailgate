# Entailgate Evidence-Bound Runtime Specification v0.2 — Draft

Status: experimental; not the current legal filing gate
Date: 2026-08-22
Normative terms: MUST, MUST NOT, SHOULD, MAY

## 1. Change from v0.1

v0.1 binds semantic attestations to the complete subject SHA-256. This is safe but causes every byte-level edit to invalidate every attestation.

v0.2 separates:

- **artifact identity**, represented by the complete subject SHA-256; and
- **verification invalidation**, represented by exact atomic-claim, proof-binding, evidence-content, policy, and checker identities.

The subject hash MUST remain in every request and trace. It identifies what was processed; it MUST NOT by itself decide that every claim needs semantic re-review.

## 2. Claim-scoped reuse

A semantic attestation MAY declare `bindingScope=claim`. Policy MUST explicitly allow claim-scoped attestations, and the atomic claim MUST declare `selfContained=true`. Subject scope remains the default.

A claim-scoped attestation from an earlier subject version is reusable by default only when:

1. the checker name and version remain trusted;
2. the exact self-contained atomic claim text hash is unchanged;
3. the evidence snapshot ID and cited evidence-content hash are unchanged;
4. jurisdiction, relevant date, required authority, proof class, and citations are unchanged in the current claim;
5. the current subject has a complete claim inventory tied to its own SHA-256;
6. the current claim maps deterministically to the prior attestation by exact claim hash, or by the separately enabled normalized fingerprint; fuzzy matching is never sufficient. The extraction/diff plan is persisted and replayable (section 5), the mapping from a plan item to the prior attestation it would reuse is persisted and replayable (section 5.1), and the decision whether that attestation may actually be reused is the separate policy gate in section 6.

Claim scope MUST NOT be used for context-dependent fragments such as “This was unlawful.” The claim must name enough actor, act, rule, time, and qualification to be independently evaluated. Headings, prior-sentence antecedents, and document position are not silently borrowed. Automatic extraction fingerprints semantic role, heading paths, and rolling prior context within a section for pronoun-dependent candidates; manual manifests remain responsible for making the text genuinely self-contained before setting the flag.

Changing unrelated prose MAY therefore preserve an exact claim-scoped attestation.

A policy MAY additionally set `allowNormalizedClaimReuse=true`, but only together with `allowClaimScopedAttestations=true`. In that experimental mode, exact wording MAY differ only when the versioned deterministic fingerprint is identical and the proof, citations, evidence, jurisdiction, date, risk, materiality, and required-authority binding remain identical. The v0.2 baseline normalization is deliberately narrow: NFC/line-ending normalization, spacing outside quotations, harmless list markers, `me`/`I`, `we`/`us`, and a small allowlist of non-temporal discourse connectors. It preserves quotation whitespace, punctuation, URLs, checkbox state, strikethrough, signs, comparison operators, parentheses, articles, possessives, actors, negation, modality, numbers, dates, sections, citations, propositions, and remedies. Multi-sentence or context-dependent text is not eligible for normalized reuse.

Fuzzy similarity is never semantic equivalence. It can map a likely edit to `REVERIFY`, but it MUST NOT inherit a prior attestation.

## 3. Automatic claim extraction

Every extractor MUST report:

- extractor name, version, and deterministic/model/hybrid kind;
- source artifact SHA-256;
- candidate text and stable locator;
- materiality classification and reasons;
- protected tokens or fields detected;
- uncertainty;
- whether completeness is asserted and by whom.

A deterministic heuristic extractor MUST NOT claim exhaustive coverage. Model extraction MUST validate against a schema and MUST NOT create source citations that were absent from retrieval.

High-risk `PASS` still requires complete coverage. Silence from an extractor is not proof that no claim exists.

## 4. Revision planning

The revision planner returns one status per old/new candidate:

- `REUSE`: exact self-contained material claim and binding unchanged;
- `REVERIFY`: protected content or evidence binding changed;
- `ADDED`: new candidate;
- `REMOVED`: prior candidate no longer present;
- `UNCERTAIN`: matching or materiality cannot be resolved safely.

Each non-reused item also declares a review class. `SOURCE_SUPPORT` reopens the affected claim's evidence and authority checks. `MATERIALITY` first decides whether changed prose is material. This two-stage route avoids rechecking every source after an unrelated rewrite without pretending that an incomplete extractor can conclusively label changed prose immaterial.

`UNCERTAIN`, `ADDED`, and material `REMOVED` MUST prevent automatic `PASS` until resolved. A removed claim matters because deletion can narrow a requested remedy, omit a qualification, or break complete coverage.

Fuzzy matching MUST have a deterministic resource bound. Exhausting that budget produces `UNCERTAIN`; it MUST NOT fall back to reuse or an unbounded all-pairs model call.

Protected fields include actors, attributions, dates, deadlines, numbers, identifiers, quotations, citations, jurisdiction, legal sections, negation, modality, exceptions, burdens, procedural status, findings, remedies, and reservations of rights.

## 5. Revision-plan trace

A revision plan MAY be persisted as a `revision-plan` trace. That artifact is versioned separately from the v0.1 `AuditTrace` and MUST NOT be read as one: it carries no verification decision, no claim verdict, and no action gate. The v0.1 request, result, and audit-trace contract is unchanged.

The artifact MUST bind, and a reader MUST validate:

- the previous and current subject text, each with its own SHA-256 audit identity;
- the extractor version and the resolved fuzzy-comparison budget the plan was produced with;
- the previous inventory, the current inventory, and the comparison plan;
- the canonical hash of each of those three components;
- the bound prior semantic attestations supplied for the previous draft, canonically ordered, and the canonical hash of that array;
- the prior-attestation mapping computed from those attestations, the previous inventory, and the plan;
- an `artifactHash` over the versioned core: schema version, kind, engine and extractor versions, comparison options, both subject records, the three component hashes, the prior-attestation hash, the prior-attestation mapping, and the recorded limits.

`artifactHash` deliberately excludes `traceId` and `createdAt`, so the same revision reproduces the same identity. Those two fields are therefore **envelope metadata, not authenticated provenance**: an edit to either is not detectable from the artifact alone, and neither may be relied on as evidence of when a plan was produced. Anything needing authenticated timing must be bound outside this artifact. The artifact records this limit in its own `reasons`.

The binding is a chain: `artifactHash` binds each component hash, and each component hash binds its component. Editing a component is reported by the inner link, and editing a stored component hash is reported by the outer one.

Every object in the artifact is closed. A reader MUST reject an unknown property at any level, because `artifactHash` binds a fixed field list and an unknown top-level property would otherwise travel unauthenticated. A reader MUST validate every field the published schema declares, to at least the schema's strictness, including `createdAt` as a date-time and every declared string array as strings. It MUST fail closed with typed issue codes and MUST NOT raise an untyped runtime error on malformed input.

A reader MUST also reject a stored plan item whose `action` disagrees with its consequences: only `REUSE` may set `requiresRevalidation=false` or `reviewKind=NONE`; `REUSE` and `REVERIFY` MUST carry both sides; `ADDED` MUST carry only the new side and `REMOVED` only the old side. `UNCERTAIN` MAY carry either side or neither. Each subject record is pinned to its own role, so a swapped pair cannot be read as a revision in the opposite direction.

Replay MUST recompute the inventories, the comparison, and the prior-attestation mapping from the stored subject text and the stored attestation wrappers, and report whether the recomputed `artifactHash` matches. It MUST report the attestation wrappers and the mapping as separate components, so an edited mapping table is never reported as an edited attestation set. It MUST NOT convert a `COMPLETE` mapping status, or a `MATCHED_REUSE_ITEM` entry, into reuse authorization. A match proves deterministic reproduction of the plan only. It is not a semantic verdict on either draft, it does not establish complete coverage, and a subject SHA-256 remains an audit identity rather than a claim-level judgement. `artifactHash` binds both the engine version and the extractor version, so replay MUST report each separately against the running versions: a hash difference explained by a recorded version change is a version change, not evidence of tampering, and replay MUST NOT attribute it to anything else.

The artifact stores raw subject text, so an implementation MUST write it owner-only through an exclusive temporary file renamed into place, exactly as a verification trace is written.

### 5.1 Prior-attestation mapping

At schema version `0.2.1` the artifact carries `priorAttestations` and a populated `priorAttestationMapping`. A `0.2.0` artifact MUST NOT be read as a `0.2.1` one.

A mapping MUST be established only through the explicit draft-candidate binding an attestation carries, and MUST NOT be inferred from a fingerprint coincidence. A `SemanticAttestation` fingerprint is computed over the isolated manifest claim text and therefore binds an empty heading path, while an in-draft candidate fingerprint binds the heading path, heading levels, semantic role, and rolling antecedent context of its position; the two coincide only for a sentence at the document root. A repeated sentence also yields several candidates sharing one fingerprint, so a fingerprint cannot name a position. There is no text or fingerprint fallback: a binding that does not match the previous inventory candidate at its own index is `NOT_IN_PLAN`, never re-attached to a lookalike.

The stored attestations MUST be canonically ordered, ascending and unique by `boundAttestationHash`, and `priorAttestationsHash` MUST be `hashObject` over exactly that stored array. A reader MUST:

- validate every stored wrapper against the bound-attestation contract, recomputing its binding, attestation, and bound hashes rather than trusting them;
- reject an array that is unordered or carries a duplicate `boundAttestationHash`;
- recompute `priorAttestationsHash` from the stored wrappers;
- validate the mapping against its own contract, including its `mappingHash`;
- reject a mapping whose `priorAttestationsHash` is not the trace's, whose entries are not exactly one per stored wrapper, or whose entries or unmapped hashes name an attestation that is not stored here.

A mapping is a **deterministic association only**. `MATCHED_REUSE_ITEM` records that the associated plan item is `REUSE`; `REVALIDATION_REQUIRED` records that it is not. Neither result, and no `COMPLETE` status, may be read as: reuse authorization, a semantic verdict, evidence validation, proof that the checker or model behind an attestation is trustworthy, proof that its citations are correct, its sources current, or its jurisdiction right, or proof that automatic extraction was complete. Whether a prior attestation may actually be reused is decided by the verifier-policy gate in section 6, which is a separate artifact, and the v0.1 reuse rules are unchanged by this mapping.

A `COMPLETE` status means only that every **supplied** attestation was associated with exactly one plan item. It says nothing about attestations nobody supplied, so it is never evidence of coverage.

## 6. Claim-scoped reuse authorization

A revision-plan trace decides nothing. The decision whether a mapped prior attestation may actually be reused is a **verifier-policy gate**, recorded as a separate `claim-reuse-authorization` artifact at schema version `0.2.0`. It MUST NOT be read as a v0.1 `AuditTrace` or as a `revision-plan` trace, and the revision-plan contract at `0.2.1` is unchanged by it.

### 6.1 Entry point

An implementation MUST NOT expose a way to authorize reuse from an unvalidated in-memory mapping. The gate MUST read the revision-plan trace and replay it itself. A trace that fails to read, that changes between the read and the replay, or whose recomputed `artifactHash` differs from the stored one yields **no authorization at all**, not a refused one. Because `artifactHash` binds the engine and extractor versions, a version change also yields no authorization.

The same closure MUST hold on the read side. **Every** exposed entry point that can return an authorized reuse — evaluation, replay, and any convenience helper over them — MUST take artifact **paths** only, and MUST do its own reading and replaying. An implementation MUST NOT expose any function that returns an authorized reuse from a caller-supplied replay result, a caller-supplied authorization object, a stored decision list, or any other in-memory value a caller could assemble, and MUST NOT offer such a signature as a compatibility overload. Because a replay result is an ordinary object in most languages, a helper that accepts one is an authorization path that bypasses replay entirely.

The path-carrying input MUST be closed and validated at runtime through the same fail-closed contract as replay: a non-object, a missing or blank path, and an unknown property MUST each raise the implementation's typed refusal rather than being ignored. Passing a fabricated replay result to such a helper therefore fails because the artifact paths are absent, not because the fabrication was inspected and disbelieved.

### 6.2 Outcomes

Every outcome is scoped to one mapped attestation. There is no whole-document `PASS` in this artifact.

- `REUSE_AUTHORIZED`: every deterministic gate passed. The named claim-scoped attestation MAY be reused for the one named current-draft candidate, under the stored policy, at the stored `asOf`.
- `REVERIFY_REQUIRED`: the plan deterministically says the claim's protected surface or binding changed.
- `POLICY_BLOCKED`: the association is intact and the named policy refused.
- `HUMAN_REVIEW_REQUIRED`: the runtime cannot deterministically classify the claim.

A refusal means the artifact cannot prove reuse is safe. It is not a finding that the claim is false.

### 6.3 Gates

`REUSE_AUTHORIZED` requires every one of these, with no permissive default anywhere:

1. trace integrity and an exact replay match;
2. a prior-attestation mapping whose status is `COMPLETE`. One unmapped, ambiguous, or `NOT_IN_PLAN` attestation refuses **every** decision in the artifact, because an incomplete mapping means the caller's picture of the previous draft is wrong somewhere;
3. a `MATCHED_REUSE_ITEM` entry naming exactly one plan item whose `action` is `REUSE`, whose `requiresRevalidation` is `false`, whose `reviewKind` is `NONE`, and whose `before` is the bound previous candidate;
4. exactly one current-inventory candidate matching that plan item's `after` by canonical hash. Zero or more than one refuses instead of guessing a position;
5. the attestation's `claimTextHash` equals the SHA-256 of the previous-draft candidate it is bound to. The mapping does not check this, so the gate MUST;
6. `bindingScope=claim` and a `SUPPORTED` verdict;
7. an exact `(checkerName, checkerVersion, checkerKind)` triple present in an explicit allowlist. A name alone is never sufficient, and one name and version MUST NOT be allowlisted under two kinds;
8. a finite score meeting an explicit threshold;
9. `checkedAt` no later than a caller-supplied deterministic `asOf`, and no older than an explicit maximum age. There is deliberately **no clock-skew window** here, unlike the live v0.1 request path, because `asOf` is deterministic input rather than an observed wall clock;
10. an exact evidence pin: the attestation's `snapshotId` **and** `evidenceHash` both equal the pinned pair. A snapshot ID alone is insufficient, because one snapshot serves many claims with different cited subsets;
11. the attestation's `claimBindingHash` equals the pinned value;
12. the pinned jurisdiction and domain equal the policy's, and the pinned source-currency confirmation is neither in the future nor older than an explicit maximum age.

### 6.4 What the gate cannot prove

A `SemanticAttestation` carries no jurisdiction, no domain, no source record, and no effective date. This runtime therefore **cannot** verify jurisdiction, domain, or source currency from the artifact, and MUST NOT pretend otherwise.

What it does instead: `claimBindingHash` binds the v0.1 claim metadata — jurisdiction, as-of date, required authority tiers, citations, proof class, materiality, and risk — so pinning it proves the attestation was made against exactly the claim binding the policy authorized. Jurisdiction, domain, and source currency are additionally supplied as **explicit caller declarations inside the hash-bound policy input**, checked for consistency and age, and recorded as declarations. They are not independently verified here, and the artifact says so in its own `reasons`.

`REUSE_AUTHORIZED` also inherits the extractor's protected-fingerprint judgement that the previous and current candidates are the same claim. It is only as strong as the extractor version recorded in the underlying trace.

### 6.5 Policy input

The policy is a closed object bound by `policyHash`. Its ordered inputs — the trusted-checker allowlist and the per-claim pins — MUST canonicalize deterministically, so the same entries in a different order produce the same hash. An implementation MUST reject a duplicate checker triple, one checker name and version carrying two kinds, and more than one pin for a claim ID, whether the second pin repeats the first or contradicts it. Caller input MUST NOT be mutated.

### 6.6 Artifact, reader, and replay

`evaluationHash` binds the schema version, kind, engine version, extractor version, `asOf`, `policyHash`, the stored canonical policy, the revision-plan trace binding, the document-release condition, every decision, and the recorded reasons. `authorizationId` and `createdAt` sit outside it, so the same trace, policy, and `asOf` reproduce the same identity; like the revision-plan envelope, those two are metadata rather than authenticated provenance, and `asOf` is deterministic input rather than authenticated time.

Every object in the artifact is closed. A reader MUST reject an unknown property at any level, MUST recompute `policyHash` and `evaluationHash` from the stored bytes, MUST reject a stored policy that is not in canonical order, and MUST reject a stored outcome that contradicts its own blockers or that claims `REUSE_AUTHORIZED` without a `MATCHED_REUSE_ITEM`/`REUSE` association and a named current candidate. It MUST fail closed with typed issue codes and MUST NOT raise an untyped runtime error on malformed input.

A structural read is **not** authorization. A stored `REUSE_AUTHORIZED` string MUST never be trusted on its own. Replay MUST recompute every component hash **and every decision** from the revision-plan trace plus the stored closed policy and `asOf`, and MUST be given the exact trace the authorization names. A forged authorization whose every hash was recomputed is therefore still exposed, because the decision itself is recomputed rather than read.

A helper that reports which reuses an authorization proves MUST, per section 6.1, take the authorization path and the revision-plan trace path, run the replay itself, and read the **recomputed** decisions. It MUST return nothing when that replay does not match, and MUST NOT return a stored decision under any circumstance.

### 6.7 Claim reuse is not document release

Automatic candidate extraction never asserts complete coverage, so the artifact carries exactly one document-level status, `DOCUMENT_REVIEW_REQUIRED`, and MUST continue to carry it even when a claim is authorized for reuse. Authorizing a claim saves re-verifying that claim. It does not satisfy coverage, added-claim, removed-claim, uncertain-claim, action, or authority requirements, and it MUST NOT be reported as a verification `PASS` or as approval of the document.

## 7. PDF and OCR ingestion

Ingestion MUST preserve:

- original file SHA-256, size, and media type;
- extraction method and exact tool version;
- page count and per-page locator;
- extracted page text and content hash;
- whether native text, OCR, or a fallback produced each page;
- typed unresolved status when extraction is unavailable or suspicious.

Sparse or empty native text SHOULD route to OCR review. OCR output MUST NOT silently become an exact quotation source without page-level provenance and appropriate visual or independent checking. `ready` MUST describe technical extraction only and MUST NOT assert OCR, quotation, or legal accuracy. Implementations SHOULD bound pages, input/output bytes, total time, and parser process lifetime. The raw source is immutable.

## 8. Benchmark and calibration

The BC legal Cantonese benchmark MUST:

- use public/licensed or separately redacted material only;
- keep raw data immutable and record lineage;
- include supported, partial, contradicted, not-found, and abstain cases;
- cover Cantonese, written Chinese, English, and code-switching;
- include fake citations, wrong sections, omitted exceptions, stale law, remedy overreach, quotation corruption, and harmless edits;
- split by authority/document family and maintain a temporal holdout;
- compare a deterministic baseline before model-based checkers;
- report sample size, confidence intervals, false-pass rate, false-reuse rate, abstention, extraction recall, latency, and cost;
- freeze thresholds before test evaluation.

No model checker is trusted for high-risk use merely because it performs well on a general factuality benchmark.

## 9. Release boundary

The claim-scoped path is experimental until the v0.2 release gate in the roadmap passes. The current legal workflow MAY continue using subject-scoped attestations. Enabling claim scope reduces repeated review but does not reduce evidence, coverage, authority, or independent-audit requirements. A `claim-reuse-authorization` artifact is subject to the same boundary: it decides one claim at a time, it is not the current legal filing gate, and it never releases a document.
