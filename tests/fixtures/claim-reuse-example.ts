import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRevisionPlanTrace } from "../../src/revision-trace.js";
import {
  evaluateClaimReuse,
  type ClaimReuseAuthorization,
  type ClaimReusePolicyInput,
} from "../../src/reuse-policy.js";
import { EXAMPLE_PATH as REVISION_PLAN_EXAMPLE_PATH } from "./revision-plan-example.js";

// The single source of truth for examples/claim-reuse-authorization.example.json.
// It is evaluated against the checked-in synthetic revision-plan example, so a
// reader can inspect both artifacts together, and
// tests/claim-reuse-example.test.ts proves the checked-in bytes still read and
// replay against this build.
//
// Regenerate after any change to this schema, the policy gate, the revision
// plan example, the extractor, or the engine version:
//
//     npm run build && node dist/tests/fixtures/claim-reuse-example.js
//
// Everything here is synthetic. The pins are read out of the synthetic
// attestations in the synthetic revision plan, so nothing published here
// carries private or user evidence.

export const CLAIM_REUSE_EXAMPLE_PATH = fileURLToPath(
  new URL("../../../examples/claim-reuse-authorization.example.json", import.meta.url),
);

/** Caller-supplied deterministic evaluation instant, bound by evaluationHash. */
export const EXAMPLE_AS_OF = "2026-08-23T00:00:00.000Z";

// Envelope metadata sits outside evaluationHash, so pinning it keeps the
// published bytes byte-for-byte reproducible instead of changing on each run.
export const EXAMPLE_AUTHORIZATION_ID = "20260823000000000-synthetic02";
export const EXAMPLE_CREATED_AT = "2026-08-23T00:00:00.000Z";

export const EXAMPLE_POLICY_DOMAIN = "synthetic-example";
export const EXAMPLE_POLICY_JURISDICTION = "SYNTHETIC";

/**
 * Reads the pinned values out of the synthetic trace rather than restating
 * them, so the example policy can never drift from the example attestations.
 */
export async function buildExamplePolicy(): Promise<ClaimReusePolicyInput> {
  const trace = await readRevisionPlanTrace(REVISION_PLAN_EXAMPLE_PATH);
  return {
    policyId: "synthetic-example-reuse-policy",
    domain: EXAMPLE_POLICY_DOMAIN,
    jurisdiction: EXAMPLE_POLICY_JURISDICTION,
    minScore: 0.9,
    maxAttestationAgeDays: 30,
    maxSourceCurrencyAgeDays: 7,
    trustedCheckers: [
      { checkerName: "synthetic-example-checker", checkerVersion: "0.0.0", checkerKind: "human" },
    ],
    // Supplied in stored-wrapper order, which is sorted by boundAttestationHash
    // rather than by claim ID. The canonical form re-sorts them by claim ID, so
    // the published policyHash never depends on the order a caller happened to
    // use.
    claimPins: trace.priorAttestations.map((bound) => ({
      claimId: bound.attestation.claimId,
      claimBindingHash: bound.attestation.claimBindingHash,
      snapshotId: bound.attestation.snapshotId,
      evidenceHash: bound.attestation.evidenceHash,
      jurisdiction: EXAMPLE_POLICY_JURISDICTION,
      domain: EXAMPLE_POLICY_DOMAIN,
      sourceCurrencyConfirmedAsOf: "2026-08-22T00:00:00.000Z",
    })),
  };
}

export async function buildExampleAuthorization(): Promise<ClaimReuseAuthorization> {
  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: REVISION_PLAN_EXAMPLE_PATH,
    policy: await buildExamplePolicy(),
    asOf: EXAMPLE_AS_OF,
  });
  return {
    ...authorization,
    authorizationId: EXAMPLE_AUTHORIZATION_ID,
    createdAt: EXAMPLE_CREATED_AT,
  };
}

/**
 * The example is deliberately public, so it is written with normal permissions
 * rather than through the owner-only writer a real authorization uses.
 */
export async function writeClaimReuseExample(): Promise<string> {
  await writeFile(
    CLAIM_REUSE_EXAMPLE_PATH,
    JSON.stringify(await buildExampleAuthorization(), null, 2) + "\n",
    "utf8",
  );
  return CLAIM_REUSE_EXAMPLE_PATH;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.stdout.write((await writeClaimReuseExample()) + "\n");
}
