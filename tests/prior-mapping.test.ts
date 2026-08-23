import assert from "node:assert/strict";
import test from "node:test";
import { hashObject, sha256Text } from "../src/canonical.js";
import { compareInventories, extractClaimInventory } from "../src/claims.js";
import type { ClaimInventory } from "../src/claims.js";
import { bindSemanticAttestationToDraftCandidate } from "../src/draft-binding.js";
import type { BoundSemanticAttestation } from "../src/draft-binding.js";
import {
  assertPriorAttestationMapping,
  mapPriorAttestations,
  PriorMappingError,
  type PriorAttestationMappingReport,
} from "../src/prior-mapping.js";
import type { SemanticAttestation } from "../src/types.js";

function attestationFor(
  inventory: ClaimInventory,
  candidateIndex: number,
  overrides: Partial<SemanticAttestation> = {},
): SemanticAttestation {
  const candidate = inventory.candidates[candidateIndex]!;
  return {
    claimId: "claim-1",
    checkerName: "test-checker",
    checkerVersion: "1.0.0",
    checkerKind: "model",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 0.9,
    reasons: ["matches evidence"],
    checkedAt: "2026-08-23T00:00:00.000Z",
    subjectSha256: inventory.subjectSha256,
    snapshotId: "snapshot-1",
    claimTextHash: sha256Text(candidate.text),
    claimBindingHash: sha256Text("claim-binding"),
    evidenceHash: sha256Text("evidence"),
    ...overrides,
  };
}

function bind(
  inventory: ClaimInventory,
  candidateIndex: number,
  overrides: Partial<SemanticAttestation> = {},
): BoundSemanticAttestation {
  return bindSemanticAttestationToDraftCandidate(
    attestationFor(inventory, candidateIndex, overrides),
    inventory,
    candidateIndex,
  );
}

test("empty input is NOT_ATTEMPTED", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const comparison = compareInventories(inventory, inventory);
  const mapping = mapPriorAttestations(inventory, comparison, []);
  assert.equal(mapping.schemaVersion, "0.2.0");
  assert.equal(mapping.kind, "prior-attestation-mapping");
  assert.equal(mapping.status, "NOT_ATTEMPTED");
  assert.deepEqual(mapping.entries, []);
  assert.deepEqual(mapping.unmappedBoundAttestationHashes, []);
  assert.doesNotThrow(() => assertPriorAttestationMapping(mapping));
});

test("claim under a heading maps despite isolated/context fingerprint differences", () => {
  const text = [
    "# Grounds",
    "",
    "The officer received the application on 2024-01-05.",
  ].join("\n");
  const inventory = extractClaimInventory(text);
  const candidateIndex = inventory.candidates.findIndex((item) => item.text.includes("The officer received"));
  const comparison = compareInventories(inventory, inventory);
  const bound = bind(inventory, candidateIndex);

  const mapping = mapPriorAttestations(inventory, comparison, [bound]);
  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries.length, 1);
  assert.equal(mapping.entries[0]!.result, "MATCHED_REUSE_ITEM");
  assert.equal(mapping.entries[0]!.planAction, "REUSE");
  assert.equal(mapping.entries[0]!.previousCandidateIndex, candidateIndex);
});

test("harmless Me->I connector change maps MATCHED_REUSE_ITEM via exact fingerprint identity", () => {
  const previousText = "Me received the application on 2024-01-05.";
  const currentText = "I received the application on 2024-01-05.";
  const previousInventory = extractClaimInventory(previousText);
  const currentInventory = extractClaimInventory(currentText);
  assert.equal(previousInventory.candidates[0]!.fingerprint, currentInventory.candidates[0]!.fingerprint);

  const comparison = compareInventories(previousInventory, currentInventory);
  assert.equal(comparison.plan[0]!.action, "REUSE");

  const bound = bind(previousInventory, 0);
  const mapping = mapPriorAttestations(previousInventory, comparison, [bound]);
  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries[0]!.result, "MATCHED_REUSE_ITEM");
});

test("section 23 -> 24 maps REVALIDATION_REQUIRED", () => {
  const previousText = "The applicant relied on section 23 of the Act.";
  const currentText = "The applicant relied on section 24 of the Act.";
  const previousInventory = extractClaimInventory(previousText);
  const currentInventory = extractClaimInventory(currentText);
  assert.notEqual(previousInventory.candidates[0]!.fingerprint, currentInventory.candidates[0]!.fingerprint);

  const comparison = compareInventories(previousInventory, currentInventory);
  assert.equal(comparison.plan[0]!.action, "REVERIFY");

  const bound = bind(previousInventory, 0);
  const mapping = mapPriorAttestations(previousInventory, comparison, [bound]);
  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries[0]!.result, "REVALIDATION_REQUIRED");
  assert.equal(mapping.entries[0]!.planAction, "REVERIFY");
});

test("repeated identical sentences bind and map to distinct plan indices", () => {
  const text = [
    "- The officer received the application.",
    "- The officer received the application.",
  ].join("\n");
  const inventory = extractClaimInventory(text);
  assert.equal(inventory.candidates.length, 2);
  assert.equal(inventory.candidates[0]!.fingerprint, inventory.candidates[1]!.fingerprint);

  const comparison = compareInventories(inventory, inventory);
  const boundA = bind(inventory, 0, { claimId: "claim-a" });
  const boundB = bind(inventory, 1, { claimId: "claim-b" });

  const mapping = mapPriorAttestations(inventory, comparison, [boundA, boundB]);
  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries.length, 2);
  const byClaimId = new Map(mapping.entries.map((entry) => [entry.claimId, entry]));
  const entryA = byClaimId.get("claim-a")!;
  const entryB = byClaimId.get("claim-b")!;
  assert.notEqual(entryA.previousCandidateIndex, entryB.previousCandidateIndex);
  assert.notEqual(entryA.planIndex, entryB.planIndex);
  assert.equal(entryA.result, "MATCHED_REUSE_ITEM");
  assert.equal(entryB.result, "MATCHED_REUSE_ITEM");
});

test("multiple different attestations may map to the same candidate/plan item", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const comparison = compareInventories(inventory, inventory);
  const boundOne = bind(inventory, 0, { claimId: "claim-one", checkerName: "checker-one" });
  const boundTwo = bind(inventory, 0, { claimId: "claim-two", checkerName: "checker-two" });
  assert.notEqual(boundOne.boundAttestationHash, boundTwo.boundAttestationHash);

  const mapping = mapPriorAttestations(inventory, comparison, [boundOne, boundTwo]);
  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries.length, 2);
  assert.equal(mapping.entries[0]!.planIndex, mapping.entries[1]!.planIndex);
});

test("input order does not change output (deep-equal, same hashes)", () => {
  const text = [
    "- The officer received the application.",
    "- The officer received the application.",
  ].join("\n");
  const inventory = extractClaimInventory(text);
  const comparison = compareInventories(inventory, inventory);
  const boundA = bind(inventory, 0, { claimId: "claim-a" });
  const boundB = bind(inventory, 1, { claimId: "claim-b" });

  const forward = mapPriorAttestations(inventory, comparison, [boundA, boundB]);
  const reversed = mapPriorAttestations(inventory, comparison, [boundB, boundA]);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.mappingHash, reversed.mappingHash);
  assert.equal(forward.priorAttestationsHash, reversed.priorAttestationsHash);
});

test("wrong inventory binding gives INCOMPLETE/NOT_IN_PLAN without fallback", () => {
  const previousInventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const otherInventory = extractClaimInventory("Something else entirely happened.");
  const comparison = compareInventories(previousInventory, previousInventory);

  const boundFromOther = bind(otherInventory, 0);
  const mapping = mapPriorAttestations(previousInventory, comparison, [boundFromOther]);

  assert.equal(mapping.status, "INCOMPLETE");
  assert.equal(mapping.entries.length, 1);
  assert.equal(mapping.entries[0]!.result, "NOT_IN_PLAN");
  assert.equal(mapping.entries[0]!.planIndex, undefined);
  assert.equal(mapping.entries[0]!.planAction, undefined);
  assert.deepEqual(mapping.unmappedBoundAttestationHashes, [boundFromOther.boundAttestationHash]);
});

test("malformed wrapper, duplicate boundAttestationHash, and tampered/unknown-field mappings fail typed", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const comparison = compareInventories(inventory, inventory);
  const bound = bind(inventory, 0);

  assert.throws(
    () => mapPriorAttestations(inventory, comparison, [{ ...bound, extra: true }]),
    (error: unknown) => error instanceof PriorMappingError
      && !(error instanceof TypeError)
      && error.codes.includes("WRAPPER_INVALID"),
  );

  assert.throws(
    () => mapPriorAttestations(inventory, comparison, [bound, bound]),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("DUPLICATE_BOUND_ATTESTATION_HASH"),
  );

  const mapping = mapPriorAttestations(inventory, comparison, [bound]);

  const tamperedMappingHash: PriorAttestationMappingReport = { ...mapping, mappingHash: sha256Text("tampered") };
  assert.throws(
    () => assertPriorAttestationMapping(tamperedMappingHash),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("MAPPING_HASH_MISMATCH"),
  );

  const unknownTopLevelField = { ...mapping, extra: true };
  assert.throws(
    () => assertPriorAttestationMapping(unknownTopLevelField),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("MAPPING_SHAPE_INVALID"),
  );

  const unknownEntryField = {
    ...mapping,
    entries: [{ ...mapping.entries[0]!, extra: true }],
  };
  assert.throws(
    () => assertPriorAttestationMapping(unknownEntryField),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("MAPPING_SHAPE_INVALID"),
  );
});

test("malformed mapping inputs fail closed before property access or hashing", () => {
  const inventory = extractClaimInventory("The officer received the application.");
  const comparison = compareInventories(inventory, inventory);

  for (const invoke of [
    () => mapPriorAttestations(null as unknown as ClaimInventory, comparison, []),
    () => mapPriorAttestations(inventory, null as unknown as typeof comparison, []),
    () => mapPriorAttestations(inventory, comparison, null as unknown as []),
  ]) {
    assert.throws(
      invoke,
      (error: unknown) => error instanceof PriorMappingError
        && error.codes.includes("INPUT_INVALID")
        && !(error instanceof TypeError),
    );
  }
});

test("mapping status must agree with its entries even after the envelope is rehashed", () => {
  const inventory = extractClaimInventory("The officer received the application.");
  const comparison = compareInventories(inventory, inventory);
  const mapping = mapPriorAttestations(inventory, comparison, [bind(inventory, 0)]);
  const forged = { ...mapping, status: "INCOMPLETE" as const };
  forged.mappingHash = hashObject({
    schemaVersion: forged.schemaVersion,
    kind: forged.kind,
    status: forged.status,
    priorAttestationsHash: forged.priorAttestationsHash,
    entries: forged.entries,
    unmappedBoundAttestationHashes: forged.unmappedBoundAttestationHashes,
    reasons: forged.reasons,
  });

  assert.throws(
    () => assertPriorAttestationMapping(forged),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("MAPPING_SHAPE_INVALID")
      && error.issues.includes("status must be COMPLETE for the stored entries"),
  );
});

test("does not mutate inputs", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const comparison = compareInventories(inventory, inventory);
  const bound = bind(inventory, 0);

  const inventorySnapshot = JSON.parse(JSON.stringify(inventory));
  const comparisonSnapshot = JSON.parse(JSON.stringify(comparison));
  const boundSnapshot = JSON.parse(JSON.stringify(bound));

  const boundAttestations = [bound];
  const mapping = mapPriorAttestations(inventory, comparison, boundAttestations);

  assert.deepEqual(inventory, inventorySnapshot);
  assert.deepEqual(comparison, comparisonSnapshot);
  assert.deepEqual(bound, boundSnapshot);
  assert.deepEqual(boundAttestations, [boundSnapshot]);

  mapping.entries[0]!.reasons.push("later mutation");
  const mappingAgain = mapPriorAttestations(inventory, comparison, [bound]);
  assert.notEqual(mappingAgain.entries[0]!.reasons.length, mapping.entries[0]!.reasons.length);
});

test("output has no decision/verdict/eligible/authorize/PASS field and reasons preserve the limits", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const comparison = compareInventories(inventory, inventory);
  const bound = bind(inventory, 0);
  const mapping = mapPriorAttestations(inventory, comparison, [bound]);

  const forbidden = ["PASS", "verdict", "eligible", "authorize", "decision"];
  const topLevelKeys = Object.keys(mapping);
  const entryKeys = Object.keys(mapping.entries[0]!);
  for (const key of [...topLevelKeys, ...entryKeys]) {
    assert.ok(!forbidden.includes(key), `unexpected forbidden field: ${key}`);
  }

  const joinedReasons = mapping.reasons.join(" ");
  assert.match(joinedReasons, /not evidence validation/i);
  assert.match(joinedReasons, /not.*semantic PASS/i);
  assert.match(joinedReasons, /complete/i);
  assert.match(joinedReasons, /reuse/i);
  assert.match(joinedReasons, /positional association/i);
});
