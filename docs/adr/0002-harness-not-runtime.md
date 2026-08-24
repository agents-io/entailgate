# ADR 0002: Entailgate is an AI harness, not a deterministic runtime

Status: accepted

## Context

The first Entailgate experiment treated verification as a local software runtime. It introduced schemas, hashes, exact-match checks, replay traces, and a CLI. Those mechanisms can record file identity or catch narrow mechanical errors. They cannot decide whether a source fairly supports a proposition, whether context changes an inference, or whether an answer stays within the meaning of arbitrary supplied material.

The intended product is broader and simpler: a reusable layer that regulates how an AI compares any output with any bounded set of sources. Legal authorities and business-owner knowledge are two applications of the same reasoning contract.

## Decision

The Entailgate core is a text-only AI harness.

It defines:

- the Subject, Source Box, and Policy inputs;
- occurrence-level Subject mapping plus sealed claim census and completeness review;
- reusable source maps and claim-scoped evidence packets;
- semantic verdicts and adversarial review;
- a closed-denominator ledger-coverage rule;
- audit, repair, and uplift modes;
- a fixed human-readable report.

The harness requires no executable verification code. Domain behaviour belongs in optional textual profiles.

## Consequences

- Existing deterministic runtime code is frozen as a historical experiment.
- No hash, parser, schema validator, regex, or test runner may be presented as the semantic verifier.
- The quality of Entailgate depends on capable models, clear source boundaries, independent review, realistic benchmark cases, and honest abstention.
- `100% ledger coverage` describes complete disposition of a closed Subject occurrence and material-claim ledger. It does not promise infallibility or convert missing sources into support.
- The same harness can govern legal drafting, customer service, booking, research, policy, and other source-bound AI work without changing the core protocol.
