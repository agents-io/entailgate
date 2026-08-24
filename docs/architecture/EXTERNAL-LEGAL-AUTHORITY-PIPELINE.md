# External legal authority review protocol

Status: current text-only protocol for Entailgate's default legal scope.

## Product boundary

The default legal profile verifies claims about external law and public authority:

- statutes, regulations, procedural rules, and official guidance;
- court, tribunal, review, and administrative decisions;
- legal identifiers, citations, links, quotations, pinpoints, holdings, posture, disposition, force, effective date, and treatment;
- secondary legal commentary only when the Subject actually relies on it and the Policy permits that source role.

It does not spend a second legal-verifier read on the applicant's emails, medical records, chronology, screenshots, internal evidence, grammar, or connective prose. A separate Policy may opt into private-evidence review, but that is a different scope and must remain visible in the report.

This protocol instructs an AI. It is not a scope-routing script, extraction service, cache, hash lock, schema, or CLI. Semantic claim extraction, source-role judgment, quotation review, and legal application are all model tasks governed by the harness.

## Review flow

```text
complete Subject
  -> occurrence map
  -> material legal-claim census
  -> split mixed legal/private claims
  -> enumerate or curate permitted authorities
  -> freeze one legal Source Box
  -> one source map + claim-scoped evidence packets
  -> integrity lane + optional advocacy-uplift lane
  -> final semantic verification at decisive source locators
  -> MUST_FIX / KEEP_STRONG / STRENGTHEN and release status
```

The legal source map and packets are defined in [`SHARED-EVIDENCE-PACKETS.md`](SHARED-EVIDENCE-PACKETS.md). The normative advocacy standard is [`../policy/BC-LEGAL-ADVOCACY-VERIFICATION.md`](../policy/BC-LEGAL-ADVOCACY-VERIFICATION.md).

## Scope census

Classify every Subject occurrence before verification:

- `IN_SCOPE_EXTERNAL_LEGAL`: a material claim about an external legal authority;
- `MIXED_SPLIT_REQUIRED`: legal and private propositions can fail separately and must become separate claim rows;
- `MATERIAL_OUT_OF_SCOPE`: a material private, medical, factual, or other claim excluded by the Policy;
- `NONCLAIM_EXCLUDED`: greeting, connective prose, formatting, or another occurrence with no material source-dependent assertion.

Do not use string shape as the decision rule. An uncited sentence can contain a legal proposition. A case-looking filename can contain private evidence. A sentence containing both law and fact cannot disappear merely because the legal half was extracted.

A default external-legal review may return `SCOPE_VERIFIED: external legal authorities`; it cannot label the complete mixed document `VERIFIED` when material private claims remain outside scope.

## Source curation

When all required authorities are already supplied, enumerate them in the Source Box and freeze it.

When the Policy authorizes discovery, use a separate source-curation step:

1. identify the exact missing authority or proposition;
2. search only the permitted jurisdiction, issuer, database, date range, and source classes;
3. open the underlying official or otherwise eligible source rather than relying on a search result, snippet, citation card, headnote, or another AI's summary;
4. record the search scope, provenance, relevant date, exact included boundary, and any access or authentication limit;
5. add each accepted source to the enumerated Source Box;
6. freeze the completed box before semantic verification.

A failed search supports `NOT_FOUND` only within its recorded scope. It does not prove universal nonexistence. A portal outage or unreadable document is `SOURCE_UNAVAILABLE`. Model memory may suggest where to search but never counts as evidence.

## Legal claim packet

For each legal claim, keep independently fallible fields separate:

- source identity and existence;
- neutral or report citation, section, case number, link, and pinpoint;
- exact quotation, ellipsis, bracket, translation, or OCR correction;
- actor, attribution, legal force, condition, exception, negation, and scope;
- procedural posture, actual holding, finding, and disposition;
- the proposition or analogy asserted in the Subject;
- whether that proposition advances the stated direction under a reasonable favourable reading;
- currentness or later treatment when required;
- remedy or proposed legal action and the decision-maker's authority to grant it.

An exact quotation does not prove the proposition around it. A real case does not prove the rule attributed to it. A favourable analogy does not need to be the only possible reading; it must be a fair reading a reasonable decision-maker could adopt under the Policy.

## Integrity and uplift share sources, not conclusions

The integrity lane looks only for demonstrable hard defects and records the concrete release impact before proposing correction. The uplift lane uses the same passages and locators to preserve fair strong readings, remove self-imposed limits, identify unused authority, prevent generated exits, and seek direct corrective relief where legally available.

Neither lane rereads the complete legal corpus merely because the other lane exists. Both may expand an affected packet when context is insufficient. The final verifier reopens every decisive locator and necessary context and assigns its own verdict.

A high-risk sealed independent reviewer still builds its own occurrence map, claim census, evidence choices, and provisional verdicts before reconciliation. Source reuse cannot be used to fake independence.

## Change sensitivity

Do not reopen legal sources for grammar, formatting, connective prose, or a nonmaterial pronoun change such as `me` to `I`.

Reverify an affected claim when any of these changes:

- quoted words or quotation boundaries;
- actor, attribution, date, number, identifier, section, link, or pinpoint;
- proposition, inference, condition, exception, negation, or scope;
- legal force, posture, holding, disposition, currentness, or treatment;
- ground, burden, deadline, jurisdiction, remedy, or proposed legal action;
- source identity, version, included boundary, provenance, readability, or Source Box membership.

After repairs or adopted uplift, rerun the complete Subject occurrence scan. This catches a new material claim or self-limiting sentence without forcing unrelated authorities to be read again.

## Non-negotiable failures

- Unknown or mixed scope requires classification or splitting; it cannot be silently excluded.
- Insufficient source context expands the packet or produces a blocking verdict; it never becomes support.
- A search result, snippet, headnote, citation card, packet summary, or prior model verdict cannot replace the underlying source.
- A quotation can be an exact continuous excerpt, but an undisclosed internal omission or a boundary that hides material meaning is a defect.
- `Should` cannot be attributed as `must`; non-binding authority cannot be attributed as binding precedent; allegation cannot become finding; referral cannot become entitlement.
- Ordinary forensic disagreement and another reasonable interpretation are not hallucinations.
- The verifier must not generate the respondent's escape route or convert a request for present correction into another process without authority or user choice.
- A legal-scope result never claims that the complete Subject's private facts were verified.

## Historical runtime

Any executable scope router, extraction cache, hash lock, schema, or CLI remaining in the repository is a frozen historical experiment. It is not this protocol, is not required to use Entailgate, and must not be presented as semantic verification.
