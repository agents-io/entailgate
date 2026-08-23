import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../../src/canonical.js";
import { extractClaimInventory, type ClaimInventory } from "../../src/claims.js";
import {
  bindSemanticAttestationToDraftCandidate,
  type BoundSemanticAttestation,
} from "../../src/draft-binding.js";
import { buildRevisionPlanTrace, type RevisionPlanTrace } from "../../src/revision-trace.js";
import type { SemanticAttestation } from "../../src/types.js";

// The single source of truth for examples/revision-plan-trace.example.json.
// The published artifact is checked in so a reader can inspect the contract
// without running anything, and tests/revision-plan-example.test.ts proves the
// checked-in bytes still validate, read, and replay against this build.
//
// Regenerate after any change to the schema, the extractor, or the engine
// version:
//
//     npm run build && node dist/tests/fixtures/revision-plan-example.js
//
// Everything here is synthetic. The drafts are invented sentences that say so,
// and every hash is derived from those invented strings, so nothing in the
// published example carries private or user evidence.

export const EXAMPLE_PATH = fileURLToPath(
  new URL("../../../examples/revision-plan-trace.example.json", import.meta.url),
);

/** A heading, a harmless first-person edit, and a changed legal section. */
export const EXAMPLE_PREVIOUS_TEXT = [
  "# Synthetic Grounds",
  "",
  "Me received the application on 2024-01-05.",
  "",
  "The applicant relied on section 23 of the Act.",
].join("\n");

export const EXAMPLE_CURRENT_TEXT = [
  "# Synthetic Grounds",
  "",
  "I received the application on 2024-01-05.",
  "",
  "The applicant relied on section 24 of the Act.",
].join("\n");

// Envelope metadata sits outside artifactHash, so pinning it keeps the
// published bytes byte-for-byte reproducible instead of changing on each run.
export const EXAMPLE_TRACE_ID = "20260823000000000-synthetic01";
export const EXAMPLE_CREATED_AT = "2026-08-23T00:00:00.000Z";

function candidateIndexFor(inventory: ClaimInventory, fragment: string): number {
  const index = inventory.candidates.findIndex((candidate) => candidate.text.includes(fragment));
  if (index < 0) throw new Error(`the example draft no longer contains: ${fragment}`);
  return index;
}

function syntheticAttestation(
  inventory: ClaimInventory,
  candidateIndex: number,
  claimId: string,
): SemanticAttestation {
  const candidate = inventory.candidates[candidateIndex];
  if (!candidate) throw new Error(`no candidate at index ${candidateIndex}`);
  return {
    claimId,
    checkerName: "synthetic-example-checker",
    checkerVersion: "0.0.0",
    checkerKind: "human",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Synthetic example attestation. It attests to nothing real."],
    checkedAt: "2026-08-22T00:00:00.000Z",
    subjectSha256: inventory.subjectSha256,
    snapshotId: "synthetic-snapshot-001",
    claimTextHash: sha256Text(candidate.text),
    claimBindingHash: sha256Text(`synthetic-claim-binding:${claimId}`),
    evidenceHash: sha256Text(`synthetic-evidence:${claimId}`),
  };
}

export function buildExamplePriorAttestations(): BoundSemanticAttestation[] {
  const previousInventory = extractClaimInventory(EXAMPLE_PREVIOUS_TEXT);
  // Bound under a heading on purpose: the isolated claim fingerprint an
  // attestation carries cannot equal this contextual candidate fingerprint,
  // so the mapping has to run off the explicit binding.
  const reusedIndex = candidateIndexFor(previousInventory, "Me received the application");
  const changedIndex = candidateIndexFor(previousInventory, "section 23 of the Act");
  return [
    bindSemanticAttestationToDraftCandidate(
      syntheticAttestation(previousInventory, reusedIndex, "SYN-001"),
      previousInventory,
      reusedIndex,
    ),
    bindSemanticAttestationToDraftCandidate(
      syntheticAttestation(previousInventory, changedIndex, "SYN-002"),
      previousInventory,
      changedIndex,
    ),
  ];
}

export function buildExampleTrace(): RevisionPlanTrace {
  const trace = buildRevisionPlanTrace({
    previousText: EXAMPLE_PREVIOUS_TEXT,
    currentText: EXAMPLE_CURRENT_TEXT,
    priorAttestations: buildExamplePriorAttestations(),
  });
  return { ...trace, traceId: EXAMPLE_TRACE_ID, createdAt: EXAMPLE_CREATED_AT };
}

/**
 * The example is deliberately public, so it is written with normal permissions
 * rather than through the owner-only writer a real revision plan uses.
 */
export async function writeExample(): Promise<string> {
  await writeFile(EXAMPLE_PATH, JSON.stringify(buildExampleTrace(), null, 2) + "\n", "utf8");
  return EXAMPLE_PATH;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.stdout.write((await writeExample()) + "\n");
}
