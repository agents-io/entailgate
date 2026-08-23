# Upstream adoption ledger

Snapshot date: 2026-08-22 (America/Vancouver)

These repositories were shallow-cloned and inspected locally. No upstream source code has been copied into the runtime. We adopt small design patterns and test ideas, preserving a clean implementation and avoiding dependency risk.

| Upstream | Inspected commit | License | Pattern taken | Decision |
|---|---|---|---|---|
| [Thormatt/orc](https://github.com/Thormatt/orc) | 61248d94d238b0bba8c81d85b930b96bf2a1dec4 | MIT | Citation-ID closure; downgrade a supported verdict with no valid citations; immutable traces; replay; corpus versioning; adversarial fake-ID tests | Adopt concepts and regression tests. Do not depend on it: no package release, very small maintainer surface, and its semantic benchmark bundle is not independently reproducible from the repo. |
| [amazon-science/RefChecker](https://github.com/amazon-science/RefChecker) | 1df1b25cee792ba2b171302e31ca4f768bd67703 | Apache-2.0 | Atomic claim extraction; sentence attribution; Entailment / Neutral / Contradiction / Abstain; strict aggregation | Adopt claim/result vocabulary and later build an extraction adapter. Do not use triplets as the legal canonical representation because modal language, exceptions, scope, and remedies can be lost. |
| [Liyan06/MiniCheck](https://github.com/Liyan06/MiniCheck) | b58b9fa69acbd1015ec970fa65dd752413a053d2 | Apache-2.0 code | Small document-to-claim support checker behind a simple score interface | Candidate semantic plugin and benchmark baseline. Never treat its score as deterministic or presume BC-law/Cantonese calibration. Model-card licenses must be checked separately from code. |
| [NVIDIA-NeMo/Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) | e961f810ca266e3738c4815df8712a35a71dc7fa | Apache-2.0 | Distinct input, retrieval, dialog, execution, and output rails; pluggable grounding checks | Adopt the separation of rails, especially text versus action. Do not import the framework into the small core. |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | a2e0d4cfd3118352d321c1c84bdeba17d4a201bc | Apache-2.0 | Citation-faithfulness and claim-level eval schemas; explicit thresholds and reasons | Use for offline comparative evaluation later. Do not use a single LLM metric as a production pass. |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 679e7ecb64a2e09042b009b549b81dc0d0b983bb | MIT | Declarative test matrices, deterministic assertions beside model-graded assertions, CI regression, adversarial suites | Adopt the eval-suite shape. Integrate as a dev/eval tool later, not runtime dependency. |

## Explicitly rejected

- maxhightower/vorpal-ai: close architecture, but proprietary and insufficiently independently maintained or tested for incorporation.
- Non-commercial verifier weights: excluded from a potentially commercial kernel unless separately licensed.
- LLM-as-judge majority vote as the root verifier: correlated failure is not independent evidence.
- Hidden chain-of-thought storage: traces store inputs, evidence IDs, structured outputs, versions, and concise findings, not private reasoning.

## Attribution rule

If code is later copied or substantially adapted rather than independently implemented, add its required copyright and license notice at that time. This ledger alone is not a substitute for license compliance.
