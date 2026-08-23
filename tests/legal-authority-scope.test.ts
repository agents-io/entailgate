import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/canonical.js";
import {
  extractExternalLegalReferences,
  LegalScopeError,
  planDraftLegalCandidates,
  planLegalVerificationScope,
  type LegalSourceClassification,
} from "../src/legal-authority-scope.js";
import type { AtomicClaim, VerifyRequest } from "../src/types.js";

const SUBJECT_HASH = "a".repeat(64);

function claim(
  claimId: string,
  text: string,
  sourceId: string,
  chunkId: string,
  proof: AtomicClaim["proof"] = { kind: "exact_quote", quote: text, normalization: "exact" },
): AtomicClaim {
  return {
    claimId,
    text,
    material: true,
    risk: "high",
    citations: [{ sourceId, chunkId }],
    proof,
  };
}

function request(): VerifyRequest {
  const claims = [
    claim("case", "2024 BCSC 994 supports the stated legal test.", "public-case", "case-chunk", { kind: "semantic" }),
    claim("fact", "The medical note records the reported symptom.", "private-note", "note-chunk", { kind: "semantic" }),
    {
      ...claim("mixed", "Section 135 applies and the employer received the email.", "public-statute", "statute-chunk", { kind: "semantic" }),
      citations: [
        { sourceId: "public-statute", chunkId: "statute-chunk" },
        { sourceId: "private-email", chunkId: "email-chunk" },
      ],
    },
    claim("unknown", "The decision establishes a legal duty.", "mystery", "mystery-chunk", { kind: "semantic" }),
    claim("prose", "Thank you for reviewing this letter.", "private-email", "email-chunk"),
  ];
  return {
    schemaVersion: "0.1.0",
    requestId: "scope-test",
    requestedAt: "2026-08-23T12:00:00-07:00",
    domain: "bc-legal",
    subject: { subjectId: "draft", mediaType: "text/plain", sha256: SUBJECT_HASH },
    coverage: { complete: false, method: "extractor", subjectSha256: SUBJECT_HASH },
    evidence: {
      schemaVersion: "0.1.0",
      snapshotId: "scope-snapshot",
      createdAt: "2026-08-23T12:00:00-07:00",
      domain: "bc-legal",
      sources: ["public-case", "public-statute", "private-note", "private-email", "mystery"].map((sourceId) => ({
        sourceId,
        title: sourceId,
        sourceType: "fixture",
        authorityTier: "unknown",
        retrievedAt: "2026-08-23T12:00:00-07:00",
      })),
      chunks: ([
        ["case-chunk", "public-case"],
        ["statute-chunk", "public-statute"],
        ["note-chunk", "private-note"],
        ["email-chunk", "private-email"],
        ["mystery-chunk", "mystery"],
      ] as const).map(([chunkId, sourceId]) => ({ chunkId, sourceId, text: chunkId })),
    },
    retrievedChunkIds: ["case-chunk", "statute-chunk", "note-chunk", "email-chunk", "mystery-chunk"],
    claims,
    policy: {
      policyId: "scope-test",
      riskTier: "high",
      requireCompleteCoverage: false,
      requireRetrievedCitationClosure: true,
    },
  };
}

const classifications: LegalSourceClassification[] = [
  { sourceId: "public-case", visibility: "external_public", legalClass: "adjudicative_decision" },
  { sourceId: "public-statute", visibility: "external_public", legalClass: "enacted_law" },
  { sourceId: "private-note", visibility: "private_case", legalClass: "non_legal_record" },
  { sourceId: "private-email", visibility: "private_case", legalClass: "non_legal_record" },
  { sourceId: "mystery", visibility: "unknown", legalClass: "unknown" },
];

test("routes external legal claims while skipping first-party facts by default", () => {
  const plan = planLegalVerificationScope(request(), classifications);
  assert.equal(plan.items.find((item) => item.claimId === "case")?.action, "VERIFY_EXTERNAL_AUTHORITY");
  assert.equal(plan.items.find((item) => item.claimId === "fact")?.action, "SKIP_BY_SCOPE");
  assert.equal(plan.items.find((item) => item.claimId === "mixed")?.action, "SPLIT_MIXED_CLAIM");
  assert.equal(plan.items.find((item) => item.claimId === "unknown")?.action, "REVIEW_SCOPE");
  assert.equal(plan.items.find((item) => item.claimId === "prose")?.action, "SKIP_BY_SCOPE");
  assert.equal(plan.scopedCoverageComplete, false);
  assert.deepEqual(plan.counts, {
    VERIFY_EXTERNAL_AUTHORITY: 1,
    SKIP_BY_SCOPE: 2,
    SPLIT_MIXED_CLAIM: 1,
    REVIEW_SCOPE: 1,
  });
});

test("private factual review requires local mode plus both claim and source allowlists", () => {
  const incomplete = planLegalVerificationScope(request(), classifications, {
    privateFactsMode: "local_only",
    privateClaimIds: ["fact"],
  });
  assert.equal(incomplete.items.find((item) => item.claimId === "fact")?.action, "SKIP_BY_SCOPE");

  const optedIn = planLegalVerificationScope(request(), classifications, {
    privateFactsMode: "local_only",
    privateClaimIds: ["fact"],
    privateSourceIds: ["private-note"],
  });
  const item = optedIn.items.find((candidate) => candidate.claimId === "fact");
  assert.equal(item?.classification, "PRIVATE_FACT");
  assert.equal(item?.action, "REVIEW_SCOPE");
  assert.equal(optedIn.scopedCoverageComplete, false);
});

test("routing trusts explicit source metadata, not a legal-looking filename or title", () => {
  const fixture = request();
  fixture.evidence.sources.find((source) => source.sourceId === "private-note")!.title = "2016 SCC 25.pdf";
  fixture.claims[0] = claim("disguised", "The attached document says this.", "private-note", "note-chunk", { kind: "semantic" });
  const plan = planLegalVerificationScope(fixture, classifications);
  const item = plan.items.find((candidate) => candidate.claimId === "disguised");
  assert.equal(item?.classification, "PRIVATE_FACT");
  assert.equal(item?.action, "SKIP_BY_SCOPE");
});

test("extracts supported BC legal reference shapes without treating ordinary prose as authority", () => {
  const text = [
    "WCAT A1802705 and Review Reference R0265633",
    "2024 BCSC 994, section 135(1), Policy Item C3-24.00",
    "https://www.canlii.org/en/bc/bcsc/doc/2024/2024bcsc994/2024bcsc994.html",
  ].join("; ");
  assert.deepEqual(extractExternalLegalReferences(text), [
    "2024 BCSC 994",
    "https://www.canlii.org/en/bc/bcsc/doc/2024/2024bcsc994/2024bcsc994.html",
    "Policy Item C3-24.00",
    "Review Reference R0265633",
    "section 135(1)",
    "WCAT A1802705",
  ]);
  assert.deepEqual(extractExternalLegalReferences("Thank you. I received the email."), []);
  assert.deepEqual(extractExternalLegalReferences("2013 CanLII 123."), ["2013 CanLII 123"]);
  assert.deepEqual(
    extractExternalLegalReferences("Workers Compensation Act, R.S.B.C. 2019, c. 1 applies."),
    ["R.S.B.C. 2019, c. 1"],
  );
  assert.deepEqual(extractExternalLegalReferences("Smith v Jones supports the test."), ["Smith v Jones"]);
  assert.deepEqual(extractExternalLegalReferences("[2016] 2 S.C.R. 3"), ["[2016] 2 S.C.R. 3"]);
  assert.deepEqual(
    extractExternalLegalReferences("https://www.bccourts.ca/jdb-txt/sc/24/09/2024BCSC0994.htm"),
    ["https://www.bccourts.ca/jdb-txt/sc/24/09/2024BCSC0994.htm"],
  );
  assert.deepEqual(
    extractExternalLegalReferences("https://laws-lois.justice.gc.ca/eng/acts/C-46/"),
    ["https://laws-lois.justice.gc.ca/eng/acts/C-46/"],
  );
});

test("a legal reference cannot override an unknown cited source", () => {
  const fixture = request();
  fixture.claims[0] = claim(
    "unknown-section",
    "Section 135 requires cumulative adjudication.",
    "mystery",
    "mystery-chunk",
    { kind: "semantic" },
  );
  const item = planLegalVerificationScope(fixture, classifications).items.find(
    (candidate) => candidate.claimId === "unknown-section",
  );
  assert.equal(item?.classification, "UNCERTAIN");
  assert.equal(item?.action, "REVIEW_SCOPE");
  assert.deepEqual(item?.externalSourceIds, []);
});

test("conflicting or foreign source classifications fail closed", () => {
  assert.throws(
    () => planLegalVerificationScope(request(), [
      ...classifications,
      { sourceId: "public-case", visibility: "private_case", legalClass: "non_legal_record" },
    ]),
    (error: unknown) => error instanceof LegalScopeError
      && error.issues.includes("conflicting classifications for sourceId: public-case"),
  );
  assert.throws(
    () => planLegalVerificationScope(request(), [
      ...classifications,
      { sourceId: "not-in-snapshot", visibility: "external_public", legalClass: "enacted_law" },
    ]),
    (error: unknown) => error instanceof LegalScopeError
      && error.issues.includes("classification references unknown sourceId: not-in-snapshot"),
  );
});

test("draft routing selects legal references and leaves unsupported legal propositions for review", () => {
  const plan = planDraftLegalCandidates([
    "WCAT A1802705 applies the policy test.",
    "The statute requires written reasons.",
    "Thank you for your response.",
  ].join("\n\n"));
  assert.ok(plan.some((item) => item.legalReferences.includes("WCAT A1802705")
    && item.action === "VERIFY_EXTERNAL_AUTHORITY"));
  assert.ok(plan.some((item) => item.candidate.text.includes("statute requires")
    && item.action === "REVIEW_SCOPE"));
  assert.ok(plan.some((item) => item.candidate.text.includes("Thank you")
    && item.action === "SKIP_BY_SCOPE"));
});

test("scope plans are deterministic and hash-bound to the subject and routing inventory", () => {
  const first = planLegalVerificationScope(request(), classifications);
  const second = planLegalVerificationScope(request(), [...classifications].reverse());
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.planHash.length, sha256Text("").length);

  const changed = request();
  changed.subject.sha256 = "b".repeat(64);
  changed.coverage.subjectSha256 = changed.subject.sha256;
  assert.notEqual(planLegalVerificationScope(changed, classifications).planHash, first.planHash);

  const reclassified = classifications.map((item) => item.sourceId === "public-case"
    ? { ...item, legalClass: "secondary_commentary" as const }
    : item);
  assert.notEqual(planLegalVerificationScope(request(), reclassified).planHash, first.planHash);
});
