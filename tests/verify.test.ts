import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSemanticAttestation } from "../src/attestation.js";
import { sha256File, sha256Text } from "../src/canonical.js";
import { createLegalManifestSkeleton, loadLegalManifest } from "../src/legal.js";
import { replayAuditTrace, writeAuditTrace } from "../src/trace.js";
import type { SemanticChecker, VerifyRequest } from "../src/types.js";
import { ContractError } from "../src/validate.js";
import { semanticEvidenceHash, verifyRequest } from "../src/verify.js";

const SUBJECT_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function baseRequest(): VerifyRequest {
  return {
    schemaVersion: "0.1.0",
    requestId: "test-001",
    requestedAt: "2026-08-22T19:00:00-07:00",
    domain: "test",
    subject: {
      subjectId: "draft-001",
      mediaType: "text/plain",
      sha256: SUBJECT_HASH,
    },
    coverage: {
      complete: true,
      method: "manual_inventory",
      subjectSha256: SUBJECT_HASH,
    },
    evidence: {
      schemaVersion: "0.1.0",
      snapshotId: "snapshot-001",
      createdAt: "2026-08-22T18:50:00-07:00",
      domain: "test",
      sources: [
        {
          sourceId: "source-1",
          title: "Authoritative test source",
          sourceType: "test",
          authorityTier: "primary",
          retrievedAt: "2026-08-22T18:50:00-07:00",
          jurisdictions: ["BC"],
        },
      ],
      chunks: [
        {
          chunkId: "chunk-1",
          sourceId: "source-1",
          text: "The exact sentence. The slot is available.",
          structuredFacts: {
            slotId: "slot-42",
            price: 100,
            taxRate: 0.12,
          },
        },
      ],
    },
    retrievedChunkIds: ["chunk-1"],
    claims: [
      {
        claimId: "claim-1",
        text: "The exact sentence.",
        material: true,
        risk: "low",
        citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
        proof: {
          kind: "exact_quote",
          quote: "The exact sentence.",
          normalization: "exact",
        },
      },
    ],
    policy: {
      policyId: "test-policy",
      riskTier: "low",
      requireCompleteCoverage: true,
      requireRetrievedCitationClosure: true,
      maxSourceAgeDays: 1,
    },
  };
}

test("passes a valid exact quotation", async () => {
  const result = await verifyRequest(baseRequest());
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");
  assert.equal(result.claims[0]?.assurance, "EXACT");
});

test("a real quote cannot launder an unsupported proposition", async () => {
  const request = baseRequest();
  request.claims[0]!.text = "The exact sentence. Therefore liability is proven.";
  const result = await verifyRequest(request);
  assert.equal(result.decision, "HUMAN_REVIEW");
  assert.equal(result.claims[0]?.verdict, "PARTIAL");
  assert.ok(result.findings.some(
    (item) => item.code === "EXACT_QUOTE_CLAIM_HAS_UNVERIFIED_TEXT",
  ));
});

test("rejects a missing policy gate instead of silently weakening policy", async () => {
  const request = baseRequest();
  delete (request.policy as unknown as Record<string, unknown>).requireCompleteCoverage;
  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.includes("policy.requireCompleteCoverage must be boolean"),
  );
});

test("rejects malformed proof payloads at the contract boundary", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "derived" } as never;
  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.some((issue) => issue.includes("derived operands")),
  );
});

test("filters a fabricated citation ID and fails closed", async () => {
  const request = baseRequest();
  request.policy.riskTier = "high";
  request.claims[0]!.citations = [{ sourceId: "source-1", chunkId: "FAKE-CHUNK" }];
  const result = await verifyRequest(request);
  assert.equal(result.decision, "ABSTAIN");
  assert.deepEqual(result.claims[0]?.validCitations, []);
  assert.ok(result.findings.some((item) => item.code === "UNKNOWN_CITATION"));
});

test("rejects a real chunk outside the retrieval set", async () => {
  const request = baseRequest();
  request.retrievedChunkIds = [];
  const result = await verifyRequest(request);
  assert.equal(result.decision, "REWRITE");
  assert.ok(result.findings.some((item) => item.code === "CITATION_OUTSIDE_RETRIEVAL_SET"));
});

test("rejects altered quotation text", async () => {
  const request = baseRequest();
  const proof = request.claims[0]!.proof;
  assert.equal(proof.kind, "exact_quote");
  if (proof.kind === "exact_quote") proof.quote = "The altered sentence.";
  const result = await verifyRequest(request);
  assert.equal(result.claims[0]?.verdict, "NOT_FOUND");
  assert.ok(result.findings.some((item) => item.code === "QUOTE_NOT_FOUND"));
});

test("verifies a structured fact and detects conflicting cited values", async () => {
  const request = baseRequest();
  request.evidence.chunks.push({
    chunkId: "chunk-2",
    sourceId: "source-1",
    text: "An older slot record.",
    structuredFacts: { slotId: "slot-99" },
  });
  request.retrievedChunkIds.push("chunk-2");
  request.claims[0] = {
    claimId: "claim-slot",
    text: "The slot is slot-42.",
    material: true,
    risk: "medium",
    citations: [
      { sourceId: "source-1", chunkId: "chunk-1" },
      { sourceId: "source-1", chunkId: "chunk-2" },
    ],
    proof: { kind: "structured_fact", field: "slotId", expected: "slot-42" },
  };
  const result = await verifyRequest(request);
  assert.equal(result.claims[0]?.verdict, "PARTIAL");
  assert.equal(result.decision, "HUMAN_REVIEW");
  assert.ok(result.findings.some((item) => item.code === "STRUCTURED_FACT_CONFLICT"));
});

test("recalculates a derived value from evidence-bound operands", async () => {
  const request = baseRequest();
  request.claims[0] = {
    claimId: "claim-tax",
    text: "Tax is $12.",
    material: true,
    risk: "medium",
    citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
    proof: {
      kind: "derived",
      operation: "multiply",
      operands: [100, 0.12],
      expected: 12,
      bindings: [
        {
          operandIndex: 0,
          sourceId: "source-1",
          chunkId: "chunk-1",
          field: "price",
        },
        {
          operandIndex: 1,
          sourceId: "source-1",
          chunkId: "chunk-1",
          field: "taxRate",
        },
      ],
    },
  };
  const result = await verifyRequest(request);
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");

  const derived = request.claims[0]!.proof;
  assert.equal(derived.kind, "derived");
  if (derived.kind === "derived") derived.expected = 13;
  const failed = await verifyRequest(request);
  assert.equal(failed.claims[0]?.verdict, "CONTRADICTED");
  assert.equal(failed.decision, "ABSTAIN");
});

test("requires all derived operands to be evidence-bound", async () => {
  const request = baseRequest();
  request.claims[0] = {
    claimId: "claim-tax",
    text: "Tax is $12.",
    material: true,
    risk: "medium",
    citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
    proof: {
      kind: "derived",
      operation: "multiply",
      operands: [100, 0.12],
      expected: 12,
      bindings: [
        {
          operandIndex: 0,
          sourceId: "source-1",
          chunkId: "chunk-1",
          field: "price",
        },
      ],
    },
  };
  const result = await verifyRequest(request);
  assert.equal(result.claims[0]?.verdict, "NOT_FOUND");
  assert.ok(result.findings.some((item) => item.code === "DERIVED_INPUT_UNBOUND"));
});

test("semantic claim without a checker is never passed", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  const result = await verifyRequest(request);
  assert.equal(result.claims[0]?.verdict, "UNCHECKED");
  assert.equal(result.decision, "HUMAN_REVIEW");
});

test("records a pinned semantic checker result", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  const checker: SemanticChecker = {
    name: "fixture-checker",
    version: "1.0.0",
    async verify() {
      return { verdict: "SUPPORTED", score: 0.96, reasons: ["fixture support"] };
    },
  };
  const result = await verifyRequest(request, { semanticChecker: checker });
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.checkerScores["fixture-checker@1.0.0"], 0.96);
});

test("accepts only a trusted hash-bound semantic attestation", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  request.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  request.semanticAttestations = [buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Full primary source checked in context."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  })];
  const result = await verifyRequest(request);
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");

  request.semanticAttestations[0]!.claimTextHash = sha256Text("older claim text");
  const stale = await verifyRequest(request);
  assert.equal(stale.decision, "HUMAN_REVIEW");
  assert.equal(stale.claims[0]?.verdict, "UNCHECKED");
  assert.ok(
    stale.findings.some((item) => item.code === "SEMANTIC_ATTESTATION_BINDING_MISMATCH"),
  );
});

test("a semantic attestation round-trips when one source supplies multiple chunks", async () => {
  const request = baseRequest();
  request.evidence.chunks.push({
    chunkId: "chunk-2",
    sourceId: "source-1",
    text: "The second cited paragraph supplies the exception.",
  });
  request.retrievedChunkIds.push("chunk-2");
  request.claims[0]!.proof = { kind: "semantic" };
  request.claims[0]!.citations.push({ sourceId: "source-1", chunkId: "chunk-2" });
  request.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  request.semanticAttestations = [buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Both cited paragraphs were checked in context."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  })];

  const result = await verifyRequest(request);
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");
  assert.equal(
    result.findings.some((item) => item.code === "SEMANTIC_ATTESTATION_BINDING_MISMATCH"),
    false,
  );
});

test("a duplicate identical citation is idempotent for semantic attestation evidence", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  request.claims[0]!.citations.push({ sourceId: "source-1", chunkId: "chunk-1" });
  request.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  request.semanticAttestations = [buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["The cited source was checked once."],
  })];
  const result = await verifyRequest(request);
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");
});

test("surfaces a contradicted semantic attestation as an explicit blocker", async () => {
  const request = baseRequest();
  request.policy.riskTier = "high";
  request.claims[0]!.proof = { kind: "semantic" };
  request.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  request.semanticAttestations = [buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "model",
    verdict: "CONTRADICTED",
    score: 1,
    reasons: ["Primary authority contradicts the claim."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  })];
  const result = await verifyRequest(request);
  assert.equal(result.decision, "ABSTAIN");
  assert.equal(result.claims[0]?.verdict, "CONTRADICTED");
  assert.ok(
    result.findings.some(
      (item) => item.code === "SEMANTIC_CLAIM_CONTRADICTED"
        && item.severity === "BLOCKER",
    ),
  );
});

test("reuses an exact claim-scoped attestation after unrelated prose changes", async () => {
  const original = baseRequest();
  original.claims[0]!.selfContained = true;
  original.claims[0]!.proof = { kind: "semantic" };
  original.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  const attestation = buildSemanticAttestation(original, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "model",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["The exact atomic claim and authority were checked."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  });

  const revised = baseRequest();
  revised.claims[0]!.selfContained = true;
  revised.claims[0]!.proof = { kind: "semantic" };
  revised.subject.sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  revised.coverage.subjectSha256 = revised.subject.sha256;
  revised.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  revised.policy.allowClaimScopedAttestations = true;
  revised.semanticAttestations = [attestation];
  const result = await verifyRequest(revised);
  assert.equal(result.decision, "PASS");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");
  assert.ok(
    result.findings.some((item) => item.code === "SEMANTIC_ATTESTATION_CLAIM_SCOPE_REUSED"),
  );

  revised.claims[0]!.asOf = "2026-08-23T19:00:00-07:00";
  const changedBinding = await verifyRequest(revised);
  assert.equal(changedBinding.decision, "HUMAN_REVIEW");
  assert.equal(changedBinding.claims[0]?.verdict, "UNCHECKED");
  delete revised.claims[0]!.asOf;

  revised.claims[0]!.text = "A materially changed claim.";
  const changed = await verifyRequest(revised);
  assert.equal(changed.decision, "HUMAN_REVIEW");
  assert.equal(changed.claims[0]?.verdict, "UNCHECKED");
  assert.ok(
    changed.findings.some((item) => item.code === "SEMANTIC_ATTESTATION_BINDING_MISMATCH"),
  );
});

test("cross-subject claim-scoped reuse requires a complete current inventory even at low risk", async () => {
  const original = baseRequest();
  original.claims[0]!.selfContained = true;
  original.claims[0]!.proof = { kind: "semantic" };
  original.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  const attestation = buildSemanticAttestation(original, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.1.0",
    checkerKind: "human",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Checked against the complete cited source."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  });

  const revised = baseRequest();
  revised.claims[0]!.selfContained = true;
  revised.claims[0]!.proof = { kind: "semantic" };
  revised.subject.sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  revised.coverage.subjectSha256 = revised.subject.sha256;
  revised.coverage.complete = false;
  revised.policy.requireCompleteCoverage = false;
  revised.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.1.0"];
  revised.policy.allowClaimScopedAttestations = true;
  revised.semanticAttestations = [attestation];

  const result = await verifyRequest(revised);
  assert.equal(result.claims[0]?.verdict, "UNCHECKED");
  assert.equal(result.decision, "HUMAN_REVIEW");
  assert.ok(result.findings.some(
    (item) => item.code === "SEMANTIC_ATTESTATION_CLAIM_SCOPE_COVERAGE_INCOMPLETE",
  ));
  assert.equal(result.findings.some(
    (item) => item.code === "SEMANTIC_ATTESTATION_CLAIM_SCOPE_REUSED",
  ), false);
});

test("normalized claim reuse is separately opt-in and limited to the same protected fingerprint", async () => {
  const original = baseRequest();
  original.claims[0]!.selfContained = true;
  original.claims[0]!.text = "Me made the request.";
  original.claims[0]!.proof = { kind: "semantic" };
  original.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.2.0"];
  const attestation = buildSemanticAttestation(original, {
    claimId: "claim-1",
    checkerName: "legal-draft-verifier",
    checkerVersion: "0.2.0",
    checkerKind: "hybrid",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["The protected claim and complete source were checked."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  });
  assert.ok(attestation.claimFingerprint);

  const revised = baseRequest();
  revised.claims[0]!.selfContained = true;
  revised.claims[0]!.text = "I made the request.";
  revised.claims[0]!.proof = { kind: "semantic" };
  revised.subject.sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  revised.coverage.subjectSha256 = revised.subject.sha256;
  revised.policy.trustedSemanticCheckers = ["legal-draft-verifier@0.2.0"];
  revised.policy.allowClaimScopedAttestations = true;
  revised.semanticAttestations = [attestation];

  const exactOnly = await verifyRequest(revised);
  assert.equal(exactOnly.decision, "HUMAN_REVIEW");
  assert.equal(exactOnly.claims[0]?.verdict, "UNCHECKED");

  revised.policy.allowNormalizedClaimReuse = true;
  const normalized = await verifyRequest(revised);
  assert.equal(normalized.decision, "PASS");
  assert.equal(normalized.claims[0]?.verdict, "SUPPORTED");
  assert.ok(normalized.findings.some(
    (item) => item.code === "SEMANTIC_ATTESTATION_NORMALIZED_CLAIM_REUSED",
  ));

  revised.claims[0]!.text = "The employer made the request.";
  const changedActor = await verifyRequest(revised);
  assert.equal(changedActor.decision, "HUMAN_REVIEW");
  assert.equal(changedActor.claims[0]?.verdict, "UNCHECKED");
});

test("normalized claim reuse cannot be enabled without claim-scoped attestations", async () => {
  const request = baseRequest();
  request.policy.allowNormalizedClaimReuse = true;
  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.includes(
        "policy.allowNormalizedClaimReuse requires allowClaimScopedAttestations=true",
      ),
  );
});

test("claim-scoped attestations reject context-dependent claims without an explicit self-contained assertion", () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  assert.throws(
    () => buildSemanticAttestation(request, {
      claimId: "claim-1",
      checkerName: "reviewer",
      checkerVersion: "1",
      checkerKind: "human",
      bindingScope: "claim",
      verdict: "SUPPORTED",
      score: 1,
      reasons: ["Checked."],
    }),
    (error: unknown) => error instanceof ContractError
      && error.issues.includes("claim-scoped attestation requires claim.selfContained=true"),
  );
});

test("attestation builder binds the exact claim and evidence", () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  const attestation = buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "reviewer",
    checkerVersion: "1",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Checked."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  });
  assert.equal(attestation.claimTextHash, sha256Text(request.claims[0]!.text));
  assert.equal(
    attestation.evidenceHash,
    semanticEvidenceHash(
      request.evidence.snapshotId,
      [request.evidence.chunks[0]!],
      [request.evidence.sources[0]!],
      request.domain,
    ),
  );
});

test("replays a recorded semantic attestation without calling a model", async () => {
  const request = baseRequest();
  request.claims[0]!.proof = { kind: "semantic" };
  request.policy.trustedSemanticCheckers = ["reviewer@1"];
  request.semanticAttestations = [buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "reviewer",
    checkerVersion: "1",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Checked."],
    checkedAt: "2026-08-22T19:01:00-07:00",
  })];
  const result = await verifyRequest(request);
  const directory = await mkdtemp(join(tmpdir(), "ebr-attested-trace-"));
  const tracePath = await writeAuditTrace(directory, request, result);
  assert.equal((await replayAuditTrace(tracePath)).matches, true);
});

test("stale and wrong-jurisdiction sources fail", async () => {
  const request = baseRequest();
  request.evidence.sources[0]!.retrievedAt = "2026-07-01T00:00:00Z";
  request.claims[0]!.jurisdiction = "ON";
  const result = await verifyRequest(request);
  assert.equal(result.decision, "REWRITE");
  assert.ok(result.findings.some((item) => item.code === "SOURCE_STALE"));
  assert.ok(result.findings.some((item) => item.code === "SOURCE_JURISDICTION_MISMATCH"));
});

test("a future retrieval timestamp fails provenance freshness", async () => {
  const request = baseRequest();
  request.evidence.sources[0]!.retrievedAt = "2026-08-23T19:00:00-07:00";
  const result = await verifyRequest(request);
  assert.equal(result.decision, "REWRITE");
  assert.ok(result.findings.some((item) => item.code === "SOURCE_RETRIEVED_IN_FUTURE"));
});

test("text pass does not authorize a mismatched action", async () => {
  const request = baseRequest();
  request.actions = [
    {
      actionId: "action-1",
      type: "book_slot",
      args: { slotId: "slot-99", phone: "+16045550123" },
      bindings: [
        {
          argPath: "slotId",
          sourceId: "source-1",
          chunkId: "chunk-1",
          field: "slotId",
        },
      ],
      idempotencyKey: "once-1",
    },
  ];
  request.policy.allowedActions = {
    book_slot: {
      requiredArgs: ["slotId", "phone"],
      allowedArgs: ["slotId", "phone"],
      requireBindings: ["slotId"],
      requireIdempotencyKey: true,
    },
  };
  const result = await verifyRequest(request);
  assert.equal(result.decision, "PASS");
  assert.equal(result.actions[0]?.decision, "DENY");
  assert.ok(result.findings.some((item) => item.code === "ACTION_VALUE_MISMATCH"));
});

test("incomplete high-risk coverage stops at human review", async () => {
  const request = baseRequest();
  request.policy.riskTier = "high";
  request.coverage.complete = false;
  const result = await verifyRequest(request);
  assert.equal(result.coverage, "INCOMPLETE");
  assert.equal(result.decision, "HUMAN_REVIEW");
});

test("high-risk incomplete coverage cannot pass even when the caller disables the policy flag", async () => {
  const request = baseRequest();
  request.policy.riskTier = "high";
  request.policy.requireCompleteCoverage = false;
  request.coverage.complete = false;
  const result = await verifyRequest(request);
  assert.equal(result.coverage, "INCOMPLETE");
  assert.equal(result.claims[0]?.verdict, "SUPPORTED");
  assert.equal(result.decision, "HUMAN_REVIEW");
});

test("a high-risk material claim cannot be downgraded by a low-risk request policy", async () => {
  const request = baseRequest();
  request.claims[0]!.risk = "high";
  request.policy.riskTier = "low";
  request.policy.requireCompleteCoverage = false;
  request.coverage.complete = false;
  const result = await verifyRequest(request);
  assert.equal(result.coverage, "INCOMPLETE");
  assert.equal(result.decision, "HUMAN_REVIEW");
});

test("known contradiction takes precedence over incomplete coverage", async () => {
  const request = baseRequest();
  request.policy.riskTier = "high";
  request.coverage.complete = false;
  request.claims[0] = {
    claimId: "claim-conflict",
    text: "The price is $101.",
    material: true,
    risk: "high",
    citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
    proof: {
      kind: "structured_fact",
      field: "price",
      expected: 101,
    },
  };
  const result = await verifyRequest(request);
  assert.equal(result.coverage, "INCOMPLETE");
  assert.equal(result.claims[0]?.verdict, "CONTRADICTED");
  assert.equal(result.decision, "ABSTAIN");
});

test("trace round-trip is deterministic", async () => {
  const request = baseRequest();
  const result = await verifyRequest(request);
  const directory = await mkdtemp(join(tmpdir(), "ebr-trace-"));
  const tracePath = await writeAuditTrace(directory, request, result);
  const mode = (await import("node:fs/promises")).stat(tracePath);
  assert.equal((await mode).mode & 0o777, 0o600);
  const replay = await replayAuditTrace(tracePath);
  assert.equal(replay.matches, true);
  assert.equal(replay.actualHash, replay.expectedHash);
});

test("legal adapter binds the manifest to the actual draft hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-legal-"));
  const draftPath = join(directory, "draft.md");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(draftPath, "Frozen legal draft.\n", "utf8");
  const actualHash = await sha256File(draftPath);
  const request = baseRequest();
  request.domain = "bc-legal";
  request.evidence.domain = "bc-legal";
  request.policy.riskTier = "high";
  request.subject.sha256 = actualHash;
  request.coverage.subjectSha256 = actualHash;
  request.claims[0]!.jurisdiction = "BC";
  request.claims[0]!.requiredAuthority = ["primary"];
  await writeFile(manifestPath, JSON.stringify(request), "utf8");
  const loaded = await loadLegalManifest(draftPath, manifestPath);
  assert.equal(loaded.subject.sha256, actualHash);

  await writeFile(draftPath, "Substantively edited draft.\n", "utf8");
  await assert.rejects(
    loadLegalManifest(draftPath, manifestPath),
    (error: unknown) => error instanceof ContractError
      && error.issues.some((issue) => issue.includes("draft SHA-256")),
  );
});

test("legal init creates a fail-closed hash-bound skeleton", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-legal-init-"));
  const draftPath = join(directory, "draft.md");
  await writeFile(draftPath, "Frozen legal draft.\n", "utf8");
  const manifest = await createLegalManifestSkeleton(draftPath, "draft.md");
  assert.equal(manifest.domain, "bc-legal");
  assert.equal(manifest.policy.riskTier, "high");
  assert.equal(manifest.coverage.complete, false);
  assert.equal(manifest.subject.sha256, await sha256File(draftPath));
  const result = await verifyRequest(manifest);
  assert.equal(result.decision, "HUMAN_REVIEW");
});

test("chunk hash tampering fails before proof evaluation", async () => {
  const request = baseRequest();
  request.evidence.chunks[0]!.sha256 = sha256Text("different text");
  const result = await verifyRequest(request);
  assert.equal(result.claims[0]?.verdict, "NOT_FOUND");
  assert.ok(result.findings.some((item) => item.code === "CHUNK_HASH_MISMATCH"));
});
