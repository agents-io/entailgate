import { hashObject, sha256Text } from "./canonical.js";
import type { CandidateAssertion, ClaimInventory } from "./claims.js";
import type { SemanticAttestation } from "./types.js";

export const DRAFT_BINDING_SCHEMA_VERSION = "0.2.0";

export type DraftBindingIssueCode =
  | "INVENTORY_INVALID"
  | "CANDIDATE_INDEX_INVALID"
  | "CANDIDATE_INDEX_OUT_OF_RANGE"
  | "CANDIDATE_INVALID"
  | "ATTESTATION_BINDING_SCOPE_INVALID"
  | "ATTESTATION_SUBJECT_MISMATCH"
  | "ATTESTATION_CLAIM_TEXT_MISMATCH"
  | "WRAPPER_SHAPE_INVALID"
  | "WRAPPER_HASH_MISMATCH";

export class DraftBindingError extends Error {
  constructor(
    public readonly codes: DraftBindingIssueCode[],
    public readonly issues: string[],
  ) {
    super(`Invalid draft candidate binding: ${issues.join("; ")}`);
    this.name = "DraftBindingError";
  }
}

function fail(code: DraftBindingIssueCode, issue: string): never {
  throw new DraftBindingError([code], [issue]);
}

export interface DraftCandidateBinding {
  schemaVersion: "0.2.0";
  kind: "draft-candidate-binding";
  extractorVersion: string;
  subjectSha256: string;
  inventoryHash: string;
  candidateIndex: number;
  candidateHash: string;
  candidateFingerprint: string;
  bindingHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validateInventoryEssentials(inventory: unknown): asserts inventory is ClaimInventory {
  if (!isRecord(inventory)) {
    fail("INVENTORY_INVALID", "inventory must be an object");
  }
  if (!isNonEmptyString(inventory.extractorVersion)) {
    fail("INVENTORY_INVALID", "inventory.extractorVersion is required");
  }
  if (!isSha256Hex(inventory.subjectSha256)) {
    fail("INVENTORY_INVALID", "inventory.subjectSha256 must be lowercase SHA-256");
  }
  if (!Array.isArray(inventory.candidates)) {
    fail("INVENTORY_INVALID", "inventory.candidates must be an array");
  }
}

function validateCandidateIndex(inventory: ClaimInventory, candidateIndex: unknown): asserts candidateIndex is number {
  if (!Number.isSafeInteger(candidateIndex) || (candidateIndex as number) < 0) {
    fail("CANDIDATE_INDEX_INVALID", "candidateIndex must be a safe non-negative integer");
  }
  if ((candidateIndex as number) >= inventory.candidates.length) {
    fail("CANDIDATE_INDEX_OUT_OF_RANGE", "candidateIndex is outside the inventory.candidates range");
  }
}

function candidateAt(inventory: ClaimInventory, candidateIndex: number): CandidateAssertion {
  const candidate = inventory.candidates[candidateIndex];
  if (
    !isRecord(candidate)
    || typeof candidate.text !== "string"
    || !isSha256Hex(candidate.fingerprint)
  ) {
    fail("CANDIDATE_INVALID", "inventory.candidates[candidateIndex] is not a valid candidate assertion");
  }
  return candidate as CandidateAssertion;
}

/**
 * Binds exactly one candidate position (by index into `inventory.candidates`,
 * never by text/fingerprint alone, since duplicate sentences share a fingerprint).
 */
export function buildDraftCandidateBinding(
  inventory: ClaimInventory,
  candidateIndex: number,
): DraftCandidateBinding {
  validateInventoryEssentials(inventory);
  validateCandidateIndex(inventory, candidateIndex);
  const candidate = candidateAt(inventory, candidateIndex);

  const extractorVersion = inventory.extractorVersion;
  const subjectSha256 = inventory.subjectSha256;
  const inventoryHash = hashObject(inventory);
  const candidateHash = hashObject(candidate);
  const candidateFingerprint = candidate.fingerprint;
  const bindingHash = hashObject({
    schemaVersion: DRAFT_BINDING_SCHEMA_VERSION,
    kind: "draft-candidate-binding",
    extractorVersion,
    subjectSha256,
    inventoryHash,
    candidateIndex,
    candidateHash,
    candidateFingerprint,
  });

  return {
    schemaVersion: DRAFT_BINDING_SCHEMA_VERSION,
    kind: "draft-candidate-binding",
    extractorVersion,
    subjectSha256,
    inventoryHash,
    candidateIndex,
    candidateHash,
    candidateFingerprint,
    bindingHash,
  };
}

export interface BoundSemanticAttestation {
  schemaVersion: "0.2.0";
  kind: "bound-semantic-attestation";
  attestation: SemanticAttestation;
  attestationHash: string;
  draftBinding: DraftCandidateBinding;
  boundAttestationHash: string;
}

/**
 * Associates an existing claim-scoped SemanticAttestation with one draft
 * candidate position. This is association only: it never derives or carries
 * a PASS/reuse/evidence-valid verdict. Fingerprint equality is intentionally
 * not required, because isolated (claim-level) and contextual (document-level)
 * fingerprints legitimately differ under headings/context-dependent prose.
 */
export function bindSemanticAttestationToDraftCandidate(
  attestation: SemanticAttestation,
  inventory: ClaimInventory,
  candidateIndex: number,
): BoundSemanticAttestation {
  if (!isRecord(attestation)) {
    fail("WRAPPER_SHAPE_INVALID", "attestation must be an object");
  }
  if (attestation.bindingScope !== "claim") {
    fail("ATTESTATION_BINDING_SCOPE_INVALID", "attestation.bindingScope must be \"claim\"");
  }
  validateInventoryEssentials(inventory);
  if (attestation.subjectSha256 !== inventory.subjectSha256) {
    fail("ATTESTATION_SUBJECT_MISMATCH", "attestation.subjectSha256 does not match inventory.subjectSha256");
  }

  const draftBinding = buildDraftCandidateBinding(inventory, candidateIndex);
  const candidate = candidateAt(inventory, candidateIndex);

  if (attestation.claimTextHash !== sha256Text(candidate.text)) {
    fail(
      "ATTESTATION_CLAIM_TEXT_MISMATCH",
      "attestation.claimTextHash does not match sha256Text(candidate.text)",
    );
  }

  // SemanticAttestation currently has one mutable nested value. Copy it so
  // the wrapper is a stable snapshot rather than an alias to caller state.
  const frozenAttestation: SemanticAttestation = {
    ...attestation,
    reasons: [...attestation.reasons],
  };
  const attestationHash = hashObject(frozenAttestation);
  const boundAttestationHash = hashObject({
    attestationHash,
    bindingHash: draftBinding.bindingHash,
  });

  return {
    schemaVersion: DRAFT_BINDING_SCHEMA_VERSION,
    kind: "bound-semantic-attestation",
    attestation: frozenAttestation,
    attestationHash,
    draftBinding,
    boundAttestationHash,
  };
}

const SEMANTIC_ATTESTATION_KEYS = [
  "claimId",
  "checkerName",
  "checkerVersion",
  "checkerKind",
  "bindingScope",
  "verdict",
  "score",
  "reasons",
  "checkedAt",
  "subjectSha256",
  "snapshotId",
  "claimTextHash",
  "claimFingerprint",
  "claimBindingHash",
  "evidenceHash",
] as const;

const CLAIM_VERDICTS = new Set(["SUPPORTED", "PARTIAL", "CONTRADICTED", "NOT_FOUND"]);

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
  codes: DraftBindingIssueCode[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${label} has unknown property: ${key}`);
      codes.push("WRAPPER_SHAPE_INVALID");
    }
  }
}

function validateNestedAttestation(
  value: unknown,
  issues: string[],
  codes: DraftBindingIssueCode[],
): SemanticAttestation | undefined {
  if (!isRecord(value)) {
    issues.push("attestation must be an object");
    codes.push("WRAPPER_SHAPE_INVALID");
    return undefined;
  }
  rejectUnknownKeys(value, SEMANTIC_ATTESTATION_KEYS, "attestation", issues, codes);
  if (!isNonEmptyString(value.claimId)) {
    issues.push("attestation.claimId is required");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isNonEmptyString(value.checkerName) || !isNonEmptyString(value.checkerVersion)) {
    issues.push("attestation.checkerName and checkerVersion are required");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!["human", "model", "hybrid"].includes(String(value.checkerKind))) {
    issues.push("attestation.checkerKind is invalid");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (value.bindingScope !== "claim") {
    issues.push("attestation.bindingScope must be \"claim\"");
    codes.push("ATTESTATION_BINDING_SCOPE_INVALID");
  }
  if (!CLAIM_VERDICTS.has(String(value.verdict))) {
    issues.push("attestation.verdict is invalid");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (
    typeof value.score !== "number" || !Number.isFinite(value.score)
    || value.score < 0 || value.score > 1
  ) {
    issues.push("attestation.score must be in [0, 1]");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!Array.isArray(value.reasons) || !value.reasons.every((item) => typeof item === "string")) {
    issues.push("attestation.reasons must be an array of strings");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isNonEmptyString(value.checkedAt) || Number.isNaN(Date.parse(value.checkedAt))) {
    issues.push("attestation.checkedAt must be an ISO date/time");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isNonEmptyString(value.snapshotId)) {
    issues.push("attestation.snapshotId is required");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  for (const field of ["subjectSha256", "claimTextHash", "claimBindingHash", "evidenceHash"] as const) {
    if (!isSha256Hex(value[field])) {
      issues.push(`attestation.${field} must be lowercase SHA-256`);
      codes.push("WRAPPER_SHAPE_INVALID");
    }
  }
  if (value.claimFingerprint !== undefined && !isSha256Hex(value.claimFingerprint)) {
    issues.push("attestation.claimFingerprint must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  return issues.length === 0 ? (value as unknown as SemanticAttestation) : undefined;
}

function validateDraftBindingShape(
  value: unknown,
  issues: string[],
  codes: DraftBindingIssueCode[],
): DraftCandidateBinding | undefined {
  if (!isRecord(value)) {
    issues.push("draftBinding must be an object");
    codes.push("WRAPPER_SHAPE_INVALID");
    return undefined;
  }
  rejectUnknownKeys(value, [
    "schemaVersion",
    "kind",
    "extractorVersion",
    "subjectSha256",
    "inventoryHash",
    "candidateIndex",
    "candidateHash",
    "candidateFingerprint",
    "bindingHash",
  ], "draftBinding", issues, codes);
  if (value.schemaVersion !== DRAFT_BINDING_SCHEMA_VERSION) {
    issues.push("draftBinding.schemaVersion must be 0.2.0");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (value.kind !== "draft-candidate-binding") {
    issues.push("draftBinding.kind must be \"draft-candidate-binding\"");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isNonEmptyString(value.extractorVersion)) {
    issues.push("draftBinding.extractorVersion is required");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.subjectSha256)) {
    issues.push("draftBinding.subjectSha256 must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.inventoryHash)) {
    issues.push("draftBinding.inventoryHash must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!Number.isSafeInteger(value.candidateIndex) || (value.candidateIndex as number) < 0) {
    issues.push("draftBinding.candidateIndex must be a safe non-negative integer");
    codes.push("CANDIDATE_INDEX_INVALID");
  }
  if (!isSha256Hex(value.candidateHash)) {
    issues.push("draftBinding.candidateHash must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.candidateFingerprint)) {
    issues.push("draftBinding.candidateFingerprint must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.bindingHash)) {
    issues.push("draftBinding.bindingHash must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  return issues.length === 0 ? (value as unknown as DraftCandidateBinding) : undefined;
}

export function assertBoundSemanticAttestation(value: unknown): asserts value is BoundSemanticAttestation {
  const issues: string[] = [];
  const codes: DraftBindingIssueCode[] = [];

  if (!isRecord(value)) {
    throw new DraftBindingError(["WRAPPER_SHAPE_INVALID"], ["root must be an object"]);
  }
  rejectUnknownKeys(value, [
    "schemaVersion",
    "kind",
    "attestation",
    "attestationHash",
    "draftBinding",
    "boundAttestationHash",
  ], "root", issues, codes);
  if (value.schemaVersion !== DRAFT_BINDING_SCHEMA_VERSION) {
    issues.push("schemaVersion must be 0.2.0");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (value.kind !== "bound-semantic-attestation") {
    issues.push("kind must be \"bound-semantic-attestation\"");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.attestationHash)) {
    issues.push("attestationHash must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }
  if (!isSha256Hex(value.boundAttestationHash)) {
    issues.push("boundAttestationHash must be lowercase SHA-256");
    codes.push("WRAPPER_SHAPE_INVALID");
  }

  const attestation = validateNestedAttestation(value.attestation, issues, codes);
  const draftBinding = validateDraftBindingShape(value.draftBinding, issues, codes);

  if (issues.length > 0) throw new DraftBindingError(codes, issues);
  if (!attestation || !draftBinding) {
    throw new DraftBindingError(["WRAPPER_SHAPE_INVALID"], ["attestation and draftBinding must be valid"]);
  }

  if (attestation.subjectSha256 !== draftBinding.subjectSha256) {
    fail("ATTESTATION_SUBJECT_MISMATCH", "attestation.subjectSha256 does not match draftBinding.subjectSha256");
  }

  const expectedBindingHash = hashObject({
    schemaVersion: draftBinding.schemaVersion,
    kind: draftBinding.kind,
    extractorVersion: draftBinding.extractorVersion,
    subjectSha256: draftBinding.subjectSha256,
    inventoryHash: draftBinding.inventoryHash,
    candidateIndex: draftBinding.candidateIndex,
    candidateHash: draftBinding.candidateHash,
    candidateFingerprint: draftBinding.candidateFingerprint,
  });
  if (expectedBindingHash !== draftBinding.bindingHash) {
    fail("WRAPPER_HASH_MISMATCH", "draftBinding.bindingHash does not match the recomputed hash");
  }

  const expectedAttestationHash = hashObject(attestation);
  if (expectedAttestationHash !== value.attestationHash) {
    fail("WRAPPER_HASH_MISMATCH", "attestationHash does not match hashObject(attestation)");
  }

  const expectedBoundAttestationHash = hashObject({
    attestationHash: expectedAttestationHash,
    bindingHash: draftBinding.bindingHash,
  });
  if (expectedBoundAttestationHash !== value.boundAttestationHash) {
    fail("WRAPPER_HASH_MISMATCH", "boundAttestationHash does not match the recomputed hash");
  }
}
