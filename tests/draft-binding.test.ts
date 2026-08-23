import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/canonical.js";
import { extractClaimInventory, normalizedAtomicClaimFingerprint } from "../src/claims.js";
import type { ClaimInventory } from "../src/claims.js";
import {
  assertBoundSemanticAttestation,
  bindSemanticAttestationToDraftCandidate,
  buildDraftCandidateBinding,
  DraftBindingError,
  type BoundSemanticAttestation,
} from "../src/draft-binding.js";
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

test("binds a claim-scoped attestation to a candidate under a heading even when isolated and contextual fingerprints differ", () => {
  const text = [
    "# Grounds",
    "",
    "The officer received the application on 2024-01-05.",
  ].join("\n");
  const inventory = extractClaimInventory(text);
  const candidate = inventory.candidates.find((item) =>
    item.text.includes("The officer received")
  )!;
  const candidateIndex = inventory.candidates.indexOf(candidate);

  const isolatedFingerprint = normalizedAtomicClaimFingerprint(candidate.text);
  assert.notEqual(isolatedFingerprint, candidate.fingerprint);

  const attestation = attestationFor(inventory, candidateIndex);
  const bound = bindSemanticAttestationToDraftCandidate(attestation, inventory, candidateIndex);

  assert.equal(bound.schemaVersion, "0.2.0");
  assert.equal(bound.kind, "bound-semantic-attestation");
  assert.equal(bound.draftBinding.candidateFingerprint, candidate.fingerprint);
  assert.equal(bound.draftBinding.candidateIndex, candidateIndex);
});

test("two repeated identical sentences bind to distinct candidateIndex/candidateHash/bindingHash", () => {
  const text = [
    "- The officer received the application.",
    "- The officer received the application.",
  ].join("\n");
  const inventory = extractClaimInventory(text);
  assert.equal(inventory.candidates.length, 2);
  assert.equal(inventory.candidates[0]!.fingerprint, inventory.candidates[1]!.fingerprint);

  const bindingA = buildDraftCandidateBinding(inventory, 0);
  const bindingB = buildDraftCandidateBinding(inventory, 1);

  assert.notEqual(bindingA.candidateIndex, bindingB.candidateIndex);
  assert.notEqual(bindingA.candidateHash, bindingB.candidateHash);
  assert.notEqual(bindingA.bindingHash, bindingB.bindingHash);
});

test("rejects wrong subject, wrong claim text, subject-scoped attestation, and bad index with typed codes", () => {
  const inventory = extractClaimInventory("The officer received the application.");
  const other = extractClaimInventory("Something else entirely happened.");

  assert.throws(
    () => bindSemanticAttestationToDraftCandidate(attestationFor(other, 0), inventory, 0),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("ATTESTATION_SUBJECT_MISMATCH"),
  );

  assert.throws(
    () =>
      bindSemanticAttestationToDraftCandidate(
        attestationFor(inventory, 0, { claimTextHash: sha256Text("not the claim text") }),
        inventory,
        0,
      ),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("ATTESTATION_CLAIM_TEXT_MISMATCH"),
  );

  assert.throws(
    () =>
      bindSemanticAttestationToDraftCandidate(
        attestationFor(inventory, 0, { bindingScope: "subject" }),
        inventory,
        0,
      ),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("ATTESTATION_BINDING_SCOPE_INVALID"),
  );

  assert.throws(
    () => buildDraftCandidateBinding(inventory, inventory.candidates.length),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("CANDIDATE_INDEX_OUT_OF_RANGE"),
  );

  assert.throws(
    () => buildDraftCandidateBinding(inventory, -1),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("CANDIDATE_INDEX_INVALID"),
  );

  assert.throws(
    () => buildDraftCandidateBinding(inventory, 1.5),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("CANDIDATE_INDEX_INVALID"),
  );

  assert.throws(
    () => buildDraftCandidateBinding({ candidates: [] } as unknown as ClaimInventory, 0),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("INVENTORY_INVALID"),
  );
});

function validBound(): { inventory: ClaimInventory; bound: BoundSemanticAttestation } {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const attestation = attestationFor(inventory, 0);
  const bound = bindSemanticAttestationToDraftCandidate(attestation, inventory, 0);
  return { inventory, bound };
}

test("tampering each hash or adding unknown wrapper/binding fields rejects", () => {
  const { bound } = validBound();
  assertBoundSemanticAttestation(bound);

  const badAttestationHash = { ...bound, attestationHash: sha256Text("tampered") };
  assert.throws(
    () => assertBoundSemanticAttestation(badAttestationHash),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_HASH_MISMATCH"),
  );

  const badBindingHash = {
    ...bound,
    draftBinding: { ...bound.draftBinding, bindingHash: sha256Text("tampered") },
  };
  assert.throws(
    () => assertBoundSemanticAttestation(badBindingHash),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_HASH_MISMATCH"),
  );

  const badBoundHash = { ...bound, boundAttestationHash: sha256Text("tampered") };
  assert.throws(
    () => assertBoundSemanticAttestation(badBoundHash),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_HASH_MISMATCH"),
  );

  const unknownWrapperField = { ...bound, extra: true };
  assert.throws(
    () => assertBoundSemanticAttestation(unknownWrapperField),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_SHAPE_INVALID"),
  );

  const unknownBindingField = {
    ...bound,
    draftBinding: { ...bound.draftBinding, extra: true },
  };
  assert.throws(
    () => assertBoundSemanticAttestation(unknownBindingField),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_SHAPE_INVALID"),
  );
});

test("does not mutate inputs", () => {
  const inventory = extractClaimInventory("The officer received the application on 2024-01-05.");
  const attestation = attestationFor(inventory, 0);
  const inventorySnapshot = JSON.parse(JSON.stringify(inventory));
  const attestationSnapshot = JSON.parse(JSON.stringify(attestation));

  Object.freeze(attestation);
  const bound = bindSemanticAttestationToDraftCandidate(attestation, inventory, 0);

  assert.deepEqual(inventory, inventorySnapshot);
  assert.deepEqual(attestation, attestationSnapshot);
  attestation.reasons.push("later caller mutation");
  assert.deepEqual(bound.attestation.reasons, attestationSnapshot.reasons);
});

test("malformed relied-on candidate and attestation fields fail with typed errors", () => {
  const inventory = extractClaimInventory("The officer received the application.");
  const missingText = structuredClone(inventory) as unknown as {
    candidates: Array<Record<string, unknown>>;
  };
  delete missingText.candidates[0]!.text;
  assert.throws(
    () => buildDraftCandidateBinding(missingText as unknown as ClaimInventory, 0),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("CANDIDATE_INVALID"),
  );

  const badFingerprint = structuredClone(inventory) as unknown as {
    candidates: Array<Record<string, unknown>>;
  };
  badFingerprint.candidates[0]!.fingerprint = "not-a-hash";
  assert.throws(
    () => buildDraftCandidateBinding(badFingerprint as unknown as ClaimInventory, 0),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("CANDIDATE_INVALID"),
  );

  assert.throws(
    () => bindSemanticAttestationToDraftCandidate(
      null as unknown as SemanticAttestation,
      inventory,
      0,
    ),
    (error: unknown) => error instanceof DraftBindingError
      && error.codes.includes("WRAPPER_SHAPE_INVALID")
      && !(error instanceof TypeError),
  );
});

test("wrapper JSON round-trip validates", () => {
  const { bound } = validBound();
  const roundTripped = JSON.parse(JSON.stringify(bound));
  assert.doesNotThrow(() => assertBoundSemanticAttestation(roundTripped));
});

test("no output field is named PASS, verdict, eligible, authorize, or reuse", () => {
  const { bound } = validBound();
  const forbidden = ["PASS", "verdict", "eligible", "authorize", "reuse"];
  const topLevelKeys = Object.keys(bound).filter((key) => key !== "attestation");
  const bindingKeys = Object.keys(bound.draftBinding);
  for (const key of [...topLevelKeys, ...bindingKeys]) {
    assert.ok(!forbidden.includes(key), `unexpected forbidden field: ${key}`);
  }
});
