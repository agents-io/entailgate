# BC legal advocacy verification policy

Status: normative for Entailgate runs using the legal-advocacy profile.

## Purpose

The verifier protects a strong legal submission from factual and citation error. It
does not turn the submission into a neutral case note, write the respondent's answer,
or force the writer to choose the least favourable plausible interpretation.

The operative question is:

> Is the proposition actually asserted a fair, materially accurate and supportable
> use of the cited authority in this submission?

It is not:

> Is this the most cautious formulation that an academic annotator could write after
> listing every possible adverse qualification?

The legal profile is not only defensive. In `UPLIFT` mode it separates two concerns
without making both reviewers rediscover or reread the complete Source Box:

1. **Integrity pass:** find objectively provable errors that must be fixed.
2. **Advocacy uplift pass:** find unnecessary helmets, underclaimed authorities,
   weak attribution, hidden actors, diluted contradictions, narrowed grounds, and
   remedies that the evidence permits the writer to state more strongly.

The ordering and shared-input contract are defined in
[`SHARED-EVIDENCE-PACKETS.md`](../architecture/SHARED-EVIDENCE-PACKETS.md). A source
mapper reads the frozen Source Box and prepares reusable, claim-scoped packets.
Integrity review, uplift, and final verification reuse those passages and locators.
Packets save discovery; they do not carry a binding semantic verdict. Every verifier
must reopen the decisive passage and necessary original context before assigning
support. Later edits reverify only claims whose material legal content changed, then
rerun the complete Subject occurrence scan.

## Default verification scope

Entailgate's default legal verifier checks external legal authorities only. It verifies
whether a cited law, rule, case, decision, official policy, or official guideline
exists; whether its identifier, quotation, number, link, legal force, posture, and
disposition are accurate; and whether it fairly supports the proposition asserted.

It does not spend a second model read checking the applicant's own email, medical record,
chronology, screenshot, internal document, grammar, or connecting prose. Those facts
remain part of the drafting evidence layer. Mixed legal-and-private claims must be
split so the legal half can be verified without uploading or rereading the private
half. Private-fact review is a separate, explicit, local-only opt-in.

## Material-consequence gate

Do not call something a correction merely because an opponent could point to it. A
proposed `MUST_FIX` item must state:

1. the hard defect demonstrated by the underlying authority;
2. the concrete effect if exposed on a legal premise, remedy, jurisdiction, deadline,
   attribution, legal force, source accuracy, or decision outcome; and
3. the smallest repair that removes that effect without diluting the rest.

`It could be challenged` is not a concrete effect. A second reasonable reading,
ordinary forensic disagreement, omitted opposing argument, or a continuous exact
excerpt shorter than the source sentence is not a defect by itself. If the proposed
nitpick cannot materially hurt the submission, classify the existing wording
`KEEP_STRONG` rather than manufacturing a caveat.

## Advocacy-preserving rules

1. **Take the proposition as written.** Verify its actor, act, legal force, scope,
   quotation, number, and cited authority. Do not silently replace it with a broader
   proposition and then reject that broader proposition.
2. **Allow favourable fair readings.** When the source reasonably supports several
   readings, a writer may use the reading that advances the writer's case.
3. **Do not require defensive completeness.** Omitted adverse facts, alternative
   readings, or respondent arguments do not create a support defect unless the
   omission materially changes the asserted proposition or makes it misleading.
4. **Respect attribution verbs.** `Held`, `found`, and `decided` attribute an actual
   determination. `Supports`, `illustrates`, `shows`, `involved`, and `is consistent
   with` may state a reasonable inference or analogy. Do not grade the second group as
   though it used the first.
5. **Preserve strong characterization.** Terms such as bullying, humiliation,
   retaliation context, surveillance, misuse of authority, and cumulative targeting
   may be used where they fairly synthesize the accepted facts, reasons, or required
   investigation. Exact tribunal terminology is required only when quotation marks or
   an express attribution claim it is exact.
6. **Separate existence, quotation, and application.** A true case ID and exact quote
   can coexist with a debatable analogy. Record the analogy as supported when it is
   reasonably available; do not convert ordinary forensic disagreement into a factual
   error.
7. **Do not add helmets.** A proposed repair must not add waivers, concessions,
   unnecessary disclaimers, the opposing case, or language that narrows an available
   ground or remedy.
8. **Repair minimally.** If one word or attribution verb causes the defect, change
   that word. Do not rewrite or weaken the rest of a supported paragraph.
9. **Search for unused strength.** Compare each verified authority and material fact
   with the draft's actual wording. When the evidence safely carries a broader or more
   forceful proposition, surface it instead of treating a merely accurate draft as
   finished.
10. **Reverify every uplift.** A proposed stronger sentence is a new subject. Any new
    material proposition, quotation, number, legal force, actor, remedy, or citation
    must pass the integrity gate again before release.
11. **Do not generate exits.** Do not tell the respondent that a changed allegation
    might be a summary, that a decision-maker can depart if it gives reasons, or how a
    defect could be repaired. Identify the missing particular or contradiction and
    stop.
12. **Prefer present correction for present harm.** Where authority permits, request
    withdrawal, setting aside, correction, cessation of reliance or enforcement,
    circulation of the correction, preservation or production, and concrete
    prevention controls. Do not default to a new neutral reviewer, reinvestigation,
    referral back, or explanation unless the user selected that result or law makes it
    the only available route.

## Legal-force calibration without surrender

- When official guidance says `should`, do not attribute `must` to it. Use `should`,
  then state positively that the applicable criteria should be followed fully and
  consistently. Do not add `unless the decision-maker explains its departure`.
- Do not call a non-binding review or tribunal decision binding precedent. Where the
  Source Box supports it, call the decision a highly analogous, consistent, and
  persuasive official application, and submit that the same standard and result
  should be applied. Do not volunteer a route for departure.
- An exact quotation may be a continuous excerpt rather than a full sentence.
  Boundary truncation alone is not a misquotation. Internal omissions, brackets,
  translations, and OCR corrections must be disclosed. An omission is material when
  it changes or hides an actor, attribution, negation, condition, exception, scope,
  force, or conclusion.

## Changed or broadened grounds

When a specific allegation becomes broader or less particular after the applicant's
denial, preserve a supportable characterization that its basis changed or expanded.
Pin down the missing actor, date, platform, words, legal basis, and document locator.
Do not recast the change as a harmless clarification, summary, or generalization
unless the Source Box establishes that conclusion and the Policy requires it. Do not
write alternative routes that teach the respondent how to restore the allegation.

## Closed-fork strategy for an incomplete adjudication

Where a decision addresses one incident but the filed claim alleges a cumulative
course of conduct, frame the issue as a closed fork:

1. WorkSafeBC adjudicated the complete cumulative claim. WorkSafeBC must then identify
   the event-by-event findings, cumulative analysis, and reasons that decide it.
2. WorkSafeBC did not adjudicate the complete cumulative claim. The one-incident
   decision did not decide the claim that was filed.

Silence is not an adverse finding. Classify coworker conduct and management/employer
decision conduct before applying any employer-decision exclusion. Do not volunteer
that WCAT decisions are fact-specific or non-binding, that the facts are not identical,
or that the reviewer cannot be forced to reconsider. Those statements surrender
ground without correcting a citation or factual error.

## Mandatory three-track output

Every legal `UPLIFT` review must classify each material observation into exactly one
track. In citation-only `AUDIT` or `REPAIR`, use the semantic verdicts and leave
advocacy tracks `N/A`.

### MUST_FIX

Use only for a provable hard defect that passes the material-consequence gate: a
purported authority contradicted by authoritative source evidence, wrong identifier, broken
quotation, wrong number, opposite holding, allegation reported as a finding, material
condition removed, materially wrong legal force, or another directly demonstrated
error. A failed or incomplete search remains `NOT_FOUND` or `SOURCE_UNAVAILABLE`; it
does not prove fabrication.

### KEEP_STRONG

Use when the existing sentence is a fair and favourable reading, including a disputed
or ambiguous reading that a reasonable reader could adopt. `KEEP_STRONG` means do not
weaken, qualify, or volunteer the opposing interpretation.

### STRENGTHEN

Use when the existing sentence is accurate but leaves material advocacy value unused.
Each item must contain:

- the exact current sentence or locator;
- the proposed stronger sentence;
- the source, fact, or authority that makes the stronger sentence safe;
- the additional proposition, if any, that must be reverified;
- a concise explanation of the practical advantage gained.

`STRENGTHEN` is advisory until the rewritten sentence passes verification. It must
never be mislabeled as a correction or imply that the original sentence was wrong.

## Advocacy uplift scan

The second pass must actively test for:

- self-limiting disclaimers (`I am not asking`, `I do not rely`, `my case is not`,
  `the issue is not whether I can require`);
- pre-emptive concessions (`I understand the decision is fact-specific`, `my facts are
  not identical`, `the authority is not binding`) that are unnecessary to accuracy;
- weak modality where the source supports stronger force (`could`, `may`, `not
  necessarily`, `should be considered`);
- weak attribution where the record identifies the actor and act;
- a conclusion presented as a concern or possibility after the documents establish it;
- an authority described only as theoretically capable when it actually accepted the
  same category of conduct;
- a cumulative series diluted into isolated incidents;
- a formal finding described as merely an allegation;
- an available ground, remedy, procedural consequence, contradiction, deadline, or
  burden that the draft omits or narrows;
- an institutional task framed as a favour, optional step, confirmation request, or
  offer to provide more material;
- a live error or restriction answered only with a request for another review,
  investigation, referral, explanation, or purportedly neutral process;
- language that suggests an innocent explanation, alternate route, departure reason,
  or repair theory that the respondent has not supplied;
- a specific allegation broadened into a platform-free, date-free, actor-free, or
  otherwise less particular description after denial.

The scan must preserve weapon negations (`There is no evidence identified`) and
necessary legal distinctions. It must not strengthen a statutory `may` into `must`
when describing the statute. It may, however, state positively that the applicant seeks the
decision-maker to exercise that power on the established record.

## Verdict boundary

### SUPPORTED

Use `SUPPORTED` when a reasonable decision-maker could read the cited source as
supporting the proposition in the way asserted, including a fair favourable inference
or analogy. The existence of adverse context or a narrower possible reading does not
change this verdict by itself.

### PARTIAL

Use `PARTIAL` only when a material component of the proposition lacks support, changes
the source's legal force, attributes an allegation as a finding, removes a condition
needed for the proposition, or applies an analogy beyond its reasonable reach.

Do not use `PARTIAL` merely because:

- the source contains other facts unfavourable to the writer;
- the authority was fact-specific;
- a more cautious sentence could have been written;
- the case does not prove the writer's ultimate entitlement by itself;
- the writer selected the favourable one of multiple reasonable interpretations.

### CONTRADICTED

Use `CONTRADICTED` only when the cited source materially conflicts with the proposition:
for example, the source reaches the opposite holding, the quoted words are absent or
altered, an allegation is expressly rejected but reported as accepted, or `may` is
materially changed into `must` without another basis.

### NOT_FOUND

Use `NOT_FOUND` when the claimed authority or required supporting passage cannot be
located after the defined source-search procedure. A portal outage is `SOURCE
UNAVAILABLE`, not proof that a decision does not exist.

## Report format

Every legal semantic audit must keep these fields separate:

- source exists and identifier is correct;
- quotation is exact;
- proposition is fairly supported;
- authority advances the submission's stated direction;
- material defect, if any;
- concrete release impact, if any;
- minimal repair, only if a material defect exists.

After those fields, include a separate **Advocacy uplift** section. Do not mix
`STRENGTHEN` opportunities into the error count, and do not count a retained strong
reading as a caveat.

Context notes may be retained in the internal ledger for QA. They must not be promoted
into a user-facing correction or outgoing submission unless needed to prevent a
materially false or misleading statement.

## Adjudication examples from dogfood round 1

- “A1802705 involved monitoring and searching personal and social-media information”
  is supported. It says `involved`; it does not claim either act independently decided
  entitlement.
- “A1900053 involved cumulative bullying and humiliation” is a permissible advocacy
  synthesis of cumulative demeaning, humiliating and abusive conduct. A verifier may
  note the tribunal's exact vocabulary internally but must not force a weaker outgoing
  formulation.
- “R0340275 confirms that isolation, denied rumours, and pressure after a report must
  be investigated within the complete retaliation context” is a fair statement about
  the required scope of investigation. It does not assert that retaliation was already
  proven.
- An express statement that Review Division **accepted entitlement** in a decision
  that only referred a matter for further investigation would be a material error and
  must be stopped.
- “A claim is not necessarily decided by isolating each event” is accurate but
  underclaims the cumulative requirement. When supported by section 135 and the cited
  cumulative authorities, Entailgate should propose: “A cumulative claim must be
  assessed as a series, not by isolating each event.”
- “My facts are not identical to J.T.” is an unnecessary concession. The proposition
  does not depend on identical facts. Delete it and state the complete-record rule.
