import { hashObject } from "./canonical.js";
import {
  isNonEmptyString as nonEmptyString,
  isRecord as record,
  isSha256Hex as validSha256,
  newTraceId,
  readJsonFile,
  writePrivateJsonArtifact,
  type PrivateArtifactWriteOptions,
} from "./trace-io.js";
import type { AuditTrace, VerificationResult, VerifyRequest } from "./types.js";
import { assertVerifyRequest, ContractError } from "./validate.js";
import { ENGINE_VERSION, verifyRequest } from "./verify.js";

export type TraceIntegrityIssue =
  | "TRACE_INVALID_JSON"
  | "TRACE_INVALID_SHAPE"
  | "TRACE_REQUEST_INVALID"
  | "TRACE_INPUT_HASH_MISMATCH"
  | "RESULT_INPUT_HASH_MISMATCH"
  | "TRACE_RESULT_HASH_MISMATCH";

export class TraceIntegrityError extends Error {
  constructor(
    public readonly issues: string[],
    public readonly issueCodes: TraceIntegrityIssue[],
  ) {
    super(`Invalid audit trace: ${issues.join("; ")}`);
    this.name = "TraceIntegrityError";
  }
}

function resultShapeIssues(value: unknown): string[] {
  if (!record(value)) return ["trace.result must be an object"];
  const issues: string[] = [];
  if (value.schemaVersion !== "0.1.0") issues.push("trace.result.schemaVersion must be 0.1.0");
  for (const field of ["engineVersion", "requestId"] as const) {
    if (!nonEmptyString(value[field])) issues.push(`trace.result.${field} must be a non-empty string`);
  }
  if (!validSha256(value.inputHash)) {
    issues.push("trace.result.inputHash must be lowercase SHA-256");
  }
  if (!["PASS", "REWRITE", "ASK", "ABSTAIN", "HUMAN_REVIEW"].includes(String(value.decision))) {
    issues.push("trace.result.decision is invalid");
  }
  if (!["COMPLETE", "INCOMPLETE", "MISMATCH"].includes(String(value.coverage))) {
    issues.push("trace.result.coverage is invalid");
  }
  for (const field of ["claims", "actions", "findings"] as const) {
    if (!Array.isArray(value[field])) issues.push(`trace.result.${field} must be an array`);
  }
  if (Array.isArray(value.claims)) {
    for (const [index, claim] of value.claims.entries()) {
      if (!record(claim)) {
        issues.push(`trace.result.claims[${index}] must be an object`);
      } else if (!record(claim.checkerScores)) {
        issues.push(`trace.result.claims[${index}].checkerScores must be an object`);
      }
    }
  }
  return issues;
}

function assertTraceShape(value: unknown): asserts value is AuditTrace {
  if (!record(value)) {
    throw new TraceIntegrityError(["trace must be an object"], ["TRACE_INVALID_SHAPE"]);
  }
  const issues: string[] = [];
  if (value.schemaVersion !== "0.1.0") issues.push("trace.schemaVersion must be 0.1.0");
  for (const field of ["traceId", "createdAt", "engineVersion"] as const) {
    if (!nonEmptyString(value[field])) issues.push(`trace.${field} must be a non-empty string`);
  }
  for (const field of ["inputHash", "resultHash"] as const) {
    if (!validSha256(value[field])) issues.push(`trace.${field} must be lowercase SHA-256`);
  }
  if (!record(value.request)) issues.push("trace.request must be an object");
  issues.push(...resultShapeIssues(value.result));
  if (issues.length > 0) {
    throw new TraceIntegrityError(issues, ["TRACE_INVALID_SHAPE"]);
  }
}

function assertStoredTraceIntegrity(trace: AuditTrace): void {
  try {
    assertVerifyRequest(trace.request);
  } catch (error) {
    const issues = error instanceof ContractError
      ? error.issues.map((issue) => `trace.request: ${issue}`)
      : ["trace.request is invalid"];
    throw new TraceIntegrityError(issues, ["TRACE_REQUEST_INVALID"]);
  }

  const requestHash = hashObject(trace.request);
  const issues: string[] = [];
  const issueCodes: TraceIntegrityIssue[] = [];
  if (trace.inputHash !== requestHash) {
    issues.push("trace.inputHash does not match hashObject(trace.request)");
    issueCodes.push("TRACE_INPUT_HASH_MISMATCH");
  }
  if (trace.result.inputHash !== requestHash) {
    issues.push("trace.result.inputHash does not match hashObject(trace.request)");
    issueCodes.push("RESULT_INPUT_HASH_MISMATCH");
  }
  if (trace.resultHash !== hashObject(trace.result)) {
    issues.push("trace.resultHash does not match hashObject(trace.result)");
    issueCodes.push("TRACE_RESULT_HASH_MISMATCH");
  }
  if (issues.length > 0) throw new TraceIntegrityError(issues, issueCodes);
}

export async function writeAuditTrace(
  directory: string,
  request: VerifyRequest,
  result: VerificationResult,
  options: PrivateArtifactWriteOptions = {},
): Promise<string> {
  assertVerifyRequest(request);
  const resultIssues = resultShapeIssues(result);
  if (resultIssues.length > 0) {
    throw new TraceIntegrityError(resultIssues, ["TRACE_INVALID_SHAPE"]);
  }
  const inputHash = hashObject(request);
  if (result.inputHash !== inputHash) {
    throw new TraceIntegrityError(
      ["result.inputHash does not match hashObject(request)"],
      ["RESULT_INPUT_HASH_MISMATCH"],
    );
  }
  const createdAt = new Date().toISOString();
  const traceId = newTraceId(createdAt);
  const trace: AuditTrace = {
    schemaVersion: "0.1.0",
    traceId,
    createdAt,
    engineVersion: ENGINE_VERSION,
    inputHash,
    resultHash: hashObject(result),
    request,
    result,
  };
  return writePrivateJsonArtifact(directory, traceId + ".json", trace, options);
}

export async function readAuditTrace(path: string): Promise<AuditTrace> {
  const outcome = await readJsonFile(path);
  if (!outcome.ok) {
    throw new TraceIntegrityError([outcome.message], ["TRACE_INVALID_JSON"]);
  }
  assertTraceShape(outcome.value);
  assertStoredTraceIntegrity(outcome.value);
  return outcome.value;
}

export async function replayAuditTrace(
  path: string,
): Promise<{ matches: boolean; expectedHash: string; actualHash: string; result: VerificationResult }> {
  const trace = await readAuditTrace(path);
  const recordedCheckers = new Set(
    (trace.request.semanticAttestations ?? []).map(
      (item) => item.checkerName + "@" + item.checkerVersion,
    ),
  );
  const hasLiveCheckerResult = trace.result.claims.some(
    (claim) => Object.keys(claim.checkerScores).some((checker) => !recordedCheckers.has(checker)),
  );
  if (hasLiveCheckerResult) {
    throw new Error(
      "This trace used a semantic checker. Replay requires the same pinned checker adapter and is not available in the deterministic-only CLI.",
    );
  }
  const result = await verifyRequest(trace.request);
  const actualHash = hashObject(result);
  return {
    matches: actualHash === trace.resultHash,
    expectedHash: trace.resultHash,
    actualHash,
    result,
  };
}
