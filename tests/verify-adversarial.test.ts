import assert from "node:assert/strict";
import test from "node:test";
import { buildSemanticAttestation } from "../src/attestation.js";
import { sha256Text } from "../src/canonical.js";
import type { VerificationResult, VerifyRequest } from "../src/types.js";
import { ContractError } from "../src/validate.js";
import { verifyRequest } from "../src/verify.js";

const SUBJECT_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function baseRequest(): VerifyRequest {
  const text = "The exact sentence. The slot is available.";
  return {
    schemaVersion: "0.1.0",
    requestId: "adversarial-001",
    requestedAt: "2026-08-22T19:00:00-07:00",
    domain: "bc-legal",
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
      domain: "bc-legal",
      sources: [
        {
          sourceId: "source-1",
          title: "Authoritative source",
          sourceType: "decision",
          authorityTier: "primary",
          sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          retrievedAt: "2026-08-22T18:50:00-07:00",
          jurisdictions: ["BC"],
          domains: ["bc-legal"],
        },
      ],
      chunks: [
        {
          chunkId: "chunk-1",
          sourceId: "source-1",
          text,
          sha256: sha256Text(text),
          structuredFacts: {
            slotId: "slot-42",
            price: 100,
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
        risk: "high",
        jurisdiction: "BC",
        requiredAuthority: ["primary"],
        citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
        proof: {
          kind: "exact_quote",
          quote: "The exact sentence.",
          normalization: "exact",
        },
      },
    ],
    actions: [],
    policy: {
      policyId: "bc-legal-v1",
      riskTier: "high",
      requireCompleteCoverage: true,
      requireRetrievedCitationClosure: true,
      maxSourceAgeDays: 1,
      trustedSemanticCheckers: ["reviewer@1"],
    },
  };
}

function findingCodes(result: VerificationResult): string[] {
  return result.findings.map((item) => item.code);
}

function assertTextBlocked(result: VerificationResult, code: string): void {
  assert.notEqual(result.decision, "PASS");
  assert.ok(
    findingCodes(result).includes(code),
    `expected ${code}; got ${findingCodes(result).join(", ") || "no findings"}`,
  );
}

function assertActionDenied(result: VerificationResult, code: string): void {
  assert.equal(result.actions[0]?.decision, "DENY");
  assert.ok(
    result.actions[0]?.findings.some((item) => item.code === code),
    `expected ${code}; got ${result.actions[0]?.findings.map((item) => item.code).join(", ")}`,
  );
}

function semanticRequest(): VerifyRequest {
  const request = baseRequest();
  request.claims[0] = {
    claimId: "claim-1",
    text: "The authority supports the proposition.",
    material: true,
    risk: "high",
    jurisdiction: "BC",
    requiredAuthority: ["primary"],
    citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
    proof: { kind: "semantic" },
  };
  return request;
}

function attest(request: VerifyRequest, checkedAt = "2026-08-22T18:55:00-07:00") {
  return buildSemanticAttestation(request, {
    claimId: "claim-1",
    checkerName: "reviewer",
    checkerVersion: "1",
    checkerKind: "human",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Checked against the cited evidence."],
    checkedAt,
  });
}

test("semantic attestation binds source metadata used by the checker", async () => {
  const request = semanticRequest();
  request.semanticAttestations = [attest(request)];
  request.evidence.sources[0]!.title = "Different source identity";
  request.evidence.sources[0]!.sha256 =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  const result = await verifyRequest(request);
  assertTextBlocked(result, "SEMANTIC_ATTESTATION_BINDING_MISMATCH");
});

test("semantic attestation binds structured facts supplied to the checker", async () => {
  const request = semanticRequest();
  request.semanticAttestations = [attest(request)];
  request.evidence.chunks[0]!.structuredFacts = { slotId: "slot-99", price: 999 };

  const result = await verifyRequest(request);
  assertTextBlocked(result, "SEMANTIC_ATTESTATION_BINDING_MISMATCH");
});

test("required authority must be the source that supports a deterministic proof", async () => {
  const request = baseRequest();
  const quote = "Binding legal rule.";
  request.evidence.sources.push({
    sourceId: "source-unknown",
    title: "Unknown source containing the quote",
    sourceType: "unknown",
    authorityTier: "unknown",
    retrievedAt: "2026-08-22T18:50:00-07:00",
    jurisdictions: ["BC"],
    domains: ["bc-legal"],
  });
  request.evidence.chunks[0]!.text = "Unrelated primary material.";
  request.evidence.chunks[0]!.sha256 = sha256Text("Unrelated primary material.");
  request.evidence.chunks.push({
    chunkId: "chunk-unknown",
    sourceId: "source-unknown",
    text: quote,
    sha256: sha256Text(quote),
  });
  request.retrievedChunkIds.push("chunk-unknown");
  request.claims[0] = {
    claimId: "claim-1",
    text: quote,
    material: true,
    risk: "high",
    jurisdiction: "BC",
    requiredAuthority: ["primary"],
    citations: [
      { sourceId: "source-1", chunkId: "chunk-1" },
      { sourceId: "source-unknown", chunkId: "chunk-unknown" },
    ],
    proof: { kind: "exact_quote", quote },
  };

  const result = await verifyRequest(request);
  assertTextBlocked(result, "REQUIRED_AUTHORITY_NOT_SUPPORTING_PROOF");
});

test("request and evidence domains must match", async () => {
  const request = baseRequest();
  request.evidence.domain = "unrelated-domain";
  request.evidence.sources[0]!.domains = ["unrelated-domain"];

  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.includes("evidence.domain must match request domain"),
  );
});

test("an action cannot bind to a chunk with a mismatched content hash", async () => {
  const request = baseRequest();
  request.evidence.chunks.push({
    chunkId: "action-chunk",
    sourceId: "source-1",
    text: "Current slot state.",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    structuredFacts: { slotId: "slot-42" },
  });
  request.retrievedChunkIds.push("action-chunk");
  request.actions = [{
    actionId: "action-1",
    type: "book_slot",
    args: { slotId: "slot-42" },
    bindings: [{
      argPath: "slotId",
      sourceId: "source-1",
      chunkId: "action-chunk",
      field: "slotId",
    }],
  }];
  request.policy.allowedActions = {
    book_slot: {
      requiredArgs: ["slotId"],
      allowedArgs: ["slotId"],
      requireBindings: ["slotId"],
    },
  };

  const result = await verifyRequest(request);
  assertActionDenied(result, "ACTION_CHUNK_HASH_MISMATCH");
});

test("action source bindings obey freshness and effective intervals", async () => {
  const request = baseRequest();
  request.evidence.sources.push({
    sourceId: "stale-source",
    title: "Expired action state",
    sourceType: "availability",
    authorityTier: "primary",
    retrievedAt: "2020-01-01T00:00:00Z",
    effectiveTo: "2020-12-31T00:00:00Z",
    jurisdictions: ["BC"],
    domains: ["bc-legal"],
  });
  request.evidence.chunks.push({
    chunkId: "stale-action-chunk",
    sourceId: "stale-source",
    text: "Old slot state.",
    sha256: sha256Text("Old slot state."),
    structuredFacts: { slotId: "slot-42" },
  });
  request.retrievedChunkIds.push("stale-action-chunk");
  request.actions = [{
    actionId: "action-1",
    type: "book_slot",
    args: { slotId: "slot-42" },
    bindings: [{
      argPath: "slotId",
      sourceId: "stale-source",
      chunkId: "stale-action-chunk",
      field: "slotId",
    }],
  }];
  request.policy.allowedActions = {
    book_slot: {
      requiredArgs: ["slotId"],
      allowedArgs: ["slotId"],
      requireBindings: ["slotId"],
    },
  };

  const result = await verifyRequest(request);
  assertActionDenied(result, "ACTION_SOURCE_STALE");
  assert.ok(result.actions[0]?.findings.some((item) => item.code === "ACTION_SOURCE_EXPIRED"));
});

test("allowlisting an object argument does not silently allow arbitrary descendants", async () => {
  const request = baseRequest();
  request.actions = [{
    actionId: "action-1",
    type: "book_slot",
    args: { booking: { slotId: "slot-42", extra: true } },
    bindings: [{
      argPath: "booking.slotId",
      sourceId: "source-1",
      chunkId: "chunk-1",
      field: "slotId",
    }],
  }];
  request.policy.allowedActions = {
    book_slot: {
      requiredArgs: ["booking.slotId"],
      allowedArgs: ["booking"],
      requireBindings: ["booking.slotId"],
    },
  };

  const result = await verifyRequest(request);
  assertActionDenied(result, "ACTION_ARG_NOT_ALLOWED");
});

test("required argument paths inspect own properties only", async () => {
  const request = baseRequest();
  request.actions = [{ actionId: "action-1", type: "book_slot", args: {}, bindings: [] }];
  request.policy.allowedActions = {
    book_slot: { requiredArgs: ["toString"], allowedArgs: [] },
  };

  const result = await verifyRequest(request);
  assertActionDenied(result, "ACTION_ARG_MISSING");
});

test("action allowlist lookup ignores inherited object properties", async () => {
  const request = baseRequest();
  request.actions = [{ actionId: "action-1", type: "toString", args: {}, bindings: [] }];
  request.policy.allowedActions = {};

  const result = await verifyRequest(request);
  assertActionDenied(result, "ACTION_NOT_ALLOWED");
});

test("future source timestamps fail even without a maximum-age policy", async () => {
  const request = baseRequest();
  delete request.policy.maxSourceAgeDays;
  request.evidence.sources[0]!.retrievedAt = "2030-01-01T00:00:00Z";

  const result = await verifyRequest(request);
  assertTextBlocked(result, "SOURCE_RETRIEVED_IN_FUTURE");
});

test("future semantic attestations cannot support a current request", async () => {
  const request = semanticRequest();
  request.semanticAttestations = [attest(request, "2030-01-01T00:00:00Z")];

  const result = await verifyRequest(request);
  assertTextBlocked(result, "SEMANTIC_ATTESTATION_FROM_FUTURE");
});

test("an unsupported high-risk claim cannot be excluded from aggregation as non-material", async () => {
  const request = baseRequest();
  request.claims.push({
    claimId: "ignored-high-risk",
    text: "Missing legal assertion.",
    material: false,
    risk: "high",
    citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
    proof: { kind: "exact_quote", quote: "Missing legal assertion." },
  });

  const result = await verifyRequest(request);
  assert.equal(result.claims[1]?.verdict, "NOT_FOUND");
  assert.equal(result.decision, "ABSTAIN");
});

test("legacy subject attestations cannot bypass claim metadata binding", async () => {
  const request = semanticRequest();
  request.claims[0]!.material = false;
  request.claims[0]!.risk = "low";
  const legacy = attest(request);
  delete (legacy as Partial<typeof legacy>).claimBindingHash;
  request.claims[0]!.material = true;
  request.claims[0]!.risk = "high";
  request.claims[0]!.asOf = "2030-01-01T00:00:00Z";
  request.semanticAttestations = [legacy];

  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.some((issue) => issue.includes("claimBindingHash")),
  );
});

test("runtime validation rejects properties forbidden by the published schema", async () => {
  const request = baseRequest() as VerifyRequest & { unexpected?: boolean };
  request.unexpected = true;

  await assert.rejects(
    verifyRequest(request),
    (error: unknown) => error instanceof ContractError
      && error.issues.some((issue) => issue.includes("unexpected")),
  );
});
