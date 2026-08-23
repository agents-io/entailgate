# Entailgate

**The fail-closed evidence gate for AI claims and actions.**

Entailgate checks whether an AI-generated claim is actually supported by the
sources it cites. It evaluates a versioned request and evidence snapshot, runs
deterministic checks first, and binds any semantic review to the exact claim,
evidence content, and checker version. Adapters that own source bytes can add
local snapshotting and re-hashing before the generic gate runs.

It is a reusable verification runtime, not another chatbot and not a truth
oracle. Legal assistants, customer-service agents, booking agents, and other AI
products can share the same core while keeping their own source and policy
adapters separate.

> Retrieval finds possible evidence. Entailgate records exactly what supported
> each claim, rejects broken bindings, and refuses to turn uncertainty into a
> pass.

## Why Entailgate exists

An AI can quote a source that does not exist, cite the right document for the
wrong proposition, copy a number incorrectly, or make a confident claim outside
the supplied material. Asking a second model “is this correct?” can repeat the
same failure without leaving an auditable proof trail.

Entailgate makes verification a runtime contract:

```text
draft + locked sources + policy
             │
             ▼
      material claim inventory
             │
             ▼
 deterministic checks ── citation closure, exact quotes, fields, maths,
             │            jurisdiction, dates, authority and action policy
             ▼
  claim-scoped evidence packets
             │
             ▼
 pinned semantic checker or human attestation
             │
             ▼
       typed decision + blockers + replayable trace
```

The expensive checker sees only the material claim and its locked evidence
packet. Unchanged claims can reuse an attestation only when the current policy
gate still accepts every binding; changed claims, sources, citations, dates,
numbers, actors, or remedies are checked again.

## What it checks

- Every cited source and chunk belongs to the frozen retrieval set.
- Exact-quotation claims contain only text that occurs in the cited chunk.
- Structured values equal the cited fields and calculations reproduce from
  evidence-bound operands.
- Source dates, jurisdiction, authority tier, and policy scope are compatible
  with the claim.
- Semantic attestations are pinned to the claim, draft, evidence, snapshot, and
  checker identities; the current policy separately decides whether to trust
  them.
- High-risk work cannot pass with an incomplete material-claim inventory.
- Tool actions pass a separate allowlist, argument, idempotency, binding, and
  confirmation gate.
- Every verification run can produce an owner-only, hash-bound trace that
  replays the stored request and evidence content. The generic command does not
  reopen the original draft path; source-owning adapters perform that check.

## What it deliberately does not claim

- A hash proves identity, not meaning or truth.
- Successful PDF/OCR extraction does not prove transcription accuracy.
- A retrieved authority card is not a semantic verdict.
- Automatic claim extraction is conservative and does not assert complete
  coverage.
- A model attestation is trusted only under an explicit checker policy; an
  unpinned checker remains `UNCHECKED`.
- Reusing one unchanged claim never releases an entire revised document.

These boundaries are part of the product. Unknown, incomplete, stale, or
ambiguous inputs stop at `BLOCK`, `ABSTAIN`, or human review.

## Quick start

Entailgate currently ships as a public source alpha and requires Node.js 20 or
newer.

```bash
git clone https://github.com/agents-io/entailgate.git
cd entailgate
npm ci
npm test
npm link

entailgate --help
```

The legacy `ebr` binary remains as an alias while the project adopts the new
name.

Run the synthetic passing example:

```bash
entailgate verify \
  --request examples/passing-request.json \
  --trace-dir /tmp/entailgate-traces
```

For `verify`, `legal`, and `dogfood verify`, exit code `0` means the decision is
`PASS` and every proposed action is `ALLOW`. Utility commands use exit code `0`
only to mean the command completed successfully.

## Core workflows

### Extract and compare material claims

```bash
entailgate claims extract --input /absolute/path/to/draft.txt

entailgate claims diff \
  --before /absolute/path/to/old-draft.txt \
  --after /absolute/path/to/new-draft.txt \
  --trace-dir /tmp/entailgate-revision-plans
```

The revision planner distinguishes `REUSE`, `REVERIFY`, `ADDED`, `REMOVED`, and
`UNCERTAIN`. A small prose edit does not force every source to be read again, but
uncertain wording cannot silently inherit an earlier pass.

### Ingest local sources

```bash
entailgate ingest --input /absolute/path/to/source.pdf
```

Native PDF extraction is the default. Suspiciously sparse text returns
`OCR_REQUIRED`; OCR happens only when explicitly requested:

```bash
entailgate ingest \
  --input /absolute/path/to/source.pdf \
  --ocr perform
```

The result includes source, page, and extraction provenance. PDF quotations
still require visual comparison with the cited page.

### Route and lock external legal authorities

The BC legal adapter first isolates external legal claims so private case facts
stay out of the authority-checking path by default:

```bash
entailgate legal scope --draft /absolute/path/to/frozen-draft.md
```

Cache one already-obtained authority by content hash and bind its declared legal
identity separately:

```bash
entailgate legal cache-source \
  --source /absolute/path/to/authority.pdf \
  --cache-dir /absolute/path/to/private-authority-cache \
  --canonical-id BCSC-2024-994 \
  --title "Fixture v Example" \
  --issuer "Supreme Court of British Columbia" \
  --class adjudicative_decision \
  --tier primary \
  --jurisdiction BC
```

Cached extraction never carries a semantic verdict. Authority authentication,
status/currentness checking, contextual packet expansion, and the final
high-reasoning checker remain separate gates.

### Run a private legal dogfood workspace

```bash
entailgate dogfood init \
  --draft /absolute/path/to/draft.md \
  --evidence-dir /absolute/path/to/evidence \
  --workspace /absolute/path/to/private-workspace

entailgate dogfood status \
  --workspace /absolute/path/to/private-workspace

entailgate dogfood verify \
  --workspace /absolute/path/to/private-workspace \
  --trace-dir /absolute/path/to/private-traces
```

The workspace snapshots each input once, stores private files with restrictive
permissions, refuses symbolic-link evidence, enforces file and byte limits, and
reuses the same ingestion output for later passes. It begins blocked: authority
classification, complete coverage, and human review are never filled in on the
operator's behalf.

Keep dogfood workspaces outside this repository. They contain draft snapshots,
host paths, and extracted evidence text.

## Architecture

The generic kernel contains no BC-specific legal rule and no booking-specific
workflow. Product adapters supply domain policy, retrieval, source
classification, and checker trust.

```text
@agents-io/entailgate
├── generic verification kernel
│   ├── closed schemas and deterministic validators
│   ├── claim extraction and delta planning
│   ├── evidence ingestion and provenance
│   ├── semantic attestation binding
│   ├── action policy
│   └── trace writing and replay
└── adapters
    ├── BC legal verification
    └── business-assistant verification
```

The runtime is a kernel rather than a prompt hook so the same frozen artifacts
can be checked from a CLI, CI job, API service, or agent workflow. See the
[architecture decision](docs/adr/0001-kernel-not-hook.md).

## Project status

| Area | Status |
|---|---|
| Deterministic v0.1.1 verification gate | Implemented |
| Hash-bound traces and replay | Implemented |
| Claim extraction and selective re-verification | v0.2 alpha |
| Local PDF/OCR ingestion | Alpha |
| BC legal scope router and authority cache | Internal alpha |
| Automatic authority retrieval and authentication | Planned |
| Context-expanding semantic legal checker | Planned |
| BC legal Cantonese benchmark | Scaffolded |
| Business-assistant adapter | Planned |

The repository is ready for internal dogfooding, adversarial fixtures, and
adapter development. It is not yet a production release gate for unattended
high-risk decisions.

## Documentation

- [Normative v0.1 specification](spec/EVIDENCE-BOUND-RUNTIME-SPEC-v0.1.md)
- [Experimental v0.2 specification](spec/EVIDENCE-BOUND-RUNTIME-SPEC-v0.2-DRAFT.md)
- [Hash is a seal, not a legal checker](docs/architecture/HASH-IS-A-SEAL.md)
- [Shared evidence packets](docs/architecture/SHARED-EVIDENCE-PACKETS.md)
- [External legal authority pipeline](docs/architecture/EXTERNAL-LEGAL-AUTHORITY-PIPELINE.md)
- [Selective-verification roadmap](docs/roadmap/V0.2-SELECTIVE-VERIFICATION-ROADMAP.md)
- [BC legal advocacy verification policy](docs/policy/BC-LEGAL-ADVOCACY-VERIFICATION.md)
- [BC legal Cantonese benchmark](benchmarks/bc-legal-cantonese/README.md)
- [Real legal fail-fast forward test](docs/qa/REAL-LEGAL-FAIL-FAST-FORWARD-TEST-2026-08-22.md)

## Design rule

Entailgate should make weaker models safer by narrowing what they can see, what
they may claim, and what counts as support. It should spend tokens on disputed,
material meaning—not on rereading unchanged prose or pretending every checksum
is a legal question.
