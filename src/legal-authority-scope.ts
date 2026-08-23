import { hashObject } from "./canonical.js";
import { extractClaimInventory, type CandidateAssertion } from "./claims.js";
import type { AtomicClaim, SourceRecord, VerifyRequest } from "./types.js";

export const LEGAL_SCOPE_PROFILE_VERSION = "external-legal-only@0.1.0-alpha" as const;

export class LegalScopeError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Legal scope planning failed closed: ${issues.join("; ")}`);
    this.name = "LegalScopeError";
  }
}

export type SourceVisibility = "external_public" | "private_case" | "unknown";

export type LegalSourceClass =
  | "enacted_law"
  | "adjudicative_decision"
  | "official_policy"
  | "official_guidance"
  | "secondary_commentary"
  | "non_legal_record"
  | "unknown";

export type ScopedClaimClass =
  | "EXTERNAL_LEGAL"
  | "PRIVATE_FACT"
  | "MIXED"
  | "OUT_OF_SCOPE"
  | "UNCERTAIN";

export type ScopeAction =
  | "VERIFY_EXTERNAL_AUTHORITY"
  | "SKIP_BY_SCOPE"
  | "SPLIT_MIXED_CLAIM"
  | "REVIEW_SCOPE";

export interface LegalSourceClassification {
  sourceId: string;
  visibility: SourceVisibility;
  legalClass: LegalSourceClass;
}

export interface LegalScopeOptions {
  privateFactsMode?: "off" | "local_only";
  privateSourceIds?: readonly string[];
  privateClaimIds?: readonly string[];
}

export interface LegalScopeItem {
  claimId: string;
  claimText: string;
  classification: ScopedClaimClass;
  action: ScopeAction;
  citedSourceIds: string[];
  externalSourceIds: string[];
  privateSourceIds: string[];
  legalReferences: string[];
  reasons: string[];
}

export interface LegalScopePlan {
  schemaVersion: "0.1.0-alpha";
  kind: "legal-verification-scope-plan";
  profileVersion: typeof LEGAL_SCOPE_PROFILE_VERSION;
  subjectSha256: string;
  privateFactsMode: "off" | "local_only";
  items: LegalScopeItem[];
  counts: Record<ScopeAction, number>;
  scopedCoverageComplete: false;
  reasons: string[];
  scopeBindingHash: string;
  planHash: string;
}

const EXTERNAL_LEGAL_CLASSES = new Set<LegalSourceClass>([
  "enacted_law",
  "adjudicative_decision",
  "official_policy",
  "official_guidance",
  "secondary_commentary",
]);

const REPORTED_CASE = /\b\d{4}\s+(?:CanLII|SCC|BCCA|BCSC|BCPC|BCHRT|FC|FCA|SCR)\s+\d+\b/giu;
const PRINT_REPORTER = /\[\d{4}\]\s+\d+\s+(?:S\.?C\.?R\.?|D\.?L\.?R\.?)\s+\d+\b/giu;
const ADMINISTRATIVE_DECISION = /\b(?:WCAT\s+)?A\d{7}\b|\b(?:Review(?:\s+Reference)?\s+)?R\d{7}\b|\b\d{4}-\d{5}\b/giu;
const POLICY_ITEM = /\b(?:Policy\s+Item\s+)?C\d+(?:-\d+)+(?:\.\d+)?\b/giu;
const LEGAL_SECTION = /\b(?:s\.?|ss\.?|section|sections|article|articles)\s*\d+[\w.-]*(?:\s*\([\w-]+\))*/giu;
const STATUTE_CHAPTER = /\b(?:R\.?S\.?B\.?C\.?|S\.?B\.?C\.?|R\.?S\.?C\.?)\s+\d{4}\s*,?\s*c\.?\s*[A-Za-z0-9.-]+\b/giu;
const CASE_NAME = /\b[A-Z][\p{L}\p{N}.'’-]+(?:\s+[A-Z][\p{L}\p{N}.'’-]+){0,3}\s+v\.?\s+[A-Z][\p{L}\p{N}.'’-]+(?:\s+[A-Z][\p{L}\p{N}.'’-]+){0,3}\b/gu;
const OFFICIAL_LEGAL_URL = /https?:\/\/(?:www\.)?(?:bclaws\.gov\.bc\.ca|bccourts\.ca|wcat\.bc\.ca|wcat-pdf\.labour\.gov\.bc\.ca|worksafebc\.com|decisions\.scc-csc\.ca|canlii\.org|laws-lois\.justice\.gc\.ca)\/[^\s<>()\[\]{}"'“”‘’「」『』]+/giu;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function extractExternalLegalReferences(text: string): string[] {
  const values: string[] = [];
  for (const pattern of [
    REPORTED_CASE,
    PRINT_REPORTER,
    ADMINISTRATIVE_DECISION,
    POLICY_ITEM,
    LEGAL_SECTION,
    STATUTE_CHAPTER,
    CASE_NAME,
    OFFICIAL_LEGAL_URL,
  ]) {
    values.push(...(text.match(pattern) ?? []));
  }
  return uniqueSorted(values.map((value) => value.trim()));
}

function sourceClassificationMap(
  sources: readonly SourceRecord[],
  classifications: readonly LegalSourceClassification[],
): Map<string, LegalSourceClassification> {
  const known = new Set(sources.map((source) => source.sourceId));
  const result = new Map<string, LegalSourceClassification>();
  for (const classification of classifications) {
    if (!known.has(classification.sourceId)) {
      throw new LegalScopeError([`classification references unknown sourceId: ${classification.sourceId}`]);
    }
    const existing = result.get(classification.sourceId);
    if (existing && hashObject(existing) !== hashObject(classification)) {
      throw new LegalScopeError([`conflicting classifications for sourceId: ${classification.sourceId}`]);
    }
    result.set(classification.sourceId, classification);
  }
  return result;
}

function privateOptInAllows(
  claimId: string,
  sourceIds: readonly string[],
  options: LegalScopeOptions,
): boolean {
  if (options.privateFactsMode !== "local_only") return false;
  const claims = new Set(options.privateClaimIds ?? []);
  const sources = new Set(options.privateSourceIds ?? []);
  return claims.has(claimId) && sourceIds.every((sourceId) => sources.has(sourceId));
}

function routeClaim(
  claim: AtomicClaim,
  sourceMap: Map<string, LegalSourceClassification>,
  options: LegalScopeOptions,
): LegalScopeItem {
  const citedSourceIds = uniqueSorted(claim.citations.map((citation) => citation.sourceId));
  const externalSourceIds: string[] = [];
  const privateSourceIds: string[] = [];
  const unknownSourceIds: string[] = [];
  for (const sourceId of citedSourceIds) {
    const source = sourceMap.get(sourceId);
    if (source?.visibility === "external_public" && EXTERNAL_LEGAL_CLASSES.has(source.legalClass)) {
      externalSourceIds.push(sourceId);
    } else if (source?.visibility === "private_case" || source?.legalClass === "non_legal_record") {
      privateSourceIds.push(sourceId);
    } else {
      unknownSourceIds.push(sourceId);
    }
  }
  const legalReferences = extractExternalLegalReferences(claim.text);
  const hasExternal = externalSourceIds.length > 0 || legalReferences.length > 0;
  const hasPrivate = privateSourceIds.length > 0;

  if (unknownSourceIds.length > 0) {
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      classification: "UNCERTAIN",
      action: "REVIEW_SCOPE",
      citedSourceIds,
      externalSourceIds: uniqueSorted(externalSourceIds),
      privateSourceIds: uniqueSorted(privateSourceIds),
      legalReferences,
      reasons: ["A cited source is missing a unique external/private classification."],
    };
  }

  if (hasExternal && hasPrivate) {
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      classification: "MIXED",
      action: "SPLIT_MIXED_CLAIM",
      citedSourceIds,
      externalSourceIds: uniqueSorted(externalSourceIds),
      privateSourceIds: uniqueSorted(privateSourceIds),
      legalReferences,
      reasons: ["External legal and private factual support appear in one claim; split before verification."],
    };
  }
  if (hasExternal) {
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      classification: "EXTERNAL_LEGAL",
      action: "VERIFY_EXTERNAL_AUTHORITY",
      citedSourceIds,
      externalSourceIds: uniqueSorted(externalSourceIds),
      privateSourceIds: [],
      legalReferences,
      reasons: ["Claim cites or names an external legal authority."],
    };
  }
  if (hasPrivate) {
    const optedIn = privateOptInAllows(claim.claimId, privateSourceIds, options);
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      classification: "PRIVATE_FACT",
      action: optedIn ? "REVIEW_SCOPE" : "SKIP_BY_SCOPE",
      citedSourceIds,
      externalSourceIds: [],
      privateSourceIds: uniqueSorted(privateSourceIds),
      legalReferences,
      reasons: [optedIn
        ? "Private factual verification was explicitly enabled for this claim and every cited private source."
        : "Private and first-party facts are outside the default external-legal-only profile."],
    };
  }
  if (claim.proof.kind === "semantic") {
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      classification: "UNCERTAIN",
      action: "REVIEW_SCOPE",
      citedSourceIds,
      externalSourceIds: [],
      privateSourceIds: [],
      legalReferences,
      reasons: ["The claim or one of its sources is not classified strongly enough for automatic routing."],
    };
  }
  return {
    claimId: claim.claimId,
    claimText: claim.text,
    classification: "OUT_OF_SCOPE",
    action: "SKIP_BY_SCOPE",
    citedSourceIds,
    externalSourceIds: [],
    privateSourceIds: [],
    legalReferences,
    reasons: ["No external legal authority claim was detected."],
  };
}

export function planLegalVerificationScope(
  request: VerifyRequest,
  classifications: readonly LegalSourceClassification[],
  options: LegalScopeOptions = {},
): LegalScopePlan {
  const sourceMap = sourceClassificationMap(request.evidence.sources, classifications);
  const items = request.claims.map((claim) => routeClaim(claim, sourceMap, options));
  const counts: Record<ScopeAction, number> = {
    VERIFY_EXTERNAL_AUTHORITY: 0,
    SKIP_BY_SCOPE: 0,
    SPLIT_MIXED_CLAIM: 0,
    REVIEW_SCOPE: 0,
  };
  for (const item of items) counts[item.action] += 1;
  const scopeBindingHash = hashObject({
    snapshotId: request.evidence.snapshotId,
    sources: request.evidence.sources.map((source) => ({
      sourceId: source.sourceId,
      sha256: source.sha256 ?? null,
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    classifications: [...sourceMap.values()].sort(
      (left, right) => left.sourceId.localeCompare(right.sourceId),
    ),
  });
  const core = {
    schemaVersion: "0.1.0-alpha" as const,
    kind: "legal-verification-scope-plan" as const,
    profileVersion: LEGAL_SCOPE_PROFILE_VERSION,
    subjectSha256: request.subject.sha256,
    privateFactsMode: options.privateFactsMode ?? "off",
    items,
    counts,
    scopedCoverageComplete: false as const,
    reasons: [
      "This plan covers external legal authority verification only, not the truth of the complete draft.",
      "Automatic scope routing never proves complete legal-claim coverage.",
    ],
    scopeBindingHash,
  };
  return { ...core, planHash: hashObject(core) };
}

export interface DraftLegalScopeCandidate {
  candidate: CandidateAssertion;
  legalReferences: string[];
  action: "VERIFY_EXTERNAL_AUTHORITY" | "SKIP_BY_SCOPE" | "REVIEW_SCOPE";
}

export function planDraftLegalCandidates(text: string): DraftLegalScopeCandidate[] {
  return extractClaimInventory(text).candidates.map((candidate) => {
    const legalReferences = extractExternalLegalReferences(candidate.text);
    if (legalReferences.length > 0) {
      return { candidate, legalReferences, action: "VERIFY_EXTERNAL_AUTHORITY" as const };
    }
    const legalSignals = candidate.materialSignals.some((signal) =>
      signal.kind === "legal_section" || signal.kind === "legal_proposition"
    );
    return {
      candidate,
      legalReferences,
      action: legalSignals ? "REVIEW_SCOPE" as const : "SKIP_BY_SCOPE" as const,
    };
  });
}
