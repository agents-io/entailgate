# Evidence-Bound Runtime instructions

This repository is the generic verification kernel. Domain behavior belongs in adapters or policy files.

## Invariants

- The core must work without a network connection or an LLM.
- A source or chunk ID outside the request's retrieved set can never support a claim.
- Exact, structured, derived, and semantic support are distinct assurance classes.
- Missing semantic verification is `UNCHECKED`, never an inferred pass.
- Text verification never authorizes an external action. Actions use a separate typed gate.
- High-risk incomplete claim coverage can never pass. A known dispositive contradiction still takes precedence and fails fast to `ABSTAIN`.
- Every result is tied to canonical input and source hashes and can be replayed.
- A whole-document hash is an audit identity, not a semantic verdict and not a reason for blanket claim re-verification.
- Automatic claim extraction is incomplete unless a separately validated coverage process proves otherwise.
- Raw legal, employment, medical, privileged, confidential, or third-party evidence stays local.

When a public schema changes, update the TypeScript types, JSON schemas, spec, examples, and tests in the same change.
