# Entailgate audit report

Use this human-readable format. Keep the evidence concise but sufficient for another reviewer to reproduce each verdict.

## Run summary

- **Mode:** `AUDIT | REPAIR | UPLIFT`
- **Policy:** domain, risk, support standard, relevant date, source quality, confidentiality, and output audience
- **Subject:** exact boundary, version, author, name, and supplied locator
- **Source Box:** list of supplied sources
- **Whole Source Box accessible:** `YES | NO`
- **Document status:** `VERIFIED | SCOPE_VERIFIED | NEEDS_REVISION | BLOCKED`
- **Review assurance:** `SINGLE_MODEL_REVIEW | SEALED_INDEPENDENT_AI | INDEPENDENT_HUMAN_REVIEW`
- **Denominator:** `CLOSED | OPEN`
- **Subject-occurrence coverage:** `accounted occurrences / total occurrences (percentage only when CLOSED)`
- **Material out-of-scope occurrences:** count and named classes
- **Claim-ledger coverage:** `reviewed / total inventoried material claims (percentage)`
- **Required-source coverage:** `fully inspected / total required sources (percentage)`
- **Profile-item coverage:** `reviewed / total applicable policy-only items (percentage or N/A)`
- **No-Diversion Gate:** `REQUIRED | NOT_APPLICABLE`
- **No-Diversion status:** `PASSED | NEEDS_REVISION | NOT_APPLICABLE | BLOCKED`
- **Diversion-item coverage:** `reviewed / total applicable triggers (percentage or N/A)`
- **Verdicts:** count of each verdict
- **Action state:** `NO ACTION REQUESTED | PROPOSED ONLY | EXTERNAL AUTHORIZATION REQUIRED | EXECUTION RECEIPT PRESENT`

`Action state` records evidence state only. Entailgate never authorizes or executes the action. Quote only the minimum source text needed to explain a verdict, consistent with the Policy’s confidentiality and output audience.

## Reviewer provenance

| Role | Reviewer or agent | Subject author? | Context | Saw earlier work before sealing own? | Underlying-source access |
|---|---|---|---|---|---|
| Subject author | ... | YES | ... | ... | ... |
| Claim Census | ... | YES / NO | same / isolated | YES / NO | FULL / SCOPED / NONE |
| Sealed Completeness reviewer | ... | YES / NO | same / isolated | YES / NO | FULL / SCOPED / NONE |
| Primary Semantic Verifier | ... | YES / NO | same / isolated | YES / NO | FULL / SCOPED / NONE |
| Sealed Independent Semantic Verifier | ... | NO | isolated | NO | FULL / SCOPED |
| Adversarial reviewer | ... | YES / NO | same / isolated | YES / NO | FULL / SCOPED / NONE |
| No-Diversion reviewer | ... | YES / NO | same / isolated | YES / NO | FULL / SCOPED / NONE |

Use `SEALED_INDEPENDENT_AI` only when the independent semantic reviewer worked in a separate context, did not author the Subject, and completed its own occurrence map, claim census, source inspection, and provisional verdicts before seeing the first reviewer’s work. A census-only or adversarial pass does not qualify. Otherwise use `SINGLE_MODEL_REVIEW`. A high-risk `VERIFIED` or `SCOPE_VERIFIED` result requires the qualifying independent semantic row.

## Subject coverage map

| Occurrence | Exact text and locator | Classification | Claim IDs or specific exclusion reason |
|---|---|---|---|
| U-001 | ... | CLAIM / NONCLAIM_EXCLUDED / MATERIAL_OUT_OF_SCOPE | C-001 / reason |

Every heading, sentence, list item, table cell, footnote, caption, and attachment reference must appear. Repeated propositions may share evidence, but every occurrence locator remains visible. Unavailable, truncated, or unclassified content leaves the denominator `OPEN`.

## Source Box inventory

| Source ID | Exact boundary | Issuer or role | Version/date | Provenance | Format | Inspection status | Material limitations | Claim IDs |
|---|---|---|---|---|---|---|---|---|
| S-001 | ... | ... | ... | ... | ... | FULLY_INSPECTED / CLAIM_SCOPED_INSPECTION / PARTIALLY_INSPECTED / UNREADABLE / OUT_OF_SCOPE | ... | ... |

No supplied source may be omitted. List every unread or truncated part. Record the scope of searches for limiting, contrary, and superseding material. A partial, unreadable, or unauthenticated source that is necessary for an in-scope verdict blocks `VERIFIED` and `SCOPE_VERIFIED`.

`FULLY_INSPECTED` means the entire enumerated boundary was inspected. `CLAIM_SCOPED_INSPECTION` records a targeted locator or search and never enters the fully-inspected numerator. If an unread part could contain material limiting, contrary, or superseding content, use `UNCERTAIN` for the affected claim.

List and challenge every `OUT_OF_SCOPE` source. If it could materially bear on a claim, the denominator remains `OPEN`.

## Claim ledger

| ID | Exact Subject occurrence and locator | Claim type | Packet IDs | Eligible source roles, IDs, and locators | Decisive verbatim evidence | Material surrounding or contrary context | Support basis | Verdict | Semantic reviewer | Action track | Concrete release impact / required action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C-001 | ... | proposition | P-001 | official guidance; S-001, p. 4 | brief verbatim passage | ... | DIRECT / NECESSARY_INFERENCE / POLICY_PERMITTED_INFERENCE | SUPPORTED | ... | KEEP_STRONG / STRENGTHEN / MUST_FIX / OUT_OF_SCOPE / N/A | none |

Rules:

- Quote the Subject occurrence exactly and always give its locator.
- Preserve source wording exactly inside quotation marks.
- Disclose and separately check every ellipsis, bracket, translation, OCR correction, or Policy-permitted typographic normalization. A translation is not an exact quotation of the original language.
- State whether the decisive passage and required context were inspected in the underlying source. A packet summary alone cannot support `SUPPORTED`.
- `Required action` is `none` unless the Policy includes repair. It means only the smallest verification follow-up, evidence request, or text correction. It never means booking, cancelling, charging, messaging, sending, filing, or changing records.
- In a legal advocacy run, `MUST_FIX` must identify a hard defect demonstrated by the underlying source, the concrete way exposure could harm a legal premise, remedy, jurisdiction, deadline, attribution, legal force, source accuracy, or decision outcome, and the smallest effective correction. `It could be challenged` is not a concrete release impact.
- Use `KEEP_STRONG` when the wording is a fair favourable reading and the proposed criticism has no material release effect. Do not manufacture a caveat merely to populate the action column.
- Never hide a missing source behind a blank evidence cell.
- Keep separate rows for a quotation and its surrounding proposition when either can fail independently.

## Completeness audit

- Claims found in first census:
- Additional claims found in the sealed completeness audit:
- Whole Subject inspected: `YES | NO`
- All Subject occurrences classified: `YES | NO`
- All supplied sources inventoried: `YES | NO`
- All applicable profile censuses completed: `YES | NO | N/A`
- Required No-Diversion census completed: `YES | NO | N/A`
- Material Subject or source exclusions challenged: `YES | NO`
- Material out-of-scope classes and counts:
- Unresolved denominator risk:

If the Subject boundary is incomplete, `Whole Subject inspected` is `NO`, or any occurrence is unavailable, truncated, or unclassified, set `Denominator: OPEN`, report no percentage, and use `BLOCKED`.

## Material defects

List every `MUST_FIX` and `DIVERSION_MUST_FIX` item, ordered by practical risk. This includes `PARTIAL` and `CONTRADICTED` claims as well as missing-source items that cannot remain in the Subject as written. Repeat unresolved-evidence items in **Missing or unavailable evidence** and retain their exact semantic verdict; do not relabel them as proven false. For each item, state the source-demonstrated defect or exact diversion trigger, concrete release impact, and smallest correction that would cure it when repair is requested. Do not list a mere nitpick, another reasonable interpretation, omitted opposing argument, or preference for cautious prose as a defect.

## Missing or unavailable evidence

List every `NOT_FOUND`, `SOURCE_UNAVAILABLE`, `OUTSIDE_SOURCE`, and `UNCERTAIN` claim. Identify the exact document, passage, currentness check, or clarification required to resolve it.

## Adversarial audit

| Claim ID | Challenge | Original-source evidence checked | Result |
|---|---|---|---|
| C-001 | ... | source IDs and locators | verdict retained / changed |

Also report omitted claims, denominator changes, prompt-injection concerns, source-authenticity concerns, and the search scope used for limiting, contrary, or superseding material. Counts alone are insufficient.

## No-Diversion Gate

This section is mandatory whenever the Subject asks an intended recipient for an answer, decision, reason, correction, action, or remedy. If it is `NOT_APPLICABLE`, state the exact reason.

| ID | Core issue A and required outcome | Exact trigger text and locator | Substituted issue B or side answer invited (internal only) | What would remain unanswered | Concrete release impact | Track | Smallest repair |
|---|---|---|---|---|---|---|---|
| D-001 | ... | ... | ... | ... | ... | DIVERSION_MUST_FIX / KEEP_STRONG / STRENGTHEN | ... |

When a prior response exists, the fourth column records the different issue B that was actually answered. In a prospective review, it records the shortest plausible side answer invited by the draft. The prospective answer is an internal diagnostic; do not copy it into proposed outgoing text. Use `DIVERSION_MUST_FIX` only when the quoted trigger creates a concrete exit with material release impact. Keep the smallest repair tied to the same core issue and required outcome. Report `PASSED` only after the complete Subject has been scanned, every core issue has a row or an explicit no-trigger finding, and zero `DIVERSION_MUST_FIX` items remain.

## Uplift

Include only in `UPLIFT` mode.

| Track | Current text | Proposed text | Source support | Release impact or practical benefit | Reverification result |
|---|---|---|---|---|---|
| KEEP_STRONG / STRENGTHEN / MUST_FIX | ... | ... | ... | ... | ... |

Do not count `STRENGTHEN` as an error. Do not weaken `KEEP_STRONG` merely because a less favourable reading also exists. In the legal profile, include direct corrective relief and generated respondent exits in the uplift census when authorized.

## Release statement

End with one of these statements, completed with the actual counts:

- `VERIFIED: the denominator is CLOSED; [u]/[u] Subject occurrences were classified, all [n]/[n] inventoried material claims are supported, all [s]/[s] required sources were fully inspected, and the No-Diversion Gate is [PASSED | validly NOT_APPLICABLE].`
- `SCOPE_VERIFIED: the in-scope denominator is CLOSED, all in-scope claims are supported, and the No-Diversion Gate is [PASSED | validly NOT_APPLICABLE]; [m] material occurrences in [named classes] were outside the stated Policy and were not verified.`
- `NEEDS_REVISION: the denominator is CLOSED; [u]/[u] Subject occurrences and [n]/[n] inventoried material claims were reviewed; [n] material defects and [d] DIVERSION_MUST_FIX items remain.`
- `BLOCKED—COVERAGE: [r]/[t known claims] have terminal rows; the denominator remains OPEN because [reason]. No percentage is reported.`
- `BLOCKED—EVIDENCE: the denominator is CLOSED and all [n]/[n] inventoried claims have terminal rows, but claims [IDs] remain blocked because [reason].`

Do not add a generic assurance statement or imply certainty beyond the supplied Source Box.

`BLOCKED` applies to release of the Subject as written. It does not downgrade rows already marked `SUPPORTED`. In `REPAIR`, preserve supported ordinary answers and remove, correct, or defer only defective claims.
