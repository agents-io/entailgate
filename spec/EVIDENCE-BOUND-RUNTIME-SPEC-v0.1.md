# Evidence-Bound Runtime Specification v0.1

Implementation amendment: runtime 0.1.1 strengthens evidence, claim, domain, and action bindings. A 0.1.0 semantic-attestation hash is not accepted as a 0.1.1 attestation.

Status: implementable MVP
Date: 2026-08-22
Normative terms: MUST, MUST NOT, SHOULD, MAY

## 1. Objective and non-objective

The runtime decides whether a prepared AI answer plan and its proposed actions are sufficiently bound to a frozen evidence snapshot to proceed.

It is not a universal truth detector. It MUST NOT call something verified merely because:

- a citation URL exists;
- a source ID is syntactically valid;
- a second LLM agrees;
- the answer sounds plausible;
- retrieval found something topically related;
- a previous version of the draft passed.

The enforceable promise is narrower:

> Every material claim is inventoried, every citation is inside the frozen retrieval set, every deterministic proof is reproducible, every semantic judgment is identified as probabilistic, and the policy makes unsupported output stop.

## 2. Trust boundaries

The system has five independent trust boundaries.

1. Evidence ingestion establishes source identity, content hashes, version, issuer, dates, jurisdiction, and stable chunk IDs.
2. Claim planning maps each material assertion to evidence and a proof class.
3. Verification checks deterministic proofs and invokes optional semantic plugins.
4. The text gate returns PASS, REWRITE, ASK, ABSTAIN, or HUMAN_REVIEW.
5. The action gate independently returns ALLOW, DENY, CONFIRM, or REVIEW.

A text PASS MUST NOT authorize an action. A hook completion MUST NOT be interpreted as either pass.

## 3. Assurance classes

| Class | Meaning | Validator |
|---|---|---|
| EXACT | The complete atomic claim is the quotation, and it occurs in one cited chunk under the declared normalization | deterministic claim equality plus cited substring check |
| STRUCTURED | A typed value equals a field in cited evidence | deterministic deep equality |
| DERIVED | A value is reproduced by an allowlisted calculation whose every operand is bound to cited fields | deterministic calculator |
| SEMANTIC | The cited text is alleged to support the proposition in context | pinned semantic checker plus calibration |
| NONE | No valid proof | fail closed |

SEMANTIC is not equivalent to the first three classes. High-risk policy SHOULD require human review or multiple calibrated signals for novel legal propositions.

## 4. Normative data model

The public types are implemented in src/types.ts; JSON Schema files are under schemas/.

### 4.1 Evidence snapshot

An EvidenceSnapshot MUST contain:

- a schema version, stable snapshot ID, creation time, and domain;
- source records with stable IDs and authority tiers;
- chunks with stable IDs, source ownership, text, and optional structured fields;
- source dates and jurisdiction where policy needs freshness or scope checks.

A chunk ID MUST be unique within a snapshot. A chunk MUST point to an existing source. When chunk.sha256 is present, it MUST equal the SHA-256 of the exact UTF-8 chunk text.

The snapshot is immutable for a run. Updating any source creates a new snapshot.

The generic verifier binds the structured snapshot supplied to it. It verifies a declared chunk hash against the included chunk text, but it does not reopen an external `source.uri` or `subject.path`. An ingestion or domain adapter that claims file-byte identity MUST compute the file hash from the actual local bytes and bind that value into the request; the BC legal adapter does this for its draft.

### 4.2 Claim inventory

Every material assertion MUST appear as an AtomicClaim. An atomic claim SHOULD contain one independently falsifiable proposition. Compound legal tests, exceptions, dates, actors, quotations, and remedies SHOULD be split when they can fail independently.

An `exact_quote` proof MUST contain no unverified wrapper proposition. The normalized complete claim text MUST equal the declared quote. A genuine quote embedded beside an inference, characterization, attribution, or other proposition is `PARTIAL` until those additional words are split into separately supported claims.

Each claim carries:

- stable claim ID and exact claim text;
- materiality and risk;
- citations;
- one proof object;
- draft locator;
- jurisdiction, effective date, and required authority when applicable.

The runtime does not infer missing claims in v0.1. High-risk policy therefore requires a claim-coverage attestation bound to the exact subject SHA-256. This is a declared process guarantee, not proof that the inventory was intellectually complete.

### 4.3 Action proposal

Actions are typed data, not prose. Each evidence-sensitive argument MUST bind to a structured field in a retrieved chunk. Policy MAY also require:

- an action-type allowlist;
- required and allowed arguments;
- an idempotency key;
- live-state revalidation in an executor;
- explicit user confirmation.

The v0.1 runtime validates proposals only. It never executes them.

Runtime 0.1.1 treats `requiredArgs`, `allowedArgs`, and `requireBindings` as explicit dotted leaf paths over own JSON properties; an allowlisted parent object does not silently authorize arbitrary descendants. Evidence-bound actions also verify chunk integrity, retrieval closure, source effective/freshness state, and an explicitly declared source-domain scope before `ALLOW`.

## 5. Verification algorithm

For every claim, the runtime MUST:

1. reject unknown source IDs and chunk IDs;
2. reject a source/chunk ownership mismatch;
3. reject cited chunks outside the request retrieval set when closure is enabled;
4. verify a present chunk hash;
5. enforce source effective dates, future/freshness checks, jurisdiction, request domain, and required authority on the sources permitted to support the proof;
6. run the validator for the declared proof class;
7. return only valid citations in the result;
8. emit structured findings with stable codes;
9. avoid converting missing evidence into contradiction or support;
10. leave semantic claims UNCHECKED when no checker is available.

For semantic plugins:

- the adapter name and version MUST be pinned;
- scores MUST be in the range zero to one;
- the plugin MUST receive only the cited chunks, not an anonymous pooled corpus;
- the runtime SHOULD preserve per-checker scores and concise reasons;
- calibration data MUST be domain and language specific before setting a pass threshold;
- replay MUST use the same model, prompt, configuration, and recorded evidence, or disclose that exact replay is unavailable.

The BC-legal adapter MUST apply the advocacy calibration in
[`docs/policy/BC-LEGAL-ADVOCACY-VERIFICATION.md`](../docs/policy/BC-LEGAL-ADVOCACY-VERIFICATION.md).
In particular, it MUST evaluate the proposition actually asserted, not require the
writer to adopt the least favourable available characterization. A fair, favourable
inference is not `PARTIAL` merely because the source also permits a less favourable
reading or contains background adverse to the writer. `PARTIAL` and `CONTRADICTED`
remain reserved for a material support gap or conflict, not for omitted defensive
commentary that is unnecessary to make the asserted proposition accurate.

After deterministic source-integrity preflight and before the final semantic release
gate, the BC-legal adapter MUST produce a separate advocacy review using the closed
dispositions `MUST_FIX`, `KEEP_STRONG`, and `STRENGTHEN`. Drafting and uplift MUST
consume hash-bound shared evidence packets rather than independently retrieving or
rereading the raw corpus. Only `MUST_FIX` affects the integrity verdict. `STRENGTHEN`
is an evidence-backed opportunity, not an error, and every adopted stronger sentence
MUST enter the final claim inventory before the one full semantic release check.
Subsequent changes revalidate only changed material claims under the selective-review
rules. `KEEP_STRONG` forbids an adapter from weakening a fair favourable reading merely
because another reasonable reading exists. See
[`docs/architecture/SHARED-EVIDENCE-PACKETS.md`](../docs/architecture/SHARED-EVIDENCE-PACKETS.md).

A completed independent review MAY be recorded as a semantic attestation. The runtime accepts it only when:

- checker name and version are allowlisted by policy;
- the attestation is bound to the current subject SHA-256;
- snapshot ID, request domain, required claim-binding hash, and atomic claim text hash all match;
- the complete cited chunk objects, structured facts, and cited source metadata all match the versioned evidence-binding hash;
- verdict, score, time, and concise reasons are recorded.

An attestation makes an external judgment tamper-evident and replayable. It does not make that judgment deterministic or correct. A changed draft, claim metadata, chunk, structured fact, cited source metadata, domain, or snapshot invalidates it automatically. An attestation dated materially after its verification request is rejected.

## 6. Gate policy

Default v0.1 aggregation:

| Condition on a material claim | Low/medium risk | High risk |
|---|---|---|
| CONTRADICTED | ABSTAIN | ABSTAIN |
| NOT_FOUND | REWRITE | ABSTAIN |
| PARTIAL | HUMAN_REVIEW | HUMAN_REVIEW |
| UNCHECKED | HUMAN_REVIEW | HUMAN_REVIEW |
| all SUPPORTED | PASS | PASS, subject to complete coverage |

Incomplete coverage prevents PASS, but it MUST NOT mask a dispositive failure already found in the checked claim set. A material `CONTRADICTED` claim therefore returns `ABSTAIN` even when coverage is incomplete. A claim marked `risk=high` remains in aggregation even if a caller marks it non-material. This preserves fail-fast review without misrepresenting a partial review as complete.

ASK is reserved for a dialogue adapter that can identify a specific missing user input. The deterministic core does not invent that question.

Legal adapters MUST use high risk, retrieval closure, exact draft hashing, and complete coverage. They MUST map anything other than PASS to a failed or unresolved filing gate.

## 7. Legal adapter: BC first

The legal adapter is a strict profile, not legal advice generation.

Before verification:

1. freeze the expressly approved Chinese controlling draft;
2. record the absolute draft path and SHA-256;
3. prepare an exhaustive material-assertion inventory;
4. ingest the full primary source or official guidance, not a search snippet;
5. identify statute, policy, decision, version, jurisdiction, effective date, and pinpoint;
6. bind quotes, dates, counts, names, identifiers, deadline inputs, legal propositions, authority treatment, procedural status, remedies, and rights reservations.

The deterministic runtime can conclusively check source identity, exact quotations, structured fields, arithmetic, declared dates, jurisdiction metadata, and citation closure. It cannot conclusively decide whether a judgment supports a nuanced legal proposition. Those claims remain semantic and require an independently calibrated checker or a fresh legal-verifier attestation plus the existing human-readable source-integrity audit.

Output MUST remain tied to the exact draft hash. Any substantive edit invalidates the prior result. A pass never authorizes translation, filing, sending, or uploading.

## 8. Missed Call AI adapter

The business adapter uses the same snapshot and claim contract with structured source fields for price, service, location, opening hours, and booking slots.

The dialogue pipeline SHOULD be:

classify → retrieve → claim plan → draft → deterministic verify → semantic verify → repair → re-inventory → reverify → render

Booking and messaging actions remain separate:

action proposal → schema/allowlist → evidence binding → live-state check → idempotency → confirmation → executor

A weaker generator may produce more rewrites, questions, abstentions, and reviews. The runtime MUST NOT lower verification standards to make a weak model appear capable.

## 9. Trace and replay

Every CLI verification writes a mode-0600 JSON trace using an atomic rename. The trace includes:

- engine and schema versions;
- canonical input hash;
- result hash;
- complete structured request;
- complete structured result;
- timestamp and trace ID.

The trace MUST NOT contain hidden chain of thought. Private source text is already present in the request and therefore traces MUST be stored locally with the same sensitivity as the source pack.

Deterministic runs and recorded hash-bound semantic attestations are replayable byte-for-byte at the result-object level. A live semantic plugin result is not replayable unless the same adapter is supplied; v0.1 refuses deterministic-only replay of such a trace.

Reading a stored trace MUST verify that the trace input hash and result input hash both equal the canonical request hash, and that the stored result hash equals the canonical stored result hash, before replay. Deterministic replay then compares the recomputed result hash with that integrity-checked stored result hash.

## 10. Security and privacy

- Local-first is the default.
- Raw evidence is never uploaded merely to test an external verifier.
- Logs and traces use restrictive permissions.
- Unknown IDs, missing sources, parse errors, model errors, and unavailable checkers fail closed.
- Source content is untrusted data. It MUST NOT alter runtime policy or action permissions.
- External actions require their own authorization workflow after verification.

## 11. MVP acceptance criteria

Version 0.1 is acceptable when automated tests prove:

- fabricated citation IDs cannot survive as valid citations;
- unretrieved real chunks cannot support claims;
- altered quotation text fails;
- structured values and conflicts are detected;
- every derived operand is source-bound and recalculated;
- stale, expired, wrong-jurisdiction, and insufficient-authority sources fail;
- semantic claims without a checker stop at human review;
- unallowlisted or mismatched actions are denied;
- coverage and draft hash mismatch stop high-risk legal work;
- trace write and deterministic replay agree.

## 12. Deferred work

- claim extraction and coverage measurement;
- source ingestion, PDF/OCR locator preservation, and content-addressed snapshots;
- MiniCheck, AlignScore, HHEM, and LLM-judge adapters;
- domain-specific calibration and gold sets;
- contradiction search beyond cited chunks;
- legal authority treatment and temporal citator integration;
- live action-executor plugins;
- repair with no-new-claim enforcement;
- promptfoo/DeepEval CI matrices;
- signed audit bundles and multi-reviewer approval.
