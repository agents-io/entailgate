import { sha256Text } from "./canonical.js";
import type {
  ClaimVerdict,
  SemanticAttestation,
  SourceRecord,
  VerifyRequest,
} from "./types.js";
import { ContractError } from "./validate.js";
import {
  semanticClaimBindingHash,
  semanticClaimFingerprint,
  semanticEvidenceHash,
} from "./verify.js";

export interface AttestationInput {
  claimId: string;
  checkerName: string;
  checkerVersion: string;
  checkerKind: SemanticAttestation["checkerKind"];
  bindingScope?: "subject" | "claim";
  verdict: Exclude<ClaimVerdict, "UNCHECKED">;
  score: number;
  reasons: string[];
  checkedAt?: string;
}

export function buildSemanticAttestation(
  request: VerifyRequest,
  input: AttestationInput,
): SemanticAttestation {
  const claim = request.claims.find((candidate) => candidate.claimId === input.claimId);
  if (!claim) throw new ContractError(["unknown claimId: " + input.claimId]);
  if (claim.proof.kind !== "semantic") {
    throw new ContractError(["attestations apply only to semantic claims"]);
  }
  if (input.bindingScope === "claim" && claim.selfContained !== true) {
    throw new ContractError(["claim-scoped attestation requires claim.selfContained=true"]);
  }
  const retrieved = new Set(request.retrievedChunkIds);
  const sourceMap = new Map(
    request.evidence.sources.map((source) => [source.sourceId, source]),
  );
  const chunkMap = new Map(
    request.evidence.chunks.map((chunk) => [chunk.chunkId, chunk]),
  );
  const chunks = claim.citations.map((citation) => {
    const source = sourceMap.get(citation.sourceId);
    const chunk = chunkMap.get(citation.chunkId);
    if (!source || !chunk || chunk.sourceId !== source.sourceId) {
      throw new ContractError([
        "claim citation is unknown or has a source mismatch: "
          + citation.sourceId + "/" + citation.chunkId,
      ]);
    }
    if (request.policy.requireRetrievedCitationClosure && !retrieved.has(chunk.chunkId)) {
      throw new ContractError(["claim citation is outside the retrieval set: " + chunk.chunkId]);
    }
    return chunk;
  });
  const uniqueChunks = [...new Map(
    chunks.map((chunk) => [`${chunk.sourceId}\u0000${chunk.chunkId}`, chunk]),
  ).values()];
  const citedSources = claim.citations
    .map((citation) => sourceMap.get(citation.sourceId))
    .filter((source): source is SourceRecord => source !== undefined);
  const sources = [...new Map(citedSources.map((source) => [source.sourceId, source])).values()];
  if (uniqueChunks.length === 0) {
    throw new ContractError(["semantic claim has no cited evidence"]);
  }
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
    throw new ContractError(["score must be in [0, 1]"]);
  }
  const claimFingerprint = semanticClaimFingerprint(claim);
  return {
    claimId: claim.claimId,
    checkerName: input.checkerName,
    checkerVersion: input.checkerVersion,
    checkerKind: input.checkerKind,
    ...(input.bindingScope ? { bindingScope: input.bindingScope } : {}),
    verdict: input.verdict,
    score: input.score,
    reasons: input.reasons,
    checkedAt: input.checkedAt ?? request.requestedAt,
    subjectSha256: request.subject.sha256,
    snapshotId: request.evidence.snapshotId,
    claimTextHash: sha256Text(claim.text),
    ...(claimFingerprint === undefined ? {} : { claimFingerprint }),
    claimBindingHash: semanticClaimBindingHash(claim),
    evidenceHash: semanticEvidenceHash(
      request.evidence.snapshotId,
      uniqueChunks,
      sources,
      request.domain,
    ),
  };
}
