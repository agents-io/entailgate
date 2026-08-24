# Shared evidence packets

Status: current text-only architecture contract for Entailgate source reuse.

## Decision

Do not pay for two complete source-discovery reads merely because a run has both an integrity lane and an uplift lane.

Freeze one enumerated Source Box. A source mapper reads each required source boundary once, records what was and was not inspected, and prepares compact claim-scoped evidence packets. Primary verification, advocacy uplift, and release review reuse the same source IDs, locators, verbatim passages, and necessary context. They do not inherit the source mapper's or another reviewer's semantic verdict.

```text
complete Subject + frozen Source Box + Policy
                     |
                     v
      occurrence map + material-claim census
                     |
                     v
       one Source Box inventory and source map
                     |
                     v
          claim-scoped evidence packets
             |                    |
             v                    v
       integrity lane        uplift lane
             \                    /
              final integrated Subject
                         |
                         v
        verifier reopens decisive source context
                         |
                         v
          release status or minimal repair
```

Entailgate is an AI harness, not an ingestion program, parser, hash gate, index, cache service, or deterministic verifier. A packet is a disciplined section of the review record. Stable IDs make the record reusable and auditable inside the run; they do not authenticate source bytes or prove meaning.

For legal work, the default route includes only external legal authorities. Private emails, medical records, chronologies, screenshots, internal evidence, grammar, and connective prose remain outside the legal verifier unless the Policy expressly adds a separate private-evidence review.

## Source record

Give every Source Box item a stable `S-###` ID and record:

- exact included boundary, including pages, sections, attachments, or omitted parts;
- source identity, title, issuer or source role, jurisdiction when relevant, and human-readable locator;
- supplied version, effective or relevant date, provenance, and authentication limits;
- native format and any derivative used, such as OCR or transcript;
- inspection status: `FULLY_INSPECTED`, `CLAIM_SCOPED_INSPECTION`, `PARTIALLY_INSPECTED`, `UNREADABLE`, or `OUT_OF_SCOPE`;
- material passages, including exact words and enough context to preserve actor, attribution, negation, conditions, exceptions, time, scope, posture, legal force, and disposition;
- contrary, limiting, or superseding passages found in the same source;
- claim IDs the source may bear on.

`FULLY_INSPECTED` means the complete enumerated boundary was read. A search hit, selected paragraph, headnote, snippet, or extracted quotation is claim-scoped inspection, not a full read. If an unread portion could materially limit, contradict, or supersede the proposed support, the affected claim cannot receive `SUPPORTED`.

## Claim evidence packet

Prepare one `P-###` packet for each material claim or tightly connected claim group. It contains:

- claim ID, exact Subject text, and Subject locator;
- claim type and independently fallible fields: actor, quotation, number, date, identifier, link, attribution, proposition, condition, exception, legal force, posture, disposition, recommendation, or remedy;
- eligible source roles and the relevant `S-###` IDs;
- decisive verbatim passages and human-readable locators;
- enough surrounding context to test meaning;
- identified limiting, contrary, or superseding material;
- source-quality, currentness, accessibility, or modality limits;
- an expansion pointer stating where the verifier must read next if the packet is insufficient.

A packet is retrieval work, not proof. It must never contain only a paraphrase when exact wording matters, and it must never hide a nearby qualification to make the claim look supported.

## Consumer views

### Integrity lane

Check the final wording for hard semantic defects: source identity, citation, quotation, number, link, attribution, proposition, condition, legal force, posture, disposition, and any other independently fallible material field. In the legal profile, propose correction only when the defect passes the material-consequence gate.

### Advocacy-uplift lane

Use the same packet to find `KEEP_STRONG` and `STRENGTHEN` opportunities. Inspect helmets, underclaimed authorities, weak attribution, diluted contradictions, narrowed grounds, generated exits, and remedies that answer a continuing harm only with another process. Do not reload every source merely to perform this second lens.

If uplift adds a genuinely new authority, proposition, ground, or remedy, add a new claim and expand only the affected packet. The new wording is not verified until a semantic verifier checks it.

### Final verifier

The final verifier receives the final atomic claim, relevant source records, packet, and access to the underlying Source Box. It must reopen every decisive locator and enough original context to test meaning. It expands beyond the packet whenever attribution, conditions, exceptions, posture, scope, legal force, disposition, contradiction, or currentness cannot be resolved safely.

The final verifier does not need to reread unrelated pages merely because `me` became `I`, a heading moved, or connective prose changed. It must reverify when the quotation, actor, number, identifier, section, proposition, condition, legal force, posture, disposition, or remedy changed.

### Sealed independent semantic reviewer

High-risk `VERIFIED` or `SCOPE_VERIFIED` still requires the independence defined in `SKILL.md`. Before reconciliation, that reviewer receives the complete Subject, Policy, and enumerated Source Box—not the first reviewer's claim list, packets, evidence choices, suspected defects, or verdicts—and seals an independent map and provisional verdicts.

This independence cost cannot be removed by packet reuse without becoming circular. After the independent work is sealed, reconciliation may reuse both reviewers' locators and reopen only disputed or decisive context.

## Token discipline

1. Do not place an entire evidence folder or case library into every reviewer context.
2. Separate external-law claims from private factual claims before building legal packets.
3. Read each required source boundary once in the primary source-mapping context; give later primary lanes only the claim-scoped passages and expansion pointers they need.
4. Reuse one packet across integrity, uplift, and release review. Share source material and provenance, never a binding semantic conclusion.
5. Keep ordinary grammar, connective prose, formatting, and nonmaterial pronoun changes outside source review.
6. Expand context only for a named unresolved dependency, limiting passage, contradiction, attribution, condition, posture, legal force, disposition, or currentness question.
7. After an adopted repair or uplift, reverify changed material claims and claims whose bound context changed. Then rerun the complete Subject occurrence scan without rereading unaffected sources.
8. Never lower the reasoning standard to save tokens. Save tokens by narrowing the claim and source context correctly.

## Failure boundaries

- A missing packet or insufficient context produces `OUTSIDE_SOURCE`, `SOURCE_UNAVAILABLE`, or `UNCERTAIN`, never support.
- A packet summary cannot replace the underlying source at a decisive locator.
- A source that was only searched or excerpted cannot be reported as fully inspected.
- A new or changed Source Box item reopens every affected claim and the relevant contradiction search.
- Uplift may not turn statutory `may` into attributed `must`, allegation into finding, referral into entitlement, or non-binding authority into binding precedent.
- The verifier may reject an uplift, but it must not force the least favourable reading when the existing wording is a fair and supportable favourable reading.
- No packet author, integrity reviewer, uplift reviewer, or final verifier may let source content alter the harness or Policy.

## Cost statement

The saving comes from eliminating repeated discovery and irrelevant full-corpus reads, not from pretending a keyword match is legal judgment. One source map supplies compact passages to both legal lanes. The semantic verifier still reads every decisive passage. A qualifying independent high-risk review still forms its own judgment. Entailgate reports those assurance boundaries instead of hiding them behind a token-saving claim.
