import { readFile } from "node:fs/promises";
import { sha256File } from "./canonical.js";
import type { VerificationResult, VerifyRequest } from "./types.js";
import { assertVerifyRequest, ContractError } from "./validate.js";
import { verifyRequest } from "./verify.js";

export interface LegalVerification {
  request: VerifyRequest;
  result: VerificationResult;
}

export async function createLegalManifestSkeleton(
  draftPath: string,
  subjectId: string,
): Promise<VerifyRequest> {
  const now = new Date().toISOString();
  const draftHash = await sha256File(draftPath);
  return {
    schemaVersion: "0.1.0",
    requestId: "legal-" + now.replace(/[^0-9]/gu, "").slice(0, 17),
    requestedAt: now,
    domain: "bc-legal",
    subject: {
      subjectId,
      mediaType: "text/markdown",
      sha256: draftHash,
      path: draftPath,
    },
    coverage: {
      complete: false,
      method: "manual_inventory",
      subjectSha256: draftHash,
      notes: "Set complete=true only after every material assertion has been inventoried.",
    },
    evidence: {
      schemaVersion: "0.1.0",
      snapshotId: "legal-snapshot-" + draftHash.slice(0, 12),
      createdAt: now,
      domain: "bc-legal",
      sources: [],
      chunks: [],
    },
    retrievedChunkIds: [],
    claims: [],
    policy: {
      policyId: "bc-legal-v1",
      riskTier: "high",
      requireCompleteCoverage: true,
      requireRetrievedCitationClosure: true,
      trustedSemanticCheckers: ["legal-draft-verifier@0.1.0"],
    },
  };
}

export async function loadLegalManifest(
  draftPath: string,
  manifestPath: string,
): Promise<VerifyRequest> {
  const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  assertVerifyRequest(raw);
  const actualHash = await sha256File(draftPath);
  const issues: string[] = [];
  if (raw.domain !== "bc-legal") issues.push("legal adapter requires domain=bc-legal");
  if (raw.policy.riskTier !== "high") issues.push("legal adapter requires policy.riskTier=high");
  if (!raw.policy.requireCompleteCoverage) {
    issues.push("legal adapter requires policy.requireCompleteCoverage=true");
  }
  if (!raw.policy.requireRetrievedCitationClosure) {
    issues.push("legal adapter requires policy.requireRetrievedCitationClosure=true");
  }
  if (raw.subject.sha256 !== actualHash) {
    issues.push("draft SHA-256 does not match manifest subject.sha256");
  }
  if (raw.coverage.subjectSha256 !== actualHash) {
    issues.push("draft SHA-256 does not match coverage.subjectSha256");
  }
  for (const claim of raw.claims) {
    if (!claim.material) continue;
    if (
      claim.proof.kind === "semantic"
      && (!claim.requiredAuthority || claim.requiredAuthority.length === 0)
    ) {
      issues.push("material semantic legal claim " + claim.claimId + " lacks requiredAuthority");
    }
    if (!claim.jurisdiction) {
      issues.push("material legal claim " + claim.claimId + " lacks jurisdiction");
    }
  }
  if (issues.length > 0) throw new ContractError(issues);
  return raw;
}

export async function verifyLegalDraft(
  draftPath: string,
  manifestPath: string,
): Promise<LegalVerification> {
  const request = await loadLegalManifest(draftPath, manifestPath);
  const result = await verifyRequest(request);
  return { request, result };
}
