import { hashObject, sha256Text } from "./canonical.js";
import {
  CLAIM_EXTRACTOR_VERSION,
  compareInventories,
  DEFAULT_MAX_FUZZY_COMPARISONS,
  extractClaimInventory,
  type ClaimInventory,
  type InventoryComparison,
  type InventoryComparisonOptions,
} from "./claims.js";
import {
  assertBoundSemanticAttestation,
  DraftBindingError,
  type BoundSemanticAttestation,
} from "./draft-binding.js";
import {
  assertPriorAttestationMapping,
  canonicalizeBoundAttestations,
  mapPriorAttestations,
  PriorMappingError,
  type PriorAttestationMappingReport,
} from "./prior-mapping.js";
import {
  isNonEmptyString,
  isRecord,
  isSha256Hex,
  newTraceId,
  readJsonFile,
  writePrivateJsonArtifact,
} from "./trace-io.js";
import { ENGINE_VERSION } from "./verify.js";

// A revision-plan trace is a separate artifact from the v0.1 AuditTrace. It
// records what a deterministic extraction and comparison produced for one
// previous/current pair so the plan can be integrity-checked and recomputed.
// It carries no decision, no verdict, and no attestation reuse.

export const REVISION_PLAN_TRACE_SCHEMA_VERSION = "0.2.1";
export const REVISION_PLAN_TRACE_KIND = "revision-plan";

export type RevisionSubjectRole = "previous" | "current";

export interface RevisionSubjectText {
  role: RevisionSubjectRole;
  /** Audit identity of the stored text. It is not a semantic verdict. */
  sha256: string;
  text: string;
}

export interface RevisionComparisonOptionsRecord {
  maxFuzzyComparisons: number;
}

/** Every field bound by `artifactHash`. */
export interface RevisionPlanCore {
  schemaVersion: typeof REVISION_PLAN_TRACE_SCHEMA_VERSION;
  kind: typeof REVISION_PLAN_TRACE_KIND;
  engineVersion: string;
  extractorVersion: string;
  comparisonOptions: RevisionComparisonOptionsRecord;
  previousSubject: RevisionSubjectText;
  currentSubject: RevisionSubjectText;
  previousInventoryHash: string;
  currentInventoryHash: string;
  planHash: string;
  /** Canonical hash of the stored `priorAttestations` array. */
  priorAttestationsHash: string;
  priorAttestationMapping: PriorAttestationMappingReport;
  reasons: string[];
}

export interface RevisionPlanTrace extends RevisionPlanCore {
  traceId: string;
  createdAt: string;
  artifactHash: string;
  previousInventory: ClaimInventory;
  currentInventory: ClaimInventory;
  comparison: InventoryComparison;
  /** Canonical, sorted, unique-by-`boundAttestationHash` wrappers. */
  priorAttestations: BoundSemanticAttestation[];
}

export interface RevisionPlanInput {
  previousText: string;
  currentText: string;
  options?: InventoryComparisonOptions;
  /**
   * Semantic attestations already bound to a candidate position in the
   * previous draft. Supplying them records a deterministic association with
   * the plan. It never authorizes reuse of any attestation.
   */
  priorAttestations?: readonly BoundSemanticAttestation[];
}

export interface RevisionPlanReplay {
  matches: boolean;
  expectedArtifactHash: string;
  actualArtifactHash: string;
  storedExtractorVersion: string;
  currentExtractorVersion: string;
  extractorVersionMatches: boolean;
  storedEngineVersion: string;
  currentEngineVersion: string;
  engineVersionMatches: boolean;
  componentMatches: {
    previousInventory: boolean;
    currentInventory: boolean;
    plan: boolean;
    /** The stored wrappers still canonicalize to the stored hash. */
    priorAttestations: boolean;
    /** Remapping the stored wrappers reproduces the stored `mappingHash`. */
    priorAttestationMapping: boolean;
  };
  previousInventory: ClaimInventory;
  currentInventory: ClaimInventory;
  comparison: InventoryComparison;
  priorAttestationMapping: PriorAttestationMappingReport;
  reasons: string[];
}

export type RevisionTraceIntegrityIssue =
  | "REVISION_TRACE_INVALID_JSON"
  | "REVISION_TRACE_INVALID_SHAPE"
  | "REVISION_SUBJECT_TEXT_HASH_MISMATCH"
  | "REVISION_INVENTORY_SUBJECT_MISMATCH"
  | "REVISION_INVENTORY_EXTRACTOR_MISMATCH"
  | "REVISION_INVENTORY_HASH_MISMATCH"
  | "REVISION_PLAN_SUBJECT_MISMATCH"
  | "REVISION_PLAN_HASH_MISMATCH"
  | "REVISION_PRIOR_ATTESTATIONS_HASH_MISMATCH"
  | "REVISION_PRIOR_MAPPING_BINDING_MISMATCH"
  | "REVISION_ARTIFACT_HASH_MISMATCH";

export class RevisionTraceIntegrityError extends Error {
  constructor(
    public readonly issues: string[],
    public readonly issueCodes: RevisionTraceIntegrityIssue[],
  ) {
    super(`Invalid revision-plan trace: ${issues.join("; ")}`);
    this.name = "RevisionTraceIntegrityError";
  }
}

const REVISION_PLAN_REASONS: readonly string[] = [
  "Each subject SHA-256 is the audit identity of the stored text. It is not a semantic verdict and it does not by itself invalidate any claim.",
  "artifactHash binds the engine version, the extractor version, the fuzzy-comparison budget, both stored subject texts, and the canonical inventory and plan hashes. It deliberately excludes traceId and createdAt so the same revision reproduces the same artifactHash.",
  "traceId and createdAt are therefore envelope metadata, not authenticated provenance: they are outside artifactHash and an edit to either is not detectable from this artifact alone.",
  "REUSE inside the plan means a protected claim fingerprint is unchanged. It does not assert that the claim is true, that its evidence still supports it, or that extraction was complete.",
  "priorAttestations holds the bound semantic attestations supplied for the previous draft, canonicalized and sorted by boundAttestationHash. artifactHash binds their canonical hash and the prior-attestation mapping, so neither can be added, dropped, or reordered without breaking this artifact.",
  "Each attestation is associated with a plan item through the explicit draft-candidate binding it carries, never through a fingerprint coincidence: an isolated claim fingerprint binds an empty heading path, while an in-draft candidate fingerprint binds heading path, heading levels, semantic role, and antecedent context.",
  "The mapping proves association and deterministic recomputation only. It is not evidence validation, not a semantic verdict, and not proof that the checker or model that produced an attestation can be trusted, that its citations are correct, that its sources are current, or that its jurisdiction is right.",
  "A MATCHED_REUSE_ITEM entry, and a COMPLETE mapping status, are not reuse authorization. Whether a prior attestation may be reused stays a verifier-policy decision made outside this artifact.",
  "A COMPLETE mapping status means only that every supplied attestation was associated with exactly one plan item. It says nothing about attestations nobody supplied, and it does not make automatic extraction complete.",
];

const PLAN_ACTIONS = new Set(["REUSE", "REVERIFY", "ADDED", "REMOVED", "UNCERTAIN"]);
const REVIEW_KINDS = new Set(["NONE", "MATERIALITY", "SOURCE_SUPPORT"]);
const CLASSIFICATIONS = new Set(["MATERIAL_CANDIDATE", "PROSE_ONLY"]);
const SEMANTIC_ROLES = new Set(["assertion", "heading", "fenced_code", "indented_code"]);
const UNCERTAINTY_LEVELS = new Set(["LOW", "MEDIUM", "HIGH"]);
const MATERIAL_SIGNAL_KINDS = new Set([
  "citation",
  "quotation",
  "date",
  "number",
  "legal_section",
  "deadline",
  "remedy",
  "actor_attribution",
  "legal_proposition",
]);
const COVERAGE_METHOD = "deterministic_candidate_extraction";

// Every object in this artifact is closed, matching additionalProperties:false
// in schemas/revision-plan-trace.schema.json. An unknown top-level key is the
// dangerous case: artifactHash binds a fixed field list, so anything smuggled
// alongside it would ride along unauthenticated.
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "traceId",
  "createdAt",
  "engineVersion",
  "extractorVersion",
  "comparisonOptions",
  "previousSubject",
  "currentSubject",
  "previousInventoryHash",
  "currentInventoryHash",
  "planHash",
  "artifactHash",
  "priorAttestationsHash",
  "priorAttestationMapping",
  "reasons",
  "previousInventory",
  "currentInventory",
  "comparison",
  "priorAttestations",
] as const;
const SUBJECT_KEYS = ["role", "sha256", "text"] as const;
const COMPARISON_OPTIONS_KEYS = ["maxFuzzyComparisons"] as const;
const INVENTORY_KEYS = ["extractorVersion", "subjectSha256", "candidates", "coverage"] as const;
const COVERAGE_KEYS = ["complete", "method", "reasons"] as const;
const CANDIDATE_KEYS = [
  "text",
  "normalizedText",
  "fingerprint",
  "comparisonFingerprint",
  "comparisonTokens",
  "classification",
  "material",
  "materialSignals",
  "semanticRole",
  "reasons",
  "uncertainty",
  "context",
  "locator",
] as const;
const MATERIAL_SIGNAL_KEYS = ["kind", "value"] as const;
const UNCERTAINTY_KEYS = ["level", "reasons"] as const;
const CONTEXT_KEYS = [
  "headingPath",
  "headingLevels",
  "dependsOnPrevious",
  "priorContextHash",
] as const;
const LOCATOR_KEYS = [
  "blockIndex",
  "sentenceIndex",
  "lineStart",
  "lineEnd",
  "startOffset",
  "endOffset",
] as const;
const COMPARISON_KEYS = [
  "previousSubjectSha256",
  "currentSubjectSha256",
  "wholeDocumentChanged",
  "coverageComplete",
  "fuzzyComparisons",
  "fuzzyComparisonLimitReached",
  "plan",
  "reasons",
] as const;
const PLAN_ITEM_KEYS = [
  "action",
  "requiresRevalidation",
  "reviewKind",
  "reason",
  "before",
  "after",
] as const;

function unknownKeyIssues(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): string[] {
  const permitted = new Set<string>(allowed);
  return Object.keys(value)
    .filter((key) => !permitted.has(key))
    .map((key) => `${label}.${key} is not an allowed property`);
}

function stringArrayIssues(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label} must be an array`];
  return value.every((item) => typeof item === "string")
    ? []
    : [`${label} must contain only strings`];
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function integerArrayIssues(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label} must be an array`];
  return value.every((item) => typeof item === "number" && Number.isSafeInteger(item))
    ? []
    : [`${label} must contain only integers`];
}

// The published schema declares createdAt as a date-time, so the reader
// applies the same rule the v0.1 contract uses for a date.
function isDateTime(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function revisionPlanCore(source: RevisionPlanCore): RevisionPlanCore {
  return {
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    engineVersion: source.engineVersion,
    extractorVersion: source.extractorVersion,
    comparisonOptions: source.comparisonOptions,
    previousSubject: source.previousSubject,
    currentSubject: source.currentSubject,
    previousInventoryHash: source.previousInventoryHash,
    currentInventoryHash: source.currentInventoryHash,
    planHash: source.planHash,
    priorAttestationsHash: source.priorAttestationsHash,
    priorAttestationMapping: source.priorAttestationMapping,
    reasons: source.reasons,
  };
}

/** Canonical identity of one revision plan, excluding traceId and createdAt. */
export function revisionPlanArtifactHash(source: RevisionPlanCore): string {
  return hashObject(revisionPlanCore(source));
}

function materialSignalIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, MATERIAL_SIGNAL_KEYS);
  if (!MATERIAL_SIGNAL_KINDS.has(String(value.kind))) issues.push(`${label}.kind is invalid`);
  if (typeof value.value !== "string") issues.push(`${label}.value must be a string`);
  return issues;
}

function contextIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, CONTEXT_KEYS);
  issues.push(...stringArrayIssues(value.headingPath, `${label}.headingPath`));
  issues.push(...integerArrayIssues(value.headingLevels, `${label}.headingLevels`));
  if (typeof value.dependsOnPrevious !== "boolean") {
    issues.push(`${label}.dependsOnPrevious must be a boolean`);
  }
  // Optional, but when present it is a hash like any other.
  if (value.priorContextHash !== undefined && !isSha256Hex(value.priorContextHash)) {
    issues.push(`${label}.priorContextHash must be lowercase SHA-256`);
  }
  return issues;
}

function locatorIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, LOCATOR_KEYS);
  for (const field of LOCATOR_KEYS) {
    if (!isSafeNonNegativeInteger(value[field])) {
      issues.push(`${label}.${field} must be a non-negative safe integer`);
    }
  }
  // The extractor always emits a locator that spans forwards.
  if (isSafeNonNegativeInteger(value.lineStart) && isSafeNonNegativeInteger(value.lineEnd)
    && value.lineEnd < value.lineStart) {
    issues.push(`${label}.lineEnd must not precede ${label}.lineStart`);
  }
  if (isSafeNonNegativeInteger(value.startOffset) && isSafeNonNegativeInteger(value.endOffset)
    && value.endOffset < value.startOffset) {
    issues.push(`${label}.endOffset must not precede ${label}.startOffset`);
  }
  return issues;
}

function candidateShapeIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, CANDIDATE_KEYS);
  for (const field of ["text", "normalizedText"] as const) {
    if (typeof value[field] !== "string") issues.push(`${label}.${field} must be a string`);
  }
  for (const field of ["fingerprint", "comparisonFingerprint"] as const) {
    if (!isSha256Hex(value[field])) issues.push(`${label}.${field} must be lowercase SHA-256`);
  }
  issues.push(...stringArrayIssues(value.comparisonTokens, `${label}.comparisonTokens`));
  issues.push(...stringArrayIssues(value.reasons, `${label}.reasons`));
  if (typeof value.material !== "boolean") issues.push(`${label}.material must be a boolean`);
  if (!CLASSIFICATIONS.has(String(value.classification))) {
    issues.push(`${label}.classification is invalid`);
  }
  if (!SEMANTIC_ROLES.has(String(value.semanticRole))) {
    issues.push(`${label}.semanticRole is invalid`);
  }
  if (!Array.isArray(value.materialSignals)) {
    issues.push(`${label}.materialSignals must be an array`);
  } else {
    for (const [index, signal] of value.materialSignals.entries()) {
      issues.push(...materialSignalIssues(signal, `${label}.materialSignals[${index}]`));
    }
  }
  if (!isRecord(value.uncertainty)) {
    issues.push(`${label}.uncertainty must be an object`);
  } else {
    issues.push(...unknownKeyIssues(value.uncertainty, `${label}.uncertainty`, UNCERTAINTY_KEYS));
    if (!UNCERTAINTY_LEVELS.has(String(value.uncertainty.level))) {
      issues.push(`${label}.uncertainty.level is invalid`);
    }
    issues.push(...stringArrayIssues(value.uncertainty.reasons, `${label}.uncertainty.reasons`));
  }
  issues.push(...contextIssues(value.context, `${label}.context`));
  issues.push(...locatorIssues(value.locator, `${label}.locator`));
  return issues;
}

function inventoryShapeIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, INVENTORY_KEYS);
  if (!isNonEmptyString(value.extractorVersion)) {
    issues.push(`${label}.extractorVersion must be a non-empty string`);
  }
  if (!isSha256Hex(value.subjectSha256)) {
    issues.push(`${label}.subjectSha256 must be lowercase SHA-256`);
  }
  if (!Array.isArray(value.candidates)) {
    issues.push(`${label}.candidates must be an array`);
  } else {
    for (const [index, candidate] of value.candidates.entries()) {
      issues.push(...candidateShapeIssues(candidate, `${label}.candidates[${index}]`));
    }
  }
  if (!isRecord(value.coverage)) {
    issues.push(`${label}.coverage must be an object`);
  } else {
    issues.push(...unknownKeyIssues(value.coverage, `${label}.coverage`, COVERAGE_KEYS));
    if (value.coverage.complete !== false) {
      issues.push(`${label}.coverage.complete must be false for automatic extraction`);
    }
    if (value.coverage.method !== COVERAGE_METHOD) {
      issues.push(`${label}.coverage.method must be ${COVERAGE_METHOD}`);
    }
    issues.push(...stringArrayIssues(value.coverage.reasons, `${label}.coverage.reasons`));
  }
  return issues;
}

function planItemShapeIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, PLAN_ITEM_KEYS);
  const action = String(value.action);
  if (!PLAN_ACTIONS.has(action)) issues.push(`${label}.action is invalid`);
  if (!REVIEW_KINDS.has(String(value.reviewKind))) issues.push(`${label}.reviewKind is invalid`);
  if (typeof value.requiresRevalidation !== "boolean") {
    issues.push(`${label}.requiresRevalidation must be a boolean`);
  }
  if (!isNonEmptyString(value.reason)) issues.push(`${label}.reason must be a non-empty string`);
  // Only REUSE may waive revalidation and review. A stored plan whose action
  // and consequences disagree is rejected instead of read as a reuse licence.
  if (PLAN_ACTIONS.has(action) && typeof value.requiresRevalidation === "boolean") {
    if (value.requiresRevalidation !== (action !== "REUSE")) {
      issues.push(`${label}.requiresRevalidation contradicts ${label}.action`);
    }
  }
  if (PLAN_ACTIONS.has(action) && REVIEW_KINDS.has(String(value.reviewKind))) {
    if ((value.reviewKind === "NONE") !== (action === "REUSE")) {
      issues.push(`${label}.reviewKind contradicts ${label}.action`);
    }
  }
  if (value.before !== undefined) {
    issues.push(...candidateShapeIssues(value.before, `${label}.before`));
  }
  if (value.after !== undefined) {
    issues.push(...candidateShapeIssues(value.after, `${label}.after`));
  }
  // The planner pairs each action with a fixed side presence. A forged REUSE
  // or REVERIFY carrying only one side would claim a match that never existed,
  // and an ADDED carrying a `before` would claim a predecessor it never had.
  // UNCERTAIN is the only action allowed any combination, including neither.
  const hasBefore = value.before !== undefined;
  const hasAfter = value.after !== undefined;
  if ((action === "REUSE" || action === "REVERIFY") && !(hasBefore && hasAfter)) {
    issues.push(`${label}.action ${action} requires both ${label}.before and ${label}.after`);
  }
  if (action === "ADDED" && (!hasAfter || hasBefore)) {
    issues.push(`${label}.action ADDED requires ${label}.after and no ${label}.before`);
  }
  if (action === "REMOVED" && (!hasBefore || hasAfter)) {
    issues.push(`${label}.action REMOVED requires ${label}.before and no ${label}.after`);
  }
  return issues;
}

function comparisonShapeIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, COMPARISON_KEYS);
  for (const field of ["previousSubjectSha256", "currentSubjectSha256"] as const) {
    if (!isSha256Hex(value[field])) issues.push(`${label}.${field} must be lowercase SHA-256`);
  }
  if (typeof value.wholeDocumentChanged !== "boolean") {
    issues.push(`${label}.wholeDocumentChanged must be a boolean`);
  }
  if (value.coverageComplete !== false) {
    issues.push(`${label}.coverageComplete must be false for automatic comparison`);
  }
  if (!isSafeNonNegativeInteger(value.fuzzyComparisons)) {
    issues.push(`${label}.fuzzyComparisons must be a non-negative integer`);
  }
  if (typeof value.fuzzyComparisonLimitReached !== "boolean") {
    issues.push(`${label}.fuzzyComparisonLimitReached must be a boolean`);
  }
  if (!Array.isArray(value.plan)) {
    issues.push(`${label}.plan must be an array`);
  } else {
    for (const [index, item] of value.plan.entries()) {
      issues.push(...planItemShapeIssues(item, `${label}.plan[${index}]`));
    }
  }
  issues.push(...stringArrayIssues(value.reasons, `${label}.reasons`));
  return issues;
}

function subjectShapeIssues(value: unknown, label: string, role: RevisionSubjectRole): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, SUBJECT_KEYS);
  // Each side is pinned to its own role, so a swapped pair cannot be read as
  // a revision in the opposite direction.
  if (value.role !== role) issues.push(`${label}.role must be ${role}`);
  if (!isSha256Hex(value.sha256)) issues.push(`${label}.sha256 must be lowercase SHA-256`);
  if (typeof value.text !== "string") issues.push(`${label}.text must be a string`);
  return issues;
}

function issueDetail(error: unknown, fallback: string): string[] {
  if (error instanceof DraftBindingError || error instanceof PriorMappingError) return error.issues;
  return [error instanceof Error ? error.message : fallback];
}

// The wrapper and mapping contracts own their own shape rules, so this reader
// delegates to them rather than restating them. Delegating keeps one source of
// truth; the issues are re-labelled with this artifact's path so a caller can
// still tell which stored object failed.
function priorAttestationsShapeIssues(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label} must be an array`];
  const issues: string[] = [];
  for (const [index, wrapper] of value.entries()) {
    try {
      assertBoundSemanticAttestation(wrapper);
    } catch (error) {
      issues.push(
        ...issueDetail(error, "is not a valid bound semantic attestation")
          .map((issue) => `${label}[${index}] ${issue}`),
      );
    }
  }
  // The stored order is part of the canonical form the hash covers, so a
  // reordered or duplicated array is rejected rather than silently re-sorted.
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1] as { boundAttestationHash?: unknown };
    const current = value[index] as { boundAttestationHash?: unknown };
    if (
      typeof previous?.boundAttestationHash !== "string"
      || typeof current?.boundAttestationHash !== "string"
    ) {
      continue;
    }
    if (previous.boundAttestationHash >= current.boundAttestationHash) {
      issues.push(`${label} must be sorted ascending and unique by boundAttestationHash`);
      break;
    }
  }
  return issues;
}

function priorMappingShapeIssues(value: unknown, label: string): string[] {
  try {
    assertPriorAttestationMapping(value);
    return [];
  } catch (error) {
    return issueDetail(error, "is not a valid prior-attestation mapping")
      .map((issue) => `${label} ${issue}`);
  }
}

function assertRevisionPlanTraceShape(value: unknown): asserts value is RevisionPlanTrace {
  if (!isRecord(value)) {
    throw new RevisionTraceIntegrityError(
      ["revision trace must be an object"],
      ["REVISION_TRACE_INVALID_SHAPE"],
    );
  }
  const issues = unknownKeyIssues(value, "trace", TOP_LEVEL_KEYS);
  if (value.schemaVersion !== REVISION_PLAN_TRACE_SCHEMA_VERSION) {
    issues.push(`trace.schemaVersion must be ${REVISION_PLAN_TRACE_SCHEMA_VERSION}`);
  }
  if (value.kind !== REVISION_PLAN_TRACE_KIND) {
    issues.push(`trace.kind must be ${REVISION_PLAN_TRACE_KIND}`);
  }
  for (const field of ["traceId", "engineVersion", "extractorVersion"] as const) {
    if (!isNonEmptyString(value[field])) {
      issues.push(`trace.${field} must be a non-empty string`);
    }
  }
  if (!isDateTime(value.createdAt)) issues.push("trace.createdAt must be a date-time");
  for (
    const field of [
      "previousInventoryHash",
      "currentInventoryHash",
      "planHash",
      "priorAttestationsHash",
      "artifactHash",
    ] as const
  ) {
    if (!isSha256Hex(value[field])) issues.push(`trace.${field} must be lowercase SHA-256`);
  }
  if (!isRecord(value.comparisonOptions)) {
    issues.push("trace.comparisonOptions must be an object");
  } else {
    issues.push(...unknownKeyIssues(
      value.comparisonOptions,
      "trace.comparisonOptions",
      COMPARISON_OPTIONS_KEYS,
    ));
    if (!isSafeNonNegativeInteger(value.comparisonOptions.maxFuzzyComparisons)) {
      issues.push("trace.comparisonOptions.maxFuzzyComparisons must be a non-negative integer");
    }
  }
  issues.push(...priorMappingShapeIssues(
    value.priorAttestationMapping,
    "trace.priorAttestationMapping",
  ));
  issues.push(...priorAttestationsShapeIssues(value.priorAttestations, "trace.priorAttestations"));
  issues.push(...stringArrayIssues(value.reasons, "trace.reasons"));
  issues.push(...subjectShapeIssues(value.previousSubject, "trace.previousSubject", "previous"));
  issues.push(...subjectShapeIssues(value.currentSubject, "trace.currentSubject", "current"));
  issues.push(...inventoryShapeIssues(value.previousInventory, "trace.previousInventory"));
  issues.push(...inventoryShapeIssues(value.currentInventory, "trace.currentInventory"));
  issues.push(...comparisonShapeIssues(value.comparison, "trace.comparison"));
  if (issues.length > 0) {
    throw new RevisionTraceIntegrityError(issues, ["REVISION_TRACE_INVALID_SHAPE"]);
  }
}

function assertStoredRevisionPlanIntegrity(trace: RevisionPlanTrace): void {
  const issues: string[] = [];
  const issueCodes: RevisionTraceIntegrityIssue[] = [];
  const add = (code: RevisionTraceIntegrityIssue, issue: string): void => {
    issues.push(issue);
    if (!issueCodes.includes(code)) issueCodes.push(code);
  };

  const sides = [
    {
      role: "previous" as const,
      subject: trace.previousSubject,
      inventory: trace.previousInventory,
      storedHash: trace.previousInventoryHash,
      hashField: "previousInventoryHash",
      planField: "previousSubjectSha256" as const,
    },
    {
      role: "current" as const,
      subject: trace.currentSubject,
      inventory: trace.currentInventory,
      storedHash: trace.currentInventoryHash,
      hashField: "currentInventoryHash",
      planField: "currentSubjectSha256" as const,
    },
  ];

  for (const side of sides) {
    // Recomputed from the stored text, so editing the text without rebuilding
    // every binding is rejected before anything downstream reads the plan.
    // This is the same hash extractClaimInventory records as subjectSha256.
    if (side.subject.sha256 !== sha256Text(side.subject.text)) {
      add(
        "REVISION_SUBJECT_TEXT_HASH_MISMATCH",
        `trace.${side.role}Subject.sha256 does not match the stored ${side.role} text`,
      );
    }
    if (side.inventory.subjectSha256 !== side.subject.sha256) {
      add(
        "REVISION_INVENTORY_SUBJECT_MISMATCH",
        `trace.${side.role}Inventory.subjectSha256 does not match trace.${side.role}Subject.sha256`,
      );
    }
    if (side.inventory.extractorVersion !== trace.extractorVersion) {
      add(
        "REVISION_INVENTORY_EXTRACTOR_MISMATCH",
        `trace.${side.role}Inventory.extractorVersion does not match trace.extractorVersion`,
      );
    }
    if (side.storedHash !== hashObject(side.inventory)) {
      add(
        "REVISION_INVENTORY_HASH_MISMATCH",
        `trace.${side.hashField} does not match hashObject(trace.${side.role}Inventory)`,
      );
    }
    if (trace.comparison[side.planField] !== side.subject.sha256) {
      add(
        "REVISION_PLAN_SUBJECT_MISMATCH",
        `trace.comparison.${side.planField} does not match trace.${side.role}Subject.sha256`,
      );
    }
  }

  if (trace.planHash !== hashObject(trace.comparison)) {
    add("REVISION_PLAN_HASH_MISMATCH", "trace.planHash does not match hashObject(trace.comparison)");
  }

  // Recomputed from the stored wrappers. A stored component hash is never
  // trusted on its own, so swapping the wrapper set while keeping the recorded
  // hash, or keeping the wrappers while editing the hash, both fail here.
  if (trace.priorAttestationsHash !== hashObject(trace.priorAttestations)) {
    add(
      "REVISION_PRIOR_ATTESTATIONS_HASH_MISMATCH",
      "trace.priorAttestationsHash does not match hashObject(trace.priorAttestations)",
    );
  }

  // The mapping is only meaningful for the exact attestations stored beside
  // it, so it must name the same hash and the same wrappers, one entry each.
  const mapping = trace.priorAttestationMapping;
  if (mapping.priorAttestationsHash !== trace.priorAttestationsHash) {
    add(
      "REVISION_PRIOR_MAPPING_BINDING_MISMATCH",
      "trace.priorAttestationMapping.priorAttestationsHash does not match trace.priorAttestationsHash",
    );
  }
  if (mapping.entries.length !== trace.priorAttestations.length) {
    add(
      "REVISION_PRIOR_MAPPING_BINDING_MISMATCH",
      "trace.priorAttestationMapping.entries does not have exactly one entry per stored prior attestation",
    );
  } else {
    // Both arrays are validated as sorted and unique by boundAttestationHash,
    // so equal length plus index-wise equality is exact correspondence.
    for (const [index, bound] of trace.priorAttestations.entries()) {
      const entry = mapping.entries[index];
      if (!entry) continue;
      const divergent = [
        entry.boundAttestationHash !== bound.boundAttestationHash ? "boundAttestationHash" : "",
        entry.attestationHash !== bound.attestationHash ? "attestationHash" : "",
        entry.claimId !== bound.attestation.claimId ? "claimId" : "",
        entry.candidateBindingHash !== bound.draftBinding.bindingHash ? "candidateBindingHash" : "",
        entry.previousCandidateIndex !== bound.draftBinding.candidateIndex
          ? "previousCandidateIndex"
          : "",
      ].filter((field) => field !== "");
      if (divergent.length > 0) {
        add(
          "REVISION_PRIOR_MAPPING_BINDING_MISMATCH",
          `trace.priorAttestationMapping.entries[${index}] does not describe trace.priorAttestations[${index}] on: ${divergent.join(", ")}`,
        );
      }
    }
  }
  const storedBoundHashes = new Set(
    trace.priorAttestations.map((bound) => bound.boundAttestationHash),
  );
  for (const hash of mapping.unmappedBoundAttestationHashes) {
    if (!storedBoundHashes.has(hash)) {
      add(
        "REVISION_PRIOR_MAPPING_BINDING_MISMATCH",
        `trace.priorAttestationMapping.unmappedBoundAttestationHashes contains ${hash}, which is not a stored prior attestation`,
      );
    }
  }

  if (trace.artifactHash !== revisionPlanArtifactHash(trace)) {
    add(
      "REVISION_ARTIFACT_HASH_MISMATCH",
      "trace.artifactHash does not match the canonical hash of the bound revision-plan core",
    );
  }
  if (issues.length > 0) throw new RevisionTraceIntegrityError(issues, issueCodes);
}

export function buildRevisionPlanTrace(input: RevisionPlanInput): RevisionPlanTrace {
  const maxFuzzyComparisons = input.options?.maxFuzzyComparisons ?? DEFAULT_MAX_FUZZY_COMPARISONS;
  const previousInventory = extractClaimInventory(input.previousText);
  const currentInventory = extractClaimInventory(input.currentText);
  // compareInventories rejects an unusable budget, so the recorded value is
  // always the exact resolved budget the stored plan was produced with.
  const comparison = compareInventories(previousInventory, currentInventory, {
    maxFuzzyComparisons,
  });
  // One canonical form for the wrappers, so the stored bytes are exactly what
  // priorAttestationsHash covers and what the mapping was computed over.
  // A malformed or duplicated wrapper throws PriorMappingError here.
  const priorAttestations = canonicalizeBoundAttestations(input.priorAttestations ?? []);
  const priorAttestationsHash = hashObject(priorAttestations);
  const priorAttestationMapping = mapPriorAttestations(
    previousInventory,
    comparison,
    priorAttestations,
  );
  if (priorAttestationMapping.priorAttestationsHash !== priorAttestationsHash) {
    throw new RevisionTraceIntegrityError(
      ["the prior-attestation mapping does not bind the canonical prior attestations stored with it"],
      ["REVISION_PRIOR_MAPPING_BINDING_MISMATCH"],
    );
  }
  const core: RevisionPlanCore = {
    schemaVersion: REVISION_PLAN_TRACE_SCHEMA_VERSION,
    kind: REVISION_PLAN_TRACE_KIND,
    engineVersion: ENGINE_VERSION,
    extractorVersion: CLAIM_EXTRACTOR_VERSION,
    comparisonOptions: { maxFuzzyComparisons },
    previousSubject: {
      role: "previous",
      sha256: previousInventory.subjectSha256,
      text: input.previousText,
    },
    currentSubject: {
      role: "current",
      sha256: currentInventory.subjectSha256,
      text: input.currentText,
    },
    previousInventoryHash: hashObject(previousInventory),
    currentInventoryHash: hashObject(currentInventory),
    planHash: hashObject(comparison),
    priorAttestationsHash,
    priorAttestationMapping,
    reasons: [...REVISION_PLAN_REASONS],
  };
  const createdAt = new Date().toISOString();
  return {
    ...core,
    traceId: newTraceId(createdAt),
    createdAt,
    artifactHash: revisionPlanArtifactHash(core),
    previousInventory,
    currentInventory,
    comparison,
    priorAttestations,
  };
}

export async function writeRevisionPlanTrace(
  directory: string,
  input: RevisionPlanInput,
): Promise<string> {
  const trace = buildRevisionPlanTrace(input);
  return writePrivateJsonArtifact(
    directory,
    trace.traceId + ".revision-plan.json",
    trace,
  );
}

export async function readRevisionPlanTrace(path: string): Promise<RevisionPlanTrace> {
  const outcome = await readJsonFile(path);
  if (!outcome.ok) {
    throw new RevisionTraceIntegrityError([outcome.message], ["REVISION_TRACE_INVALID_JSON"]);
  }
  assertRevisionPlanTraceShape(outcome.value);
  assertStoredRevisionPlanIntegrity(outcome.value);
  return outcome.value;
}

/**
 * Recomputes the inventories and the comparison from the stored subject text,
 * remaps the stored bound attestations onto that recomputed plan, and reports
 * whether all of it reproduces the stored artifact hash. A mismatch means the
 * stored plan is not what this extractor produces for that text; it is not by
 * itself a finding about the draft's legal meaning, and a reproduced mapping
 * is an association, never reuse authorization.
 */
export async function replayRevisionPlanTrace(path: string): Promise<RevisionPlanReplay> {
  const trace = await readRevisionPlanTrace(path);
  const previousInventory = extractClaimInventory(trace.previousSubject.text);
  const currentInventory = extractClaimInventory(trace.currentSubject.text);
  const comparison = compareInventories(previousInventory, currentInventory, {
    maxFuzzyComparisons: trace.comparisonOptions.maxFuzzyComparisons,
  });
  const previousInventoryHash = hashObject(previousInventory);
  const currentInventoryHash = hashObject(currentInventory);
  const planHash = hashObject(comparison);
  // Re-derived from the stored wrappers, never copied from the stored hash,
  // and remapped against the inventory and plan this runtime just recomputed.
  const priorAttestations = canonicalizeBoundAttestations(trace.priorAttestations);
  const priorAttestationsHash = hashObject(priorAttestations);
  const priorAttestationMapping = mapPriorAttestations(
    previousInventory,
    comparison,
    priorAttestations,
  );
  const actualArtifactHash = revisionPlanArtifactHash({
    schemaVersion: REVISION_PLAN_TRACE_SCHEMA_VERSION,
    kind: REVISION_PLAN_TRACE_KIND,
    engineVersion: ENGINE_VERSION,
    extractorVersion: CLAIM_EXTRACTOR_VERSION,
    comparisonOptions: trace.comparisonOptions,
    previousSubject: {
      role: "previous",
      sha256: previousInventory.subjectSha256,
      text: trace.previousSubject.text,
    },
    currentSubject: {
      role: "current",
      sha256: currentInventory.subjectSha256,
      text: trace.currentSubject.text,
    },
    previousInventoryHash,
    currentInventoryHash,
    planHash,
    priorAttestationsHash,
    priorAttestationMapping,
    reasons: [...REVISION_PLAN_REASONS],
  });

  const componentMatches = {
    previousInventory: previousInventoryHash === trace.previousInventoryHash,
    currentInventory: currentInventoryHash === trace.currentInventoryHash,
    plan: planHash === trace.planHash,
    priorAttestations: priorAttestationsHash === trace.priorAttestationsHash,
    priorAttestationMapping:
      priorAttestationMapping.mappingHash === trace.priorAttestationMapping.mappingHash,
  };
  const extractorVersionMatches = trace.extractorVersion === CLAIM_EXTRACTOR_VERSION;
  const engineVersionMatches = trace.engineVersion === ENGINE_VERSION;
  const matches = actualArtifactHash === trace.artifactHash;
  const reasons: string[] = [];
  if (!extractorVersionMatches) {
    reasons.push(
      `The stored plan was produced by extractor ${trace.extractorVersion} and this runtime is ${CLAIM_EXTRACTOR_VERSION}, so a difference here does not prove tampering.`,
    );
  }
  if (!engineVersionMatches) {
    reasons.push(
      `The stored plan records engine ${trace.engineVersion} and this runtime is ${ENGINE_VERSION}. artifactHash binds the engine version, so it differs for that reason alone.`,
    );
  }
  if (matches) {
    reasons.push("Recomputation from the stored subject text reproduced the stored artifact hash.");
  } else {
    const diverged = Object.entries(componentMatches)
      .filter(([, same]) => !same)
      .map(([name]) => name);
    if (diverged.length > 0) {
      reasons.push(`Recomputation diverged from the stored artifact in: ${diverged.join(", ")}.`);
      // The wrapper set and the mapping table fail for different reasons, so
      // the report names which one moved instead of blaming the pair.
      if (!componentMatches.priorAttestations) {
        reasons.push(
          "The stored bound attestations do not canonicalize to the stored priorAttestationsHash, so the divergence is in the stored attestation wrappers themselves.",
        );
      } else if (!componentMatches.priorAttestationMapping) {
        reasons.push(
          "The stored bound attestations reproduce their canonical hash, so the divergence is in the recorded prior-attestation mapping: remapping those same wrappers onto the recomputed inventory and plan produces a different mappingHash.",
        );
      }
    } else if (!extractorVersionMatches || !engineVersionMatches) {
      reasons.push(
        "Every recomputed component hash matches the stored plan, so the artifact hash differs only because of the recorded version change above.",
      );
    } else {
      reasons.push(
        "Every recomputed component hash matches the stored plan, so the difference is in the stored artifact core itself: its recorded reasons or prior-attestation mapping text are not the ones this build emits.",
      );
    }
  }
  reasons.push(
    "A matching artifact hash proves deterministic reproduction of the plan only. It is not a semantic verdict on either draft and does not establish complete claim coverage.",
  );
  reasons.push(
    "A reproduced prior-attestation mapping proves association and deterministic recomputation only. It does not authorize reuse of any attestation, and it does not establish that the checker behind an attestation, its evidence, its citations, its source currency, or its jurisdiction can be trusted.",
  );

  return {
    matches,
    expectedArtifactHash: trace.artifactHash,
    actualArtifactHash,
    storedExtractorVersion: trace.extractorVersion,
    currentExtractorVersion: CLAIM_EXTRACTOR_VERSION,
    extractorVersionMatches,
    storedEngineVersion: trace.engineVersion,
    currentEngineVersion: ENGINE_VERSION,
    engineVersionMatches,
    componentMatches,
    previousInventory,
    currentInventory,
    comparison,
    priorAttestationMapping,
    reasons,
  };
}
