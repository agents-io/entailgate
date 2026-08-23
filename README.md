# Evidence-Bound Runtime

An independent, generic verification kernel that binds AI claims and proposed actions to a versioned evidence snapshot. Product-specific systems such as 明鏡 and Missed Call AI consume this core through adapters; private product data does not belong in this repository.

It guarantees structural and deterministic invariants. It does not claim to be a truth oracle:

- cited source and chunk IDs must exist and belong to the current retrieval set;
- an exact-quotation claim must be quote-only, and that quote must occur in the cited text;
- structured values must equal cited fields;
- calculations must reproduce from evidence-bound operands;
- source dates, jurisdiction, and authority scope must satisfy policy;
- tool actions pass a separate allowlist, argument, binding, idempotency, and confirmation gate;
- semantic support is a plugin result. Without a pinned checker, it is UNCHECKED;
- completed human or model checks can be recorded only as policy-trusted attestations bound to the exact draft, claim, snapshot, and evidence hashes;
- every `verify` and `legal` verification run writes a private trace tied to canonical SHA-256 hashes.

The first adapters are bc-legal and the Missed Call AI business assistant. The generic core contains no BC-specific legal rule and no booking-specific workflow.

## Current status

Version 0.1.1 remains the default deterministic filing/action gate. It accepts a prepared atomic-claim manifest and keeps semantic attestations bound to the exact subject by default. The 0.1.1 attestation envelope binds the complete cited chunk objects, structured facts, cited source metadata, request domain, and claim metadata; older 0.1.0 envelopes must be independently re-attested rather than silently upgraded.

The v0.2 path is experimental and now includes:

- deterministic candidate-claim extraction and selective revision planning;
- a separately versioned `revision-plan` trace that stores both drafts, both inventories, the plan, and any bound prior semantic attestations under canonical hashes, and replays all of it from the stored bytes;
- a separately versioned `claim-reuse-authorization` artifact: the fail-closed verifier-policy gate that reads and replays a revision plan and then decides, one claim at a time, whether a prior attestation may actually be reused;
- opt-in exact claim-scoped attestation reuse after unrelated draft edits;
- local UTF-8, PDF, and explicitly authorized OCR ingestion with page provenance;
- a leakage-controlled BC legal Cantonese benchmark scaffold;
- a private local dogfood workspace that wires ingestion, the legal manifest, and verification into one first-run workflow.
- an external-legal-only scope router plus content-addressed legal source extraction
  cache and immutable authority-lock identity. Private case facts stay out by default;
  cached extraction never carries a semantic verdict.

Automatic extraction deliberately reports incomplete coverage. It is a conservative baseline, not proof that every legally material assertion was found. High-risk work still requires a complete current inventory before `PASS`.

The current PDF/OCR path is also alpha. It snapshots the source privately, applies page/text/time/output limits, records local tool versions, and kills timed-out POSIX process groups. `ready` means only that technical extraction completed. PDF quotations still require visual comparison with the cited page; OCR and legal accuracy remain `UNCHECKED`. PATH-resolved parsers are not a complete sandbox.

## Hashes and re-verification

The complete document SHA-256 is a cheap audit seal: when a trusted adapter or ingestion step computes it from bytes, it identifies that exact artifact and binds the verification trace. The generic JSON `verify` command validates and binds the declared hash but deliberately does not reopen `subject.path` or an external source file; the BC legal adapter re-hashes its draft, and ingestion computes source/snapshot hashes locally. A hash does not judge legal meaning and no longer causes blanket semantic re-verification in the v0.2 revision planner.

Claim fingerprints do the selective work. They protect semantic role, heading path, rolling antecedent context, quotations and code spans, URLs, and detected material fields. An unchanged protected claim can be reused; a changed section, date, number, quotation, actor, modality, proposition, citation, deadline, or remedy receives source-support review. Changed wording that the baseline cannot classify is `UNCERTAIN` and receives a cheaper materiality review first; it does not trigger blanket source verification, but it also cannot silently inherit an old pass. Fuzzy similarity can locate an edit but can never establish equivalence.

See [Hash is a seal, not a legal checker](docs/architecture/HASH-IS-A-SEAL.md) and the [v0.2 selective-verification roadmap](docs/roadmap/V0.2-SELECTIVE-VERIFICATION-ROADMAP.md).

## Run

    npm install
    npm test
    npm run build

    node dist/src/cli.js verify \
      --request examples/passing-request.json \
      --trace-dir /tmp/ebr-traces

Compare two text drafts without rechecking unchanged material claims:

    node dist/src/cli.js claims diff \
      --before /absolute/path/to/old-draft.txt \
      --after /absolute/path/to/new-draft.txt

Persist that comparison as a replayable `revision-plan` trace. The artifact stores both drafts, so it is written owner-only through an atomic temporary file:

    node dist/src/cli.js claims diff \
      --before /absolute/path/to/old-draft.txt \
      --after /absolute/path/to/new-draft.txt \
      --trace-dir /tmp/ebr-revision-plans

    node dist/src/cli.js revision replay \
      /tmp/ebr-revision-plans/PLAN.revision-plan.json

Replay re-extracts both inventories from the stored text, remaps any stored prior attestations onto the recomputed plan, and reports whether the recomputed `artifactHash` matches, plus whether the stored engine and extractor versions match the running ones so a version change is never reported as tampering. The attestation set and the mapping are reported as separate components, so an edited mapping table is never blamed on the attestations. Exit zero means the stored plan reproduces exactly; it is not a verification `PASS` and not a statement about legal meaning.

A synthetic public example of the artifact, including two bound attestations and their mapping, is checked in at [`examples/revision-plan-trace.example.json`](examples/revision-plan-trace.example.json).

`artifactHash` covers the plan content, not the envelope: `traceId` and `createdAt` sit outside it so an identical revision reproduces an identical hash. Treat those two as envelope metadata, not authenticated provenance.

Extract a conservative candidate inventory:

    node dist/src/cli.js claims extract \
      --input /absolute/path/to/draft.txt

Ingest a local text or PDF source. Native extraction is the default; suspiciously sparse PDF text returns `OCR_REQUIRED`:

    node dist/src/cli.js ingest \
      --input /absolute/path/to/source.pdf

OCR runs only when explicitly requested and operates on a temporary copy:

    node dist/src/cli.js ingest \
      --input /absolute/path/to/source.pdf \
      --ocr perform

The JSON result includes a `quality` object. Do not treat `status: "ready"` as OCR correctness or permission to quote a PDF without page-level visual review.

Legal adapter:

Route only external legal candidates before retrieving any source:

    node dist/src/cli.js legal scope \
      --draft /absolute/path/to/frozen-draft.md

Cache a downloaded external authority once. The command prints hashes and quality
state, not source text or its local path:

    node dist/src/cli.js legal cache-source \
      --source /absolute/path/to/authority.pdf \
      --cache-dir /absolute/path/to/private-authority-cache \
      --canonical-id BCSC-2024-994 \
      --title "Fixture v Example" \
      --issuer "Supreme Court of British Columbia" \
      --class adjudicative_decision \
      --tier primary \
      --jurisdiction BC

This is an internal alpha routing/cache slice. The declared authority identity is
hash-bound but not automatically authenticated. Authority-card retrieval, contextual
packet assembly, and the strongest final semantic checker remain the next integration
layer. See [external legal authority pipeline](docs/architecture/EXTERNAL-LEGAL-AUTHORITY-PIPELINE.md).

    node dist/src/cli.js legal init \
      --draft /absolute/path/to/frozen-draft.md \
      --out /absolute/path/to/claim-manifest.json

    node dist/src/cli.js legal \
      --draft /absolute/path/to/frozen-draft.md \
      --manifest /absolute/path/to/claim-manifest.json

The legal manifest is the normal verification request with:

- domain set to bc-legal;
- policy.riskTier set to high;
- complete coverage tied to the draft SHA-256;
- jurisdiction on each material claim;
- a required authority tier on every material semantic legal proposition.

After independently checking a semantic claim against its complete cited sources, generate a hash-bound attestation object:

    node dist/src/cli.js attest \
      --request /absolute/path/to/claim-manifest.json \
      --claim-id L-001 \
      --checker legal-draft-verifier@0.1.0 \
      --kind human \
      --verdict SUPPORTED \
      --score 1 \
      --reason "Full primary source and context checked."

Insert that object into the manifest semanticAttestations array. Changing the draft, claim metadata, snapshot, cited chunks or structured facts, cited source metadata, or domain invalidates it.

Experimental claim-scoped reuse adds `--scope claim` and requires `claim.selfContained: true`, `policy.allowClaimScopedAttestations: true`, and a complete claim inventory tied to the current subject hash before an attestation can cross subject versions. Exact wording remains the default. A second explicit flag, `policy.allowNormalizedClaimReuse: true`, permits only the narrow versioned fingerprint equivalences described above, such as `me`/`I`; every proof, citation, jurisdiction, as-of date, required authority, snapshot, and evidence-content binding must remain identical. Subject-scoped binding remains the default. The revision plan is now persisted as a replayable artifact that can also carry the prior semantic attestations bound to the previous draft, together with a deterministic mapping onto the plan (`priorAttestationMapping`). That mapping runs off an explicit attestation-to-candidate binding, never off a fingerprint coincidence: an attestation fingerprint is computed over the isolated claim text and so binds an empty heading path, while an in-draft candidate fingerprint binds its heading path and antecedent context, and a repeated sentence produces several candidates sharing one fingerprint.

The mapping proves association and deterministic recomputation, nothing more. `MATCHED_REUSE_ITEM` records that the associated plan item is `REUSE`; it does not authorize reuse, does not validate evidence, and says nothing about whether the checker or model behind an attestation can be trusted, whether its citations are correct, whether its sources are still current, whether its jurisdiction still applies, or whether extraction was complete. Deciding that is the separate policy gate below. Cross-version reuse is still alpha and is not the current legal filing gate.

For the `verify` and `legal` verification commands, exit code zero means the text gate is `PASS` and every proposed action is `ALLOW`. `dogfood verify` follows the same rule and exits 1 when it is blocked. Other commands, including `dogfood init` and `dogfood status`, use zero for successful extraction, ingestion, initialization, attestation construction, trace display, or matching replay; that is not a verification `PASS`.

## Local dogfood workspace

`ebr dogfood` is the first-run internal workflow: it puts one draft, one evidence directory, the legal manifest skeleton, and the existing verifier into a single private workspace so a BC-legal draft can actually be walked end to end on one machine.

It is scoped honestly. This enables a **first internal dogfood run**. It is not a high-risk public release, it is not automatic legal verification, and it does not do selective revision reuse across draft versions — cross-version reuse remains the separate alpha gate described above and is not wired into this workflow.

    node dist/src/cli.js dogfood init \
      --draft /absolute/path/to/draft.md \
      --evidence-dir /absolute/path/to/evidence \
      --workspace /absolute/path/to/private-workspace

    node dist/src/cli.js dogfood status \
      --workspace /absolute/path/to/private-workspace

    node dist/src/cli.js dogfood verify \
      --workspace /absolute/path/to/private-workspace \
      --trace-dir /absolute/path/to/private-traces

`--ocr perform` is available on `init` and, as everywhere else in this runtime, must be asked for explicitly:

    node dist/src/cli.js dogfood init \
      --draft /absolute/path/to/draft.md \
      --evidence-dir /absolute/path/to/evidence \
      --workspace /absolute/path/to/private-workspace \
      --ocr perform

### What init does and does not do

`init` creates a brand-new `0700` directory and refuses a path that already exists, so it can never write over a previous run. Every regular file inside is `0600` and every directory is `0700`, and each file is created exclusively; no draft, evidence file, workspace file, or earlier report is ever replaced. The workspace may not overlap the draft or the evidence directory in either direction — including the case where one is an ordinary child whose name happens to begin with `..` — and a draft, evidence root, or workspace parent that resolves through a symbolic link is refused rather than silently followed somewhere you did not name.

The evidence directory is walked recursively in deterministic relative-path order with explicit file-count, aggregate-byte, entry-count, and depth limits enforced **before** anything is parsed. Symbolic links are never followed, and no socket, FIFO, device, or directory is ever read as a file. Every entry the walk saw is recorded, including the ones it refused to read: a non-regular entry becomes a `skipped` inventory row and an `EVIDENCE_ENTRY_SKIPPED` blocker, so it cannot quietly count as verified evidence.

Because the limits are enforced during that preflight, ingestion re-checks what it actually read. An entry whose resolved path or byte length differs by the time it is snapshotted becomes `unresolved` (`ENTRY_PATH_AMBIGUOUS`, `ENTRY_SIZE_CHANGED`) instead of a ready source, so a small file replaced by a large one after the count cannot be admitted without ever being weighed.

Regular files go through the same `ingestLocalFile` as `ebr ingest`. `ready` still means technical extraction completed — never quotation, transcription, or legal accuracy.

The workspace holds five things:

| File | Written by | Meaning |
|---|---|---|
| `workspace.json` | init | Limits, the draft snapshot hash, the inventory/manifest identities, and the private absolute host paths of the draft and evidence root |
| `draft/draft.snapshot` | init | The exact draft bytes, so later verification is tied to stable content |
| `evidence-inventory.json` | init | Every enumerated entry, per-source and per-page hashes, locators, extraction/OCR/quality state |
| `manifest.json` | init, then **you** | The legal verification request |
| `review.json` | init, then **you** | The human review checklist |

`manifest.json` is prepopulated from technically ready extraction only. Authority tier is `unknown` on every source without exception — a file name is not evidence of what a document is, so nothing infers primary or official authority from it. `coverage.complete` stays `false` and `claims` stays empty, because this runtime knows what parsed, not what the draft asserts.

Evidence inventory paths and every operational file reference are relative — inventory entries to the evidence root, artifact references to the workspace. The absolute host paths of your draft and evidence directory are recorded, deliberately, in `workspace.json` under `hostPaths`, because a later run has to be able to say which inputs a workspace came from. That file is `0600` inside a `0700` directory and is never printed: `init`, `status`, and `verify` write a compact JSON summary — workspace path, status, counts, blockers — and nothing else. No extracted evidence text and no evidence file path reaches stdout; blockers name entries by their inventory `entryId`, which you look up in the private `evidence-inventory.json`.

The artifact names are fixed. `workspace.json` records them so the file is self-describing, but every reader compares each recorded name against the constant this build uses and refuses anything else, so a resealed metadata file cannot redirect a read or a write to another name, to a parent directory, or to an absolute path outside the workspace. On reopen, a symbolic link or a non-regular file standing where a fixed artifact belongs is refused before the file is opened; a fixed artifact that is simply *missing* stays an ordinary blocker.

Plain UTF-8 text and Markdown are the supported draft formats. There is no DOCX support.

### The gates

`status` rebuilds the whole picture from the bytes on disk every time. It re-hashes the draft snapshot, revalidates the inventory against the hash recorded at init, revalidates the manifest against the closed v0.1 request contract, and rereads the checklist. There is no stored status field to trust, and an injected one fails closed. `NEEDS_REVIEW` and `READY_FOR_VERIFICATION` are recomputed, and neither is ever a verification `PASS`. Exit zero means the utility ran and the workspace was readable; invalid input exits 2.

`dogfood verify` calls the existing legal verifier only when every one of these holds:

- no evidence entry is unresolved or skipped;
- the draft snapshot still hashes to the value recorded at `init`, and the machine-generated inventory is byte-for-byte the one `init` wrote;
- the manifest still carries this workspace's `requestId`, `snapshotId`, and draft hash, so it is not a file from another workspace. Its *content* is deliberately not pinned to its initial hash — you are meant to edit it — but everything in it that the machine produced must still be bound: each source's `sha256` (present, and equal to the ingested hash), `title` (the ingested evidence-relative path), and `sourceType` (`local_file`); each chunk's `sourceId`, `sha256`, text, and `locator`; and `subject.path` pointing at the workspace draft snapshot. Authority tier, jurisdictions, issuer, version, and dates stay yours to fill in;
- no evidence chunk carries `structuredFacts`. Structured and derived proofs read that field and treat it as evidence, and ingestion produces no structured facts at all, so there is nothing to bind one to and no hash that would catch an invented one. Until a separately validated structured-fact ingestion contract exists, the field is refused outright;
- the manifest is still `domain=bc-legal`, `riskTier=high`, complete coverage required, citation closure required;
- `coverage.complete` is explicitly `true`;
- the claims list is non-empty for a non-empty draft;
- every material claim carries a jurisdiction, every material semantic claim carries a required authority tier, and every source a material claim cites has been classified out of the `unknown` default and scoped to that jurisdiction;
- every applicable checklist confirmation is `true`.

If anything remains, it prints `status: "BLOCKED"` with typed blocker codes, exits 1, and writes no trace at all. There is no path that emits a partial trace or reports `PASS` the verifier did not produce. When the gates do pass, it runs the normal verification, writes the usual owner-only audit trace, and reports `status: "CHECK_COMPLETED"` — which says only that the verifier ran. The verdict is the `decision` field beside it, and that field can be `ABSTAIN`, `HUMAN_REVIEW`, `REWRITE`, or `ASK`. Exit zero still requires the existing shippable rule: decision `PASS` and every action `ALLOW`. The default trace directory is `traces/` inside the workspace and is refused if a symbolic link is standing in its place; an explicit `--trace-dir` writes exclusively and cannot replace an existing artifact. Nothing here sends, files, or performs any external action, and no network or model call is involved.

`review.json` is a human gate, not an attestation. Every confirmation starts `false`, and nothing in this runtime ever writes `true` into it. Its schema version, kind, and fields are closed like every other artifact, so an unknown key, a missing key, a wrong kind, or a non-boolean confirmation fails closed. The PDF and OCR items are only *required* when a PDF source or a performed OCR run actually exists — an inapplicable requirement is dropped from the required set, but a `false` confirmation is never flipped to `true` on your behalf. It is not a `SemanticAttestation`: it binds no claim hash and authorises no reuse.

### Limits worth knowing

The workspace contract is an internal alpha with no published JSON schema; it is deliberately not exported from the library index, so it is reached through the CLI. `workspace.json` carries a `metadataHash` over its own content, and the inventory is pinned by hash. Both are consistency seals that catch accidental drift, stale files, and a manifest carried over from another workspace. They are not authentication: there is no secret, so anyone who can write inside the workspace can recompute them. The same caveat already stated for `revision-plan` envelope metadata applies here. That is also why the artifact names are taken from the constants in the code rather than from the sealed file.

The checklist has the same limit, and it is the sharper one: `review.json` records that *somebody* asserted the review happened, with no identity field and no secret behind it. A checklist copied in from another workspace with every confirmation already `true` reads as valid here. Treat the human gate as an operator control on a private machine, not as authentication.

Symbolic links are refused at `init` and again on every reopen, but this is ordinary path traversal, not a hostile-filesystem sandbox. An attacker who can write inside the workspace or evidence directory *while a command is running* can still swap a path between the check and the open; nothing here uses `openat`-style directory handles, and adding that dependency is out of scope for the alpha. The stronger PDF/OCR parser-sandbox limitation stated in the ingestion section is unchanged and applies to every file this workflow reads.

If `init` fails part way through, the partially written workspace is left in place; this tool does not delete directory trees. Remove it yourself and rerun.

A dogfood workspace contains a draft snapshot and extracted evidence text. Keep it outside this repository. `.gitignore` covers `dogfood-workspace/` and `*.dogfood-workspace/` as a backstop only.

## Claim reuse authorization

`evaluateClaimReuse` is the verifier-policy gate that turns a mapping into a decision. It takes a revision-plan trace path, a closed policy, and a caller-supplied `asOf`, and returns a `claim-reuse-authorization` artifact (schema `0.2.0`, published at [`schemas/claim-reuse-authorization.schema.json`](schemas/claim-reuse-authorization.schema.json)). There is deliberately no way to authorize reuse from an in-memory mapping: the gate reads and replays the trace itself, and a trace that fails to read, that changes mid-evaluation, or that does not reproduce its `artifactHash` yields no authorization at all.

Every decision is scoped to one mapped attestation — `REUSE_AUTHORIZED`, `REVERIFY_REQUIRED`, `POLICY_BLOCKED`, or `HUMAN_REVIEW_REQUIRED`. There is no whole-document `PASS` in the artifact. `REUSE_AUTHORIZED` requires all of: a `COMPLETE` mapping, an exact `MATCHED_REUSE_ITEM`/`REUSE` association to one uniquely identified current-draft candidate, an attested claim text that really is the bound previous candidate's, a `SUPPORTED` verdict, an exact `(name, version, kind)` trust triple from an explicit allowlist, a finite score over an explicit threshold, a `checkedAt` that is neither after `asOf` nor older than an explicit maximum age, and an exact `snapshotId` **and** `evidenceHash` pin. Anything missing, malformed, stale, ambiguous, or unmapped refuses. A refusal means the artifact cannot prove reuse is safe; it is not a finding that the claim is false.

What the gate cannot prove, it does not pretend to. A `SemanticAttestation` carries no jurisdiction, no domain, and no source effective date, so those are supplied as explicit hash-bound caller declarations, checked for consistency and age, and recorded as declarations. What is cryptographically proved is that the attestation carries exactly the pinned `claimBindingHash` — which binds the v0.1 jurisdiction, as-of date, required authority, citations, proof class, materiality, and risk — and exactly the pinned evidence pair.

A stored `REUSE_AUTHORIZED` string is never trusted. `readClaimReuseAuthorization` only proves the artifact is internally consistent and self-hashing; `replayClaimReuseAuthorization` recomputes every hash **and every decision** from the revision-plan trace plus the stored policy, so a forged authorization that was fully rehashed still fails.

The closure holds on the read side too. Every entry point that can hand back an authorized decision takes artifact **paths** and does its own reading and replaying, so there is no object a caller can build that this library will read as proof:

```ts
import { authorizedClaimReuses } from "@mcpware/evidence-bound-runtime";

// Paths only. The helper replays both artifacts itself and returns the
// recomputed REUSE_AUTHORIZED decisions, or an empty list if replay does not
// match. It never returns a stored decision.
const reusable = await authorizedClaimReuses({
  authorizationPath: "…/authorization.claim-reuse-authorization.json",
  revisionPlanTracePath: "…/plan.revision-plan.json",
});
```

There is deliberately no overload that accepts a replay result, an authorization object, or a decision list. A replay result is an ordinary object, so a helper taking one would let a caller fabricate `{ matches: true, recomputed: { decisions: [{ outcome: "REUSE_AUTHORIZED", … }] } }` and skip replay altogether. Handing that object to `authorizedClaimReuses` fails closed with a typed `EVALUATION_INPUT_INVALID` naming the two absent paths, and the input is closed, so smuggling those fields in beside real paths is refused rather than ignored.

Claim reuse is not document release. Automatic extraction never asserts complete coverage, so the artifact always carries `documentRelease.status: "DOCUMENT_REVIEW_REQUIRED"`, including when a claim is authorized for reuse. A synthetic public example, evaluated against the published revision plan, is checked in at [`examples/claim-reuse-authorization.example.json`](examples/claim-reuse-authorization.example.json): it authorizes the unchanged first-person sentence and sends the changed legal section back for revalidation.

See [the normative v0.1 specification](spec/EVIDENCE-BOUND-RUNTIME-SPEC-v0.1.md), [the experimental v0.2 draft](spec/EVIDENCE-BOUND-RUNTIME-SPEC-v0.2-DRAFT.md), [the BC legal Cantonese benchmark](benchmarks/bc-legal-cantonese/README.md), [the upstream adoption ledger](docs/references/UPSTREAM-ADOPTION-LEDGER.md), and [the real legal fail-fast forward test](docs/qa/REAL-LEGAL-FAIL-FAST-FORWARD-TEST-2026-08-22.md).

Legal semantic checking is calibrated for accurate advocacy, not academic
neutralization. See [BC legal advocacy verification
policy](docs/policy/BC-LEGAL-ADVOCACY-VERIFICATION.md). Drafting, uplift, and final
verification share one content-addressed retrieval layer rather than rereading the
corpus; see [shared evidence packets](docs/architecture/SHARED-EVIDENCE-PACKETS.md).
