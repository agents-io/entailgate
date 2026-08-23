import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  readRevisionPlanTrace,
  replayRevisionPlanTrace,
} from "../src/revision-trace.js";
import {
  buildExampleTrace,
  EXAMPLE_CURRENT_TEXT,
  EXAMPLE_PATH,
  EXAMPLE_PREVIOUS_TEXT,
} from "./fixtures/revision-plan-example.js";

const REGENERATE = "regenerate with: npm run build && node dist/tests/fixtures/revision-plan-example.js";

async function loadExample(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(EXAMPLE_PATH, "utf8")) as Record<string, unknown>;
}

test("the checked-in public example is exactly what this build produces", async () => {
  const published = await loadExample();
  const rebuilt = JSON.parse(JSON.stringify(buildExampleTrace())) as Record<string, unknown>;

  // Bound artifact and envelope alike: the fixture pins traceId and createdAt,
  // so the published bytes are reproducible rather than merely equivalent.
  assert.deepEqual(published, rebuilt, REGENERATE);
});

test("the checked-in public example reads and replays", async () => {
  const trace = await readRevisionPlanTrace(EXAMPLE_PATH);
  assert.equal(trace.schemaVersion, "0.2.1");
  assert.equal(trace.kind, "revision-plan");
  assert.equal(trace.previousSubject.text, EXAMPLE_PREVIOUS_TEXT);
  assert.equal(trace.currentSubject.text, EXAMPLE_CURRENT_TEXT);

  const replay = await replayRevisionPlanTrace(EXAMPLE_PATH);
  assert.equal(replay.matches, true, REGENERATE);
  assert.deepEqual(replay.componentMatches, {
    previousInventory: true,
    currentInventory: true,
    plan: true,
    priorAttestations: true,
    priorAttestationMapping: true,
  }, REGENERATE);
});

test("the example shows both mapping results and claims nothing beyond association", async () => {
  const trace = await readRevisionPlanTrace(EXAMPLE_PATH);
  const mapping = trace.priorAttestationMapping;

  assert.equal(mapping.status, "COMPLETE");
  assert.equal(mapping.entries.length, 2);
  assert.deepEqual(mapping.unmappedBoundAttestationHashes, []);

  const results = mapping.entries.map((entry) => entry.result).sort();
  assert.deepEqual(results, ["MATCHED_REUSE_ITEM", "REVALIDATION_REQUIRED"]);

  const reused = mapping.entries.find((entry) => entry.result === "MATCHED_REUSE_ITEM");
  const revalidate = mapping.entries.find((entry) => entry.result === "REVALIDATION_REQUIRED");
  assert.ok(reused && revalidate);
  assert.equal(trace.comparison.plan[reused.planIndex!]?.action, "REUSE");
  assert.equal(trace.comparison.plan[revalidate.planIndex!]?.action, "REVERIFY");

  // The reused claim sits under a heading, so the attestation's own isolated
  // fingerprint could not have produced this association.
  const reusedWrapper = trace.priorAttestations
    .find((bound) => bound.boundAttestationHash === reused.boundAttestationHash);
  assert.ok(reusedWrapper);
  const boundCandidate = trace.previousInventory
    .candidates[reusedWrapper.draftBinding.candidateIndex];
  assert.ok(boundCandidate);
  assert.ok(boundCandidate.context.headingPath.length > 0);
  assert.equal(reusedWrapper.attestation.claimFingerprint, undefined);

  // COMPLETE is an association, never a licence.
  const spoken = [...trace.reasons, ...mapping.reasons].join(" ");
  assert.match(spoken, /not reuse authorization|does not authorize reuse/i);
  assert.match(spoken, /not evidence validation/i);
  assert.equal(trace.previousInventory.coverage.complete, false);
  assert.equal(trace.comparison.coverageComplete, false);
});

test("the published example carries no private evidence", async () => {
  const published = await loadExample();
  const trace = await readRevisionPlanTrace(EXAMPLE_PATH);

  // Every stored text is one of the two synthetic drafts, and both say so.
  assert.match(trace.previousSubject.text, /Synthetic/u);
  assert.match(trace.currentSubject.text, /Synthetic/u);
  for (const bound of trace.priorAttestations) {
    assert.equal(bound.attestation.checkerName, "synthetic-example-checker");
    assert.match(bound.attestation.snapshotId, /^synthetic-/u);
    assert.match(bound.attestation.reasons.join(" "), /Synthetic example attestation/u);
  }

  // Nothing in the file points at a local path or a real person's file.
  const serialized = JSON.stringify(published);
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|C:\\\\/u);
});
