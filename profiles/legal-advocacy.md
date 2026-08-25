# Legal advocacy profile

Load this profile only for legal or formal institutional work. It changes the Policy, not the generic Entailgate workflow.

## Default scope

Verify external legal authorities only unless the user expressly expands the scope:

- statutes and regulations;
- rules, policies, and official guidance;
- cases, tribunal decisions, and administrative decisions;
- legal identifiers, links, quotations, pinpoints, holdings, procedural posture, legal force, effective date, and treatment.

Do not spend a second legal-verifier read on the user’s own emails, medical records, chronology, screenshots, internal documents, grammar, or connective prose. Split a mixed claim so the legal proposition can be checked separately. A separate evidence-review request may cover private facts.

Record those unreviewed material classes as `MATERIAL_OUT_OF_SCOPE`. A successful citation-only review is `SCOPE_VERIFIED: external legal authorities`; it is never an unqualified whole-document `VERIFIED`.

## Advocacy calibration

The question is whether the proposition actually asserted is a fair, materially accurate, and supportable use of the authority. The question is not whether the writer adopted the most cautious or least favourable possible interpretation.

This profile expressly permits `POLICY_PERMITTED_INFERENCE` when a reasonable decision-maker could adopt the favourable reading actually asserted. That permission does not cover a missing premise, opposite holding, altered legal force, or inference outside the authority’s reasonable reach.

- Permit a favourable reading when a reasonable reader could adopt it.
- Do not require the draft to volunteer the opposing interpretation, unnecessary caveats, or defensive concessions.
- Respect attribution verbs. `Held`, `found`, and `decided` assert a determination; `supports`, `illustrates`, and `is consistent with` may assert a reasonable inference or analogy.
- Omitted background is a defect only when the omission makes the asserted proposition materially false or misleading.
- Preserve strong, fair characterizations. Do not weaken them merely because another reasonable characterization exists.
- Treat ordinary forensic disagreement as disagreement, not hallucination.
- Repair only provable hard defects and make the smallest effective correction.
- Preserve all reasonably available grounds and remedies. Verification must not add waivers, concessions, or self-limiting disclaimers.

## Release-impact gate

Do not propose a correction merely because an opponent could criticise a word choice or because a more cautious sentence exists. Before assigning `MUST_FIX`, record all three:

1. the defect directly demonstrable from the underlying authority;
2. the concrete release impact if the defect is exposed, such as damage to a legal premise, remedy, jurisdiction, deadline, attribution, legal force, or the writer's source accuracy;
3. the smallest change that removes that impact without weakening the remainder.

`It could be challenged` is not a release impact. Ordinary forensic disagreement, a second reasonable reading, omitted adverse argument, or failure to quote an entire sentence is not a defect by itself.

Use these action tracks:

- `MUST_FIX`: a demonstrable hard defect with a concrete release impact;
- `KEEP_STRONG`: a fair favourable reading whose force should be preserved;
- `STRENGTHEN`: supported advocacy value or direct relief is left unused;
- `OUT_OF_SCOPE`: nonmaterial connective or stylistic text, private evidence outside this Policy, or another expressly excluded class.

The action track does not replace the semantic verdict. Missing evidence remains `NOT_FOUND`, `SOURCE_UNAVAILABLE`, `OUTSIDE_SOURCE`, or `UNCERTAIN`; do not call it false merely to force a correction.

## No-exit advocacy review

The verifier must not improve the respondent's case while reviewing the applicant's draft.

- Do not supply a possible innocent explanation, alternate factual route, repair theory, internal process, or departure rationale that the respondent has not supplied.
- Do not write `unless the decision-maker explains its departure`, `the respondent may still show`, `if this was only a summary`, or equivalent language. A decision-maker does not need the applicant to be taught how to avoid the requested result.
- When a specific allegation becomes broader or less particular after a denial, preserve a supported characterization that the ground was changed or expanded. Identify the missing actor, date, platform, words, legal basis, or document locator. Do not recast the change as a harmless clarification unless the Source Box establishes that conclusion and the Policy requires it.
- Internal notes may record genuinely necessary litigation risk. They must not be promoted into proposed outgoing text unless omitting the point would make the applicant's proposition materially false or misleading.

## Direct corrective relief

In `UPLIFT`, inspect whether an operative record, order, restriction, reliance, or continuing harm is answered only with another process. When the supplied authority permits effective present relief, prefer a positive request to withdraw, set aside, correct, cease relying on, cease enforcing, circulate the correction, preserve or produce the record, or impose identified prevention controls.

Do not default to another neutral reviewer, reinvestigation, referral back, further explanation, or process reset unless the user selected that remedy or the governing authority makes it the only available route. A continuing harm calls for a present corrective result. A remedy proposal is a new legal claim and must be verified for jurisdiction and legal availability before adoption.

## Legal-force calibration without surrender

- If an official source says `should`, do not attribute `must` to that source. Make the smallest correction to `should`, then state positively that the applicable official criteria should be applied fully and consistently. Do not append an invitation to justify departure.
- Do not describe a non-binding review or tribunal decision as binding precedent. Where supported, describe it as a highly analogous, consistent, and persuasive official application, and submit that the same standard and result should be applied. Do not volunteer a route for departing from it.
- A quotation may use an exact continuous excerpt rather than the complete sentence. Boundary truncation is not a misquotation merely because surrounding words exist. Internal omissions, brackets, translations, or OCR corrections must be disclosed. Omission becomes `MUST_FIX` only when it changes or conceals a material actor, attribution, negation, condition, exception, scope, force, or conclusion.

## Advocacy-scope census

Run this census only in `UPLIFT` mode or when the Policy expressly authorizes advocacy-scope review. In a citation-only `AUDIT` or `REPAIR`, mark profile-item coverage `N/A` and review only the authorized external legal-source dimensions.

When authorized, independently inspect the complete Subject for express waivers, concessions, remedy disclaimers, ground-narrowing statements, `I do not allege/rely/seek` language, and other self-imposed scope limitations. These items are material even when they are not source-dependent. Assign separate `A-###` IDs so they cannot disappear from the legal-claim denominator.

An unapproved self-limitation that conflicts with the Policy is `MUST_FIX`. Delete an unsupported waiver or narrowing sentence. Any affirmative replacement that adds a legal proposition, ground, or remedy is a new claim and must be independently verified before adoption. Respect an express, reviewed Policy instruction that deliberately narrows scope. Never infer a waiver from silence.

## No-Diversion Gate (advocacy scope)

Run the generic No-Diversion Gate for every outward legal or formal Subject in `AUDIT`, `REPAIR`, and `UPLIFT` mode. It is mandatory whenever the draft asks an institution or person for an answer, decision, reason, correction, action, or remedy. A citation-only review may report `SCOPE_VERIFIED: external legal authorities`, but the complete draft is not release-ready until this gate passes.

For each pleaded issue, record the exact non-displaceable answer, correction, or remedy required. Then inspect the complete Subject for wording that gives the institution an easier side issue to answer while leaving that required outcome untouched. A possible criticism is not enough. Use `DIVERSION_MUST_FIX` only when the exact trigger creates a concrete procedural, evidentiary, remedial, or decision-outcome risk.

Inspect these legal-advocacy traps in particular:

- attacks or comparisons about intelligence, English ability, education, child comprehension, or what “anyone can see”;
- a request to assign another manager, reviewer, or internal workflow instead of delivering the correction or remedy;
- an unclear actor, target, platform, event, category, or document;
- an answer to a substituted actor, event, legal test, time period, causation question, or remedy presented as an answer to the issue actually raised;
- merged categories that let an employer-decision exclusion erase earlier coworker conduct;
- a factual-comparison answer presented as though it answered a legal-principle question;
- a generic reply request or deadline that is not tied to the numbered issues and required point-by-point answer;
- a side analogy or adjective that is easier to dispute than the documented contradiction.

For rumours and smears, keep dissemination, repetition, notice, and direct communication distinct. Third-party dissemination is itself the relevant reputational and workplace event. A coworker's direct message to the applicant may prove that the statement had already spread, was repeated, or reached that coworker; “was it said directly to the applicant?” must not replace the dissemination question.

The internal diagnostic may name the shortest facially responsive non-answer invited by the wording. Never place that imagined answer, a new defence, or instructions for avoiding the requested result into the outgoing draft. The smallest repair should delete the side trigger, identify the exact actor or object, separate the categories, replace internal process with the required result, or bind the deadline to the numbered issues. Preserve every supported allegation and remedy.

## Legal verification dimensions

Keep these findings separate for every authority:

1. authority exists and identity is correct;
2. link and neutral/report citation are correct;
3. quotation and pinpoint are exact;
4. procedural posture, holding, and disposition are described accurately;
5. the asserted proposition is fairly supported;
6. the authority advances the stated direction under a reasonable favourable reading;
7. currentness or later treatment is established when the Policy requires it.

An exact quotation does not automatically prove the surrounding proposition. A real case does not automatically support the claimed rule.

## Three-track review

Run `KEEP_STRONG` and `STRENGTHEN` only in `UPLIFT` mode or when the Policy expressly authorizes advocacy-scope review. In a citation-only review, use the generic semantic verdict and material-defect report without adding advocacy observations.

- **MUST_FIX:** a purported authority contradicted by authoritative source evidence, wrong identifier, altered quote, wrong number, opposite holding, allegation stated as finding, material condition removed, materially wrong legal force, or another directly demonstrable defect that passes the release-impact gate.
- **KEEP_STRONG:** a fair and favourable reading that should not be diluted or qualified.
- **STRENGTHEN:** an accurate sentence that leaves useful source-supported ground unused.

For `STRENGTHEN`, provide the existing sentence, proposed stronger sentence, decisive source passage, practical advantage, and a fresh verdict on the proposed wording. Do not label uplift as correction.

Keep the semantic verdict separate from the advocacy track. `NOT_FOUND`, `SOURCE_UNAVAILABLE`, `OUTSIDE_SOURCE`, and `UNCERTAIN` do not prove falsity. A cited authority that cannot remain in a release-ready draft may receive the action track `MUST_FIX`, but the reason must retain the exact unresolved verdict. Never call an authority nonexistent unless authoritative evidence establishes nonexistence.

## Source quality

Use the hierarchy required by the matter and stated Policy. For high-risk outward work, prefer the issuing body’s current text and include enough surrounding reasons to assess context. A search result, headnote, summary, citation card, or another AI’s description may locate a source but cannot replace the source where the full authority is required.

If the authority cannot be reopened or authenticated, return `SOURCE_UNAVAILABLE`. Do not infer nonexistence from a portal outage. If currentness or subsequent treatment was not supplied and matters to the claim, return `OUTSIDE_SOURCE` and state what must be obtained.

## One source pass, two legal lanes

At the start of the run, freeze one enumerated legal Source Box and prepare one claim-scoped packet for each material external-law claim. The integrity lane and advocacy-uplift lane reuse the same source identity, decisive passage, locator, and necessary surrounding context. They must not each rediscover or reread the complete corpus.

Shared packets save retrieval and full-document rereading; they do not share a semantic conclusion. Each semantic verifier must reopen every decisive locator and enough underlying context to test quotation, attribution, conditions, posture, legal force, scope, and disposition. A qualifying sealed independent reviewer builds and seals its own evidence choices before reconciliation.

Do not reopen legal sources for a change limited to grammar, connective prose, formatting, or `me`/`I`. Reverify the affected claim when a quotation, actor, number, identifier, section, proposition, condition, legal force, posture, disposition, or remedy changes. After changes, rerun the complete Subject occurrence scan so a new material claim or helmet cannot disappear.

## Output discipline

Audit first. When advocacy-scope review is authorized, show the user every proposed `MUST_FIX`, `KEEP_STRONG`, and `STRENGTHEN` item before editing unless the user expressly asks for repair. Do not turn internal context notes into outgoing helmets.
