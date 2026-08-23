import { hashObject } from "./canonical.js";
import type { CandidateAssertion, ClaimInventory, InventoryAction, InventoryComparison } from "./claims.js";
import {
  assertBoundSemanticAttestation,
  DraftBindingError,
  type BoundSemanticAttestation,
} from "./draft-binding.js";

export const PRIOR_MAPPING_SCHEMA_VERSION = "0.2.0";

export type PriorMappingIssueCode =
  | "INPUT_INVALID"
  | "WRAPPER_INVALID"
  | "DUPLICATE_BOUND_ATTESTATION_HASH"
  | "MAPPING_SHAPE_INVALID"
  | "MAPPING_HASH_MISMATCH";

export class PriorMappingError extends Error {
  constructor(
    public readonly codes: PriorMappingIssueCode[],
    public readonly issues: string[],
  ) {
    super(`Invalid prior attestation mapping: ${issues.join("; ")}`);
    this.name = "PriorMappingError";
  }
}

function fail(code: PriorMappingIssueCode, issue: string): never {
  throw new PriorMappingError([code], [issue]);
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export type PriorMappingStatus = "NOT_ATTEMPTED" | "COMPLETE" | "INCOMPLETE";

export type PriorMappingResult =
  | "MATCHED_REUSE_ITEM"
  | "REVALIDATION_REQUIRED"
  | "NOT_IN_PLAN"
  | "AMBIGUOUS";

const RESULT_VALUES = new Set<PriorMappingResult>([
  "MATCHED_REUSE_ITEM",
  "REVALIDATION_REQUIRED",
  "NOT_IN_PLAN",
  "AMBIGUOUS",
]);

const ACTION_VALUES = new Set<InventoryAction>(["REUSE", "REVERIFY", "ADDED", "REMOVED", "UNCERTAIN"]);
const STATUS_VALUES = new Set<PriorMappingStatus>(["NOT_ATTEMPTED", "COMPLETE", "INCOMPLETE"]);

export interface PriorAttestationMappingEntry {
  boundAttestationHash: string;
  attestationHash: string;
  claimId: string;
  candidateBindingHash: string;
  previousCandidateIndex: number;
  planIndex?: number;
  planAction?: InventoryAction;
  result: PriorMappingResult;
  reasons: string[];
}

export interface PriorAttestationMappingReport {
  schemaVersion: "0.2.0";
  kind: "prior-attestation-mapping";
  status: PriorMappingStatus;
  priorAttestationsHash: string;
  entries: PriorAttestationMappingEntry[];
  unmappedBoundAttestationHashes: string[];
  reasons: string[];
  mappingHash: string;
}

const MAPPING_REASONS: readonly string[] = [
  "This mapping is a positional association between a bound attestation and a comparison plan item, established only by canonical hash equality; it is not evidence validation.",
  "A MATCHED_REUSE_ITEM or REVALIDATION_REQUIRED result is not a semantic PASS verdict on the underlying claim.",
  "This mapping does not establish or imply complete automatic claim extraction; the inventory's own coverage statement remains incomplete.",
  "A mapped entry does not authorize reuse of the attestation; reuse authorization is a separate decision made elsewhere.",
];

const NO_FALLBACK_NOTE =
  "No text or fingerprint fallback lookup is performed; a binding that does not exactly match the prior inventory candidate at its own index is not treated as belonging to it.";

function candidateBindingMismatches(
  binding: BoundSemanticAttestation["draftBinding"],
  previousInventory: ClaimInventory,
): string[] {
  const mismatches: string[] = [];
  if (binding.extractorVersion !== previousInventory.extractorVersion) {
    mismatches.push("extractorVersion");
  }
  if (binding.subjectSha256 !== previousInventory.subjectSha256) {
    mismatches.push("subjectSha256");
  }
  const inventoryHash = hashObject(previousInventory);
  if (binding.inventoryHash !== inventoryHash) {
    mismatches.push("inventoryHash");
  }
  if (
    !isSafeNonNegativeInteger(binding.candidateIndex)
    || binding.candidateIndex >= previousInventory.candidates.length
  ) {
    mismatches.push("candidateIndex");
    return mismatches;
  }
  const candidate = previousInventory.candidates[binding.candidateIndex];
  if (!candidate) {
    mismatches.push("candidateIndex");
    return mismatches;
  }
  const candidateHash = hashObject(candidate);
  if (binding.candidateHash !== candidateHash) {
    mismatches.push("candidateHash");
  }
  if (binding.candidateFingerprint !== candidate.fingerprint) {
    mismatches.push("candidateFingerprint");
  }
  return mismatches;
}

function findPlanMatches(
  comparison: InventoryComparison,
  candidateHash: string,
): Array<{ index: number; before: CandidateAssertion; action: InventoryAction }> {
  const matches: Array<{ index: number; before: CandidateAssertion; action: InventoryAction }> = [];
  for (let index = 0; index < comparison.plan.length; index += 1) {
    const item = comparison.plan[index];
    if (!item?.before) continue;
    if (hashObject(item.before) === candidateHash) {
      matches.push({ index, before: item.before, action: item.action });
    }
  }
  return matches;
}

function buildEntry(bound: BoundSemanticAttestation, previousInventory: ClaimInventory, comparison: InventoryComparison): PriorAttestationMappingEntry {
  const binding = bound.draftBinding;
  const base = {
    boundAttestationHash: bound.boundAttestationHash,
    attestationHash: bound.attestationHash,
    claimId: bound.attestation.claimId,
    candidateBindingHash: binding.bindingHash,
    previousCandidateIndex: binding.candidateIndex,
  };

  const mismatches = candidateBindingMismatches(binding, previousInventory);
  if (mismatches.length > 0) {
    return {
      ...base,
      result: "NOT_IN_PLAN",
      reasons: [
        `The bound candidate does not match previousInventory.candidates[${binding.candidateIndex}] on: ${mismatches.join(", ")}.`,
        NO_FALLBACK_NOTE,
      ],
    };
  }

  const matches = findPlanMatches(comparison, binding.candidateHash);
  if (matches.length === 0) {
    return {
      ...base,
      result: "NOT_IN_PLAN",
      reasons: [
        "No comparison plan item's canonical hash of `before` equals the bound candidateHash.",
        NO_FALLBACK_NOTE,
      ],
    };
  }
  if (matches.length > 1) {
    return {
      ...base,
      result: "AMBIGUOUS",
      reasons: [
        `More than one plan item's canonical hash of \`before\` equals the bound candidateHash (plan indices: ${
          matches.map((match) => match.index).join(", ")
        }); no unique plan item can be determined for this candidate.`,
      ],
    };
  }

  const [match] = matches;
  if (!match) {
    return {
      ...base,
      result: "NOT_IN_PLAN",
      reasons: ["No comparison plan item's canonical hash of `before` equals the bound candidateHash.", NO_FALLBACK_NOTE],
    };
  }
  const result: PriorMappingResult = match.action === "REUSE" ? "MATCHED_REUSE_ITEM" : "REVALIDATION_REQUIRED";
  return {
    ...base,
    planIndex: match.index,
    planAction: match.action,
    result,
    reasons: result === "MATCHED_REUSE_ITEM"
      ? [
        `Exactly one plan item (index ${match.index}) has a \`before\` hash equal to the bound candidateHash, with action REUSE.`,
        "This is a positional association only; it is not evidence validation, a semantic PASS, complete extraction, or reuse authorization.",
      ]
      : [
        `Exactly one plan item (index ${match.index}) has a \`before\` hash equal to the bound candidateHash, with action ${match.action} (not REUSE), so revalidation is required.`,
        "This is a positional association only; it is not evidence validation, a semantic PASS, complete extraction, or reuse authorization.",
      ],
  };
}

function compareByBoundAttestationHash(
  left: BoundSemanticAttestation,
  right: BoundSemanticAttestation,
): number {
  return left.boundAttestationHash < right.boundAttestationHash
    ? -1
    : left.boundAttestationHash > right.boundAttestationHash
      ? 1
      : 0;
}

/**
 * Validates every supplied wrapper, rejects a duplicate `boundAttestationHash`,
 * and returns stable copies sorted ascending by that hash.
 *
 * This is the single canonical form. `priorAttestationsHash` is `hashObject`
 * over exactly this array, so a caller that persists the returned array
 * persists the bytes that hash covers, and a reader can recompute the hash
 * from the stored wrappers instead of trusting a stored value.
 */
export function canonicalizeBoundAttestations(
  boundAttestations: readonly unknown[],
): BoundSemanticAttestation[] {
  if (!Array.isArray(boundAttestations)) {
    fail("INPUT_INVALID", "boundAttestations must be an array");
  }
  const canonical: BoundSemanticAttestation[] = [];
  const seenBoundAttestationHashes = new Set<string>();
  for (const candidate of boundAttestations) {
    try {
      assertBoundSemanticAttestation(candidate);
    } catch (error) {
      if (error instanceof DraftBindingError) {
        throw new PriorMappingError(["WRAPPER_INVALID"], error.issues);
      }
      throw error;
    }
    if (seenBoundAttestationHashes.has(candidate.boundAttestationHash)) {
      fail(
        "DUPLICATE_BOUND_ATTESTATION_HASH",
        `Duplicate boundAttestationHash: ${candidate.boundAttestationHash}`,
      );
    }
    seenBoundAttestationHashes.add(candidate.boundAttestationHash);
    canonical.push({
      schemaVersion: candidate.schemaVersion,
      kind: candidate.kind,
      attestation: { ...candidate.attestation, reasons: [...candidate.attestation.reasons] },
      attestationHash: candidate.attestationHash,
      draftBinding: { ...candidate.draftBinding },
      boundAttestationHash: candidate.boundAttestationHash,
    });
  }
  canonical.sort(compareByBoundAttestationHash);
  return canonical;
}

/**
 * Maps previously bound semantic attestations onto a prior inventory's
 * comparison plan, purely by canonical hash equality. This never validates
 * evidence, asserts a semantic PASS, claims complete extraction, or
 * authorizes attestation reuse; it only records a positional association.
 */
export function mapPriorAttestations(
  previousInventory: ClaimInventory,
  comparison: InventoryComparison,
  boundAttestations: readonly unknown[],
): PriorAttestationMappingReport {
  if (
    !isRecord(previousInventory)
    || !isNonEmptyString(previousInventory.extractorVersion)
    || !isSha256Hex(previousInventory.subjectSha256)
    || !Array.isArray(previousInventory.candidates)
    || !previousInventory.candidates.every((candidate) => isRecord(candidate))
  ) {
    fail("INPUT_INVALID", "previousInventory is malformed");
  }
  if (
    !isRecord(comparison)
    || !Array.isArray(comparison.plan)
    || !comparison.plan.every((item) => isRecord(item))
  ) {
    fail("INPUT_INVALID", "comparison is malformed");
  }
  if (!Array.isArray(boundAttestations)) {
    fail("INPUT_INVALID", "boundAttestations must be an array");
  }
  if (boundAttestations.length === 0) {
    const priorAttestationsHash = hashObject([]);
    return {
      schemaVersion: PRIOR_MAPPING_SCHEMA_VERSION,
      kind: "prior-attestation-mapping",
      status: "NOT_ATTEMPTED",
      priorAttestationsHash,
      entries: [],
      unmappedBoundAttestationHashes: [],
      reasons: [...MAPPING_REASONS],
      mappingHash: hashObject({
        schemaVersion: PRIOR_MAPPING_SCHEMA_VERSION,
        kind: "prior-attestation-mapping",
        status: "NOT_ATTEMPTED",
        priorAttestationsHash,
        entries: [],
        unmappedBoundAttestationHashes: [],
        reasons: MAPPING_REASONS,
      }),
    };
  }

  const canonical = canonicalizeBoundAttestations(boundAttestations);
  const priorAttestationsHash = hashObject(canonical);

  const entries = canonical
    .map((bound) => buildEntry(bound, previousInventory, comparison))
    .sort((left, right) =>
      left.boundAttestationHash < right.boundAttestationHash
        ? -1
        : left.boundAttestationHash > right.boundAttestationHash
          ? 1
          : 0
    );

  const unmappedBoundAttestationHashes = entries
    .filter((entry) => entry.result === "NOT_IN_PLAN" || entry.result === "AMBIGUOUS")
    .map((entry) => entry.boundAttestationHash)
    .sort();

  const status: PriorMappingStatus = unmappedBoundAttestationHashes.length === 0 ? "COMPLETE" : "INCOMPLETE";
  const reasons = [...MAPPING_REASONS];

  const mappingHash = hashObject({
    schemaVersion: PRIOR_MAPPING_SCHEMA_VERSION,
    kind: "prior-attestation-mapping",
    status,
    priorAttestationsHash,
    entries,
    unmappedBoundAttestationHashes,
    reasons,
  });

  return {
    schemaVersion: PRIOR_MAPPING_SCHEMA_VERSION,
    kind: "prior-attestation-mapping",
    status,
    priorAttestationsHash,
    entries,
    unmappedBoundAttestationHashes,
    reasons,
    mappingHash,
  };
}

const MAPPING_KEYS = [
  "schemaVersion",
  "kind",
  "status",
  "priorAttestationsHash",
  "entries",
  "unmappedBoundAttestationHashes",
  "reasons",
  "mappingHash",
] as const;

const ENTRY_KEYS = [
  "boundAttestationHash",
  "attestationHash",
  "claimId",
  "candidateBindingHash",
  "previousCandidateIndex",
  "planIndex",
  "planAction",
  "result",
  "reasons",
] as const;

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${label} has unknown property: ${key}`);
  }
}

function validateEntryShape(value: unknown, index: number, issues: string[]): PriorAttestationMappingEntry | undefined {
  if (!isRecord(value)) {
    issues.push(`entries[${index}] must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ENTRY_KEYS, `entries[${index}]`, issues);
  if (!isSha256Hex(value.boundAttestationHash)) issues.push(`entries[${index}].boundAttestationHash must be lowercase SHA-256`);
  if (!isSha256Hex(value.attestationHash)) issues.push(`entries[${index}].attestationHash must be lowercase SHA-256`);
  if (!isNonEmptyString(value.claimId)) issues.push(`entries[${index}].claimId is required`);
  if (!isSha256Hex(value.candidateBindingHash)) issues.push(`entries[${index}].candidateBindingHash must be lowercase SHA-256`);
  if (!isSafeNonNegativeInteger(value.previousCandidateIndex)) {
    issues.push(`entries[${index}].previousCandidateIndex must be a safe non-negative integer`);
  }
  if (!RESULT_VALUES.has(value.result as PriorMappingResult)) issues.push(`entries[${index}].result is invalid`);
  if (!Array.isArray(value.reasons) || !value.reasons.every((item) => typeof item === "string")) {
    issues.push(`entries[${index}].reasons must be an array of strings`);
  }

  const requiresPlan = value.result === "MATCHED_REUSE_ITEM" || value.result === "REVALIDATION_REQUIRED";
  if (requiresPlan) {
    if (!isSafeNonNegativeInteger(value.planIndex)) {
      issues.push(`entries[${index}].planIndex is required when result is ${String(value.result)}`);
    }
    if (!ACTION_VALUES.has(value.planAction as InventoryAction)) {
      issues.push(`entries[${index}].planAction is required and must be valid when result is ${String(value.result)}`);
    }
    if (value.result === "MATCHED_REUSE_ITEM" && value.planAction !== "REUSE") {
      issues.push(`entries[${index}].planAction must be REUSE when result is MATCHED_REUSE_ITEM`);
    }
    if (value.result === "REVALIDATION_REQUIRED" && value.planAction === "REUSE") {
      issues.push(`entries[${index}].planAction must not be REUSE when result is REVALIDATION_REQUIRED`);
    }
  } else {
    if (value.planIndex !== undefined) issues.push(`entries[${index}].planIndex must be absent when result is ${String(value.result)}`);
    if (value.planAction !== undefined) issues.push(`entries[${index}].planAction must be absent when result is ${String(value.result)}`);
  }

  return issues.length === 0 ? (value as unknown as PriorAttestationMappingEntry) : undefined;
}

export function assertPriorAttestationMapping(value: unknown): asserts value is PriorAttestationMappingReport {
  const issues: string[] = [];

  if (!isRecord(value)) {
    throw new PriorMappingError(["MAPPING_SHAPE_INVALID"], ["root must be an object"]);
  }
  rejectUnknownKeys(value, MAPPING_KEYS, "root", issues);
  if (value.schemaVersion !== PRIOR_MAPPING_SCHEMA_VERSION) issues.push("schemaVersion must be 0.2.0");
  if (value.kind !== "prior-attestation-mapping") issues.push("kind must be \"prior-attestation-mapping\"");
  if (!STATUS_VALUES.has(value.status as PriorMappingStatus)) issues.push("status is invalid");
  if (!isSha256Hex(value.priorAttestationsHash)) issues.push("priorAttestationsHash must be lowercase SHA-256");
  if (!isSha256Hex(value.mappingHash)) issues.push("mappingHash must be lowercase SHA-256");
  if (!Array.isArray(value.reasons) || !value.reasons.every((item) => typeof item === "string")) {
    issues.push("reasons must be an array of strings");
  }

  let entries: PriorAttestationMappingEntry[] | undefined;
  if (!Array.isArray(value.entries)) {
    issues.push("entries must be an array");
  } else {
    const parsed: PriorAttestationMappingEntry[] = [];
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = validateEntryShape(value.entries[index], index, issues);
      if (entry) parsed.push(entry);
    }
    if (parsed.length === value.entries.length) entries = parsed;
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1];
      const current = parsed[index];
      if (previous && current && previous.boundAttestationHash >= current.boundAttestationHash) {
        issues.push("entries must be sorted ascending and unique by boundAttestationHash");
      }
    }
  }

  let unmapped: string[] | undefined;
  if (
    !Array.isArray(value.unmappedBoundAttestationHashes)
    || !value.unmappedBoundAttestationHashes.every((item) => isSha256Hex(item))
  ) {
    issues.push("unmappedBoundAttestationHashes must be an array of lowercase SHA-256 hashes");
  } else {
    unmapped = value.unmappedBoundAttestationHashes as string[];
    for (let index = 1; index < unmapped.length; index += 1) {
      if ((unmapped[index - 1] ?? "") >= (unmapped[index] ?? "")) {
        issues.push("unmappedBoundAttestationHashes must be sorted ascending and unique");
        break;
      }
    }
  }

  if (issues.length === 0 && entries && unmapped) {
    const expectedUnmapped = entries
      .filter((entry) => entry.result === "NOT_IN_PLAN" || entry.result === "AMBIGUOUS")
      .map((entry) => entry.boundAttestationHash)
      .sort();
    if (JSON.stringify(expectedUnmapped) !== JSON.stringify(unmapped)) {
      issues.push("unmappedBoundAttestationHashes does not match the entries whose result is NOT_IN_PLAN or AMBIGUOUS");
    }
    const expectedStatus: PriorMappingStatus = entries.length === 0
      ? "NOT_ATTEMPTED"
      : expectedUnmapped.length === 0
        ? "COMPLETE"
        : "INCOMPLETE";
    if (value.status !== expectedStatus) {
      issues.push(`status must be ${expectedStatus} for the stored entries`);
    }
  }

  if (issues.length > 0) throw new PriorMappingError(["MAPPING_SHAPE_INVALID"], issues);

  const expectedMappingHash = hashObject({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    status: value.status,
    priorAttestationsHash: value.priorAttestationsHash,
    entries: value.entries,
    unmappedBoundAttestationHashes: value.unmappedBoundAttestationHashes,
    reasons: value.reasons,
  });
  if (expectedMappingHash !== value.mappingHash) {
    fail("MAPPING_HASH_MISMATCH", "mappingHash does not match the recomputed hash");
  }
}
