import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readRevisionPlanTrace } from "../src/revision-trace.js";
import {
  authorizedClaimReuses,
  ClaimReusePolicyError,
  readClaimReuseAuthorization,
  replayClaimReuseAuthorization,
  type ClaimReuseAuthorizationReplayInput,
} from "../src/reuse-policy.js";
import {
  buildExampleAuthorization,
  CLAIM_REUSE_EXAMPLE_PATH,
  EXAMPLE_AS_OF,
} from "./fixtures/claim-reuse-example.js";
import { EXAMPLE_PATH as REVISION_PLAN_EXAMPLE_PATH } from "./fixtures/revision-plan-example.js";

const REGENERATE =
  "regenerate with: npm run build && node dist/tests/fixtures/claim-reuse-example.js";

async function loadExample(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(CLAIM_REUSE_EXAMPLE_PATH, "utf8")) as Record<string, unknown>;
}

test("the checked-in public example is exactly what this build produces", async () => {
  const published = await loadExample();
  const rebuilt = JSON.parse(JSON.stringify(await buildExampleAuthorization())) as
    Record<string, unknown>;

  // Bound artifact and envelope alike: the fixture pins authorizationId and
  // createdAt, so the published bytes are reproducible rather than equivalent.
  assert.deepEqual(published, rebuilt, REGENERATE);
});

test("the checked-in public example reads and replays against the published plan", async () => {
  const authorization = await readClaimReuseAuthorization(CLAIM_REUSE_EXAMPLE_PATH);
  assert.equal(authorization.schemaVersion, "0.2.0");
  assert.equal(authorization.kind, "claim-reuse-authorization");
  assert.equal(authorization.asOf, EXAMPLE_AS_OF);

  // The stored trace binding really names the published revision plan.
  const trace = await readRevisionPlanTrace(REVISION_PLAN_EXAMPLE_PATH);
  assert.equal(authorization.trace.artifactHash, trace.artifactHash);
  assert.equal(authorization.trace.mappingHash, trace.priorAttestationMapping.mappingHash);
  assert.equal(authorization.trace.mappingStatus, "COMPLETE");

  const replay = await replayClaimReuseAuthorization({
    authorizationPath: CLAIM_REUSE_EXAMPLE_PATH,
    revisionPlanTracePath: REVISION_PLAN_EXAMPLE_PATH,
  });
  assert.equal(replay.matches, true, REGENERATE);
  assert.deepEqual(replay.componentMatches, {
    policy: true,
    trace: true,
    documentRelease: true,
    decisions: true,
  }, REGENERATE);
});

test("the example authorizes the unchanged claim and revalidates the changed section", async () => {
  const authorization = await readClaimReuseAuthorization(CLAIM_REUSE_EXAMPLE_PATH);
  assert.equal(authorization.decisions.length, 2);

  const reused = authorization.decisions.find((item) => item.claimId === "SYN-001");
  const revalidate = authorization.decisions.find((item) => item.claimId === "SYN-002");
  assert.ok(reused && revalidate);

  assert.equal(reused.outcome, "REUSE_AUTHORIZED");
  assert.equal(reused.mappingResult, "MATCHED_REUSE_ITEM");
  assert.equal(reused.planAction, "REUSE");
  assert.deepEqual(reused.blockers, []);
  assert.ok(reused.currentCandidate);

  assert.equal(revalidate.outcome, "REVERIFY_REQUIRED");
  assert.deepEqual(revalidate.blockers.map((item) => item.code), ["PLAN_ACTION_NOT_REUSE"]);
  assert.equal(revalidate.currentCandidate, undefined);

  // The named current candidate is the rewritten sentence in the published plan.
  const trace = await readRevisionPlanTrace(REVISION_PLAN_EXAMPLE_PATH);
  const candidate = trace.currentInventory.candidates[reused.currentCandidate!.index];
  assert.ok(candidate);
  assert.match(candidate.text, /^I received the application/u);
});

test("the example keeps claim reuse separate from document release", async () => {
  const authorization = await readClaimReuseAuthorization(CLAIM_REUSE_EXAMPLE_PATH);
  const trace = await readRevisionPlanTrace(REVISION_PLAN_EXAMPLE_PATH);

  assert.equal(authorization.documentRelease.status, "DOCUMENT_REVIEW_REQUIRED");
  assert.equal(authorization.documentRelease.coverageComplete, false);
  assert.equal(trace.currentInventory.coverage.complete, false);
  assert.equal(trace.comparison.coverageComplete, false);

  const spoken = [
    ...authorization.reasons,
    ...authorization.documentRelease.reasons,
  ].join(" ");
  assert.match(spoken, /not a document release/i);
  assert.match(spoken, /incomplete coverage/i);
  assert.match(spoken, /not independently verified/i);
  assert.match(spoken, /must replay this artifact/i);
});

test("a reader that skips replay is given nothing to rely on", async () => {
  const paths = {
    authorizationPath: CLAIM_REUSE_EXAMPLE_PATH,
    revisionPlanTracePath: REVISION_PLAN_EXAMPLE_PATH,
  };

  // The only way to reach an authorized decision is to name both artifacts and
  // let the helper replay them itself. It reads the recomputed decisions, so
  // the stored REUSE_AUTHORIZED string is never what is returned.
  const authorized = await authorizedClaimReuses(paths);
  assert.deepEqual(authorized.map((item) => item.claimId), ["SYN-001"]);

  const replay = await replayClaimReuseAuthorization(paths);
  assert.equal(replay.recomputed.decisions.length, 2);
  assert.deepEqual(
    replay.recomputed.decisions
      .filter((item) => item.outcome === "REUSE_AUTHORIZED")
      .map((item) => item.claimId),
    authorized.map((item) => item.claimId),
  );

  // A caller cannot skip that replay by handing the helper a replay object it
  // holds, even the genuine matching one: the helper takes paths only.
  await assert.rejects(
    authorizedClaimReuses(replay as unknown as ClaimReuseAuthorizationReplayInput),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("EVALUATION_INPUT_INVALID"),
  );
});

test("the published example carries no private evidence", async () => {
  const published = await loadExample();
  const authorization = await readClaimReuseAuthorization(CLAIM_REUSE_EXAMPLE_PATH);

  assert.match(authorization.policy.policyId, /^synthetic-/u);
  for (const checker of authorization.policy.trustedCheckers) {
    assert.match(checker.checkerName, /^synthetic-/u);
  }
  for (const pin of authorization.policy.claimPins) {
    assert.match(pin.claimId, /^SYN-/u);
    assert.match(pin.snapshotId, /^synthetic-/u);
  }

  // The artifact stores no draft text at all, and nothing points at a local path.
  const serialized = JSON.stringify(published);
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|C:\\\\/u);
  assert.doesNotMatch(serialized, /received the application|section 2\d of the Act/u);
});
