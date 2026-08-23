import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashObject } from "../src/canonical.js";
import {
  readAuditTrace,
  replayAuditTrace,
  TraceIntegrityError,
  writeAuditTrace,
} from "../src/trace.js";
import type { AuditTrace, VerifyRequest } from "../src/types.js";
import { verifyRequest } from "../src/verify.js";

const SUBJECT_HASH = "a".repeat(64);

function requestFixture(): VerifyRequest {
  return {
    schemaVersion: "0.1.0",
    requestId: "trace-test-001",
    requestedAt: "2026-08-23T12:00:00-07:00",
    domain: "trace-test",
    subject: {
      subjectId: "subject-001",
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
      createdAt: "2026-08-23T11:59:00-07:00",
      domain: "trace-test",
      sources: [{
        sourceId: "source-1",
        title: "Trace fixture source",
        sourceType: "fixture",
        authorityTier: "primary",
      }],
      chunks: [{
        chunkId: "chunk-1",
        sourceId: "source-1",
        text: "The exact sentence.",
      }],
    },
    retrievedChunkIds: ["chunk-1"],
    claims: [{
      claimId: "claim-1",
      text: "The exact sentence.",
      material: true,
      risk: "high",
      citations: [{ sourceId: "source-1", chunkId: "chunk-1" }],
      proof: {
        kind: "exact_quote",
        quote: "The exact sentence.",
        normalization: "exact",
      },
    }],
    policy: {
      policyId: "trace-test-policy",
      riskTier: "high",
      requireCompleteCoverage: true,
      requireRetrievedCitationClosure: true,
    },
  };
}

async function createTrace(request = requestFixture()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ebr-trace-integrity-"));
  const result = await verifyRequest(request);
  return writeAuditTrace(directory, request, result);
}

async function loadRawTrace(path: string): Promise<AuditTrace> {
  return JSON.parse(await readFile(path, "utf8")) as AuditTrace;
}

async function overwriteRawTrace(path: string, trace: AuditTrace): Promise<void> {
  await writeFile(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
}

test("legitimate existing trace format still reads and replays", async () => {
  const path = await createTrace();
  const trace = await readAuditTrace(path);
  assert.equal(trace.inputHash, hashObject(trace.request));
  assert.equal(trace.result.inputHash, trace.inputHash);
  assert.equal(trace.resultHash, hashObject(trace.result));
  const replay = await replayAuditTrace(path);
  assert.equal(replay.matches, true);
  assert.equal(replay.expectedHash, replay.actualHash);
});

test("stored result decision tampering from ABSTAIN to PASS fails closed", async () => {
  const request = requestFixture();
  request.claims[0]!.proof = {
    kind: "exact_quote",
    quote: "A quote absent from the source.",
    normalization: "exact",
  };
  const path = await createTrace(request);
  const trace = await loadRawTrace(path);
  assert.equal(trace.result.decision, "ABSTAIN");
  trace.result.decision = "PASS";
  await overwriteRawTrace(path, trace);

  await assert.rejects(
    readAuditTrace(path),
    (error: unknown) => error instanceof TraceIntegrityError
      && error.issueCodes.includes("TRACE_RESULT_HASH_MISMATCH"),
  );
  await assert.rejects(replayAuditTrace(path), TraceIntegrityError);
});

test("valid request mutation without rebinding hashes fails closed", async () => {
  const path = await createTrace();
  const trace = await loadRawTrace(path);
  trace.request.question = "Tampered but structurally valid question";
  await overwriteRawTrace(path, trace);

  await assert.rejects(
    readAuditTrace(path),
    (error: unknown) => error instanceof TraceIntegrityError
      && error.issueCodes.includes("TRACE_INPUT_HASH_MISMATCH")
      && error.issueCodes.includes("RESULT_INPUT_HASH_MISMATCH"),
  );
});

test("stored trace hash mutation fails closed", async () => {
  const path = await createTrace();
  const trace = await loadRawTrace(path);
  trace.resultHash = "0".repeat(64);
  await overwriteRawTrace(path, trace);

  await assert.rejects(
    readAuditTrace(path),
    (error: unknown) => error instanceof TraceIntegrityError
      && error.issueCodes.includes("TRACE_RESULT_HASH_MISMATCH"),
  );
});

test("result.inputHash must independently bind to the stored request", async () => {
  const path = await createTrace();
  const trace = await loadRawTrace(path);
  trace.result.inputHash = "1".repeat(64);
  trace.resultHash = hashObject(trace.result);
  await overwriteRawTrace(path, trace);

  await assert.rejects(
    readAuditTrace(path),
    (error: unknown) => error instanceof TraceIntegrityError
      && error.issueCodes.includes("RESULT_INPUT_HASH_MISMATCH")
      && !error.issueCodes.includes("TRACE_RESULT_HASH_MISMATCH"),
  );
});

test("internally rehashed tampering is reported by deterministic replay", async () => {
  const path = await createTrace();
  const trace = await loadRawTrace(path);
  const claim = trace.request.claims[0]!;
  assert.equal(claim.proof.kind, "exact_quote");
  claim.proof = {
    kind: "exact_quote",
    quote: "A quote absent from the source.",
    normalization: "exact",
  };
  trace.inputHash = hashObject(trace.request);
  trace.result.inputHash = trace.inputHash;
  trace.resultHash = hashObject(trace.result);
  await overwriteRawTrace(path, trace);

  await readAuditTrace(path);
  const replay = await replayAuditTrace(path);
  assert.equal(replay.matches, false);
  assert.notEqual(replay.actualHash, replay.expectedHash);
  assert.equal(replay.result.decision, "ABSTAIN");
});

test("malformed required result fields fail closed without TypeError", async () => {
  const path = await createTrace();
  const trace = await loadRawTrace(path) as unknown as Record<string, unknown>;
  const result = trace.result as Record<string, unknown>;
  result.claims = "not-an-array";
  await writeFile(path, JSON.stringify(trace), "utf8");

  await assert.rejects(
    replayAuditTrace(path),
    (error: unknown) => error instanceof TraceIntegrityError
      && error.issueCodes.includes("TRACE_INVALID_SHAPE")
      && error.issues.includes("trace.result.claims must be an array")
      && !(error instanceof TypeError),
  );
});
