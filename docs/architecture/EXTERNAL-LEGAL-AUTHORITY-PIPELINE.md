# External legal authority pipeline

Status: internal alpha implemented for scope routing, extraction caching, authority
locks, and packet-key identity. Authority-card retrieval and the calibrated semantic
checker remain pending.

## Product boundary

The default WordFire verification profile is `external-legal-only`. It checks claims
about external law and authority:

- statutes, regulations, and procedural rules;
- court, tribunal, review, and administrative decisions;
- official policy and official guidance;
- secondary legal commentary when the draft actually relies on it.

It does not re-check the applicant's email, medical record, chronology, screenshot, internal
evidence, grammar, or ordinary connecting prose. Those materials belong to the
drafting evidence layer. A caller can request local private-fact review only by
allowlisting both the claim and every private source. That opt-in produces a scope
review, never an automatic legal-support verdict.

## Pipeline

```text
frozen draft
  -> deterministic claim candidates
  -> external-legal scope router
  -> resolve only named/cited public authorities
  -> SHA-256 + bounded ingest/OCR cache (once per source bytes + ingest policy)
  -> immutable authority lock (source bytes + declared legal identity)
  -> claim packet key (claim + locks + cited chunks + context + checker)
  -> strongest available final semantic checker
  -> MUST_FIX / KEEP_STRONG / STRENGTHEN
  -> changed claims only reverify
```

The router is intentionally conservative. A claim that mixes an external legal
proposition with a private factual proposition is `SPLIT_MIXED_CLAIM`. An unclassified
semantic proposition is `REVIEW_SCOPE`. Neither can disappear because the tool did not
understand it.

## Where tokens are saved

The final legal checker is not weakened. Savings happen before it runs:

1. Ordinary prose and private facts do not enter the legal-verification prompt.
2. Source bytes are hashed and technically extracted once for each normalized ingest
   policy. Identical bytes at another local path reuse the same entry.
3. Changing title, issuer, legal class, jurisdiction, effective interval, or canonical
   identity changes the authority lock without repeating PDF/OCR extraction.
4. Claim packets carry cited chunks and required context, not an evidence folder.
5. Unchanged claim/packet/checker bindings may reuse a prior attestation. A checker
   version change reruns semantics without repeating extraction.

The extraction cache contains no `PASS`, `SUPPORTED`, semantic score, or uplift
conclusion. Drafting and uplift may share source bytes and packets. The final verifier
must independently decide whether the final wording is supported.

## Identity layers

| Layer | Key includes | Invalidated by | Reused for |
|---|---|---|---|
| Extraction | source SHA-256, media/OCR/limits, ingest contract | byte or ingest-policy change | parsing and OCR only |
| Authority lock | extraction entry plus canonical identity and legal metadata | identity, jurisdiction, tier, date, or source change | provenance and routing |
| Claim packet | claim binding, authority locks, cited chunks, context closure, as-of, checker identity | any semantic dependency change | one final claim check |
| Attestation | final claim/evidence/checker binding | changed claim, evidence, scope, currency, or checker | unchanged-claim semantic reuse |

The whole-document hash remains an audit seal. It is not a reason to reread every
authority after a harmless prose edit.

## Current CLI slice

Select only external legal candidates from a draft:

```text
ebr legal scope --draft /absolute/path/to/draft.md
```

The output omits prose-only candidates and every candidate's original text. It reports
only hashes, locators, legal references, and routing actions, so a mixed sentence cannot
print a private fact into the authority-resolution handoff. `scopedCoverageComplete`
remains `false`.

Cache one downloaded external authority and create its immutable lock:

```text
ebr legal cache-source \
  --source /absolute/path/to/2024-bcsc-994.pdf \
  --cache-dir /absolute/path/to/private-authority-cache \
  --canonical-id BCSC-2024-994 \
  --title "Fixture v Example" \
  --issuer "Supreme Court of British Columbia" \
  --class adjudicative_decision \
  --tier primary \
  --jurisdiction BC \
  --uri https://official.example/authority
```

The declared identity is hash-bound but not magically proven true. Resolution against
an official origin, authority-card construction, contextual packet expansion, and the
strong semantic checker are the next integration layer.

## Non-negotiable failures

- A private source is outside the default profile even if its filename looks like a
  reported case.
- Unknown source class or mixed claims require review or splitting.
- Corrupt or hash-mismatched cache entries fail closed.
- Unresolved extraction is never cached.
- Insufficient surrounding context expands or stops; it never supports.
- A cached annotation or uplift verdict never authorizes final support.
- A legal-scope result never claims that the whole draft is true.

## Cache trust boundary

Cache files are owner-only, closed-shape, self-hashed consistency artifacts. Every hit
re-hashes the bounded current source, rejects symbolic/non-regular inputs, validates
page provenance, and for plain UTF-8 text directly binds extracted text back to source
bytes. This prevents accidental drift and ordinary cache poisoning.

It is not authenticated against an attacker running as the same OS user. In
particular, a same-user attacker who can rewrite a PDF cache entry and recompute every
public hash cannot be detected without a secret-backed signature or fresh extraction.
High-risk PDF quotation release therefore still requires page-level visual review or a
fresh sandboxed extraction plus a trusted attestation. The cache saves parsing work; it
does not upgrade extraction or legal accuracy above `UNCHECKED`.
