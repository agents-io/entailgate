# BC legal Cantonese verification benchmark

This scaffold evaluates whether an evidence-bound verifier safely checks Cantonese and Cantonese-English legal claims against British Columbia authorities.

The included nine-item seed is **synthetic and not legal ground truth**. It contains no private `Evidence` content and must never be cited in a real matter.

The seed labels—including rows named `test`—are visible. Those split names test the pipeline contract only; they are **not a held-out performance test**. A real benchmark must keep test gold in an evaluator-only store outside the development repository. No product-performance claim may be made from this seed. The seed also has no English-only row, so it cannot measure an English/Cantonese language gap.

## Layout

```text
schema/item.schema.json                 JSONL item contract
data/raw/synthetic-seed-v0.1.jsonl      immutable synthetic seed
data/raw/manifest-v0.1.json              raw checksum and provenance
splits/splits-v0.1.json                  frozen grouped assignments
taxonomy/error-taxonomy-v0.1.json        safety and analysis errors
scripts/validate-schema.py               Draft 2020-12 validation
scripts/validate.mjs                     lineage, leakage, and invariant checks
scripts/assign-splits.mjs                connected-component future split assignment
scripts/run-baseline.mjs                 deterministic baseline plus CIs
experiments/                              one-hypothesis experiment records
```

## Validation

From the repository root:

```bash
uv run --with jsonschema==4.26.0 \
  python benchmarks/bc-legal-cantonese/scripts/validate-schema.py
node benchmarks/bc-legal-cantonese/scripts/validate.mjs
node benchmarks/bc-legal-cantonese/scripts/assign-splits.mjs --self-test
node benchmarks/bc-legal-cantonese/scripts/run-baseline.mjs
```

The first command validates every JSONL item against the published JSON Schema. The second verifies the raw SHA-256, required phenomena, synthetic provenance, split manifest, error taxonomy, and absence of authority-, document-, or group-family leakage.

## Data discipline

- Treat every file under `data/raw/` as immutable. Corrections create a new version and checksum manifest.
- Add only public primary-source data or records redacted with documented permission.
- Never include private claim files, medical records, privileged communications, employment records, personal identifiers, or material from a private `Evidence` repository.
- Preserve source bytes outside the prompt-facing JSONL. Record a source URI, SHA-256, retrieval time, authority tier, jurisdiction, and effective interval.
- Use the half-open effective interval `[effective_from, effective_to)`; a null end date means currently effective within the fixture.

## Leakage control

Split assignment is frozen before model evaluation. No `authority_family`, `document_family`, or combined `group_id` may cross train, dev, and test. New data is grouped as connected components across both family dimensions. A component touching conflicting frozen splits is rejected for adjudication rather than hashed into a split. A wholly new component is assigned from the frozen seed and its sorted canonical component ID. Entire related decision series, policy versions, translations, and near-duplicate passages must remain together.

## Evaluation order

1. Validate schema, provenance, hashes, and grouped splits.
2. Run the deterministic citation/date/quote baseline.
3. Freeze the metric definitions and multiple-comparison plan.
4. Develop semantic or cross-lingual systems on train/dev only.
5. Evaluate the locked system once on test.

False-pass rate is the primary safety metric: `predicted PASS` when the expected gate requires `ABSTAIN`. Always report its numerator, denominator, and Wilson 95% confidence interval. Also report overall coverage, pass-worthy coverage, safe-pass precision, abstention rate, false-abstain rate, decision accuracy, error-family slices, and language-profile slices. Error-specific detection counts only a reason mapped to that error; a generic safe abstention is reported separately and is not credited as failure localization.

The legal benchmark must also measure **advocacy false rejects**: claims that are a
fair and favourable reading of an authority but are downgraded only because a checker
prefers a more defensive formulation or volunteers non-dispositive adverse context.
Evaluation must distinguish `held/found` from `supports/illustrates/involved`, while
allowing the latter formulations their ordinary inferential breadth. The gold label
must judge the proposition actually asserted under the [BC legal advocacy verification
policy](../../docs/policy/BC-LEGAL-ADVOCACY-VERIFICATION.md).

The benchmark must separately score uplift recall: among gold `STRENGTHEN` items, how
many supported helmets or underclaims the system surfaces. A missed uplift is not a
false factual pass and must not contaminate the integrity metric. Report it as
`MISSED_ADVOCACY_UPLIFT`. Also measure unsafe uplift: a proposed stronger sentence
that would fail the normal evidence gate. Unsafe uplift is a critical false-pass
variant because strength never overrides source boundaries.

The roadmap defines proposed acceptance thresholds. Seed results are diagnostic only; they are not achieved product claims. The v0.1 seed also contains two known fixture defects: the exception-omission row changes modality as well as omitting an exception, and the nominal exact-quote PASS row wraps the quote in extra Chinese text that violates the runtime's quote-only contract. Those rows cannot support the intended per-error/quote conclusions and must be replaced in a new immutable seed version.
