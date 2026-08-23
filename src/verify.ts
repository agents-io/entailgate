import { canonicalJson, hashObject, sha256Text } from "./canonical.js";
import { normalizedAtomicClaimFingerprint } from "./claims.js";
import { assertVerifyRequest } from "./validate.js";
import type {
  ActionProposal,
  ActionResult,
  AtomicClaim,
  CitationRef,
  ClaimResult,
  ClaimVerdict,
  Decision,
  EvidenceChunk,
  Finding,
  JsonValue,
  SemanticAttestation,
  SemanticChecker,
  SourceRecord,
  VerificationResult,
  VerifyRequest,
} from "./types.js";

export const ENGINE_VERSION = "0.1.1";

export interface VerifyOptions {
  semanticChecker?: SemanticChecker;
}

export function semanticEvidenceHash(
  snapshotId: string,
  chunks: EvidenceChunk[],
  sources: SourceRecord[] = [],
  domain = "",
): string {
  return hashObject({
    bindingVersion: "0.1.1",
    snapshotId,
    domain,
    chunks: [...chunks]
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
      .map((chunk) => ({ ...chunk, computedTextSha256: sha256Text(chunk.text) })),
    sources: [...sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  });
}

export function semanticClaimBindingHash(claim: AtomicClaim): string {
  const claimFingerprint = semanticClaimFingerprint(claim);
  return hashObject({
    claimTextIdentity: claimFingerprint === undefined
      ? { kind: "exact", sha256: sha256Text(claim.text) }
      : { kind: "normalized_atomic_fingerprint", sha256: claimFingerprint },
    material: claim.material,
    risk: claim.risk,
    selfContained: claim.selfContained ?? false,
    citations: [...claim.citations].sort((left, right) =>
      (left.sourceId + "\u0000" + left.chunkId)
        .localeCompare(right.sourceId + "\u0000" + right.chunkId)),
    proof: claim.proof,
    jurisdiction: claim.jurisdiction ?? null,
    asOf: claim.asOf ?? null,
    requiredAuthority: [...(claim.requiredAuthority ?? [])].sort(),
  });
}

export function semanticClaimFingerprint(claim: AtomicClaim): string | undefined {
  return normalizedAtomicClaimFingerprint(claim.text);
}

function finding(
  code: string,
  severity: Finding["severity"],
  message: string,
  context: Partial<Pick<Finding, "claimId" | "actionId" | "sourceId" | "chunkId">> = {},
): Finding {
  return { code, severity, message, ...context };
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalized(text: string, mode: "exact" | "unicode" | "whitespace"): string {
  if (mode === "exact") return text;
  const unicode = text.normalize("NFC");
  return mode === "whitespace" ? unicode.replace(/\s+/gu, " ").trim() : unicode;
}

function dateIsAfter(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function sourceScopeFindings(
  claim: AtomicClaim,
  sources: SourceRecord[],
  requestedAt: string,
  maxSourceAgeDays: number | undefined,
  requestDomain: string,
): Finding[] {
  const findings: Finding[] = [];
  const asOf = claim.asOf ?? requestedAt;
  for (const source of sources) {
    const context = { claimId: claim.claimId, sourceId: source.sourceId };
    if (source.effectiveFrom && dateIsAfter(source.effectiveFrom, asOf)) {
      findings.push(finding(
        "SOURCE_NOT_YET_EFFECTIVE",
        "BLOCKER",
        source.sourceId + " was not effective at " + asOf + ".",
        context,
      ));
    }
    if (source.effectiveTo && dateIsAfter(asOf, source.effectiveTo)) {
      findings.push(finding(
        "SOURCE_EXPIRED",
        "BLOCKER",
        source.sourceId + " expired before " + asOf + ".",
        context,
      ));
    }
    if (source.retrievedAt) {
      const ageMs = Date.parse(requestedAt) - Date.parse(source.retrievedAt);
      if (Number.isFinite(ageMs) && ageMs < 0) {
        findings.push(finding(
          "SOURCE_RETRIEVED_IN_FUTURE",
          "BLOCKER",
          source.sourceId + " has a retrievedAt timestamp after the verification request.",
          context,
        ));
      } else if (
        maxSourceAgeDays !== undefined
        && (!Number.isFinite(ageMs) || ageMs > maxSourceAgeDays * 86_400_000)
      ) {
        findings.push(finding(
          "SOURCE_STALE",
          "BLOCKER",
          source.sourceId + " exceeds maxSourceAgeDays=" + maxSourceAgeDays + ".",
          context,
        ));
      }
    } else if (maxSourceAgeDays !== undefined) {
        findings.push(finding(
          "SOURCE_FRESHNESS_UNKNOWN",
          "BLOCKER",
          source.sourceId + " has no retrievedAt timestamp.",
          context,
        ));
    }
    if (claim.jurisdiction && !source.jurisdictions?.includes(claim.jurisdiction)) {
      findings.push(finding(
        "SOURCE_JURISDICTION_MISMATCH",
        "BLOCKER",
        source.sourceId + " is not scoped to " + claim.jurisdiction + ".",
        context,
      ));
    }
    if (source.domains && !source.domains.includes(requestDomain)) {
      findings.push(finding(
        "SOURCE_DOMAIN_MISMATCH",
        "BLOCKER",
        source.sourceId + " is not scoped to domain " + requestDomain + ".",
        context,
      ));
    }
    if (claim.requiredAuthority && !claim.requiredAuthority.includes(source.authorityTier)) {
      findings.push(finding(
        "REQUIRED_AUTHORITY_NOT_SUPPORTING_PROOF",
        "BLOCKER",
        source.sourceId + " has authority tier " + source.authorityTier
          + ", outside the tiers permitted to support this claim.",
        context,
      ));
    }
  }
  if (
    claim.requiredAuthority
    && !sources.some((source) => claim.requiredAuthority?.includes(source.authorityTier))
  ) {
    findings.push(finding(
      "REQUIRED_AUTHORITY_MISSING",
      "BLOCKER",
      "Claim requires one of: " + claim.requiredAuthority.join(", ") + ".",
      { claimId: claim.claimId },
    ));
  }
  return findings;
}

function validateCitations(
  request: VerifyRequest,
  claim: AtomicClaim,
  sourceMap: Map<string, SourceRecord>,
  chunkMap: Map<string, EvidenceChunk>,
): { citations: CitationRef[]; chunks: EvidenceChunk[]; sources: SourceRecord[]; findings: Finding[] } {
  const retrieved = new Set(request.retrievedChunkIds);
  const citations: CitationRef[] = [];
  const chunks: EvidenceChunk[] = [];
  const sources: SourceRecord[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const seenSources = new Set<string>();

  for (const citation of claim.citations) {
    const context = {
      claimId: claim.claimId,
      sourceId: citation.sourceId,
      chunkId: citation.chunkId,
    };
    const source = sourceMap.get(citation.sourceId);
    const chunk = chunkMap.get(citation.chunkId);
    if (!source || !chunk) {
      findings.push(finding(
        "UNKNOWN_CITATION",
        "BLOCKER",
        "Citation references an unknown source or chunk ID.",
        context,
      ));
      continue;
    }
    if (chunk.sourceId !== source.sourceId) {
      findings.push(finding(
        "CITATION_SOURCE_MISMATCH",
        "BLOCKER",
        "Chunk does not belong to the cited source.",
        context,
      ));
      continue;
    }
    if (request.policy.requireRetrievedCitationClosure && !retrieved.has(chunk.chunkId)) {
      findings.push(finding(
        "CITATION_OUTSIDE_RETRIEVAL_SET",
        "BLOCKER",
        "Cited chunk was not in this request's retrieval set.",
        context,
      ));
      continue;
    }
    if (chunk.sha256 && sha256Text(chunk.text) !== chunk.sha256) {
      findings.push(finding(
        "CHUNK_HASH_MISMATCH",
        "BLOCKER",
        "Chunk text does not match its recorded SHA-256.",
        context,
      ));
      continue;
    }
    const key = source.sourceId + "\u0000" + chunk.chunkId;
    if (!seen.has(key)) {
      citations.push(citation);
      chunks.push(chunk);
      seen.add(key);
      if (!seenSources.has(source.sourceId)) {
        sources.push(source);
        seenSources.add(source.sourceId);
      }
    }
  }
  if (claim.material && citations.length === 0) {
    findings.push(finding(
      "NO_VALID_CITATION",
      "BLOCKER",
      "Material claim has no valid in-snapshot citation.",
      { claimId: claim.claimId },
    ));
  }
  findings.push(...sourceScopeFindings(
    claim,
    sources,
    request.requestedAt,
    request.policy.maxSourceAgeDays,
    request.domain,
  ));
  return { citations, chunks, sources, findings };
}

function calculateDerived(
  claim: AtomicClaim,
  chunks: EvidenceChunk[],
): { verdict: ClaimVerdict; findings: Finding[] } {
  if (claim.proof.kind !== "derived") throw new Error("Expected derived proof");
  const findings: Finding[] = [];
  const chunkMap = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const boundIndices = new Set<number>();
  for (const binding of claim.proof.bindings) {
    const chunk = chunkMap.get(binding.chunkId);
    const value = chunk?.structuredFacts?.[binding.field];
    const expectedOperand = claim.proof.operands[binding.operandIndex];
    const context = {
      claimId: claim.claimId,
      sourceId: binding.sourceId,
      chunkId: binding.chunkId,
    };
    if (!chunk || chunk.sourceId !== binding.sourceId || value === undefined) {
      findings.push(finding(
        "DERIVED_INPUT_NOT_FOUND",
        "BLOCKER",
        "Derived input " + binding.operandIndex + " is not bound to a cited structured fact.",
        context,
      ));
    } else if (!sameJson(value, expectedOperand)) {
      findings.push(finding(
        "DERIVED_INPUT_MISMATCH",
        "BLOCKER",
        "Derived input " + binding.operandIndex + " differs from the cited structured fact.",
        context,
      ));
    } else {
      boundIndices.add(binding.operandIndex);
    }
  }
  for (let index = 0; index < claim.proof.operands.length; index += 1) {
    if (!boundIndices.has(index)) {
      findings.push(finding(
        "DERIVED_INPUT_UNBOUND",
        "BLOCKER",
        "Derived operand " + index + " has no verified evidence binding.",
        { claimId: claim.claimId },
      ));
    }
  }
  if (findings.length > 0) return { verdict: "NOT_FOUND", findings };

  let actual: JsonValue;
  const operands = claim.proof.operands;
  if (claim.proof.operation === "date_add_days") {
    const start = operands[0];
    const days = operands[1];
    if (typeof start !== "string" || typeof days !== "number" || Number.isNaN(Date.parse(start))) {
      return {
        verdict: "NOT_FOUND",
        findings: [finding(
          "INVALID_DERIVATION_INPUT",
          "BLOCKER",
          "date_add_days requires [ISO date, number].",
          { claimId: claim.claimId },
        )],
      };
    }
    const result = new Date(Date.parse(start));
    result.setUTCDate(result.getUTCDate() + days);
    actual = result.toISOString().slice(0, 10);
  } else {
    if (operands.length !== 2 || operands.some((operand) => typeof operand !== "number")) {
      return {
        verdict: "NOT_FOUND",
        findings: [finding(
          "INVALID_DERIVATION_INPUT",
          "BLOCKER",
          claim.proof.operation + " requires two numbers.",
          { claimId: claim.claimId },
        )],
      };
    }
    const left = operands[0] as number;
    const right = operands[1] as number;
    if (claim.proof.operation === "add") actual = left + right;
    else if (claim.proof.operation === "subtract") actual = left - right;
    else if (claim.proof.operation === "multiply") actual = left * right;
    else {
      if (right === 0) {
        return {
          verdict: "NOT_FOUND",
          findings: [finding(
            "DIVISION_BY_ZERO",
            "BLOCKER",
            "Derived proof divides by zero.",
            { claimId: claim.claimId },
          )],
        };
      }
      actual = left / right;
    }
  }
  if (!sameJson(actual, claim.proof.expected)) {
    return {
      verdict: "CONTRADICTED",
      findings: [finding(
        "DERIVATION_MISMATCH",
        "BLOCKER",
        "Calculated value " + canonicalJson(actual)
          + " does not equal expected " + canonicalJson(claim.proof.expected) + ".",
        { claimId: claim.claimId },
      )],
    };
  }
  return { verdict: "SUPPORTED", findings };
}

async function verifyClaim(
  request: VerifyRequest,
  claim: AtomicClaim,
  sourceMap: Map<string, SourceRecord>,
  chunkMap: Map<string, EvidenceChunk>,
  checker: SemanticChecker | undefined,
): Promise<ClaimResult> {
  const checked = validateCitations(request, claim, sourceMap, chunkMap);
  const findings = [...checked.findings];
  const checkerScores: Record<string, number> = {};
  let verdict: ClaimVerdict = "NOT_FOUND";
  const assurance = claim.proof.kind === "exact_quote"
    ? "EXACT"
    : claim.proof.kind === "structured_fact"
      ? "STRUCTURED"
      : claim.proof.kind === "derived"
        ? "DERIVED"
        : "SEMANTIC";

  if (!findings.some((item) => item.severity === "BLOCKER")) {
    if (claim.proof.kind === "exact_quote") {
      const mode = claim.proof.normalization ?? "exact";
      const quote = normalized(claim.proof.quote, mode);
      const matched = checked.chunks.some((chunk) => normalized(chunk.text, mode).includes(quote));
      const claimIsOnlyQuote = normalized(claim.text, mode) === quote;
      verdict = !matched ? "NOT_FOUND" : claimIsOnlyQuote ? "SUPPORTED" : "PARTIAL";
      if (!matched) {
        findings.push(finding(
          "QUOTE_NOT_FOUND",
          "BLOCKER",
          "Quoted text is not present in any cited chunk under the declared normalization.",
          { claimId: claim.claimId },
        ));
      } else if (!claimIsOnlyQuote) {
        findings.push(finding(
          "EXACT_QUOTE_CLAIM_HAS_UNVERIFIED_TEXT",
          "MAJOR",
          "The quoted span is present, but the claim contains additional text not proved by exact quotation matching. Split it into separate atomic claims.",
          { claimId: claim.claimId },
        ));
      }
    } else if (claim.proof.kind === "structured_fact") {
      const proof = claim.proof;
      const values = checked.chunks
        .map((chunk) => chunk.structuredFacts?.[proof.field])
        .filter((value): value is JsonValue => value !== undefined);
      const distinct = new Set(values.map((value) => canonicalJson(value)));
      if (values.length === 0) {
        verdict = "NOT_FOUND";
        findings.push(finding(
          "STRUCTURED_FIELD_NOT_FOUND",
          "BLOCKER",
          "Field " + proof.field + " is absent from cited chunks.",
          { claimId: claim.claimId },
        ));
      } else if (distinct.size > 1) {
        verdict = "PARTIAL";
        findings.push(finding(
          "STRUCTURED_FACT_CONFLICT",
          "MAJOR",
          "Cited chunks disagree on " + proof.field + ".",
          { claimId: claim.claimId },
        ));
      } else if (values.some((value) => sameJson(value, proof.expected))) {
        verdict = "SUPPORTED";
      } else {
        verdict = "CONTRADICTED";
        findings.push(finding(
          "STRUCTURED_FACT_MISMATCH",
          "BLOCKER",
          "Cited " + proof.field + " does not equal the claimed value.",
          { claimId: claim.claimId },
        ));
      }
    } else if (claim.proof.kind === "derived") {
      const derived = calculateDerived(claim, checked.chunks);
      verdict = derived.verdict;
      findings.push(...derived.findings);
    } else if (checker) {
      const output = await checker.verify({
        claim,
        chunks: checked.chunks,
        sources: checked.sources,
        domain: request.domain,
      });
      if (!Number.isFinite(output.score) || output.score < 0 || output.score > 1) {
        verdict = "UNCHECKED";
        findings.push(finding(
          "SEMANTIC_CHECKER_INVALID_SCORE",
          "BLOCKER",
          "Semantic checker returned a score outside [0, 1].",
          { claimId: claim.claimId },
        ));
      } else {
        verdict = output.verdict;
        checkerScores[checker.name + "@" + checker.version] = output.score;
        for (const reason of output.reasons) {
          findings.push(finding(
            "SEMANTIC_CHECKER_REASON",
            "INFO",
            reason,
            { claimId: claim.claimId },
          ));
        }
      }
    } else {
      const attestations = validSemanticAttestations(
        request,
        claim,
        checked.chunks,
        checked.sources,
        findings,
      );
      if (attestations.length === 0) {
        verdict = "UNCHECKED";
        findings.push(finding(
          "SEMANTIC_CHECKER_UNAVAILABLE",
          "MAJOR",
          "Semantic support has no live checker result or trusted hash-bound attestation.",
          { claimId: claim.claimId },
        ));
      } else {
        for (const attestation of attestations) {
          checkerScores[attestation.checkerName + "@" + attestation.checkerVersion] =
            attestation.score;
          for (const reason of attestation.reasons) {
            findings.push(finding(
              "SEMANTIC_ATTESTATION_REASON",
              "INFO",
              reason,
              { claimId: claim.claimId },
            ));
          }
        }
        const attestedVerdicts = new Set(attestations.map((item) => item.verdict));
        if (attestedVerdicts.size > 1) {
          verdict = "PARTIAL";
          findings.push(finding(
            "SEMANTIC_ATTESTATION_CONFLICT",
            "MAJOR",
            "Trusted semantic attestations disagree.",
            { claimId: claim.claimId },
          ));
        } else {
          verdict = attestations[0]!.verdict;
        }
      }
    }
  }

  if (claim.proof.kind === "semantic") {
    if (verdict === "CONTRADICTED") {
      findings.push(finding(
        "SEMANTIC_CLAIM_CONTRADICTED",
        "BLOCKER",
        "The trusted semantic check contradicts this material claim.",
        { claimId: claim.claimId },
      ));
    } else if (verdict === "NOT_FOUND") {
      findings.push(finding(
        "SEMANTIC_CLAIM_NOT_FOUND",
        "BLOCKER",
        "The trusted semantic check could not find support for this material claim.",
        { claimId: claim.claimId },
      ));
    }
  }

  return {
    claimId: claim.claimId,
    claimText: claim.text,
    assurance,
    verdict,
    validCitations: checked.citations,
    checkerScores,
    findings,
  };
}

function validSemanticAttestations(
  request: VerifyRequest,
  claim: AtomicClaim,
  chunks: EvidenceChunk[],
  sources: SourceRecord[],
  findings: Finding[],
): SemanticAttestation[] {
  const trusted = new Set(request.policy.trustedSemanticCheckers ?? []);
  const claimHash = sha256Text(claim.text);
  const claimFingerprint = semanticClaimFingerprint(claim);
  const claimBindingHash = semanticClaimBindingHash(claim);
  const evidenceHash = semanticEvidenceHash(
    request.evidence.snapshotId,
    chunks,
    sources,
    request.domain,
  );
  const valid: SemanticAttestation[] = [];
  for (const attestation of request.semanticAttestations ?? []) {
    if (attestation.claimId !== claim.claimId) continue;
    const checkerId = attestation.checkerName + "@" + attestation.checkerVersion;
    if (!trusted.has(checkerId)) {
      findings.push(finding(
        "SEMANTIC_ATTESTOR_NOT_TRUSTED",
        "MAJOR",
        "Semantic attestor " + checkerId + " is not allowlisted by policy.",
        { claimId: claim.claimId },
      ));
      continue;
    }
    const scope = attestation.bindingScope ?? "subject";
    const subjectMatches = attestation.subjectSha256 === request.subject.sha256;
    const currentCoverageIsComplete = request.coverage.complete === true
      && request.coverage.subjectSha256 === request.subject.sha256;
    if (
      !subjectMatches
      && scope === "claim"
      && request.policy.allowClaimScopedAttestations === true
      && claim.selfContained === true
      && !currentCoverageIsComplete
    ) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_CLAIM_SCOPE_COVERAGE_INCOMPLETE",
        "MAJOR",
        "A claim-scoped attestation from another subject version cannot be reused until the current subject has a complete hash-matched claim inventory.",
        { claimId: claim.claimId },
      ));
      continue;
    }
    const claimScopeReuse = scope === "claim"
      && request.policy.allowClaimScopedAttestations === true
      && claim.selfContained === true
      && currentCoverageIsComplete;
    const exactClaimTextMatches = attestation.claimTextHash === claimHash;
    const normalizedClaimTextMatches = claimScopeReuse
      && request.policy.allowNormalizedClaimReuse === true
      && claimFingerprint !== undefined
      && attestation.claimFingerprint === claimFingerprint;
    const claimBindingMatches = attestation.claimBindingHash === claimBindingHash;
    const bindingMatches = (subjectMatches || claimScopeReuse)
      && attestation.snapshotId === request.evidence.snapshotId
      && (exactClaimTextMatches || normalizedClaimTextMatches)
      && claimBindingMatches
      && attestation.evidenceHash === evidenceHash;
    if (!bindingMatches) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_BINDING_MISMATCH",
        "MAJOR",
        "Semantic attestation is tied to a different subject, claim, snapshot, or evidence content.",
        { claimId: claim.claimId },
      ));
      continue;
    }
    if (!subjectMatches && claimScopeReuse) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_CLAIM_SCOPE_REUSED",
        "INFO",
        exactClaimTextMatches
          ? "A claim-scoped attestation from another subject version was reused because the exact atomic claim and cited evidence hashes are unchanged."
          : "A claim-scoped attestation from another subject version was reused under the explicit normalized-claim policy; protected claim and evidence bindings are unchanged.",
        { claimId: claim.claimId },
      ));
    }
    if (!exactClaimTextMatches && normalizedClaimTextMatches) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_NORMALIZED_CLAIM_REUSED",
        "INFO",
        "The exact wording changed, but the versioned deterministic claim fingerprint and every protected binding remained unchanged.",
        { claimId: claim.claimId },
      ));
    }
    const checkedAtMs = Date.parse(attestation.checkedAt);
    const requestedAtMs = Date.parse(request.requestedAt);
    if (Number.isFinite(checkedAtMs) && checkedAtMs > requestedAtMs + 300_000) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_FROM_FUTURE",
        "MAJOR",
        "Semantic attestation is dated more than five minutes after the verification request.",
        { claimId: claim.claimId },
      ));
      continue;
    }
    if (
      !Number.isFinite(attestation.score)
      || attestation.score < 0
      || attestation.score > 1
      || !Number.isFinite(checkedAtMs)
    ) {
      findings.push(finding(
        "SEMANTIC_ATTESTATION_INVALID",
        "MAJOR",
        "Semantic attestation has an invalid score or timestamp.",
        { claimId: claim.claimId },
      ));
      continue;
    }
    valid.push(attestation);
  }
  return valid;
}

function getPath(root: Record<string, JsonValue>, path: string): JsonValue | undefined {
  let value: JsonValue | undefined = root;
  for (const segment of path.split(".")) {
    if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function leafPaths(value: JsonValue, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) => leafPaths(child, prefix ? prefix + "." + key : key));
}

function verifyAction(
  request: VerifyRequest,
  action: ActionProposal,
  sourceMap: Map<string, SourceRecord>,
  chunkMap: Map<string, EvidenceChunk>,
): ActionResult {
  const findings: Finding[] = [];
  const allowedActions = request.policy.allowedActions;
  const policy = allowedActions && Object.hasOwn(allowedActions, action.type)
    ? allowedActions[action.type]
    : undefined;
  const retrieved = new Set(request.retrievedChunkIds);
  if (!policy) {
    findings.push(finding(
      "ACTION_NOT_ALLOWED",
      "BLOCKER",
      "Action type " + action.type + " is not allowlisted.",
      { actionId: action.actionId },
    ));
    return { actionId: action.actionId, type: action.type, decision: "DENY", findings };
  }
  for (const arg of policy.requiredArgs) {
    if (getPath(action.args, arg) === undefined) {
      findings.push(finding(
        "ACTION_ARG_MISSING",
        "BLOCKER",
        "Required action arg " + arg + " is missing.",
        { actionId: action.actionId },
      ));
    }
  }
  if (policy.allowedArgs) {
    for (const arg of leafPaths(action.args)) {
      if (!policy.allowedArgs.includes(arg)) {
        findings.push(finding(
          "ACTION_ARG_NOT_ALLOWED",
          "BLOCKER",
          "Action arg " + arg + " is not allowlisted.",
          { actionId: action.actionId },
        ));
      }
    }
  }
  if (policy.requireIdempotencyKey && !action.idempotencyKey) {
    findings.push(finding(
      "ACTION_IDEMPOTENCY_KEY_MISSING",
      "BLOCKER",
      "Action requires an idempotency key.",
      { actionId: action.actionId },
    ));
  }
  for (const argPath of policy.requireBindings ?? []) {
    const binding = action.bindings.find((candidate) => candidate.argPath === argPath);
    if (!binding) {
      findings.push(finding(
        "ACTION_BINDING_MISSING",
        "BLOCKER",
        "Action arg " + argPath + " is not evidence-bound.",
        { actionId: action.actionId },
      ));
      continue;
    }
    const chunk = chunkMap.get(binding.chunkId);
    const source = sourceMap.get(binding.sourceId);
    const fact = chunk?.structuredFacts?.[binding.field];
    const actual = getPath(action.args, argPath);
    const context = {
      actionId: action.actionId,
      sourceId: binding.sourceId,
      chunkId: binding.chunkId,
    };
    if (
      !source
      || !chunk
      || chunk.sourceId !== binding.sourceId
      || !retrieved.has(binding.chunkId)
    ) {
      findings.push(finding(
        "ACTION_BINDING_INVALID",
        "BLOCKER",
        "Action arg " + argPath + " references invalid or unretrieved evidence.",
        context,
      ));
      continue;
    }
    if (chunk.sha256 && sha256Text(chunk.text) !== chunk.sha256) {
      findings.push(finding(
        "ACTION_CHUNK_HASH_MISMATCH",
        "BLOCKER",
        "Action binding chunk text does not match its recorded SHA-256.",
        context,
      ));
    }
    const actionAsOf = request.requestedAt;
    if (source.effectiveFrom && dateIsAfter(source.effectiveFrom, actionAsOf)) {
      findings.push(finding(
        "ACTION_SOURCE_NOT_YET_EFFECTIVE",
        "BLOCKER",
        source.sourceId + " was not effective for this action request.",
        context,
      ));
    }
    if (source.effectiveTo && dateIsAfter(actionAsOf, source.effectiveTo)) {
      findings.push(finding(
        "ACTION_SOURCE_EXPIRED",
        "BLOCKER",
        source.sourceId + " expired before this action request.",
        context,
      ));
    }
    if (source.retrievedAt) {
      const ageMs = Date.parse(request.requestedAt) - Date.parse(source.retrievedAt);
      if (Number.isFinite(ageMs) && ageMs < 0) {
        findings.push(finding(
          "ACTION_SOURCE_RETRIEVED_IN_FUTURE",
          "BLOCKER",
          source.sourceId + " was retrieved after this action request.",
          context,
        ));
      } else if (
        request.policy.maxSourceAgeDays !== undefined
        && (!Number.isFinite(ageMs)
          || ageMs > request.policy.maxSourceAgeDays * 86_400_000)
      ) {
        findings.push(finding(
          "ACTION_SOURCE_STALE",
          "BLOCKER",
          source.sourceId + " exceeds the action freshness policy.",
          context,
        ));
      }
    } else if (request.policy.maxSourceAgeDays !== undefined) {
      findings.push(finding(
        "ACTION_SOURCE_FRESHNESS_UNKNOWN",
        "BLOCKER",
        source.sourceId + " has no retrieval timestamp.",
        context,
      ));
    }
    if (source.domains && !source.domains.includes(request.domain)) {
      findings.push(finding(
        "ACTION_SOURCE_DOMAIN_MISMATCH",
        "BLOCKER",
        source.sourceId + " is outside request domain " + request.domain + ".",
        context,
      ));
    }
    if (fact === undefined || !sameJson(fact, actual)) {
      findings.push(finding(
        "ACTION_VALUE_MISMATCH",
        "BLOCKER",
        "Action arg " + argPath + " differs from its bound structured fact.",
        {
          actionId: action.actionId,
          sourceId: binding.sourceId,
          chunkId: binding.chunkId,
        },
      ));
    }
  }
  const blocked = findings.some((item) => item.severity === "BLOCKER");
  return {
    actionId: action.actionId,
    type: action.type,
    decision: blocked ? "DENY" : policy.requireConfirmation ? "CONFIRM" : "ALLOW",
    findings,
  };
}

function decide(
  request: VerifyRequest,
  coverage: VerificationResult["coverage"],
  claims: ClaimResult[],
): Decision {
  const materialIds = new Set(
    request.claims
      .filter((claim) => claim.material || claim.risk === "high")
      .map((claim) => claim.claimId),
  );
  const material = claims.filter((claim) => materialIds.has(claim.claimId));
  const highRisk = request.policy.riskTier === "high"
    || request.claims.some((claim) => claim.risk === "high");
  if (highRisk && material.length === 0) return "HUMAN_REVIEW";
  // Coverage can prevent PASS, but it must not conceal a dispositive failure
  // already established in the checked claim set.
  if (material.some((claim) => claim.verdict === "CONTRADICTED")) return "ABSTAIN";
  if (material.some((claim) => claim.verdict === "NOT_FOUND")) {
    return highRisk ? "ABSTAIN" : "REWRITE";
  }
  if (
    (highRisk || request.policy.requireCompleteCoverage)
    && coverage !== "COMPLETE"
  ) return "HUMAN_REVIEW";
  if (material.some((claim) => claim.verdict === "PARTIAL" || claim.verdict === "UNCHECKED")) {
    return "HUMAN_REVIEW";
  }
  return "PASS";
}

export async function verifyRequest(
  raw: unknown,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  assertVerifyRequest(raw);
  const request = raw;
  const inputHash = hashObject(request);
  const sourceMap = new Map(request.evidence.sources.map((source) => [source.sourceId, source]));
  const chunkMap = new Map(request.evidence.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const topFindings: Finding[] = [];

  let coverage: VerificationResult["coverage"] = "COMPLETE";
  if (request.coverage.subjectSha256 !== request.subject.sha256) {
    coverage = "MISMATCH";
    topFindings.push(finding(
      "COVERAGE_SUBJECT_HASH_MISMATCH",
      "BLOCKER",
      "Coverage inventory is tied to a different subject hash.",
    ));
  } else if (!request.coverage.complete) {
    coverage = "INCOMPLETE";
    topFindings.push(finding(
      "CLAIM_COVERAGE_INCOMPLETE",
      "BLOCKER",
      "Material claim inventory is not complete.",
    ));
  }

  const claims: ClaimResult[] = [];
  for (const claim of request.claims) {
    claims.push(await verifyClaim(request, claim, sourceMap, chunkMap, options.semanticChecker));
  }
  const actions = (request.actions ?? []).map((action) =>
    verifyAction(request, action, sourceMap, chunkMap)
  );
  const allFindings = [
    ...topFindings,
    ...claims.flatMap((claim) => claim.findings),
    ...actions.flatMap((action) => action.findings),
  ];
  return {
    schemaVersion: "0.1.0",
    engineVersion: ENGINE_VERSION,
    requestId: request.requestId,
    inputHash,
    decision: decide(request, coverage, claims),
    coverage,
    claims,
    actions,
    findings: allFindings,
  };
}
