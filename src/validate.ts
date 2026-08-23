import type { VerifyRequest } from "./types.js";

export class ContractError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid verification request: ${issues.join("; ")}`);
    this.name = "ContractError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value: unknown): boolean {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}

const AUTHORITY_TIERS = new Set([
  "primary",
  "official_guidance",
  "secondary",
  "user_provided",
  "unknown",
]);
const RISK_TIERS = new Set(["low", "medium", "high"]);
const CLAIM_VERDICTS = new Set(["SUPPORTED", "PARTIAL", "CONTRADICTED", "NOT_FOUND"]);
const RESERVED_ACTION_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function rejectUnknownProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${label} has unknown property: ${key}`);
  }
}

function validActionPath(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const segments = value.split(".");
  return segments.every((segment) =>
    segment.trim().length > 0 && !RESERVED_ACTION_PATH_SEGMENTS.has(segment)
  );
}

function validActionPathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(validActionPath);
}

export function assertVerifyRequest(value: unknown): asserts value is VerifyRequest {
  const issues: string[] = [];
  if (!value || typeof value !== "object") throw new ContractError(["root must be an object"]);
  const root = value as Record<string, unknown>;
  rejectUnknownProperties(root, [
    "schemaVersion",
    "requestId",
    "requestedAt",
    "domain",
    "question",
    "subject",
    "coverage",
    "evidence",
    "retrievedChunkIds",
    "claims",
    "semanticAttestations",
    "actions",
    "policy",
  ], "root", issues);
  if (root.schemaVersion !== "0.1.0") issues.push("schemaVersion must be 0.1.0");
  if (!nonEmpty(root.requestId)) issues.push("requestId is required");
  if (!validDate(root.requestedAt)) issues.push("requestedAt must be an ISO date/time");
  if (!nonEmpty(root.domain)) issues.push("domain is required");
  if (root.question !== undefined && typeof root.question !== "string") {
    issues.push("question must be a string");
  }

  const subject = record(root.subject) ? root.subject : undefined;
  if (!subject) {
    issues.push("subject is required");
  } else {
    rejectUnknownProperties(
      subject,
      ["subjectId", "mediaType", "sha256", "path"],
      "subject",
      issues,
    );
    if (!nonEmpty(subject.subjectId)) issues.push("subject.subjectId is required");
    if (!nonEmpty(subject.mediaType)) issues.push("subject.mediaType is required");
    if (!validSha256(subject.sha256)) issues.push("subject.sha256 must be lowercase SHA-256");
    if (subject.path !== undefined && typeof subject.path !== "string") {
      issues.push("subject.path must be a string");
    }
  }

  const coverage = record(root.coverage) ? root.coverage : undefined;
  if (!coverage) {
    issues.push("coverage is required");
  } else {
    rejectUnknownProperties(
      coverage,
      ["complete", "method", "subjectSha256", "reviewer", "notes"],
      "coverage",
      issues,
    );
    if (typeof coverage.complete !== "boolean") issues.push("coverage.complete is required");
    if (!["manual_inventory", "extractor", "hybrid"].includes(String(coverage.method))) {
      issues.push("coverage.method is invalid");
    }
    if (!validSha256(coverage.subjectSha256)) {
      issues.push("coverage.subjectSha256 must be lowercase SHA-256");
    }
  }

  const evidence = record(root.evidence) ? root.evidence : undefined;
  if (!evidence) {
    issues.push("evidence is required");
  } else {
    rejectUnknownProperties(
      evidence,
      ["schemaVersion", "snapshotId", "createdAt", "domain", "sources", "chunks"],
      "evidence",
      issues,
    );
    if (evidence.schemaVersion !== "0.1.0") {
      issues.push("evidence.schemaVersion must be 0.1.0");
    }
    if (!nonEmpty(evidence.snapshotId)) issues.push("evidence.snapshotId is required");
    if (!validDate(evidence.createdAt)) issues.push("evidence.createdAt must be an ISO date/time");
    if (!nonEmpty(evidence.domain)) issues.push("evidence.domain is required");
    if (nonEmpty(root.domain) && nonEmpty(evidence.domain) && evidence.domain !== root.domain) {
      issues.push("evidence.domain must match request domain");
    }
    if (!Array.isArray(evidence.sources)) issues.push("evidence.sources must be an array");
    if (!Array.isArray(evidence.chunks)) issues.push("evidence.chunks must be an array");
  }

  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const chunks = Array.isArray(evidence?.chunks) ? evidence.chunks : [];
  const claims = Array.isArray(root.claims) ? root.claims : [];
  const retrievedChunkIds = Array.isArray(root.retrievedChunkIds) ? root.retrievedChunkIds : [];
  if (!Array.isArray(root.retrievedChunkIds)) issues.push("retrievedChunkIds must be an array");
  if (!Array.isArray(root.claims)) issues.push("claims must be an array");

  const sourceIds = new Set<string>();
  for (const rawSource of sources) {
    if (!record(rawSource)) {
      issues.push("every source must be an object");
      continue;
    }
    const source = rawSource;
    rejectUnknownProperties(source, [
      "sourceId",
      "title",
      "sourceType",
      "authorityTier",
      "sha256",
      "uri",
      "issuer",
      "version",
      "retrievedAt",
      "effectiveFrom",
      "effectiveTo",
      "jurisdictions",
      "domains",
    ], `source ${String(source.sourceId)}`, issues);
    if (!nonEmpty(source.sourceId)) issues.push("every source needs sourceId");
    else if (sourceIds.has(source.sourceId)) issues.push(`duplicate sourceId: ${source.sourceId}`);
    else sourceIds.add(source.sourceId);
    if (!nonEmpty(source.title)) issues.push(`source ${String(source.sourceId)} needs title`);
    if (!nonEmpty(source.sourceType)) issues.push(`source ${String(source.sourceId)} needs sourceType`);
    if (!AUTHORITY_TIERS.has(String(source.authorityTier))) {
      issues.push(`source ${String(source.sourceId)} has invalid authorityTier`);
    }
    if (source.sha256 !== undefined && !validSha256(source.sha256)) {
      issues.push(`source ${String(source.sourceId)} has invalid sha256`);
    }
    for (const field of ["retrievedAt", "effectiveFrom", "effectiveTo"] as const) {
      if (source[field] !== undefined && !validDate(source[field])) {
        issues.push(`source ${String(source.sourceId)} has invalid ${field}`);
      }
    }
    if (source.jurisdictions !== undefined && !stringArray(source.jurisdictions)) {
      issues.push(`source ${String(source.sourceId)} jurisdictions must be strings`);
    }
    if (source.domains !== undefined && !stringArray(source.domains)) {
      issues.push(`source ${String(source.sourceId)} domains must be strings`);
    }
  }
  const chunkIds = new Set<string>();
  for (const rawChunk of chunks) {
    if (!record(rawChunk)) {
      issues.push("every chunk must be an object");
      continue;
    }
    const chunk = rawChunk;
    rejectUnknownProperties(
      chunk,
      ["chunkId", "sourceId", "text", "sha256", "locator", "structuredFacts"],
      `chunk ${String(chunk.chunkId)}`,
      issues,
    );
    if (!nonEmpty(chunk.chunkId)) issues.push("every chunk needs chunkId");
    else if (chunkIds.has(chunk.chunkId)) issues.push(`duplicate chunkId: ${chunk.chunkId}`);
    else chunkIds.add(chunk.chunkId);
    if (!nonEmpty(chunk.sourceId) || !sourceIds.has(chunk.sourceId)) {
      issues.push(`chunk ${String(chunk.chunkId)} references unknown source ${String(chunk.sourceId)}`);
    }
    if (typeof chunk.text !== "string") issues.push(`chunk ${String(chunk.chunkId)} needs text`);
    if (chunk.sha256 !== undefined && !validSha256(chunk.sha256)) {
      issues.push(`chunk ${String(chunk.chunkId)} has invalid sha256`);
    }
    if (chunk.structuredFacts !== undefined) {
      if (!record(chunk.structuredFacts)) {
        issues.push(`chunk ${String(chunk.chunkId)} structuredFacts must be an object`);
      } else if (!Object.values(chunk.structuredFacts).every(jsonValue)) {
        issues.push(`chunk ${String(chunk.chunkId)} structuredFacts must contain JSON values`);
      }
    }
  }
  const retrieved = new Set<string>();
  for (const chunkId of retrievedChunkIds) {
    if (!nonEmpty(chunkId)) issues.push("retrievedChunkIds must contain non-empty strings");
    else if (retrieved.has(chunkId)) issues.push(`duplicate retrievedChunkId: ${chunkId}`);
    else {
      retrieved.add(chunkId);
      if (!chunkIds.has(chunkId)) issues.push(`retrievedChunkIds references unknown chunk: ${chunkId}`);
    }
  }

  const claimIds = new Set<string>();
  for (const rawClaim of claims) {
    if (!record(rawClaim)) {
      issues.push("every claim must be an object");
      continue;
    }
    const claim = rawClaim;
    rejectUnknownProperties(claim, [
      "claimId",
      "text",
      "material",
      "risk",
      "selfContained",
      "citations",
      "proof",
      "jurisdiction",
      "asOf",
      "requiredAuthority",
      "draftLocator",
    ], `claim ${String(claim.claimId)}`, issues);
    if (!nonEmpty(claim.claimId)) issues.push("every claim needs claimId");
    else if (claimIds.has(claim.claimId)) issues.push(`duplicate claimId: ${claim.claimId}`);
    else claimIds.add(claim.claimId);
    const label = String(claim.claimId || "<unknown>");
    if (!nonEmpty(claim.text)) issues.push(`claim ${label} needs text`);
    if (typeof claim.material !== "boolean") issues.push(`claim ${label} needs material boolean`);
    if (claim.selfContained !== undefined && typeof claim.selfContained !== "boolean") {
      issues.push(`claim ${label} selfContained must be boolean`);
    }
    if (!RISK_TIERS.has(String(claim.risk))) issues.push(`claim ${label} has invalid risk`);
    if (!Array.isArray(claim.citations)) {
      issues.push(`claim ${label} needs citations[]`);
    } else {
      for (const citation of claim.citations) {
        if (!record(citation)) {
          issues.push(`claim ${label} has an invalid citation`);
          continue;
        }
        rejectUnknownProperties(
          citation,
          ["sourceId", "chunkId"],
          `claim ${label} citation`,
          issues,
        );
        if (!nonEmpty(citation.sourceId) || !nonEmpty(citation.chunkId)) {
          issues.push(`claim ${label} has an invalid citation`);
        }
      }
    }
    if (claim.asOf !== undefined && !validDate(claim.asOf)) {
      issues.push(`claim ${label} has invalid asOf`);
    }
    if (
      claim.requiredAuthority !== undefined
      && (!Array.isArray(claim.requiredAuthority)
        || !claim.requiredAuthority.every((tier) => AUTHORITY_TIERS.has(String(tier))))
    ) {
      issues.push(`claim ${label} has invalid requiredAuthority`);
    }
    if (!record(claim.proof)) {
      issues.push(`claim ${label} has invalid proof`);
      continue;
    }
    const proof = claim.proof;
    if (proof.kind === "exact_quote") {
      rejectUnknownProperties(
        proof,
        ["kind", "quote", "normalization"],
        `claim ${label} proof`,
        issues,
      );
      if (!nonEmpty(proof.quote)) issues.push(`claim ${label} exact quote is required`);
      if (
        proof.normalization !== undefined
        && !["exact", "unicode", "whitespace"].includes(String(proof.normalization))
      ) {
        issues.push(`claim ${label} has invalid quote normalization`);
      }
    } else if (proof.kind === "structured_fact") {
      rejectUnknownProperties(
        proof,
        ["kind", "field", "expected"],
        `claim ${label} proof`,
        issues,
      );
      if (!nonEmpty(proof.field)) issues.push(`claim ${label} structured field is required`);
      if (!Object.hasOwn(proof, "expected") || !jsonValue(proof.expected)) {
        issues.push(`claim ${label} structured expected must be a JSON value`);
      }
    } else if (proof.kind === "derived") {
      rejectUnknownProperties(
        proof,
        ["kind", "operation", "operands", "expected", "bindings"],
        `claim ${label} proof`,
        issues,
      );
      if (!["add", "subtract", "multiply", "divide", "date_add_days"].includes(String(proof.operation))) {
        issues.push(`claim ${label} has invalid derived operation`);
      }
      const operands = Array.isArray(proof.operands) ? proof.operands : [];
      if (operands.length < 2 || !operands.every(jsonValue)) {
        issues.push(`claim ${label} derived operands must contain at least two JSON values`);
      }
      if (!Object.hasOwn(proof, "expected") || !jsonValue(proof.expected)) {
        issues.push(`claim ${label} derived expected must be a JSON value`);
      }
      if (!Array.isArray(proof.bindings)) {
        issues.push(`claim ${label} derived bindings must be an array`);
      } else {
        for (const binding of proof.bindings) {
          if (!record(binding)) {
            issues.push(`claim ${label} has an invalid derived binding`);
            continue;
          }
          rejectUnknownProperties(
            binding,
            ["operandIndex", "sourceId", "chunkId", "field"],
            `claim ${label} derived binding`,
            issues,
          );
          if (
            !Number.isInteger(binding.operandIndex)
            || Number(binding.operandIndex) < 0
            || Number(binding.operandIndex) >= operands.length
            || !nonEmpty(binding.sourceId)
            || !nonEmpty(binding.chunkId)
            || !nonEmpty(binding.field)
          ) {
            issues.push(`claim ${label} has an invalid derived binding`);
          }
        }
      }
    } else if (proof.kind === "semantic") {
      rejectUnknownProperties(proof, ["kind"], `claim ${label} proof`, issues);
    } else {
      rejectUnknownProperties(proof, ["kind"], `claim ${label} proof`, issues);
      issues.push(`claim ${label} has invalid proof kind`);
    }
  }

  const rawAttestations = root.semanticAttestations;
  if (rawAttestations !== undefined && !Array.isArray(rawAttestations)) {
    issues.push("semanticAttestations must be an array");
  }
  const attestations = Array.isArray(rawAttestations) ? rawAttestations : [];
  for (const rawAttestation of attestations) {
    if (!record(rawAttestation)) {
      issues.push("every semantic attestation must be an object");
      continue;
    }
    const attestation = rawAttestation;
    rejectUnknownProperties(attestation, [
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
    ], "semantic attestation", issues);
    if (!nonEmpty(attestation.claimId) || !claimIds.has(attestation.claimId)) {
      issues.push("semantic attestation references unknown claimId: " + String(attestation.claimId));
    }
    if (!nonEmpty(attestation.checkerName) || !nonEmpty(attestation.checkerVersion)) {
      issues.push("every semantic attestation needs checkerName and checkerVersion");
    }
    if (!["human", "model", "hybrid"].includes(String(attestation.checkerKind))) {
      issues.push("semantic attestation checkerKind is invalid");
    }
    if (
      attestation.bindingScope !== undefined
      && !["subject", "claim"].includes(String(attestation.bindingScope))
    ) {
      issues.push("semantic attestation bindingScope is invalid");
    }
    if (!CLAIM_VERDICTS.has(String(attestation.verdict))) {
      issues.push("semantic attestation verdict is invalid");
    }
    if (!stringArray(attestation.reasons)) {
      issues.push("semantic attestation reasons must be strings");
    }
    if (!validDate(attestation.checkedAt)) {
      issues.push("semantic attestation checkedAt must be an ISO date/time");
    }
    if (
      typeof attestation.score !== "number"
      || !Number.isFinite(attestation.score)
      || attestation.score < 0
      || attestation.score > 1
    ) {
      issues.push("semantic attestation score must be in [0, 1]");
    }
    for (
      const field of [
        "subjectSha256",
        "claimTextHash",
        "claimBindingHash",
        "evidenceHash",
      ] as const
    ) {
      if (!validSha256(attestation[field])) {
        issues.push(`semantic attestation ${field} must be lowercase SHA-256`);
      }
    }
    if (attestation.claimFingerprint !== undefined && !validSha256(attestation.claimFingerprint)) {
      issues.push("semantic attestation claimFingerprint must be lowercase SHA-256");
    }
    const attestedClaim = claims.find((candidate) =>
      record(candidate) && candidate.claimId === attestation.claimId
    );
    if (
      attestation.bindingScope === "claim"
      && (!record(attestedClaim) || attestedClaim.selfContained !== true)
    ) {
      issues.push("claim-scoped semantic attestation requires claim.selfContained=true");
    }
    if (!nonEmpty(attestation.snapshotId)) {
      issues.push("semantic attestation snapshotId is required");
    }
  }

  const rawActions = root.actions;
  if (rawActions !== undefined && !Array.isArray(rawActions)) issues.push("actions must be an array");
  const actionIds = new Set<string>();
  for (const rawAction of Array.isArray(rawActions) ? rawActions : []) {
    if (!record(rawAction)) {
      issues.push("every action must be an object");
      continue;
    }
    const action = rawAction;
    rejectUnknownProperties(
      action,
      ["actionId", "type", "args", "bindings", "idempotencyKey"],
      `action ${String(action.actionId)}`,
      issues,
    );
    if (!nonEmpty(action.actionId)) issues.push("every action needs actionId");
    else if (actionIds.has(action.actionId)) issues.push(`duplicate actionId: ${action.actionId}`);
    else actionIds.add(action.actionId);
    const label = String(action.actionId || "<unknown>");
    if (!nonEmpty(action.type)) issues.push(`action ${label} needs type`);
    if (!record(action.args) || !Object.values(action.args).every(jsonValue)) {
      issues.push(`action ${label} args must contain JSON values`);
    }
    if (!Array.isArray(action.bindings)) {
      issues.push(`action ${label} bindings must be an array`);
    } else {
      for (const binding of action.bindings) {
        if (!record(binding)) {
          issues.push(`action ${label} has an invalid binding`);
          continue;
        }
        rejectUnknownProperties(
          binding,
          ["argPath", "sourceId", "chunkId", "field"],
          `action ${label} binding`,
          issues,
        );
        if (
          !validActionPath(binding.argPath)
          || !nonEmpty(binding.sourceId)
          || !nonEmpty(binding.chunkId)
          || !nonEmpty(binding.field)
        ) {
          issues.push(`action ${label} has an invalid binding`);
        }
      }
    }
    if (action.idempotencyKey !== undefined && !nonEmpty(action.idempotencyKey)) {
      issues.push(`action ${label} has invalid idempotencyKey`);
    }
  }

  const policy = record(root.policy) ? root.policy : undefined;
  if (!policy) {
    issues.push("policy is required");
  } else {
    rejectUnknownProperties(policy, [
      "policyId",
      "riskTier",
      "requireCompleteCoverage",
      "requireRetrievedCitationClosure",
      "maxSourceAgeDays",
      "trustedSemanticCheckers",
      "allowClaimScopedAttestations",
      "allowNormalizedClaimReuse",
      "allowedActions",
    ], "policy", issues);
    if (!nonEmpty(policy.policyId)) issues.push("policy.policyId is required");
    if (!RISK_TIERS.has(String(policy.riskTier))) issues.push("policy.riskTier is invalid");
    if (typeof policy.requireCompleteCoverage !== "boolean") {
      issues.push("policy.requireCompleteCoverage must be boolean");
    }
    if (typeof policy.requireRetrievedCitationClosure !== "boolean") {
      issues.push("policy.requireRetrievedCitationClosure must be boolean");
    }
    if (
      policy.maxSourceAgeDays !== undefined
      && (typeof policy.maxSourceAgeDays !== "number"
        || !Number.isFinite(policy.maxSourceAgeDays)
        || policy.maxSourceAgeDays < 0)
    ) {
      issues.push("policy.maxSourceAgeDays must be a non-negative number");
    }
    if (
      policy.trustedSemanticCheckers !== undefined
      && (!stringArray(policy.trustedSemanticCheckers)
        || policy.trustedSemanticCheckers.some((item) => !nonEmpty(item)))
    ) {
      issues.push("policy.trustedSemanticCheckers must contain non-empty strings");
    }
    if (
      policy.allowClaimScopedAttestations !== undefined
      && typeof policy.allowClaimScopedAttestations !== "boolean"
    ) {
      issues.push("policy.allowClaimScopedAttestations must be boolean");
    }
    if (
      policy.allowNormalizedClaimReuse !== undefined
      && typeof policy.allowNormalizedClaimReuse !== "boolean"
    ) {
      issues.push("policy.allowNormalizedClaimReuse must be boolean");
    }
    if (
      policy.allowNormalizedClaimReuse === true
      && policy.allowClaimScopedAttestations !== true
    ) {
      issues.push("policy.allowNormalizedClaimReuse requires allowClaimScopedAttestations=true");
    }
    if (policy.allowedActions !== undefined) {
      if (!record(policy.allowedActions)) {
        issues.push("policy.allowedActions must be an object");
      } else {
        for (const [actionType, rawRule] of Object.entries(policy.allowedActions)) {
          if (!record(rawRule)) {
            issues.push(`policy action ${actionType} needs requiredArgs[]`);
            continue;
          }
          rejectUnknownProperties(rawRule, [
            "requiredArgs",
            "allowedArgs",
            "requireBindings",
            "requireIdempotencyKey",
            "requireConfirmation",
          ], `policy action ${actionType}`, issues);
          if (!validActionPathArray(rawRule.requiredArgs)) {
            issues.push(`policy action ${actionType} needs valid requiredArgs[]`);
          }
          for (const field of ["allowedArgs", "requireBindings"] as const) {
            if (rawRule[field] !== undefined && !validActionPathArray(rawRule[field])) {
              issues.push(`policy action ${actionType} ${field} must contain valid action paths`);
            }
          }
          for (const field of ["requireIdempotencyKey", "requireConfirmation"] as const) {
            if (rawRule[field] !== undefined && typeof rawRule[field] !== "boolean") {
              issues.push(`policy action ${actionType} ${field} must be boolean`);
            }
          }
        }
      }
    }
  }
  if (issues.length > 0) throw new ContractError(issues);
}
