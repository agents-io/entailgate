import { canonicalJson, hashObject, sha256Text } from "./canonical.js";
import type {
  ClaimInventory,
  InventoryAction,
  InventoryComparison,
  InventoryPlanItem,
} from "./claims.js";
import { DraftBindingError, type BoundSemanticAttestation } from "./draft-binding.js";
import {
  PriorMappingError,
  type PriorAttestationMappingEntry,
  type PriorAttestationMappingReport,
  type PriorMappingResult,
  type PriorMappingStatus,
} from "./prior-mapping.js";
import {
  readRevisionPlanTrace,
  replayRevisionPlanTrace,
  RevisionTraceIntegrityError,
  type RevisionPlanReplay,
  type RevisionPlanTrace,
} from "./revision-trace.js";
import {
  isNonEmptyString,
  isRecord,
  isSha256Hex,
  newTraceId,
  readJsonFile,
  writePrivateJsonArtifact,
} from "./trace-io.js";
import { ENGINE_VERSION } from "./verify.js";

// The verifier-policy gate that consumes a revision-plan trace and decides,
// per mapped claim-scoped attestation, whether that attestation may be reused
// for the current draft. It is a separate artifact from the revision-plan
// trace: the trace records what the extractor and the mapping produced, this
// records what one named policy decided about it at one caller-supplied
// instant.
//
// Nothing here weakens the contracts it consumes. The trace still authorizes
// nothing on its own, MATCHED_REUSE_ITEM is still only an association, and
// this gate reads and replays the trace itself rather than accepting an
// in-memory mapping a caller could have assembled by hand.
//
// That closure holds on the read side too. Every exported entry point that can
// yield an authorized decision takes file paths and does its own reading and
// replaying: `evaluateClaimReuse`, `replayClaimReuseAuthorization`, and
// `authorizedClaimReuses`. None of them accepts an in-memory authorization, an
// in-memory replay, or a decision list, so there is no object a caller can
// build that this module will treat as proof.

export const CLAIM_REUSE_AUTHORIZATION_SCHEMA_VERSION = "0.2.0";
export const CLAIM_REUSE_AUTHORIZATION_KIND = "claim-reuse-authorization";

const MILLISECONDS_PER_DAY = 86_400_000;

export type ClaimReuseIssueCode =
  | "POLICY_INPUT_INVALID"
  | "POLICY_DUPLICATE_TRUSTED_CHECKER"
  | "POLICY_CONFLICTING_TRUSTED_CHECKER"
  | "POLICY_DUPLICATE_CLAIM_PIN"
  | "EVALUATION_INPUT_INVALID"
  | "TRACE_NOT_READABLE"
  | "TRACE_CHANGED_DURING_EVALUATION"
  | "TRACE_REPLAY_MISMATCH"
  | "TRACE_ATTESTATION_SET_INCONSISTENT"
  | "AUTHORIZATION_INVALID_JSON"
  | "AUTHORIZATION_INVALID_SHAPE"
  | "AUTHORIZATION_POLICY_NOT_CANONICAL"
  | "AUTHORIZATION_POLICY_HASH_MISMATCH"
  | "AUTHORIZATION_DECISION_INCONSISTENT"
  | "AUTHORIZATION_EVALUATION_HASH_MISMATCH"
  | "AUTHORIZATION_TRACE_BINDING_MISMATCH";

export class ClaimReusePolicyError extends Error {
  constructor(
    public readonly codes: ClaimReuseIssueCode[],
    public readonly issues: string[],
  ) {
    super(`Claim reuse authorization failed closed: ${issues.join("; ")}`);
    this.name = "ClaimReusePolicyError";
  }
}

function fail(code: ClaimReuseIssueCode, issue: string): never {
  throw new ClaimReusePolicyError([code], [issue]);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDateTime(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

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

/* -------------------------------------------------------------------------- */
/* Policy input                                                               */
/* -------------------------------------------------------------------------- */

export type CheckerKind = "human" | "model" | "hybrid";

/**
 * One allowlisted checker identity. Trust is the exact triple, never the name
 * alone: a rebuilt checker at a new version, or the same name switched from a
 * human reviewer to a model, is a different attestor.
 */
export interface TrustedCheckerEntry {
  checkerName: string;
  checkerVersion: string;
  checkerKind: CheckerKind;
}

/**
 * Everything a `SemanticAttestation` cannot prove about one claim, pinned by
 * the caller and bound into `policyHash`.
 *
 * `claimBindingHash` and the `snapshotId`/`evidenceHash` pair are cryptographic
 * gates: the attestation must carry exactly these values, so the claim metadata
 * it was made against (jurisdiction, as-of date, required authority, citations,
 * proof class, materiality, risk) and the cited evidence content are provably
 * the ones this policy authorized. A snapshot ID alone is not enough, because
 * one snapshot serves many claims with different cited subsets.
 *
 * `jurisdiction`, `domain`, and `sourceCurrencyConfirmedAsOf` are caller
 * declarations. This runtime cannot read a jurisdiction, a domain, or a source
 * effective date out of an attestation, so it records what the caller declared,
 * checks the declaration against the policy, and age-gates the confirmation. It
 * does not independently verify any of the three.
 */
export interface ClaimReuseClaimPin {
  claimId: string;
  claimBindingHash: string;
  snapshotId: string;
  evidenceHash: string;
  jurisdiction: string;
  domain: string;
  sourceCurrencyConfirmedAsOf: string;
}

export interface ClaimReusePolicyInput {
  policyId: string;
  domain: string;
  jurisdiction: string;
  minScore: number;
  maxAttestationAgeDays: number;
  maxSourceCurrencyAgeDays: number;
  trustedCheckers: readonly TrustedCheckerEntry[];
  claimPins: readonly ClaimReuseClaimPin[];
}

/** The single canonical form of a policy: copied, sorted, and deduplicated. */
export interface CanonicalClaimReusePolicy {
  policyId: string;
  domain: string;
  jurisdiction: string;
  minScore: number;
  maxAttestationAgeDays: number;
  maxSourceCurrencyAgeDays: number;
  trustedCheckers: TrustedCheckerEntry[];
  claimPins: ClaimReuseClaimPin[];
}

const POLICY_KEYS = [
  "policyId",
  "domain",
  "jurisdiction",
  "minScore",
  "maxAttestationAgeDays",
  "maxSourceCurrencyAgeDays",
  "trustedCheckers",
  "claimPins",
] as const;
const TRUSTED_CHECKER_KEYS = ["checkerName", "checkerVersion", "checkerKind"] as const;
const CLAIM_PIN_KEYS = [
  "claimId",
  "claimBindingHash",
  "snapshotId",
  "evidenceHash",
  "jurisdiction",
  "domain",
  "sourceCurrencyConfirmedAsOf",
] as const;
const CHECKER_KINDS = new Set<string>(["human", "model", "hybrid"]);

function checkerIdentity(entry: TrustedCheckerEntry): string {
  return `${entry.checkerName}@${entry.checkerVersion}/${entry.checkerKind}`;
}

/**
 * Validates a policy, rejects a duplicate or conflicting entry, and returns a
 * deterministically ordered copy. Caller input is never mutated, so two callers
 * that pass the same entries in different orders produce the same `policyHash`.
 */
export function canonicalizeClaimReusePolicy(value: unknown): CanonicalClaimReusePolicy {
  if (!isRecord(value)) fail("POLICY_INPUT_INVALID", "policy must be an object");
  const issues = unknownKeyIssues(value, "policy", POLICY_KEYS);
  for (const field of ["policyId", "domain", "jurisdiction"] as const) {
    if (!isNonEmptyString(value[field])) issues.push(`policy.${field} must be a non-empty string`);
  }
  if (
    typeof value.minScore !== "number"
    || !Number.isFinite(value.minScore)
    || value.minScore < 0
    || value.minScore > 1
  ) {
    issues.push("policy.minScore must be a finite number in [0, 1]");
  }
  for (const field of ["maxAttestationAgeDays", "maxSourceCurrencyAgeDays"] as const) {
    if (!isSafeNonNegativeInteger(value[field])) {
      issues.push(`policy.${field} must be a safe non-negative integer`);
    }
  }
  if (!Array.isArray(value.trustedCheckers)) issues.push("policy.trustedCheckers must be an array");
  if (!Array.isArray(value.claimPins)) issues.push("policy.claimPins must be an array");
  if (issues.length > 0) throw new ClaimReusePolicyError(["POLICY_INPUT_INVALID"], issues);

  const trustedCheckers: TrustedCheckerEntry[] = [];
  for (const [index, entry] of (value.trustedCheckers as readonly unknown[]).entries()) {
    const label = `policy.trustedCheckers[${index}]`;
    if (!isRecord(entry)) fail("POLICY_INPUT_INVALID", `${label} must be an object`);
    const entryIssues = unknownKeyIssues(entry, label, TRUSTED_CHECKER_KEYS);
    for (const field of ["checkerName", "checkerVersion"] as const) {
      if (!isNonEmptyString(entry[field])) {
        entryIssues.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (!CHECKER_KINDS.has(String(entry.checkerKind))) {
      entryIssues.push(`${label}.checkerKind must be human, model, or hybrid`);
    }
    if (entryIssues.length > 0) throw new ClaimReusePolicyError(["POLICY_INPUT_INVALID"], entryIssues);
    trustedCheckers.push({
      checkerName: entry.checkerName as string,
      checkerVersion: entry.checkerVersion as string,
      checkerKind: entry.checkerKind as CheckerKind,
    });
  }
  // An exact repeat is a duplicate. The same name and version carrying a
  // different kind is a conflict: it would silently widen trust from a human
  // reviewer to a model, or the reverse, depending on which entry matched.
  const seenCheckers = new Set<string>();
  const kindByNameVersion = new Map<string, CheckerKind>();
  for (const entry of trustedCheckers) {
    const identity = checkerIdentity(entry);
    if (seenCheckers.has(identity)) {
      fail("POLICY_DUPLICATE_TRUSTED_CHECKER", `duplicate trusted checker: ${identity}`);
    }
    seenCheckers.add(identity);
    const nameVersion = `${entry.checkerName}@${entry.checkerVersion}`;
    const existingKind = kindByNameVersion.get(nameVersion);
    if (existingKind !== undefined && existingKind !== entry.checkerKind) {
      fail(
        "POLICY_CONFLICTING_TRUSTED_CHECKER",
        `conflicting checkerKind for ${nameVersion}: ${existingKind} and ${entry.checkerKind}`,
      );
    }
    kindByNameVersion.set(nameVersion, entry.checkerKind);
  }

  const claimPins: ClaimReuseClaimPin[] = [];
  for (const [index, entry] of (value.claimPins as readonly unknown[]).entries()) {
    const label = `policy.claimPins[${index}]`;
    if (!isRecord(entry)) fail("POLICY_INPUT_INVALID", `${label} must be an object`);
    const entryIssues = unknownKeyIssues(entry, label, CLAIM_PIN_KEYS);
    for (const field of ["claimId", "snapshotId", "jurisdiction", "domain"] as const) {
      if (!isNonEmptyString(entry[field])) {
        entryIssues.push(`${label}.${field} must be a non-empty string`);
      }
    }
    for (const field of ["claimBindingHash", "evidenceHash"] as const) {
      if (!isSha256Hex(entry[field])) entryIssues.push(`${label}.${field} must be lowercase SHA-256`);
    }
    if (!isDateTime(entry.sourceCurrencyConfirmedAsOf)) {
      entryIssues.push(`${label}.sourceCurrencyConfirmedAsOf must be a date-time`);
    }
    if (entryIssues.length > 0) throw new ClaimReusePolicyError(["POLICY_INPUT_INVALID"], entryIssues);
    claimPins.push({
      claimId: entry.claimId as string,
      claimBindingHash: entry.claimBindingHash as string,
      snapshotId: entry.snapshotId as string,
      evidenceHash: entry.evidenceHash as string,
      jurisdiction: entry.jurisdiction as string,
      domain: entry.domain as string,
      sourceCurrencyConfirmedAsOf: entry.sourceCurrencyConfirmedAsOf as string,
    });
  }
  // Exactly one pin per claim. A second entry for the same claim is rejected
  // whether it repeats the first or contradicts it, because a gate that had to
  // choose between two pins would be choosing which evidence to require.
  const seenClaimIds = new Set<string>();
  for (const pin of claimPins) {
    if (seenClaimIds.has(pin.claimId)) {
      fail("POLICY_DUPLICATE_CLAIM_PIN", `more than one claim pin for claimId: ${pin.claimId}`);
    }
    seenClaimIds.add(pin.claimId);
  }

  trustedCheckers.sort((left, right) =>
    checkerIdentity(left).localeCompare(checkerIdentity(right))
  );
  claimPins.sort((left, right) => left.claimId.localeCompare(right.claimId));

  return {
    policyId: value.policyId as string,
    domain: value.domain as string,
    jurisdiction: value.jurisdiction as string,
    minScore: value.minScore as number,
    maxAttestationAgeDays: value.maxAttestationAgeDays as number,
    maxSourceCurrencyAgeDays: value.maxSourceCurrencyAgeDays as number,
    trustedCheckers,
    claimPins,
  };
}

export function claimReusePolicyHash(policy: CanonicalClaimReusePolicy): string {
  return hashObject(policy);
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * - `REUSE_AUTHORIZED`: every deterministic gate passed. The named claim-scoped
 *   attestation may be reused for the one named current-draft candidate, under
 *   this exact policy, at this exact `asOf`. It is not a verification `PASS`,
 *   not a document release, and not a statement that the claim is true.
 * - `REVERIFY_REQUIRED`: the plan deterministically says this claim's protected
 *   surface or binding changed. Run semantic verification again for it.
 * - `POLICY_BLOCKED`: the association is intact but the named policy refused;
 *   for example an untrusted checker, a score below the threshold, a stale or
 *   future timestamp, or a missing or wrong evidence pin.
 * - `HUMAN_REVIEW_REQUIRED`: this runtime cannot deterministically classify the
 *   claim; for example an ambiguous or unmapped association, or a current
 *   candidate that cannot be uniquely identified.
 */
export type ClaimReuseOutcome =
  | "REUSE_AUTHORIZED"
  | "REVERIFY_REQUIRED"
  | "POLICY_BLOCKED"
  | "HUMAN_REVIEW_REQUIRED";

export type ClaimReuseBlockerCode =
  | "MAPPING_STATUS_NOT_COMPLETE"
  | "MAPPING_NOT_IN_PLAN"
  | "MAPPING_AMBIGUOUS"
  | "PLAN_ITEM_UNAVAILABLE"
  | "PLAN_ITEM_INCONSISTENT"
  | "PLAN_ACTION_NOT_REUSE"
  | "CURRENT_CANDIDATE_NOT_IN_INVENTORY"
  | "CURRENT_CANDIDATE_AMBIGUOUS"
  | "ATTESTATION_SUBJECT_NOT_PREVIOUS_DRAFT"
  | "ATTESTATION_CLAIM_TEXT_NOT_PREVIOUS_CANDIDATE"
  | "ATTESTATION_SCOPE_NOT_CLAIM"
  | "ATTESTATION_VERDICT_NOT_SUPPORTED"
  | "ATTESTATION_SCORE_INVALID"
  | "ATTESTATION_SCORE_BELOW_THRESHOLD"
  | "CHECKER_NOT_TRUSTED"
  | "ATTESTATION_CHECKED_AT_INVALID"
  | "ATTESTATION_FROM_FUTURE"
  | "ATTESTATION_STALE"
  | "CLAIM_PIN_MISSING"
  | "CLAIM_BINDING_HASH_MISMATCH"
  | "EVIDENCE_SNAPSHOT_MISMATCH"
  | "EVIDENCE_HASH_MISMATCH"
  | "CLAIM_JURISDICTION_MISMATCH"
  | "CLAIM_DOMAIN_MISMATCH"
  | "SOURCE_CURRENCY_CONFIRMATION_INVALID"
  | "SOURCE_CURRENCY_CONFIRMATION_FROM_FUTURE"
  | "SOURCE_CURRENCY_STALE";

type BlockerClass = "REVIEW" | "REVERIFY" | "POLICY";

// Every blocker is fatal to authorization. The class only routes the refusal:
// REVIEW means this runtime cannot decide, REVERIFY means the plan already
// decided the claim changed, POLICY means the named policy refused.
const BLOCKER_CLASS: Record<ClaimReuseBlockerCode, BlockerClass> = {
  MAPPING_STATUS_NOT_COMPLETE: "REVIEW",
  MAPPING_NOT_IN_PLAN: "REVIEW",
  MAPPING_AMBIGUOUS: "REVIEW",
  PLAN_ITEM_UNAVAILABLE: "REVIEW",
  PLAN_ITEM_INCONSISTENT: "REVIEW",
  PLAN_ACTION_NOT_REUSE: "REVERIFY",
  CURRENT_CANDIDATE_NOT_IN_INVENTORY: "REVIEW",
  CURRENT_CANDIDATE_AMBIGUOUS: "REVIEW",
  ATTESTATION_SUBJECT_NOT_PREVIOUS_DRAFT: "REVIEW",
  ATTESTATION_CLAIM_TEXT_NOT_PREVIOUS_CANDIDATE: "REVIEW",
  ATTESTATION_SCOPE_NOT_CLAIM: "POLICY",
  ATTESTATION_VERDICT_NOT_SUPPORTED: "POLICY",
  ATTESTATION_SCORE_INVALID: "POLICY",
  ATTESTATION_SCORE_BELOW_THRESHOLD: "POLICY",
  CHECKER_NOT_TRUSTED: "POLICY",
  ATTESTATION_CHECKED_AT_INVALID: "POLICY",
  ATTESTATION_FROM_FUTURE: "POLICY",
  ATTESTATION_STALE: "POLICY",
  CLAIM_PIN_MISSING: "POLICY",
  CLAIM_BINDING_HASH_MISMATCH: "POLICY",
  EVIDENCE_SNAPSHOT_MISMATCH: "POLICY",
  EVIDENCE_HASH_MISMATCH: "POLICY",
  CLAIM_JURISDICTION_MISMATCH: "POLICY",
  CLAIM_DOMAIN_MISMATCH: "POLICY",
  SOURCE_CURRENCY_CONFIRMATION_INVALID: "POLICY",
  SOURCE_CURRENCY_CONFIRMATION_FROM_FUTURE: "POLICY",
  SOURCE_CURRENCY_STALE: "POLICY",
};

const BLOCKER_CODES = new Set<string>(Object.keys(BLOCKER_CLASS));

export interface ClaimReuseBlocker {
  code: ClaimReuseBlockerCode;
  message: string;
}

/** The one current-draft candidate a reuse authorization applies to. */
export interface CurrentCandidateBinding {
  index: number;
  hash: string;
  fingerprint: string;
}

export interface ClaimReuseDecision {
  boundAttestationHash: string;
  attestationHash: string;
  claimId: string;
  mappingResult: PriorMappingResult;
  planIndex?: number;
  planAction?: InventoryAction;
  previousCandidateIndex: number;
  previousCandidateHash: string;
  currentCandidate?: CurrentCandidateBinding;
  outcome: ClaimReuseOutcome;
  blockers: ClaimReuseBlocker[];
  reasons: string[];
}

/**
 * Claim-scoped reuse is never document release. Automatic extraction reports
 * incomplete coverage by construction, so this artifact has exactly one
 * document-level status today and says so rather than implying a release path
 * it cannot prove.
 */
export type DocumentReleaseStatus = "DOCUMENT_REVIEW_REQUIRED";

export interface DocumentReleaseCondition {
  status: DocumentReleaseStatus;
  coverageComplete: boolean;
  reasons: string[];
}

export interface ClaimReuseTraceBinding {
  artifactHash: string;
  previousSubjectSha256: string;
  currentSubjectSha256: string;
  priorAttestationsHash: string;
  mappingHash: string;
  mappingStatus: PriorMappingStatus;
}

/** Every field bound by `evaluationHash`. */
export interface ClaimReuseAuthorizationCore {
  schemaVersion: typeof CLAIM_REUSE_AUTHORIZATION_SCHEMA_VERSION;
  kind: typeof CLAIM_REUSE_AUTHORIZATION_KIND;
  engineVersion: string;
  extractorVersion: string;
  asOf: string;
  policyHash: string;
  policy: CanonicalClaimReusePolicy;
  trace: ClaimReuseTraceBinding;
  documentRelease: DocumentReleaseCondition;
  decisions: ClaimReuseDecision[];
  reasons: string[];
}

export interface ClaimReuseAuthorization extends ClaimReuseAuthorizationCore {
  authorizationId: string;
  createdAt: string;
  evaluationHash: string;
}

const AUTHORIZATION_REASONS: readonly string[] = [
  "REUSE_AUTHORIZED authorizes reuse of one claim-scoped semantic attestation for one named current-draft candidate, under the stored policy, at the stored asOf. It is not a verification PASS, not a document release, and not a statement that the claim is true.",
  "Every decision here is claim-scoped. This artifact never produces a whole-document verdict, and a reusable claim never becomes an approved document.",
  "Automatic claim extraction reports incomplete coverage, so the document as a whole still requires a separately validated coverage process and human review even when a claim is reusable.",
  "This runtime cannot read a jurisdiction, a domain, or a source effective date out of a SemanticAttestation. It proves only that the attestation carries exactly the claimBindingHash, snapshotId, and evidenceHash the policy pinned; the jurisdiction, domain, and source-currency confirmation are caller declarations, recorded and age-gated here, not independently verified.",
  "REUSE_AUTHORIZED inherits the extractor's protected-fingerprint judgement that the previous and current candidates are the same claim. It is only as strong as the extractor version recorded in the underlying revision-plan trace.",
  "The gate reads and replays the revision-plan trace itself. A trace that fails to read, that changes during evaluation, or that does not replay to its stored artifact hash yields no authorization at all.",
  "No attestation is authorized unless the prior-attestation mapping status is COMPLETE, so one unmapped or ambiguous attestation refuses the whole batch instead of authorizing its well-formed neighbours.",
  "asOf is a caller-supplied evaluation instant bound into evaluationHash. It is deterministic input, not authenticated time.",
  "authorizationId and createdAt sit outside evaluationHash, so the same trace, policy, and asOf reproduce the same identity. They are envelope metadata, not authenticated provenance.",
  "A stored decision is never authoritative. A reader must replay this artifact against the revision-plan trace, which recomputes every hash and every decision from the trace and the stored policy.",
];

const DOCUMENT_RELEASE_REASONS: readonly string[] = [
  "Automatic candidate extraction never asserts complete coverage, so this artifact cannot release the document.",
  "A claim-scoped REUSE_AUTHORIZED decision saves re-verifying that one claim. It does not satisfy coverage, added-claim, removed-claim, uncertain-claim, action, or authority requirements for the document.",
  "Document release remains a separate decision made against a complete, hash-matched current claim inventory.",
];

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ClaimReuseEvaluationInput {
  /** Path to the revision-plan trace this gate reads and replays itself. */
  revisionPlanTracePath: string;
  policy: ClaimReusePolicyInput;
  /** Caller-supplied deterministic evaluation instant. */
  asOf: string;
}

function wrapTraceError(error: unknown): never {
  if (
    error instanceof RevisionTraceIntegrityError
    || error instanceof PriorMappingError
    || error instanceof DraftBindingError
  ) {
    throw new ClaimReusePolicyError(["TRACE_NOT_READABLE"], error.issues);
  }
  throw new ClaimReusePolicyError(
    ["TRACE_NOT_READABLE"],
    [error instanceof Error ? error.message : "the revision-plan trace could not be read"],
  );
}

/**
 * Reads and replays the trace. Both steps run against the file on disk and the
 * two reads are compared, so a trace swapped between them is caught instead of
 * silently mixing one artifact's wrappers with another's replay.
 */
async function loadReplayedTrace(
  path: unknown,
): Promise<{ trace: RevisionPlanTrace; replay: RevisionPlanReplay }> {
  if (!isNonEmptyString(path)) {
    fail("EVALUATION_INPUT_INVALID", "revisionPlanTracePath must be a non-empty string");
  }
  let trace: RevisionPlanTrace;
  let replay: RevisionPlanReplay;
  try {
    trace = await readRevisionPlanTrace(path);
  } catch (error) {
    wrapTraceError(error);
  }
  try {
    replay = await replayRevisionPlanTrace(path);
  } catch (error) {
    wrapTraceError(error);
  }
  if (replay.expectedArtifactHash !== trace.artifactHash) {
    fail(
      "TRACE_CHANGED_DURING_EVALUATION",
      "the revision-plan trace changed between the integrity read and the replay",
    );
  }
  if (!replay.matches) {
    throw new ClaimReusePolicyError(
      ["TRACE_REPLAY_MISMATCH"],
      [
        "the revision-plan trace does not replay to its stored artifact hash, so no attestation can be authorized from it",
        ...replay.reasons,
      ],
    );
  }
  return { trace, replay };
}

function blocker(code: ClaimReuseBlockerCode, message: string): ClaimReuseBlocker {
  return { code, message };
}

function sortBlockers(blockers: readonly ClaimReuseBlocker[]): ClaimReuseBlocker[] {
  const unique = new Map<string, ClaimReuseBlocker>();
  for (const item of blockers) unique.set(`${item.code}\u0000${item.message}`, item);
  return [...unique.values()].sort((left, right) =>
    left.code === right.code
      ? left.message.localeCompare(right.message)
      : left.code.localeCompare(right.code)
  );
}

function classifyOutcome(blockers: readonly ClaimReuseBlocker[]): ClaimReuseOutcome {
  if (blockers.length === 0) return "REUSE_AUTHORIZED";
  const classes = new Set(blockers.map((item) => BLOCKER_CLASS[item.code]));
  if (classes.has("REVIEW")) return "HUMAN_REVIEW_REQUIRED";
  if (classes.has("REVERIFY")) return "REVERIFY_REQUIRED";
  return "POLICY_BLOCKED";
}

function candidateIndicesByHash(inventory: ClaimInventory): Map<string, number[]> {
  const byHash = new Map<string, number[]>();
  for (const [index, candidate] of inventory.candidates.entries()) {
    const hash = hashObject(candidate);
    const bucket = byHash.get(hash);
    if (bucket) bucket.push(index);
    else byHash.set(hash, [index]);
  }
  return byHash;
}

function planItemAt(comparison: InventoryComparison, index: number): InventoryPlanItem | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= comparison.plan.length) return undefined;
  return comparison.plan[index];
}

interface DecisionContext {
  policy: CanonicalClaimReusePolicy;
  asOf: string;
  asOfMs: number;
  mappingComplete: boolean;
  previousInventory: ClaimInventory;
  currentCandidatesByHash: Map<string, number[]>;
  comparison: InventoryComparison;
}

/** Locates the single current-draft candidate a REUSE plan item points at. */
function bindCurrentCandidate(
  context: DecisionContext,
  item: InventoryPlanItem,
  entry: PriorAttestationMappingEntry,
  previousCandidateHash: string,
): { binding?: CurrentCandidateBinding; blockers: ClaimReuseBlocker[] } {
  const inconsistencies: string[] = [];
  if (item.action !== "REUSE") inconsistencies.push(`its action is ${item.action}`);
  if (item.requiresRevalidation !== false) inconsistencies.push("it still requires revalidation");
  if (item.reviewKind !== "NONE") inconsistencies.push(`its review kind is ${item.reviewKind}`);
  if (entry.planAction !== "REUSE") {
    inconsistencies.push(`the mapping records planAction ${String(entry.planAction)}`);
  }
  if (!item.before || hashObject(item.before) !== previousCandidateHash) {
    inconsistencies.push("its `before` candidate is not the bound previous candidate");
  }
  if (inconsistencies.length > 0) {
    return {
      blockers: [blocker(
        "PLAN_ITEM_INCONSISTENT",
        `The associated plan item cannot support reuse: ${inconsistencies.join("; ")}.`,
      )],
    };
  }
  const after = item.after;
  if (!after) {
    return {
      blockers: [blocker(
        "PLAN_ITEM_INCONSISTENT",
        "The associated plan item carries no `after` candidate, so reuse has nothing to apply to.",
      )],
    };
  }
  const afterHash = hashObject(after);
  const indices = context.currentCandidatesByHash.get(afterHash) ?? [];
  const only = indices.length === 1 ? indices[0] : undefined;
  if (indices.length === 0) {
    return {
      blockers: [blocker(
        "CURRENT_CANDIDATE_NOT_IN_INVENTORY",
        "The plan's current-side candidate is not present in the recomputed current inventory.",
      )],
    };
  }
  if (only === undefined) {
    return {
      blockers: [blocker(
        "CURRENT_CANDIDATE_AMBIGUOUS",
        `The plan's current-side candidate matches more than one current inventory position (${indices.join(", ")}), so reuse cannot name a single claim.`,
      )],
    };
  }
  return {
    binding: { index: only, hash: afterHash, fingerprint: after.fingerprint },
    blockers: [],
  };
}

function decideForEntry(
  context: DecisionContext,
  entry: PriorAttestationMappingEntry,
  bound: BoundSemanticAttestation,
): ClaimReuseDecision {
  const blockers: ClaimReuseBlocker[] = [];
  const attestation = bound.attestation;
  const previousCandidateHash = bound.draftBinding.candidateHash;

  if (!context.mappingComplete) {
    blockers.push(blocker(
      "MAPPING_STATUS_NOT_COMPLETE",
      "The prior-attestation mapping is not COMPLETE, so no attestation in this trace may be reused.",
    ));
  }

  // 1. Association. The mapping already refused to guess; this gate refuses to
  //    reinterpret its refusal as anything softer.
  let currentCandidate: CurrentCandidateBinding | undefined;
  if (entry.result === "NOT_IN_PLAN") {
    blockers.push(blocker(
      "MAPPING_NOT_IN_PLAN",
      "The bound attestation is not associated with any plan item.",
    ));
  } else if (entry.result === "AMBIGUOUS") {
    blockers.push(blocker(
      "MAPPING_AMBIGUOUS",
      "More than one plan item matches this bound candidate, so no unique claim can be reused.",
    ));
  } else if (entry.result === "REVALIDATION_REQUIRED") {
    blockers.push(blocker(
      "PLAN_ACTION_NOT_REUSE",
      `The associated plan item's action is ${String(entry.planAction)}, not REUSE, so this claim must be verified again.`,
    ));
  } else {
    // 2. The plan item itself, and through it the one current candidate that a
    //    reuse authorization would apply to.
    const item = entry.planIndex === undefined
      ? undefined
      : planItemAt(context.comparison, entry.planIndex);
    if (!item) {
      blockers.push(blocker(
        "PLAN_ITEM_UNAVAILABLE",
        "The plan item named by the mapping is outside the recomputed plan.",
      ));
    } else {
      const outcome = bindCurrentCandidate(context, item, entry, previousCandidateHash);
      blockers.push(...outcome.blockers);
      currentCandidate = outcome.binding;
    }
  }

  // 3. The wrapper really describes the previous draft's candidate. The mapping
  //    proves the binding points at that position; it never checks that the
  //    attested claim text is the text sitting at that position.
  if (attestation.subjectSha256 !== context.previousInventory.subjectSha256) {
    blockers.push(blocker(
      "ATTESTATION_SUBJECT_NOT_PREVIOUS_DRAFT",
      "The attestation is bound to a subject hash that is not the previous draft in this trace.",
    ));
  }
  const previousCandidate = context.previousInventory.candidates[entry.previousCandidateIndex];
  if (!previousCandidate || attestation.claimTextHash !== sha256Text(previousCandidate.text)) {
    blockers.push(blocker(
      "ATTESTATION_CLAIM_TEXT_NOT_PREVIOUS_CANDIDATE",
      "The attestation's claimTextHash is not the SHA-256 of the previous-draft candidate it is bound to.",
    ));
  }

  // 4. The attestation's own content.
  if (attestation.bindingScope !== "claim") {
    blockers.push(blocker(
      "ATTESTATION_SCOPE_NOT_CLAIM",
      "Only a claim-scoped attestation can be reused across draft versions.",
    ));
  }
  if (attestation.verdict !== "SUPPORTED") {
    blockers.push(blocker(
      "ATTESTATION_VERDICT_NOT_SUPPORTED",
      `The attested verdict is ${attestation.verdict}, not SUPPORTED.`,
    ));
  }
  if (typeof attestation.score !== "number" || !Number.isFinite(attestation.score)) {
    blockers.push(blocker(
      "ATTESTATION_SCORE_INVALID",
      "The attestation score is not a finite number.",
    ));
  } else if (attestation.score < context.policy.minScore) {
    blockers.push(blocker(
      "ATTESTATION_SCORE_BELOW_THRESHOLD",
      `The attestation score ${attestation.score} is below the policy threshold ${context.policy.minScore}.`,
    ));
  }

  // 5. Trust is the exact triple.
  const trusted = context.policy.trustedCheckers.some((candidate) =>
    candidate.checkerName === attestation.checkerName
    && candidate.checkerVersion === attestation.checkerVersion
    && candidate.checkerKind === attestation.checkerKind
  );
  if (!trusted) {
    blockers.push(blocker(
      "CHECKER_NOT_TRUSTED",
      `No policy entry allowlists ${attestation.checkerName}@${attestation.checkerVersion}/${attestation.checkerKind}.`,
    ));
  }

  // 6. Freshness against the caller-supplied asOf. There is deliberately no
  //    clock-skew window here: asOf is deterministic input, not an observed
  //    wall clock, so an attestation dated after it is always rejected.
  const checkedAtMs = Date.parse(attestation.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    blockers.push(blocker(
      "ATTESTATION_CHECKED_AT_INVALID",
      "The attestation checkedAt is not a readable date-time.",
    ));
  } else if (checkedAtMs > context.asOfMs) {
    blockers.push(blocker(
      "ATTESTATION_FROM_FUTURE",
      `The attestation is dated ${attestation.checkedAt}, after the evaluation instant ${context.asOf}.`,
    ));
  } else if (
    context.asOfMs - checkedAtMs > context.policy.maxAttestationAgeDays * MILLISECONDS_PER_DAY
  ) {
    blockers.push(blocker(
      "ATTESTATION_STALE",
      `The attestation is older than the policy maximum of ${context.policy.maxAttestationAgeDays} day(s) at ${context.asOf}.`,
    ));
  }

  // 7. The pinned claim binding, evidence, jurisdiction, domain, and source
  //    currency. Without a pin there is nothing to compare against, so the
  //    absence of a pin is a refusal rather than a waiver.
  const pin = context.policy.claimPins.find((candidate) => candidate.claimId === attestation.claimId);
  if (!pin) {
    blockers.push(blocker(
      "CLAIM_PIN_MISSING",
      `The policy pins no claim binding, evidence, jurisdiction, domain, or source-currency confirmation for claimId ${attestation.claimId}.`,
    ));
  } else {
    if (pin.claimBindingHash !== attestation.claimBindingHash) {
      blockers.push(blocker(
        "CLAIM_BINDING_HASH_MISMATCH",
        "The attestation's claimBindingHash is not the value the policy pinned for this claim.",
      ));
    }
    if (pin.snapshotId !== attestation.snapshotId) {
      blockers.push(blocker(
        "EVIDENCE_SNAPSHOT_MISMATCH",
        `The attestation names evidence snapshot ${attestation.snapshotId}, not the pinned ${pin.snapshotId}.`,
      ));
    }
    if (pin.evidenceHash !== attestation.evidenceHash) {
      blockers.push(blocker(
        "EVIDENCE_HASH_MISMATCH",
        "The attestation's evidenceHash is not the value the policy pinned for this claim.",
      ));
    }
    if (pin.jurisdiction !== context.policy.jurisdiction) {
      blockers.push(blocker(
        "CLAIM_JURISDICTION_MISMATCH",
        `The pinned claim jurisdiction ${pin.jurisdiction} is not the policy jurisdiction ${context.policy.jurisdiction}.`,
      ));
    }
    if (pin.domain !== context.policy.domain) {
      blockers.push(blocker(
        "CLAIM_DOMAIN_MISMATCH",
        `The pinned claim domain ${pin.domain} is not the policy domain ${context.policy.domain}.`,
      ));
    }
    const confirmedMs = Date.parse(pin.sourceCurrencyConfirmedAsOf);
    if (!Number.isFinite(confirmedMs)) {
      blockers.push(blocker(
        "SOURCE_CURRENCY_CONFIRMATION_INVALID",
        "The pinned source-currency confirmation is not a readable date-time.",
      ));
    } else if (confirmedMs > context.asOfMs) {
      blockers.push(blocker(
        "SOURCE_CURRENCY_CONFIRMATION_FROM_FUTURE",
        `The source-currency confirmation is dated ${pin.sourceCurrencyConfirmedAsOf}, after the evaluation instant ${context.asOf}.`,
      ));
    } else if (
      context.asOfMs - confirmedMs > context.policy.maxSourceCurrencyAgeDays * MILLISECONDS_PER_DAY
    ) {
      blockers.push(blocker(
        "SOURCE_CURRENCY_STALE",
        `The source-currency confirmation is older than the policy maximum of ${context.policy.maxSourceCurrencyAgeDays} day(s) at ${context.asOf}.`,
      ));
    }
  }

  const sorted = sortBlockers(blockers);
  const outcome = classifyOutcome(sorted);
  const reasons = outcome === "REUSE_AUTHORIZED" && currentCandidate
    ? [
      `Every deterministic gate passed, so the claim-scoped attestation for ${attestation.claimId} may be reused for current-draft candidate ${currentCandidate.index}.`,
      "The previous and current candidate texts may differ. What was proved is that the extractor's protected fingerprint is unchanged and that every pinned binding matched.",
      "This authorizes one claim. It is not a verification PASS and it does not release the document.",
    ]
    : [
      `Reuse is refused for ${attestation.claimId}: ${sorted.map((item) => item.code).join(", ")}.`,
      "A refusal is fail-closed. It means this artifact cannot prove reuse is safe, not that the claim is false.",
    ];

  return {
    boundAttestationHash: entry.boundAttestationHash,
    attestationHash: entry.attestationHash,
    claimId: entry.claimId,
    mappingResult: entry.result,
    ...(entry.planIndex === undefined ? {} : { planIndex: entry.planIndex }),
    ...(entry.planAction === undefined ? {} : { planAction: entry.planAction }),
    previousCandidateIndex: entry.previousCandidateIndex,
    previousCandidateHash,
    ...(currentCandidate === undefined ? {} : { currentCandidate }),
    outcome,
    blockers: sorted,
    reasons,
  };
}

function buildAuthorizationCore(
  trace: RevisionPlanTrace,
  replay: RevisionPlanReplay,
  policy: CanonicalClaimReusePolicy,
  asOf: string,
): ClaimReuseAuthorizationCore {
  // Re-guarded here rather than trusted from the caller: an unreadable asOf
  // would make every freshness comparison silently false, which is the one
  // failure mode that could turn a stale attestation into an authorization.
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    fail("EVALUATION_INPUT_INVALID", "asOf must be a readable date-time");
  }
  // Everything decided from here on comes from the replay, never from the
  // stored plan or the stored mapping.
  const mapping: PriorAttestationMappingReport = replay.priorAttestationMapping;
  const wrappers = new Map(
    trace.priorAttestations.map((bound) => [bound.boundAttestationHash, bound]),
  );
  const context: DecisionContext = {
    policy,
    asOf,
    asOfMs,
    mappingComplete: mapping.status === "COMPLETE",
    previousInventory: replay.previousInventory,
    currentCandidatesByHash: candidateIndicesByHash(replay.currentInventory),
    comparison: replay.comparison,
  };

  const decisions = mapping.entries
    .map((entry) => {
      const bound = wrappers.get(entry.boundAttestationHash);
      if (!bound) {
        // The trace reader already requires one stored wrapper per mapping
        // entry, so reaching here means the artifact is internally impossible.
        fail(
          "TRACE_ATTESTATION_SET_INCONSISTENT",
          `the recomputed mapping names bound attestation ${entry.boundAttestationHash}, which is not stored in this trace`,
        );
      }
      return decideForEntry(context, entry, bound);
    })
    .sort((left, right) => left.boundAttestationHash.localeCompare(right.boundAttestationHash));

  return {
    schemaVersion: CLAIM_REUSE_AUTHORIZATION_SCHEMA_VERSION,
    kind: CLAIM_REUSE_AUTHORIZATION_KIND,
    engineVersion: ENGINE_VERSION,
    extractorVersion: trace.extractorVersion,
    asOf,
    policyHash: claimReusePolicyHash(policy),
    policy,
    trace: {
      artifactHash: trace.artifactHash,
      previousSubjectSha256: replay.previousInventory.subjectSha256,
      currentSubjectSha256: replay.currentInventory.subjectSha256,
      priorAttestationsHash: trace.priorAttestationsHash,
      mappingHash: mapping.mappingHash,
      mappingStatus: mapping.status,
    },
    documentRelease: {
      status: "DOCUMENT_REVIEW_REQUIRED",
      coverageComplete: replay.currentInventory.coverage.complete,
      reasons: [...DOCUMENT_RELEASE_REASONS],
    },
    decisions,
    reasons: [...AUTHORIZATION_REASONS],
  };
}

function authorizationCore(source: ClaimReuseAuthorizationCore): ClaimReuseAuthorizationCore {
  return {
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    engineVersion: source.engineVersion,
    extractorVersion: source.extractorVersion,
    asOf: source.asOf,
    policyHash: source.policyHash,
    policy: source.policy,
    trace: source.trace,
    documentRelease: source.documentRelease,
    decisions: source.decisions,
    reasons: source.reasons,
  };
}

/** Canonical identity of one evaluation, excluding authorizationId and createdAt. */
export function claimReuseEvaluationHash(source: ClaimReuseAuthorizationCore): string {
  return hashObject(authorizationCore(source));
}

/**
 * The only way to obtain a claim reuse authorization. It reads and replays the
 * revision-plan trace itself, so no caller can authorize reuse from an
 * in-memory mapping, a stored decision, or a trace that does not reproduce.
 */
export async function evaluateClaimReuse(
  input: ClaimReuseEvaluationInput,
): Promise<ClaimReuseAuthorization> {
  if (!isRecord(input)) fail("EVALUATION_INPUT_INVALID", "evaluation input must be an object");
  const raw = input as Record<string, unknown>;
  if (!isDateTime(raw.asOf)) {
    fail("EVALUATION_INPUT_INVALID", "asOf must be a date-time supplied by the caller");
  }
  const asOf = raw.asOf;
  const policy = canonicalizeClaimReusePolicy(raw.policy);
  const { trace, replay } = await loadReplayedTrace(raw.revisionPlanTracePath);
  const core = buildAuthorizationCore(trace, replay, policy, asOf);
  const createdAt = new Date().toISOString();
  return {
    ...core,
    authorizationId: newTraceId(createdAt),
    createdAt,
    evaluationHash: claimReuseEvaluationHash(core),
  };
}

export async function writeClaimReuseAuthorization(
  directory: string,
  input: ClaimReuseEvaluationInput,
): Promise<string> {
  const authorization = await evaluateClaimReuse(input);
  return writePrivateJsonArtifact(
    directory,
    authorization.authorizationId + ".claim-reuse-authorization.json",
    authorization,
  );
}

/* -------------------------------------------------------------------------- */
/* Reader and replay                                                          */
/* -------------------------------------------------------------------------- */

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "authorizationId",
  "createdAt",
  "engineVersion",
  "extractorVersion",
  "asOf",
  "policyHash",
  "policy",
  "trace",
  "documentRelease",
  "decisions",
  "reasons",
  "evaluationHash",
] as const;
const TRACE_BINDING_KEYS = [
  "artifactHash",
  "previousSubjectSha256",
  "currentSubjectSha256",
  "priorAttestationsHash",
  "mappingHash",
  "mappingStatus",
] as const;
const DOCUMENT_RELEASE_KEYS = ["status", "coverageComplete", "reasons"] as const;
const DECISION_KEYS = [
  "boundAttestationHash",
  "attestationHash",
  "claimId",
  "mappingResult",
  "planIndex",
  "planAction",
  "previousCandidateIndex",
  "previousCandidateHash",
  "currentCandidate",
  "outcome",
  "blockers",
  "reasons",
] as const;
const CURRENT_CANDIDATE_KEYS = ["index", "hash", "fingerprint"] as const;
const BLOCKER_KEYS = ["code", "message"] as const;

const MAPPING_RESULTS = new Set<string>([
  "MATCHED_REUSE_ITEM",
  "REVALIDATION_REQUIRED",
  "NOT_IN_PLAN",
  "AMBIGUOUS",
]);
const MAPPING_STATUSES = new Set<string>(["NOT_ATTEMPTED", "COMPLETE", "INCOMPLETE"]);
const PLAN_ACTIONS = new Set<string>(["REUSE", "REVERIFY", "ADDED", "REMOVED", "UNCERTAIN"]);
const OUTCOMES = new Set<string>([
  "REUSE_AUTHORIZED",
  "REVERIFY_REQUIRED",
  "POLICY_BLOCKED",
  "HUMAN_REVIEW_REQUIRED",
]);

function policyShapeIssues(value: unknown, label: string): string[] {
  try {
    canonicalizeClaimReusePolicy(value);
    return [];
  } catch (error) {
    if (error instanceof ClaimReusePolicyError) {
      return error.issues.map((issue) => `${label} ${issue}`);
    }
    return [`${label} is not a valid policy`];
  }
}

function decisionShapeIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`];
  const issues = unknownKeyIssues(value, label, DECISION_KEYS);
  for (const field of ["boundAttestationHash", "attestationHash", "previousCandidateHash"] as const) {
    if (!isSha256Hex(value[field])) issues.push(`${label}.${field} must be lowercase SHA-256`);
  }
  if (!isNonEmptyString(value.claimId)) issues.push(`${label}.claimId must be a non-empty string`);
  if (!MAPPING_RESULTS.has(String(value.mappingResult))) {
    issues.push(`${label}.mappingResult is invalid`);
  }
  if (!isSafeNonNegativeInteger(value.previousCandidateIndex)) {
    issues.push(`${label}.previousCandidateIndex must be a safe non-negative integer`);
  }
  if (!OUTCOMES.has(String(value.outcome))) issues.push(`${label}.outcome is invalid`);
  issues.push(...stringArrayIssues(value.reasons, `${label}.reasons`));

  const requiresPlan = value.mappingResult === "MATCHED_REUSE_ITEM"
    || value.mappingResult === "REVALIDATION_REQUIRED";
  if (requiresPlan) {
    if (!isSafeNonNegativeInteger(value.planIndex)) {
      issues.push(`${label}.planIndex is required when mappingResult is ${String(value.mappingResult)}`);
    }
    if (!PLAN_ACTIONS.has(String(value.planAction))) {
      issues.push(`${label}.planAction is required when mappingResult is ${String(value.mappingResult)}`);
    }
  } else {
    if (value.planIndex !== undefined) {
      issues.push(`${label}.planIndex must be absent when mappingResult is ${String(value.mappingResult)}`);
    }
    if (value.planAction !== undefined) {
      issues.push(`${label}.planAction must be absent when mappingResult is ${String(value.mappingResult)}`);
    }
  }

  if (value.currentCandidate !== undefined) {
    if (!isRecord(value.currentCandidate)) {
      issues.push(`${label}.currentCandidate must be an object`);
    } else {
      issues.push(...unknownKeyIssues(
        value.currentCandidate,
        `${label}.currentCandidate`,
        CURRENT_CANDIDATE_KEYS,
      ));
      if (!isSafeNonNegativeInteger(value.currentCandidate.index)) {
        issues.push(`${label}.currentCandidate.index must be a safe non-negative integer`);
      }
      for (const field of ["hash", "fingerprint"] as const) {
        if (!isSha256Hex(value.currentCandidate[field])) {
          issues.push(`${label}.currentCandidate.${field} must be lowercase SHA-256`);
        }
      }
    }
  }

  if (!Array.isArray(value.blockers)) {
    issues.push(`${label}.blockers must be an array`);
  } else {
    for (const [index, item] of value.blockers.entries()) {
      const blockerLabel = `${label}.blockers[${index}]`;
      if (!isRecord(item)) {
        issues.push(`${blockerLabel} must be an object`);
        continue;
      }
      issues.push(...unknownKeyIssues(item, blockerLabel, BLOCKER_KEYS));
      if (!BLOCKER_CODES.has(String(item.code))) issues.push(`${blockerLabel}.code is invalid`);
      if (!isNonEmptyString(item.message)) {
        issues.push(`${blockerLabel}.message must be a non-empty string`);
      }
    }
  }
  return issues;
}

function assertClaimReuseAuthorizationShape(
  value: unknown,
): asserts value is ClaimReuseAuthorization {
  if (!isRecord(value)) {
    throw new ClaimReusePolicyError(
      ["AUTHORIZATION_INVALID_SHAPE"],
      ["claim reuse authorization must be an object"],
    );
  }
  const issues = unknownKeyIssues(value, "authorization", TOP_LEVEL_KEYS);
  if (value.schemaVersion !== CLAIM_REUSE_AUTHORIZATION_SCHEMA_VERSION) {
    issues.push(`authorization.schemaVersion must be ${CLAIM_REUSE_AUTHORIZATION_SCHEMA_VERSION}`);
  }
  if (value.kind !== CLAIM_REUSE_AUTHORIZATION_KIND) {
    issues.push(`authorization.kind must be ${CLAIM_REUSE_AUTHORIZATION_KIND}`);
  }
  for (const field of ["authorizationId", "engineVersion", "extractorVersion"] as const) {
    if (!isNonEmptyString(value[field])) issues.push(`authorization.${field} must be a non-empty string`);
  }
  for (const field of ["createdAt", "asOf"] as const) {
    if (!isDateTime(value[field])) issues.push(`authorization.${field} must be a date-time`);
  }
  for (const field of ["policyHash", "evaluationHash"] as const) {
    if (!isSha256Hex(value[field])) issues.push(`authorization.${field} must be lowercase SHA-256`);
  }
  issues.push(...policyShapeIssues(value.policy, "authorization.policy"));
  issues.push(...stringArrayIssues(value.reasons, "authorization.reasons"));

  if (!isRecord(value.trace)) {
    issues.push("authorization.trace must be an object");
  } else {
    issues.push(...unknownKeyIssues(value.trace, "authorization.trace", TRACE_BINDING_KEYS));
    for (
      const field of [
        "artifactHash",
        "previousSubjectSha256",
        "currentSubjectSha256",
        "priorAttestationsHash",
        "mappingHash",
      ] as const
    ) {
      if (!isSha256Hex(value.trace[field])) {
        issues.push(`authorization.trace.${field} must be lowercase SHA-256`);
      }
    }
    if (!MAPPING_STATUSES.has(String(value.trace.mappingStatus))) {
      issues.push("authorization.trace.mappingStatus is invalid");
    }
  }

  if (!isRecord(value.documentRelease)) {
    issues.push("authorization.documentRelease must be an object");
  } else {
    issues.push(...unknownKeyIssues(
      value.documentRelease,
      "authorization.documentRelease",
      DOCUMENT_RELEASE_KEYS,
    ));
    // Claim reuse is never document release, so the single legal status and the
    // incomplete-coverage statement are both pinned here.
    if (value.documentRelease.status !== "DOCUMENT_REVIEW_REQUIRED") {
      issues.push("authorization.documentRelease.status must be DOCUMENT_REVIEW_REQUIRED");
    }
    if (value.documentRelease.coverageComplete !== false) {
      issues.push("authorization.documentRelease.coverageComplete must be false");
    }
    issues.push(...stringArrayIssues(
      value.documentRelease.reasons,
      "authorization.documentRelease.reasons",
    ));
  }

  if (!Array.isArray(value.decisions)) {
    issues.push("authorization.decisions must be an array");
  } else {
    for (const [index, decision] of value.decisions.entries()) {
      issues.push(...decisionShapeIssues(decision, `authorization.decisions[${index}]`));
    }
  }

  if (issues.length > 0) throw new ClaimReusePolicyError(["AUTHORIZATION_INVALID_SHAPE"], issues);
}

function assertStoredClaimReuseIntegrity(authorization: ClaimReuseAuthorization): void {
  const issues: string[] = [];
  const codes: ClaimReuseIssueCode[] = [];
  const add = (code: ClaimReuseIssueCode, issue: string): void => {
    issues.push(issue);
    if (!codes.includes(code)) codes.push(code);
  };

  // The stored policy must already be in canonical form, otherwise two byte
  // sequences could carry the same policy under different orders and only one
  // of them would reproduce policyHash.
  const canonical = canonicalizeClaimReusePolicy(authorization.policy);
  if (canonicalJson(canonical) !== canonicalJson(authorization.policy)) {
    add("AUTHORIZATION_POLICY_NOT_CANONICAL", "authorization.policy is not stored in canonical order");
  }
  if (claimReusePolicyHash(canonical) !== authorization.policyHash) {
    add("AUTHORIZATION_POLICY_HASH_MISMATCH", "authorization.policyHash does not match the stored policy");
  }

  // Decisions are canonically ordered, and a stored outcome must agree with its
  // own stored blockers. A forged REUSE_AUTHORIZED that kept its blockers, or a
  // refusal with the blockers deleted, fails here before any replay.
  for (const [index, decision] of authorization.decisions.entries()) {
    const previous = authorization.decisions[index - 1];
    if (previous && previous.boundAttestationHash >= decision.boundAttestationHash) {
      add(
        "AUTHORIZATION_INVALID_SHAPE",
        "authorization.decisions must be sorted ascending and unique by boundAttestationHash",
      );
    }
    if (canonicalJson(sortBlockers(decision.blockers)) !== canonicalJson(decision.blockers)) {
      add(
        "AUTHORIZATION_INVALID_SHAPE",
        `authorization.decisions[${index}].blockers must be sorted, unique, and canonical`,
      );
    }
    if (decision.outcome !== classifyOutcome(decision.blockers)) {
      add(
        "AUTHORIZATION_DECISION_INCONSISTENT",
        `authorization.decisions[${index}].outcome contradicts its own blockers`,
      );
    }
    if (decision.outcome === "REUSE_AUTHORIZED") {
      if (decision.mappingResult !== "MATCHED_REUSE_ITEM" || decision.planAction !== "REUSE") {
        add(
          "AUTHORIZATION_DECISION_INCONSISTENT",
          `authorization.decisions[${index}] authorizes reuse without a MATCHED_REUSE_ITEM/REUSE association`,
        );
      }
      if (!decision.currentCandidate) {
        add(
          "AUTHORIZATION_DECISION_INCONSISTENT",
          `authorization.decisions[${index}] authorizes reuse without naming a current candidate`,
        );
      }
      if (authorization.trace.mappingStatus !== "COMPLETE") {
        add(
          "AUTHORIZATION_DECISION_INCONSISTENT",
          `authorization.decisions[${index}] authorizes reuse under a ${authorization.trace.mappingStatus} prior-attestation mapping`,
        );
      }
    }
  }

  if (claimReuseEvaluationHash(authorization) !== authorization.evaluationHash) {
    add(
      "AUTHORIZATION_EVALUATION_HASH_MISMATCH",
      "authorization.evaluationHash does not match the canonical hash of the bound core",
    );
  }
  if (issues.length > 0) throw new ClaimReusePolicyError(codes, issues);
}

/**
 * Structural read only. It proves the stored artifact is internally consistent
 * and self-hashing. It proves nothing about whether the decisions inside are
 * the ones this build would make, so its result must never be treated as
 * authorization without `replayClaimReuseAuthorization`.
 */
export async function readClaimReuseAuthorization(path: string): Promise<ClaimReuseAuthorization> {
  const outcome = await readJsonFile(path);
  if (!outcome.ok) throw new ClaimReusePolicyError(["AUTHORIZATION_INVALID_JSON"], [outcome.message]);
  assertClaimReuseAuthorizationShape(outcome.value);
  assertStoredClaimReuseIntegrity(outcome.value);
  return outcome.value;
}

export interface ClaimReuseAuthorizationReplay {
  matches: boolean;
  expectedEvaluationHash: string;
  actualEvaluationHash: string;
  componentMatches: {
    policy: boolean;
    trace: boolean;
    documentRelease: boolean;
    decisions: boolean;
  };
  storedOutcomes: Record<string, ClaimReuseOutcome>;
  recomputedOutcomes: Record<string, ClaimReuseOutcome>;
  recomputed: ClaimReuseAuthorizationCore;
  reasons: string[];
}

export interface ClaimReuseAuthorizationReplayInput {
  authorizationPath: string;
  revisionPlanTracePath: string;
}

const REPLAY_INPUT_KEYS = ["authorizationPath", "revisionPlanTracePath"] as const;

/**
 * The one closed entry shape for replay and for everything built on it. It is
 * deliberately paths only. An in-memory replay, authorization, or decision list
 * is rejected here rather than trusted, so there is no shape a caller can
 * assemble by hand that this module will read as evidence, and a fabricated
 * `{ matches: true, recomputed: ... }` object fails closed on both missing
 * paths instead of being partially honoured.
 */
function assertClaimReuseReplayInput(
  value: unknown,
): asserts value is ClaimReuseAuthorizationReplayInput {
  if (!isRecord(value)) fail("EVALUATION_INPUT_INVALID", "replay input must be an object");
  const issues = unknownKeyIssues(value, "replayInput", REPLAY_INPUT_KEYS);
  for (const field of REPLAY_INPUT_KEYS) {
    if (!isNonEmptyString(value[field])) {
      issues.push(`replayInput.${field} must be a non-empty string path`);
    }
  }
  if (issues.length > 0) throw new ClaimReusePolicyError(["EVALUATION_INPUT_INVALID"], issues);
}

/**
 * Recomputes every component hash and every decision from the revision-plan
 * trace plus the stored closed policy and asOf, then compares. A forged
 * authorization that was fully rehashed still fails here, because the decision
 * is recomputed rather than read.
 */
export async function replayClaimReuseAuthorization(
  input: ClaimReuseAuthorizationReplayInput,
): Promise<ClaimReuseAuthorizationReplay> {
  assertClaimReuseReplayInput(input);
  const stored = await readClaimReuseAuthorization(input.authorizationPath);
  const { trace, replay } = await loadReplayedTrace(input.revisionPlanTracePath);
  if (trace.artifactHash !== stored.trace.artifactHash) {
    fail(
      "AUTHORIZATION_TRACE_BINDING_MISMATCH",
      "the supplied revision-plan trace is not the artifact this authorization was evaluated against",
    );
  }

  const recomputed = buildAuthorizationCore(
    trace,
    replay,
    canonicalizeClaimReusePolicy(stored.policy),
    stored.asOf,
  );
  const actualEvaluationHash = claimReuseEvaluationHash(recomputed);
  const componentMatches = {
    policy: canonicalJson(recomputed.policy) === canonicalJson(stored.policy)
      && recomputed.policyHash === stored.policyHash,
    trace: canonicalJson(recomputed.trace) === canonicalJson(stored.trace),
    documentRelease: canonicalJson(recomputed.documentRelease)
      === canonicalJson(stored.documentRelease),
    decisions: canonicalJson(recomputed.decisions) === canonicalJson(stored.decisions),
  };
  const matches = actualEvaluationHash === stored.evaluationHash;

  const storedOutcomes: Record<string, ClaimReuseOutcome> = {};
  for (const decision of stored.decisions) {
    storedOutcomes[decision.boundAttestationHash] = decision.outcome;
  }
  const recomputedOutcomes: Record<string, ClaimReuseOutcome> = {};
  for (const decision of recomputed.decisions) {
    recomputedOutcomes[decision.boundAttestationHash] = decision.outcome;
  }

  const reasons: string[] = [];
  if (matches) {
    reasons.push(
      "Recomputing every decision from the revision-plan trace and the stored policy reproduced the stored evaluation hash.",
    );
  } else {
    const diverged = Object.entries(componentMatches)
      .filter(([, same]) => !same)
      .map(([name]) => name);
    reasons.push(
      diverged.length > 0
        ? `Recomputation diverged from the stored authorization in: ${diverged.join(", ")}.`
        : "Every recomputed component matches, so the difference is in the stored core itself: its recorded engine version, extractor version, asOf, or reason text is not what this build emits.",
    );
    if (!componentMatches.decisions) {
      reasons.push(
        "The stored decisions are not the decisions this build makes for that trace and that policy, so no stored outcome may be relied on.",
      );
    }
  }
  reasons.push(
    "A matching evaluation hash proves deterministic reproduction of this policy decision only. It is not a verification PASS, it does not release the document, and it does not make the underlying attestation correct.",
  );

  return {
    matches,
    expectedEvaluationHash: stored.evaluationHash,
    actualEvaluationHash,
    componentMatches,
    storedOutcomes,
    recomputedOutcomes,
    recomputed,
    reasons,
  };
}

/**
 * The claim reuses a stored authorization can still prove, on this build,
 * against the revision-plan trace it names.
 *
 * It takes the same closed pair of paths as replay and runs
 * `replayClaimReuseAuthorization` itself, so there is no in-memory path to an
 * authorized decision: a caller cannot hand this a replay, an authorization, or
 * a decision list it assembled, because those shapes are refused by the same
 * fail-closed input contract rather than read. It returns recomputed decisions
 * only, never stored ones, and returns nothing at all unless the internally
 * obtained replay matched.
 */
export async function authorizedClaimReuses(
  input: ClaimReuseAuthorizationReplayInput,
): Promise<ClaimReuseDecision[]> {
  const replay = await replayClaimReuseAuthorization(input);
  if (!replay.matches) return [];
  return replay.recomputed.decisions.filter((decision) => decision.outcome === "REUSE_AUTHORIZED");
}
