# BC legal Cantonese verification benchmark roadmap

Status: **proposal and synthetic scaffold; blocked as a real performance benchmark**
Primary safety metric: **false-pass rate**
Jurisdiction: **British Columbia, Canada**

## Objective

Measure whether an evidence-bound system can verify Cantonese and Cantonese-English legal propositions against the exact authority, passage, jurisdiction, and effective date supplied to it.

The benchmark must reward safe support and useful coverage separately. A system does not earn credit merely for abstaining on every item, and it must never convert missing semantic verification into a pass.

The nine seed records are invented software fixtures. They are **not statements of British Columbia law, not legal advice, and not legal ground truth**. No material from a private `Evidence` repository is included or permitted.

## Unit of evaluation

Each JSONL item binds:

- one atomic Cantonese, English, or code-switched claim;
- its displayed citation and locator;
- one evidence chunk with authority tier, jurisdiction, retrieval time, and effective interval;
- a frozen authority/document-family group and split;
- a binary safety gate (`PASS` or `ABSTAIN`), a support status, error tags, and rationale;
- provenance establishing whether the item is synthetic, public-primary, or redacted with permission.

The normative schema is `benchmarks/bc-legal-cantonese/schema/item.schema.json`.

## Seed coverage

The synthetic v0.1 seed contains one item for each required phenomenon:

1. exact quotation;
2. supported paraphrase;
3. wrong statutory section;
4. authority outside its effective date;
5. fabricated citation;
6. omitted exception;
7. remedy overreach;
8. Cantonese-English code-switching;
9. innocuous punctuation or wording edits.

This is contract coverage, not statistical coverage. Nine synthetic items cannot establish real-world accuracy.

The visible `test` labels in the synthetic seed are pipeline fixtures, not a held-out set. Before real evaluation, publish an unlabeled test-input artifact and keep its gold labels in an evaluator-only store outside the development repository. The current exception-omission fixture also changes modal force; replace it in a new immutable seed version before calculating per-error metrics.

## Data acquisition and lineage

### Permitted sources

- Published statutes and regulations from official repositories.
- Published WorkSafeBC policy and Review Division decisions.
- Published WCAT and court decisions.
- Public official practice materials.
- Expert-created adversarial variants derived from public material, with the original source hash retained.
- Redacted records only where permission, redaction method, and provenance are documented.

### Prohibited sources

- Any private `Evidence` repository.
- Unredacted claims, medical records, employment records, privileged communications, or third-party identifiers.
- Search snippets, model answers, headnotes, or summaries used as substitutes for the complete authority.

Raw source bytes and raw annotations are immutable. A correction creates a new versioned file and manifest. Every public item records a URI, retrieval timestamp, SHA-256, authority tier, jurisdiction, and effective interval. Transform stages assert record count, null rate, allowed values, hash closure, and one-to-one item lineage.

## Annotation protocol

1. Freeze the source snapshot and effective date before drafting variants.
2. Divide source documents into atomic passages without moving exceptions away from their operative rule.
3. Draft Cantonese claims in plain written Chinese; introduce colloquial Cantonese or English code-switching only for an assigned phenomenon.
4. Obtain two independent legal-language annotations for every non-synthetic item.
5. Adjudicate disagreements without exposing test labels to system developers.
6. Record both the gate label and the precise error taxonomy. Do not reduce `PARTIAL`, version mismatch, or a missing citation to generic unsupported text.
7. Measure inter-annotator agreement, but treat agreement as process evidence rather than proof of legal correctness.

Any item whose complete authority or material context cannot be reopened remains excluded or labelled unresolved; it cannot become a passing gold item.

## Deterministic leakage-safe splits

Use the frozen manifest in `benchmarks/bc-legal-cantonese/splits/`.

- The group key is `authority_family::document_family`.
- No authority family may cross splits.
- No document family, decision series, policy-version chain, translation, or near duplicate may cross splits.
- A new document in an existing authority family inherits the existing split.
- A wholly new family is assigned with the documented SHA-256 rule and fixed seed `20260822`, then frozen.
- Target proportions for the full corpus are 60% train, 20% dev, and 20% test by groups, with class and language balance checked after grouping rather than achieved by moving related items.

This is intentionally stricter than random row splitting. Random row or passage splitting is prohibited because it would leak authority wording and document templates.

## Baseline before models

`EXP001-rule-baseline` performs only three deterministic checks:

1. cited source and chunk IDs match the supplied evidence;
2. the evidence is effective on the claim's as-of date;
3. the complete claim is quote-only and that declared quote occurs after Unicode, quote-mark, and whitespace normalization.

It passes no wrapper proposition or unverified semantic paraphrase. This prevents a genuine short quote from laundering an unsupported surrounding claim. The baseline establishes the safety/coverage floor before any embedding, language model, translation, retrieval, or reranking experiment.

## Metrics and uncertainty

Report counts and 95% confidence intervals with every rate.

| Metric | Definition | Role |
|---|---|---|
| False-pass rate | `PASS` on an expected `ABSTAIN` item | Primary safety metric |
| Coverage | Fraction of all items receiving `PASS` | Utility constraint |
| Safe-pass precision | Expected-pass items among predicted passes | Reliability of released output |
| Abstention rate | Fraction receiving `ABSTAIN` | Safety/utility trade-off |
| False-abstain rate | `ABSTAIN` on an expected `PASS` item | Over-conservatism |
| Decision accuracy | Correct binary gate decisions | Secondary summary only |
| Error-specific recall | Correctly localized detection by critical error tag; generic abstention does not count | Failure localization |
| Language gap | Metric difference across English, Cantonese, and code-switch profiles | Cross-lingual parity |

Use Wilson 95% intervals for binomial rates. For the real corpus, add a fixed-seed cluster bootstrap over authority families so repeated passages from one authority do not create falsely narrow intervals. For predeclared language/error comparisons use Holm correction; do not choose a correction after reading results.

Small-sample seed output is descriptive. Sensitivity output must include a deterministic 1,000-resample bootstrap, while Wilson intervals remain authoritative for a zero-event false-pass rate.

## Proposed acceptance gates

These thresholds are **proposals, not achieved results**:

- Overall false-pass point estimate: **0%**.
- Overall false-pass Wilson 95% upper bound: **≤5%**.
- Each critical error family—fake citation, wrong section, ineffective source, omitted exception, and remedy overreach—has **0 observed false passes** and a Wilson 95% upper bound **≤10%**.
- Pass-worthy coverage (expected-pass items receiving `PASS`): point estimate **≥80%** and Wilson 95% lower bound **≥70%**. Overall coverage remains `PASS / all items` and is reported separately.
- Safe-pass precision: point estimate **100%** and Wilson 95% lower bound **≥95%**.
- Exact-quote and citation-closure deterministic tests: **100%**.
- Absolute false-pass gap between Cantonese/code-switch and English strata: **≤2 percentage points**, with the cluster-bootstrap interval reported.
- No private-evidence, provenance, hash, schema, or split-leakage failure.

With zero observed false passes, at least **73 must-abstain items** are required before the ordinary 95% Wilson upper bound falls to 5%; at least **35 items per critical error family** are required for its upper bound to fall to 10%. These sample-size calculations are protocol requirements, not performance claims.

If the false-pass gate fails, the release fails regardless of average accuracy. If safety passes but coverage fails, the result is a safe research prototype, not an accepted verifier.

## Experiment roadmap

### EXP001 — deterministic baseline

Hypothesis: citation closure, date binding, and normalized quote matching provide a zero-semantic safety baseline with limited coverage.

### EXP002 — cross-lingual semantic checker

Hypothesis: a pinned semantic checker improves supported-paraphrase and code-switch coverage without increasing false passes. Tune only on train/dev.

### EXP003 — exception and remedy adversaries

Hypothesis: explicit scope features improve detection of omitted exceptions and remedy overreach. Every feature must pass the prediction-time leakage question: would this information exist in the supplied evidence at verification time?

### EXP004 — temporal policy graph

Hypothesis: version-aware retrieval reduces outdated-authority false passes. Compare against EXP001 and EXP002 on the same frozen groups.

### EXP005 — locked test

Run once through an evaluator that developers cannot use to read gold labels, after the decision rule, prompts, checker version, thresholds, and multiple-comparison plan are frozen. A substantive change creates a new experiment and does not reuse the test result as validation.

Each experiment directory records one hypothesis, configuration, fixed seeds, package versions, source and split hashes, predictions, metrics with confidence intervals, status, failures, and lessons learned.

The immutable v0.1 synthetic seed cannot estimate these gates: it has no English-only stratum, visible test labels, and its nominal exact-quote PASS row contains wrapper text that the quote-only runtime correctly rejects. A new seed version must fix those fixture-design defects rather than modifying v0.1.

## Completion criteria for a real benchmark

- Public/redacted lineage review complete with no private content.
- At least 73 must-abstain items overall and 35 per critical safety family.
- Sufficient expected-pass items to estimate the proposed coverage lower bound.
- Authority-, document-, version-, and near-duplicate grouping independently audited.
- Dual annotation and adjudication complete.
- EXP001 recorded before any model experiment.
- Test labels held back until the release candidate is frozen.
- All proposed acceptance gates either met or explicitly reported as failed.
