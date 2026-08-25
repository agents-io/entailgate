# Entailgate

**A source-bound verification harness for AI.**

Entailgate is a set of instructions for an AI to check its output against a bounded box of sources. It is generic: the same harness can review a legal submission, a customer-service answer, a booking response, a policy summary, a research draft, or any other source-dependent text.

It requires no verification script. The AI does the reading and semantic judgment. The harness specifies the required procedure, evidence standard, uncertainty handling, and report.

```text
Subject to verify + Source Box + Policy
                    |
                    v
       occurrence map + sealed claim census
                    |
                    v
       shared source map and evidence packets
                    |
                    v
      semantic verification + adversarial audit
          + mandatory No-Diversion Gate
                    |
                    v
      required outcome: closed ledger or BLOCKED
```

## Defects the harness is designed to detect or reduce

- invented sources or citations;
- a real source cited for a proposition it does not support;
- altered quotations, numbers, dates, identifiers, or attributions;
- conditions, exceptions, negation, or context being silently dropped;
- an AI using its memory as if it appeared in the supplied material;
- a confident `PASS` when a source is missing or unreadable;
- a second reviewer checking only the first reviewer’s conclusions;
- wording that invites a facially responsive side answer while leaving the core issue unresolved;
- a response to a substituted actor, event, test, time period, or remedy being treated as an answer to the issue actually raised;
- repeated full-source reading while still requiring original-source checks at decisive passages.

## The contract

Each run supplies three things:

1. **Subject** — the answer, draft, plan, or action proposal being checked.
2. **Source Box** — the exact material allowed to support the Subject.
3. **Policy** — the domain, risk, support standard, date, source quality, confidentiality, output audience, and whether the run is audit-only, repair, or uplift.

The harness then separates the work:

1. An occurrence map accounts for every part of the Subject, then a claim census and sealed completeness reading extract material source-dependent claims.
2. A source mapper prepares one shared evidence packet for each claim.
3. A primary verifier judges every claim against the underlying passages, not against a summary verdict.
4. For high-risk work, a sealed independent semantic verifier repeats the mapping and verdict work in an isolated context before seeing the primary review.
5. An adversarial reviewer searches for omitted claims, contrary passages, invalid exclusions, missing context, and overreach.
6. Whenever the Subject asks a recipient for an answer, decision, reason, correction, action, or remedy, a No-Diversion reviewer finds exact wording that lets the recipient answer a side issue instead of the required outcome.
7. A release review checks the closed ledger and applies status precedence.

The default is **audit only**. Entailgate reports the defects before changing the Subject. Repair and advocacy uplift are separate, explicit modes.

The No-Diversion Gate is mandatory for recipient-facing requests. The run card must name the intended reader, core issue IDs, and non-displaceable outcomes. A draft cannot be called release-ready while a concrete diversion route remains. The same gate can protect a legal demand, customer escalation, policy request, or business instruction from a facially responsive non-answer.

## What 100% means

Entailgate uses a strict procedural definition. The percentage is **ledger coverage**, not a claim of infallible discovery or universal truth:

> Every addressable part of the Subject is classified, every material claim found by either review has an evidence mapping and terminal verdict, and every required enumerated source boundary is fully inspected.

A run is not 100% covered merely because every citation has a link. It is not 100% covered if one sentence is unclassified, one claim is unreviewed, one quotation lacks its passage, or one supplied source silently disappears. `SOURCE_UNAVAILABLE`, `NOT_FOUND`, `OUTSIDE_SOURCE`, and `UNCERTAIN` are honest terminal findings, but they block the label `VERIFIED`.

This is a reported process metric, not a claim that an AI can guarantee universal truth.

A deliberately narrow review must say so. For example, a legal run that verifies external authorities but does not review private factual evidence may return `SCOPE_VERIFIED: external legal authorities`; it may not label the whole document `VERIFIED`.

## Limits

Entailgate is an instruction protocol, not an enforcement or security boundary. It cannot guarantee that one model found every claim, resisted prompt injection, authenticated a source, or independently corrected its own prior judgment. High-risk use requires trusted Source Box construction, documented reviewer and context separation, and a semantic reviewer that did not author the Subject. Missing independence or an open denominator must be reported as `BLOCKED`, not hidden behind a percentage.

## Use it

Give an AI:

- this repository’s [`SKILL.md`](SKILL.md);
- a completed [`harness/run-card.md`](harness/run-card.md);
- the Subject;
- the Source Box;
- a short Policy, for example: `audit only; high risk; use only supplied sources; report before editing`.

For legal work, also load [`profiles/legal-advocacy.md`](profiles/legal-advocacy.md). For a source-bound business assistant, load [`profiles/business-knowledge.md`](profiles/business-knowledge.md).

The required output is defined in [`harness/report-format.md`](harness/report-format.md).

## Repository map

```text
SKILL.md                         generic AI harness
harness/run-card.md             fill-in contract for each review
harness/report-format.md        fixed human-readable audit format
profiles/legal-advocacy.md      optional legal verification and uplift policy
profiles/business-knowledge.md  optional owner-source and action policy
docs/adr/0002-harness-not-runtime.md
                                 reason for the text-only product direction
```

## Historical runtime

The TypeScript code, schemas, and v0.1/v0.2 runtime specifications in this repository are a frozen earlier experiment. They explored file integrity, replay, and deterministic gates. They are not required by Entailgate’s current harness and must not be confused with semantic verification.

The public repository is [agents-io/entailgate](https://github.com/agents-io/entailgate).
