import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashObject, sha256Text } from "../src/canonical.js";
import { extractClaimInventory, type ClaimInventory } from "../src/claims.js";
import {
  bindSemanticAttestationToDraftCandidate,
  type BoundSemanticAttestation,
} from "../src/draft-binding.js";
import {
  revisionPlanArtifactHash,
  writeRevisionPlanTrace,
  type RevisionPlanTrace,
} from "../src/revision-trace.js";
import {
  authorizedClaimReuses,
  canonicalizeClaimReusePolicy,
  ClaimReusePolicyError,
  claimReuseEvaluationHash,
  claimReusePolicyHash,
  evaluateClaimReuse,
  readClaimReuseAuthorization,
  replayClaimReuseAuthorization,
  writeClaimReuseAuthorization,
  type ClaimReuseAuthorization,
  type ClaimReuseAuthorizationReplay,
  type ClaimReuseAuthorizationReplayInput,
  type ClaimReuseBlockerCode,
  type ClaimReuseDecision,
  type ClaimReusePolicyInput,
} from "../src/reuse-policy.js";
import type { SemanticAttestation } from "../src/types.js";

// A heading, a harmless first-person edit that the extractor treats as the same
// claim, and a changed legal section that it does not.
const PREVIOUS_DRAFT = [
  "# Synthetic Grounds",
  "",
  "Me received the application on 2024-01-05.",
  "",
  "The applicant relied on section 23 of the Act.",
].join("\n");

const CURRENT_DRAFT = [
  "# Synthetic Grounds",
  "",
  "I received the application on 2024-01-05.",
  "",
  "The applicant relied on section 24 of the Act.",
].join("\n");

const REUSED_FRAGMENT = "Me received the application";
const CHANGED_FRAGMENT = "section 23 of the Act";

const AS_OF = "2026-08-23T00:00:00.000Z";
const CHECKED_AT = "2026-08-22T00:00:00.000Z";
const SNAPSHOT_ID = "synthetic-snapshot-001";
const DOMAIN = "synthetic-example";
const JURISDICTION = "SYNTHETIC";

function candidateIndexFor(inventory: ClaimInventory, fragment: string): number {
  const index = inventory.candidates.findIndex((candidate) => candidate.text.includes(fragment));
  assert.ok(index >= 0, `no candidate containing ${fragment}`);
  return index;
}

function attestationFor(
  inventory: ClaimInventory,
  candidateIndex: number,
  claimId: string,
  overrides: Partial<SemanticAttestation> = {},
): SemanticAttestation {
  const candidate = inventory.candidates[candidateIndex]!;
  return {
    claimId,
    checkerName: "synthetic-example-checker",
    checkerVersion: "0.0.0",
    checkerKind: "human",
    bindingScope: "claim",
    verdict: "SUPPORTED",
    score: 1,
    reasons: ["Synthetic test attestation. It attests to nothing real."],
    checkedAt: CHECKED_AT,
    subjectSha256: inventory.subjectSha256,
    snapshotId: SNAPSHOT_ID,
    claimTextHash: sha256Text(candidate.text),
    claimBindingHash: sha256Text(`synthetic-claim-binding:${claimId}`),
    evidenceHash: sha256Text(`synthetic-evidence:${claimId}`),
    ...overrides,
  };
}

function boundFor(
  previousText: string,
  fragment: string,
  claimId: string,
  overrides: Partial<SemanticAttestation> = {},
): BoundSemanticAttestation {
  const inventory = extractClaimInventory(previousText);
  const candidateIndex = candidateIndexFor(inventory, fragment);
  return bindSemanticAttestationToDraftCandidate(
    attestationFor(inventory, candidateIndex, claimId, overrides),
    inventory,
    candidateIndex,
  );
}

function pinFor(
  bound: BoundSemanticAttestation,
  overrides: Partial<ClaimReusePolicyInput["claimPins"][number]> = {},
): ClaimReusePolicyInput["claimPins"][number] {
  return {
    claimId: bound.attestation.claimId,
    claimBindingHash: bound.attestation.claimBindingHash,
    snapshotId: bound.attestation.snapshotId,
    evidenceHash: bound.attestation.evidenceHash,
    jurisdiction: JURISDICTION,
    domain: DOMAIN,
    sourceCurrencyConfirmedAsOf: CHECKED_AT,
    ...overrides,
  };
}

function policyFor(
  bounds: readonly BoundSemanticAttestation[],
  overrides: Partial<ClaimReusePolicyInput> = {},
): ClaimReusePolicyInput {
  return {
    policyId: "synthetic-test-reuse-policy",
    domain: DOMAIN,
    jurisdiction: JURISDICTION,
    minScore: 0.9,
    maxAttestationAgeDays: 30,
    maxSourceCurrencyAgeDays: 7,
    trustedCheckers: [
      { checkerName: "synthetic-example-checker", checkerVersion: "0.0.0", checkerKind: "human" },
    ],
    claimPins: bounds.map((bound) => pinFor(bound)),
    ...overrides,
  };
}

async function writeTrace(
  priorAttestations: readonly BoundSemanticAttestation[],
  previousText = PREVIOUS_DRAFT,
  currentText = CURRENT_DRAFT,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-policy-"));
  return writeRevisionPlanTrace(directory, { previousText, currentText, priorAttestations });
}

/** The default two-attestation scenario: one reusable claim, one changed one. */
function defaultBounds(): { reused: BoundSemanticAttestation; changed: BoundSemanticAttestation } {
  return {
    reused: boundFor(PREVIOUS_DRAFT, REUSED_FRAGMENT, "SYN-001"),
    changed: boundFor(PREVIOUS_DRAFT, CHANGED_FRAGMENT, "SYN-002"),
  };
}

function decisionFor(
  authorization: ClaimReuseAuthorization,
  claimId: string,
): ClaimReuseDecision {
  const decision = authorization.decisions.find((item) => item.claimId === claimId);
  assert.ok(decision, `no decision for ${claimId}`);
  return decision;
}

function blockerCodes(decision: ClaimReuseDecision): ClaimReuseBlockerCode[] {
  return decision.blockers.map((item) => item.code);
}

/** Evaluates the default scenario with one policy override. */
async function evaluateDefault(
  overrides: Partial<ClaimReusePolicyInput> = {},
  bounds = defaultBounds(),
): Promise<ClaimReuseAuthorization> {
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  return evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor(list, overrides),
    asOf: AS_OF,
  });
}

async function overwriteRaw(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function loadRaw<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/* -------------------------------------------------------------------------- */
/* Happy path and the claim/document boundary                                 */
/* -------------------------------------------------------------------------- */

test("one unchanged claim is authorized and the changed legal section is not", async () => {
  const authorization = await evaluateDefault();

  assert.equal(authorization.schemaVersion, "0.2.0");
  assert.equal(authorization.kind, "claim-reuse-authorization");
  assert.equal(authorization.asOf, AS_OF);
  assert.equal(authorization.decisions.length, 2);

  const reused = decisionFor(authorization, "SYN-001");
  assert.equal(reused.outcome, "REUSE_AUTHORIZED");
  assert.deepEqual(reused.blockers, []);
  assert.equal(reused.mappingResult, "MATCHED_REUSE_ITEM");
  assert.equal(reused.planAction, "REUSE");
  assert.ok(reused.currentCandidate, "an authorized reuse must name one current candidate");

  const changed = decisionFor(authorization, "SYN-002");
  assert.equal(changed.outcome, "REVERIFY_REQUIRED");
  assert.deepEqual(blockerCodes(changed), ["PLAN_ACTION_NOT_REUSE"]);
  assert.equal(changed.mappingResult, "REVALIDATION_REQUIRED");
  assert.equal(changed.currentCandidate, undefined);

  // Exactly one authorization, and it is the only decision with no blockers.
  const authorized = authorization.decisions.filter((item) => item.outcome === "REUSE_AUTHORIZED");
  assert.deepEqual(authorized.map((item) => item.claimId), ["SYN-001"]);
});

test("the authorized claim is bound to the current draft candidate, not the previous text", async () => {
  const authorization = await evaluateDefault();
  const reused = decisionFor(authorization, "SYN-001");
  const currentInventory = extractClaimInventory(CURRENT_DRAFT);
  const previousInventory = extractClaimInventory(PREVIOUS_DRAFT);
  const candidate = currentInventory.candidates[reused.currentCandidate!.index];
  assert.ok(candidate);

  // The named position really is the rewritten sentence in the current draft.
  assert.match(candidate.text, /^I received the application/u);
  assert.equal(hashObject(candidate), reused.currentCandidate!.hash);
  assert.equal(candidate.fingerprint, reused.currentCandidate!.fingerprint);

  // And the previous side is the exact bound candidate, whose text differs.
  const previous = previousInventory.candidates[reused.previousCandidateIndex];
  assert.ok(previous);
  assert.match(previous.text, /^Me received the application/u);
  assert.notEqual(previous.text, candidate.text);
  assert.equal(hashObject(previous), reused.previousCandidateHash);
});

test("a reusable claim never becomes an approved document", async () => {
  const authorization = await evaluateDefault();

  assert.equal(authorization.documentRelease.status, "DOCUMENT_REVIEW_REQUIRED");
  assert.equal(authorization.documentRelease.coverageComplete, false);
  assert.match(
    authorization.documentRelease.reasons.join(" "),
    /never asserts complete coverage/i,
  );
  assert.match(
    authorization.reasons.join(" "),
    /not a verification PASS, not a document release/i,
  );

  // The artifact carries no whole-document verdict field at all.
  for (const key of Object.keys(authorization)) {
    assert.ok(!["decision", "verdict", "pass", "release"].includes(key.toLowerCase()));
  }
  assert.ok(
    authorization.decisions.some((item) => item.outcome === "REUSE_AUTHORIZED"),
    "the incomplete-coverage condition must survive a successful claim authorization",
  );
});

test("no prior attestation is NOT_ATTEMPTED with nothing authorized", async () => {
  const tracePath = await writeTrace([]);
  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor([]),
    asOf: AS_OF,
  });

  assert.equal(authorization.trace.mappingStatus, "NOT_ATTEMPTED");
  assert.deepEqual(authorization.decisions, []);
  assert.equal(authorization.documentRelease.status, "DOCUMENT_REVIEW_REQUIRED");
});

/* -------------------------------------------------------------------------- */
/* Deterministic gates                                                        */
/* -------------------------------------------------------------------------- */

test("each attestation-content gate blocks on its own", async () => {
  const cases: Array<{
    label: string;
    overrides: Partial<SemanticAttestation>;
    code: ClaimReuseBlockerCode;
  }> = [
    { label: "unknown checker name", overrides: { checkerName: "other-checker" }, code: "CHECKER_NOT_TRUSTED" },
    { label: "unknown checker version", overrides: { checkerVersion: "9.9.9" }, code: "CHECKER_NOT_TRUSTED" },
    { label: "unknown checker kind", overrides: { checkerKind: "model" }, code: "CHECKER_NOT_TRUSTED" },
    { label: "score below threshold", overrides: { score: 0.5 }, code: "ATTESTATION_SCORE_BELOW_THRESHOLD" },
    { label: "stale attestation", overrides: { checkedAt: "2026-01-01T00:00:00.000Z" }, code: "ATTESTATION_STALE" },
    { label: "future attestation", overrides: { checkedAt: "2026-08-24T00:00:00.000Z" }, code: "ATTESTATION_FROM_FUTURE" },
    { label: "PARTIAL verdict", overrides: { verdict: "PARTIAL" }, code: "ATTESTATION_VERDICT_NOT_SUPPORTED" },
    { label: "CONTRADICTED verdict", overrides: { verdict: "CONTRADICTED" }, code: "ATTESTATION_VERDICT_NOT_SUPPORTED" },
    { label: "NOT_FOUND verdict", overrides: { verdict: "NOT_FOUND" }, code: "ATTESTATION_VERDICT_NOT_SUPPORTED" },
  ];

  for (const scenario of cases) {
    const reused = boundFor(PREVIOUS_DRAFT, REUSED_FRAGMENT, "SYN-001", scenario.overrides);
    const changed = boundFor(PREVIOUS_DRAFT, CHANGED_FRAGMENT, "SYN-002");
    const authorization = await evaluateDefault({}, { reused, changed });
    const decision = decisionFor(authorization, "SYN-001");

    assert.notEqual(decision.outcome, "REUSE_AUTHORIZED", scenario.label);
    assert.ok(
      blockerCodes(decision).includes(scenario.code),
      `${scenario.label}: expected ${scenario.code}, received ${blockerCodes(decision).join(", ")}`,
    );
    // The association was fine, so this is a policy refusal, not a review route.
    assert.equal(decision.outcome, "POLICY_BLOCKED", scenario.label);
  }
});

test("each pinned-evidence gate blocks on its own", async () => {
  const bounds = defaultBounds();
  const cases: Array<{
    label: string;
    pin: Partial<ClaimReusePolicyInput["claimPins"][number]>;
    code: ClaimReuseBlockerCode;
  }> = [
    { label: "wrong snapshot ID", pin: { snapshotId: "synthetic-snapshot-002" }, code: "EVIDENCE_SNAPSHOT_MISMATCH" },
    { label: "wrong evidence hash", pin: { evidenceHash: sha256Text("other-evidence") }, code: "EVIDENCE_HASH_MISMATCH" },
    { label: "wrong claim binding hash", pin: { claimBindingHash: sha256Text("other-binding") }, code: "CLAIM_BINDING_HASH_MISMATCH" },
    { label: "wrong jurisdiction", pin: { jurisdiction: "ELSEWHERE" }, code: "CLAIM_JURISDICTION_MISMATCH" },
    { label: "wrong domain", pin: { domain: "other-domain" }, code: "CLAIM_DOMAIN_MISMATCH" },
    { label: "stale source currency", pin: { sourceCurrencyConfirmedAsOf: "2026-01-01T00:00:00.000Z" }, code: "SOURCE_CURRENCY_STALE" },
    { label: "future source currency", pin: { sourceCurrencyConfirmedAsOf: "2026-08-24T00:00:00.000Z" }, code: "SOURCE_CURRENCY_CONFIRMATION_FROM_FUTURE" },
  ];

  for (const scenario of cases) {
    const authorization = await evaluateDefault({
      claimPins: [pinFor(bounds.reused, scenario.pin), pinFor(bounds.changed)],
    }, bounds);
    const decision = decisionFor(authorization, "SYN-001");

    assert.equal(decision.outcome, "POLICY_BLOCKED", scenario.label);
    assert.ok(
      blockerCodes(decision).includes(scenario.code),
      `${scenario.label}: expected ${scenario.code}, received ${blockerCodes(decision).join(", ")}`,
    );
  }
});

test("a missing claim pin and an empty trust list both refuse rather than waive", async () => {
  const bounds = defaultBounds();

  const noPin = await evaluateDefault({ claimPins: [pinFor(bounds.changed)] }, bounds);
  const withoutPin = decisionFor(noPin, "SYN-001");
  assert.equal(withoutPin.outcome, "POLICY_BLOCKED");
  assert.ok(blockerCodes(withoutPin).includes("CLAIM_PIN_MISSING"));

  const noTrust = await evaluateDefault({ trustedCheckers: [] }, bounds);
  const untrusted = decisionFor(noTrust, "SYN-001");
  assert.equal(untrusted.outcome, "POLICY_BLOCKED");
  assert.ok(blockerCodes(untrusted).includes("CHECKER_NOT_TRUSTED"));
});

test("an attestation whose claim text is not the bound candidate's is refused", async () => {
  // The mapping proves the binding points at a previous-draft position. It
  // never checks that the attested claim text is the text at that position, so
  // this gate closes that hole itself.
  const honest = boundFor(PREVIOUS_DRAFT, REUSED_FRAGMENT, "SYN-001");
  const attestation = { ...honest.attestation, claimTextHash: sha256Text("a different sentence") };
  const attestationHash = hashObject(attestation);
  const forged: BoundSemanticAttestation = {
    ...honest,
    attestation,
    attestationHash,
    boundAttestationHash: hashObject({
      attestationHash,
      bindingHash: honest.draftBinding.bindingHash,
    }),
  };

  const tracePath = await writeTrace([forged]);
  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor([forged]),
    asOf: AS_OF,
  });
  const decision = decisionFor(authorization, "SYN-001");

  // The mapping still says MATCHED_REUSE_ITEM; the policy gate still refuses.
  assert.equal(decision.mappingResult, "MATCHED_REUSE_ITEM");
  assert.equal(decision.outcome, "HUMAN_REVIEW_REQUIRED");
  assert.ok(blockerCodes(decision).includes("ATTESTATION_CLAIM_TEXT_NOT_PREVIOUS_CANDIDATE"));
});

/* -------------------------------------------------------------------------- */
/* Mapping association                                                        */
/* -------------------------------------------------------------------------- */

test("NOT_IN_PLAN never authorizes and its INCOMPLETE mapping refuses the whole batch", async () => {
  const otherInventory = extractClaimInventory("Something else entirely happened on 2020-01-01.");
  const stray = bindSemanticAttestationToDraftCandidate(
    attestationFor(otherInventory, 0, "SYN-003"),
    otherInventory,
    0,
  );
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed, stray];
  const tracePath = await writeTrace(list);
  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor(list),
    asOf: AS_OF,
  });

  assert.equal(authorization.trace.mappingStatus, "INCOMPLETE");

  const strayDecision = decisionFor(authorization, "SYN-003");
  assert.equal(strayDecision.outcome, "HUMAN_REVIEW_REQUIRED");
  assert.ok(blockerCodes(strayDecision).includes("MAPPING_NOT_IN_PLAN"));

  // The otherwise perfect claim is refused too: an incomplete mapping means the
  // caller's picture of the previous draft is wrong somewhere.
  const reused = decisionFor(authorization, "SYN-001");
  assert.equal(reused.outcome, "HUMAN_REVIEW_REQUIRED");
  assert.ok(blockerCodes(reused).includes("MAPPING_STATUS_NOT_COMPLETE"));
  assert.equal(
    authorization.decisions.filter((item) => item.outcome === "REUSE_AUTHORIZED").length,
    0,
  );
});

test("an unrelated redraft leaves the claim unmatched instead of reusing a lookalike", async () => {
  const bounds = defaultBounds();
  const rewritten = [
    "# Synthetic Grounds",
    "",
    "The tribunal issued a completely different notice on 2025-09-09.",
  ].join("\n");
  const tracePath = await writeTrace([bounds.reused], PREVIOUS_DRAFT, rewritten);
  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor([bounds.reused]),
    asOf: AS_OF,
  });
  const decision = decisionFor(authorization, "SYN-001");

  assert.notEqual(decision.outcome, "REUSE_AUTHORIZED");
  assert.equal(decision.currentCandidate, undefined);
});

/* -------------------------------------------------------------------------- */
/* Policy input contract                                                      */
/* -------------------------------------------------------------------------- */

test("policy input order does not change the decision or any hash", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const extraChecker = {
    checkerName: "another-checker",
    checkerVersion: "1.2.3",
    checkerKind: "model" as const,
  };
  const base = policyFor(list);

  const forward = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: { ...base, trustedCheckers: [...base.trustedCheckers, extraChecker] },
    asOf: AS_OF,
  });
  const reversed = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: {
      ...base,
      trustedCheckers: [extraChecker, ...base.trustedCheckers],
      claimPins: [...base.claimPins].reverse(),
    },
    asOf: AS_OF,
  });

  assert.equal(forward.policyHash, reversed.policyHash);
  assert.equal(forward.evaluationHash, reversed.evaluationHash);
  assert.deepEqual(forward.policy, reversed.policy);
  assert.deepEqual(forward.decisions, reversed.decisions);
  assert.deepEqual(
    forward.policy.claimPins.map((pin) => pin.claimId),
    ["SYN-001", "SYN-002"],
  );
});

test("malformed, duplicate, and conflicting policy input fails typed with no raw TypeError", () => {
  const bounds = defaultBounds();
  const base = policyFor([bounds.reused]);
  const checker = base.trustedCheckers[0]!;

  const cases: Array<{ label: string; policy: unknown; code: string }> = [
    { label: "null policy", policy: null, code: "POLICY_INPUT_INVALID" },
    { label: "array policy", policy: [], code: "POLICY_INPUT_INVALID" },
    { label: "unknown property", policy: { ...base, extra: true }, code: "POLICY_INPUT_INVALID" },
    { label: "missing threshold", policy: { ...base, minScore: undefined }, code: "POLICY_INPUT_INVALID" },
    { label: "threshold above one", policy: { ...base, minScore: 1.5 }, code: "POLICY_INPUT_INVALID" },
    { label: "non-finite threshold", policy: { ...base, minScore: Number.NaN }, code: "POLICY_INPUT_INVALID" },
    { label: "fractional max age", policy: { ...base, maxAttestationAgeDays: 1.5 }, code: "POLICY_INPUT_INVALID" },
    { label: "negative max age", policy: { ...base, maxSourceCurrencyAgeDays: -1 }, code: "POLICY_INPUT_INVALID" },
    { label: "trust list is not an array", policy: { ...base, trustedCheckers: "all" }, code: "POLICY_INPUT_INVALID" },
    { label: "checker is not an object", policy: { ...base, trustedCheckers: [null] }, code: "POLICY_INPUT_INVALID" },
    { label: "checker kind is invalid", policy: { ...base, trustedCheckers: [{ ...checker, checkerKind: "committee" }] }, code: "POLICY_INPUT_INVALID" },
    { label: "pin is not an object", policy: { ...base, claimPins: [7] }, code: "POLICY_INPUT_INVALID" },
    { label: "pin hash is not SHA-256", policy: { ...base, claimPins: [{ ...base.claimPins[0]!, evidenceHash: "nope" }] }, code: "POLICY_INPUT_INVALID" },
    { label: "pin confirmation is not a date", policy: { ...base, claimPins: [{ ...base.claimPins[0]!, sourceCurrencyConfirmedAsOf: "whenever" }] }, code: "POLICY_INPUT_INVALID" },
    { label: "duplicate checker", policy: { ...base, trustedCheckers: [checker, { ...checker }] }, code: "POLICY_DUPLICATE_TRUSTED_CHECKER" },
    { label: "conflicting checker kind", policy: { ...base, trustedCheckers: [checker, { ...checker, checkerKind: "model" }] }, code: "POLICY_CONFLICTING_TRUSTED_CHECKER" },
    { label: "duplicate claim pin", policy: { ...base, claimPins: [base.claimPins[0]!, { ...base.claimPins[0]! }] }, code: "POLICY_DUPLICATE_CLAIM_PIN" },
    { label: "conflicting claim pin", policy: { ...base, claimPins: [base.claimPins[0]!, { ...base.claimPins[0]!, evidenceHash: sha256Text("other") }] }, code: "POLICY_DUPLICATE_CLAIM_PIN" },
  ];

  for (const scenario of cases) {
    assert.throws(
      () => canonicalizeClaimReusePolicy(scenario.policy),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && !(error instanceof TypeError)
        && error.codes.includes(scenario.code as never),
      scenario.label,
    );
  }
});

test("canonicalization copies the caller's policy instead of mutating it", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const policy = policyFor(list);
  const snapshot = JSON.parse(JSON.stringify(policy));

  const authorization = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy,
    asOf: AS_OF,
  });

  assert.deepEqual(policy, snapshot);
  authorization.policy.claimPins.push(pinFor(bounds.reused, { claimId: "SYN-999" }));
  assert.deepEqual(policy, snapshot);
});

test("a missing or unusable asOf refuses before anything is read", async () => {
  const bounds = defaultBounds();
  const tracePath = await writeTrace([bounds.reused]);
  for (const asOf of ["", "whenever", undefined as unknown as string]) {
    await assert.rejects(
      evaluateClaimReuse({
        revisionPlanTracePath: tracePath,
        policy: policyFor([bounds.reused]),
        asOf,
      }),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && error.codes.includes("EVALUATION_INPUT_INVALID"),
    );
  }
});

test("the same policy at a later asOf goes stale deterministically", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const policy = policyFor(list);

  const fresh = await evaluateClaimReuse({ revisionPlanTracePath: tracePath, policy, asOf: AS_OF });
  assert.equal(decisionFor(fresh, "SYN-001").outcome, "REUSE_AUTHORIZED");

  const later = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy,
    asOf: "2026-12-31T00:00:00.000Z",
  });
  const stale = decisionFor(later, "SYN-001");
  assert.equal(stale.outcome, "POLICY_BLOCKED");
  assert.deepEqual(
    blockerCodes(stale).sort(),
    ["ATTESTATION_STALE", "SOURCE_CURRENCY_STALE"],
  );
  assert.notEqual(fresh.evaluationHash, later.evaluationHash);
});

/* -------------------------------------------------------------------------- */
/* Trace integrity                                                            */
/* -------------------------------------------------------------------------- */

test("a trace that fails to read yields no authorization", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const trace = await loadRaw<RevisionPlanTrace>(tracePath);
  trace.previousSubject.text = trace.previousSubject.text.replace("section 23", "section 25");
  await overwriteRaw(tracePath, trace);

  await assert.rejects(
    evaluateClaimReuse({
      revisionPlanTracePath: tracePath,
      policy: policyFor(list),
      asOf: AS_OF,
    }),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("TRACE_NOT_READABLE"),
  );
});

test("a trace edited and fully resealed is caught by replay and yields no authorization", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const trace = await loadRaw<RevisionPlanTrace>(tracePath);

  // Every stored hash is rebound, so only a recomputation can expose the edit.
  trace.currentSubject.text = trace.currentSubject.text.replace("section 24", "section 99");
  trace.currentSubject.sha256 = sha256Text(trace.currentSubject.text);
  trace.currentInventory.subjectSha256 = trace.currentSubject.sha256;
  trace.comparison.currentSubjectSha256 = trace.currentSubject.sha256;
  trace.currentInventoryHash = hashObject(trace.currentInventory);
  trace.planHash = hashObject(trace.comparison);
  trace.priorAttestationsHash = hashObject(trace.priorAttestations);
  trace.artifactHash = revisionPlanArtifactHash(trace);
  await overwriteRaw(tracePath, trace);

  await assert.rejects(
    evaluateClaimReuse({
      revisionPlanTracePath: tracePath,
      policy: policyFor(list),
      asOf: AS_OF,
    }),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("TRACE_REPLAY_MISMATCH"),
  );
});

test("a missing trace path refuses typed rather than throwing a runtime error", async () => {
  const bounds = defaultBounds();
  for (const path of ["", undefined as unknown as string]) {
    await assert.rejects(
      evaluateClaimReuse({
        revisionPlanTracePath: path,
        policy: policyFor([bounds.reused]),
        asOf: AS_OF,
      }),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && !(error instanceof TypeError)
        && error.codes.includes("EVALUATION_INPUT_INVALID"),
    );
  }
  await assert.rejects(
    evaluateClaimReuse({
      revisionPlanTracePath: join(tmpdir(), "ebr-nonexistent-plan.json"),
      policy: policyFor([bounds.reused]),
      asOf: AS_OF,
    }),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("TRACE_NOT_READABLE"),
  );
});

/* -------------------------------------------------------------------------- */
/* Persistence, reader, and replay                                            */
/* -------------------------------------------------------------------------- */

async function writeScenario(): Promise<{
  tracePath: string;
  authorizationPath: string;
  authorization: ClaimReuseAuthorization;
}> {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-authorization-"));
  const authorizationPath = await writeClaimReuseAuthorization(directory, {
    revisionPlanTracePath: tracePath,
    policy: policyFor(list),
    asOf: AS_OF,
  });
  return {
    tracePath,
    authorizationPath,
    authorization: await readClaimReuseAuthorization(authorizationPath),
  };
}

test("a written authorization is private, reads, and replays", async () => {
  const { tracePath, authorizationPath, authorization } = await writeScenario();

  const mode = (await stat(authorizationPath)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, received ${mode.toString(8)}`);
  assert.equal(authorization.policyHash, claimReusePolicyHash(authorization.policy));
  assert.equal(authorization.evaluationHash, claimReuseEvaluationHash(authorization));

  const replay = await replayClaimReuseAuthorization({
    authorizationPath,
    revisionPlanTracePath: tracePath,
  });
  assert.equal(replay.matches, true);
  assert.deepEqual(replay.componentMatches, {
    policy: true,
    trace: true,
    documentRelease: true,
    decisions: true,
  });
  const authorized = await authorizedClaimReuses({
    authorizationPath,
    revisionPlanTracePath: tracePath,
  });
  assert.deepEqual(authorized.map((item) => item.claimId), ["SYN-001"]);
  assert.match(replay.reasons.join(" "), /not a verification PASS/i);
});

test("the same trace, policy, and asOf reproduce the same evaluation hash", async () => {
  const bounds = defaultBounds();
  const list = [bounds.reused, bounds.changed];
  const tracePath = await writeTrace(list);
  const first = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor(list),
    asOf: AS_OF,
  });
  const second = await evaluateClaimReuse({
    revisionPlanTracePath: tracePath,
    policy: policyFor(list),
    asOf: AS_OF,
  });

  assert.equal(first.evaluationHash, second.evaluationHash);
  // The envelope is generated per run and deliberately outside the hash.
  assert.notEqual(first.authorizationId, second.authorizationId);
});

test("stored hash, policy order, and shape tampering fail the reader", async () => {
  const { authorization } = await writeScenario();
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-tamper-"));
  const write = async (label: string, value: unknown): Promise<string> => {
    const path = join(directory, `${label}.json`);
    await overwriteRaw(path, value);
    return path;
  };

  const cases: Array<{ label: string; value: unknown; code: string }> = [
    {
      label: "policy-hash",
      value: { ...authorization, policyHash: sha256Text("tampered") },
      code: "AUTHORIZATION_POLICY_HASH_MISMATCH",
    },
    {
      label: "evaluation-hash",
      value: { ...authorization, evaluationHash: sha256Text("tampered") },
      code: "AUTHORIZATION_EVALUATION_HASH_MISMATCH",
    },
    {
      label: "unknown-field",
      value: { ...authorization, smuggled: "unauthenticated" },
      code: "AUTHORIZATION_INVALID_SHAPE",
    },
    {
      label: "document-release",
      value: {
        ...authorization,
        documentRelease: { ...authorization.documentRelease, status: "DOCUMENT_RELEASED" },
      },
      code: "AUTHORIZATION_INVALID_SHAPE",
    },
    {
      label: "coverage-complete",
      value: {
        ...authorization,
        documentRelease: { ...authorization.documentRelease, coverageComplete: true },
      },
      code: "AUTHORIZATION_INVALID_SHAPE",
    },
    {
      label: "unknown-blocker-code",
      value: {
        ...authorization,
        decisions: authorization.decisions.map((decision) =>
          decision.claimId === "SYN-002"
            ? { ...decision, blockers: [{ code: "NOT_A_REAL_CODE", message: "x" }] }
            : decision
        ),
      },
      code: "AUTHORIZATION_INVALID_SHAPE",
    },
    {
      label: "outcome-without-blockers",
      value: {
        ...authorization,
        decisions: authorization.decisions.map((decision) =>
          decision.claimId === "SYN-002" ? { ...decision, outcome: "REUSE_AUTHORIZED" } : decision
        ),
      },
      code: "AUTHORIZATION_DECISION_INCONSISTENT",
    },
    {
      label: "blockers-deleted",
      value: {
        ...authorization,
        decisions: authorization.decisions.map((decision) =>
          decision.claimId === "SYN-002" ? { ...decision, blockers: [] } : decision
        ),
      },
      code: "AUTHORIZATION_DECISION_INCONSISTENT",
    },
    {
      label: "authorized-under-incomplete-mapping",
      value: {
        ...authorization,
        trace: { ...authorization.trace, mappingStatus: "INCOMPLETE" },
      },
      code: "AUTHORIZATION_DECISION_INCONSISTENT",
    },
    {
      label: "authorized-without-current-candidate",
      value: {
        ...authorization,
        decisions: authorization.decisions.map((decision) => {
          if (decision.claimId !== "SYN-001") return decision;
          const { currentCandidate: _dropped, ...rest } = decision;
          return rest;
        }),
      },
      code: "AUTHORIZATION_DECISION_INCONSISTENT",
    },
  ];

  for (const scenario of cases) {
    const path = await write(scenario.label, scenario.value);
    await assert.rejects(
      readClaimReuseAuthorization(path),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && !(error instanceof TypeError)
        && error.codes.includes(scenario.code as never),
      scenario.label,
    );
  }

  // A non-canonical policy order that was carefully rehashed still fails.
  const shuffled = {
    ...authorization,
    policy: {
      ...authorization.policy,
      claimPins: [...authorization.policy.claimPins].reverse(),
    },
  };
  const resealed = {
    ...shuffled,
    policyHash: hashObject(shuffled.policy),
  };
  const finalised = { ...resealed, evaluationHash: claimReuseEvaluationHash(resealed) };
  const shuffledPath = await write("policy-order", finalised);
  await assert.rejects(
    readClaimReuseAuthorization(shuffledPath),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("AUTHORIZATION_POLICY_NOT_CANONICAL"),
  );
});

test("a fully rehashed forged authorization is exposed by replay", async () => {
  const { tracePath, authorizationPath, authorization } = await writeScenario();
  const authorized = decisionFor(authorization, "SYN-001");
  const refused = decisionFor(authorization, "SYN-002");

  // The refused claim is rewritten as an authorized one, complete with a stolen
  // plan association and current-candidate binding, and the artifact is resealed
  // so every stored hash is internally consistent.
  const forgedDecision: ClaimReuseDecision = {
    ...refused,
    mappingResult: "MATCHED_REUSE_ITEM",
    planAction: "REUSE",
    planIndex: authorized.planIndex!,
    currentCandidate: { ...authorized.currentCandidate! },
    outcome: "REUSE_AUTHORIZED",
    blockers: [],
    reasons: ["Forged."],
  };
  const forgedCore = {
    ...authorization,
    decisions: authorization.decisions
      .map((decision) => (decision.claimId === "SYN-002" ? forgedDecision : decision))
      .sort((left, right) => left.boundAttestationHash.localeCompare(right.boundAttestationHash)),
  };
  const forged = { ...forgedCore, evaluationHash: claimReuseEvaluationHash(forgedCore) };

  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-forgery-"));
  const forgedPath = join(directory, "forged.json");
  await overwriteRaw(forgedPath, forged);

  // The reader accepts it: every stored hash and every internal rule holds.
  const readBack = await readClaimReuseAuthorization(forgedPath);
  assert.equal(decisionFor(readBack, "SYN-002").outcome, "REUSE_AUTHORIZED");

  // Replay recomputes the decision from the trace and refuses it.
  const replay = await replayClaimReuseAuthorization({
    authorizationPath: forgedPath,
    revisionPlanTracePath: tracePath,
  });
  assert.equal(replay.matches, false);
  assert.equal(replay.componentMatches.decisions, false);
  assert.equal(replay.storedOutcomes[refused.boundAttestationHash], "REUSE_AUTHORIZED");
  assert.equal(replay.recomputedOutcomes[refused.boundAttestationHash], "REVERIFY_REQUIRED");
  assert.deepEqual(
    await authorizedClaimReuses({
      authorizationPath: forgedPath,
      revisionPlanTracePath: tracePath,
    }),
    [],
  );

  // And the honest artifact beside it still replays, so the failure is the
  // forgery rather than the harness.
  const honest = await replayClaimReuseAuthorization({
    authorizationPath,
    revisionPlanTracePath: tracePath,
  });
  assert.equal(honest.matches, true);
});

test("a rehashed current-candidate binding is exposed by replay", async () => {
  const { tracePath, authorizationPath, authorization } = await writeScenario();
  const authorized = decisionFor(authorization, "SYN-001");
  const moved = {
    ...authorization,
    decisions: authorization.decisions.map((decision) =>
      decision.claimId === "SYN-001"
        ? {
          ...decision,
          currentCandidate: { ...authorized.currentCandidate!, index: 0 },
        }
        : decision
    ),
  };
  const forged = { ...moved, evaluationHash: claimReuseEvaluationHash(moved) };
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-candidate-"));
  const forgedPath = join(directory, "moved-candidate.json");
  await overwriteRaw(forgedPath, forged);

  await assert.doesNotReject(readClaimReuseAuthorization(forgedPath));
  const replay = await replayClaimReuseAuthorization({
    authorizationPath: forgedPath,
    revisionPlanTracePath: tracePath,
  });
  assert.equal(replay.matches, false);
  assert.equal(replay.componentMatches.decisions, false);
  assert.deepEqual(
    await authorizedClaimReuses({
      authorizationPath: forgedPath,
      revisionPlanTracePath: tracePath,
    }),
    [],
  );
  assert.notEqual(authorizationPath, forgedPath);
});

test("replay refuses a revision-plan trace the authorization was not evaluated against", async () => {
  const { authorizationPath } = await writeScenario();
  const bounds = defaultBounds();
  const otherTracePath = await writeTrace(
    [bounds.reused],
    PREVIOUS_DRAFT,
    CURRENT_DRAFT.replace("section 24", "section 26"),
  );

  await assert.rejects(
    replayClaimReuseAuthorization({
      authorizationPath,
      revisionPlanTracePath: otherTracePath,
    }),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("AUTHORIZATION_TRACE_BINDING_MISMATCH"),
  );
});

test("replay refuses once the underlying trace itself is tampered with", async () => {
  const { tracePath, authorizationPath } = await writeScenario();
  const trace = await loadRaw<RevisionPlanTrace>(tracePath);
  trace.comparison.plan = trace.comparison.plan.map((item) =>
    item.action === "REVERIFY"
      ? { ...item, action: "REUSE" as const, requiresRevalidation: false, reviewKind: "NONE" as const }
      : item
  );
  await overwriteRaw(tracePath, trace);

  await assert.rejects(
    replayClaimReuseAuthorization({ authorizationPath, revisionPlanTracePath: tracePath }),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && (error.codes.includes("TRACE_NOT_READABLE")
        || error.codes.includes("TRACE_REPLAY_MISMATCH")),
  );
});

test("malformed stored authorizations fail typed with no raw TypeError", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-malformed-"));
  const cases: Array<{ label: string; body: string; code: string }> = [
    { label: "not-json", body: "{", code: "AUTHORIZATION_INVALID_JSON" },
    { label: "array", body: "[]", code: "AUTHORIZATION_INVALID_SHAPE" },
    { label: "empty-object", body: "{}", code: "AUTHORIZATION_INVALID_SHAPE" },
    { label: "null", body: "null", code: "AUTHORIZATION_INVALID_SHAPE" },
  ];
  for (const scenario of cases) {
    const path = join(directory, `${scenario.label}.json`);
    await writeFile(path, scenario.body, "utf8");
    await assert.rejects(
      readClaimReuseAuthorization(path),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && !(error instanceof TypeError)
        && error.codes.includes(scenario.code as never),
      scenario.label,
    );
  }
  await assert.rejects(
    readClaimReuseAuthorization(join(directory, "absent.json")),
    (error: unknown) => error instanceof ClaimReusePolicyError
      && error.codes.includes("AUTHORIZATION_INVALID_JSON"),
  );
});

test("an ambiguous or unmapped association can never be relabelled as authorized", async () => {
  // A well-formed inventory cannot produce AMBIGUOUS, because each previous
  // candidate carries a distinct locator and so appears as `before` in exactly
  // one plan item. The rule is therefore enforced where a forged artifact would
  // try to use it: in the stored-decision contract.
  const { authorization } = await writeScenario();
  const authorized = decisionFor(authorization, "SYN-001");
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-ambiguous-"));

  for (const mappingResult of ["AMBIGUOUS", "NOT_IN_PLAN"] as const) {
    const relabelled = {
      ...authorization,
      decisions: authorization.decisions.map((decision) => {
        if (decision.claimId !== "SYN-001") return decision;
        const { planIndex: _index, planAction: _action, ...rest } = decision;
        return { ...rest, mappingResult };
      }),
    };
    const forged = { ...relabelled, evaluationHash: claimReuseEvaluationHash(relabelled) };
    const path = join(directory, `${mappingResult}.json`);
    await overwriteRaw(path, forged);

    await assert.rejects(
      readClaimReuseAuthorization(path),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && error.codes.includes("AUTHORIZATION_DECISION_INCONSISTENT"),
      mappingResult,
    );
  }
  assert.equal(authorized.mappingResult, "MATCHED_REUSE_ITEM");
});

/* -------------------------------------------------------------------------- */
/* No in-memory path to authorization                                         */
/* -------------------------------------------------------------------------- */

function typedRefusal(code: string) {
  return (error: unknown): boolean => {
    assert.ok(
      error instanceof ClaimReusePolicyError,
      `expected ClaimReusePolicyError, received ${String(error)}`,
    );
    assert.ok(!(error instanceof TypeError), "a raw TypeError must never reach the caller");
    assert.ok(
      error.codes.includes(code as never),
      `expected code ${code}, received ${error.codes.join(", ")}`,
    );
    return true;
  };
}

test("a fabricated in-memory replay cannot obtain authorization from any exported helper", async () => {
  const { tracePath, authorizationPath } = await writeScenario();
  const honest = await replayClaimReuseAuthorization({
    authorizationPath,
    revisionPlanTracePath: tracePath,
  });
  assert.equal(honest.matches, true);

  // Every field a caller can assemble by hand, shaped exactly like a genuine
  // matching replay, with every decision rewritten to REUSE_AUTHORIZED and its
  // blockers stripped. Nothing on disk changed: this object claims an
  // authorization the trace never produced.
  const fabricated: ClaimReuseAuthorizationReplay = {
    matches: true,
    expectedEvaluationHash: honest.expectedEvaluationHash,
    actualEvaluationHash: honest.expectedEvaluationHash,
    componentMatches: { policy: true, trace: true, documentRelease: true, decisions: true },
    storedOutcomes: { ...honest.storedOutcomes },
    recomputedOutcomes: Object.fromEntries(
      Object.keys(honest.recomputedOutcomes).map((hash) => [hash, "REUSE_AUTHORIZED" as const]),
    ),
    recomputed: {
      ...honest.recomputed,
      decisions: honest.recomputed.decisions.map((decision) => ({
        ...decision,
        outcome: "REUSE_AUTHORIZED" as const,
        blockers: [],
      })),
    },
    reasons: ["fabricated by the caller"],
  };
  assert.equal(
    fabricated.recomputed.decisions.filter((item) => item.outcome === "REUSE_AUTHORIZED").length,
    2,
  );

  // The helper takes paths, so the fabrication is refused for the two paths it
  // does not carry rather than read for the decisions it does.
  await assert.rejects(
    authorizedClaimReuses(fabricated as unknown as ClaimReuseAuthorizationReplayInput),
    (error: unknown) => {
      typedRefusal("EVALUATION_INPUT_INVALID")(error);
      const spoken = (error as ClaimReusePolicyError).issues.join(" ");
      assert.match(spoken, /authorizationPath/u);
      assert.match(spoken, /revisionPlanTracePath/u);
      return true;
    },
  );

  // No other exported entry point takes it either, and none of them leaks an
  // untyped runtime error on the way to refusing.
  await assert.rejects(
    replayClaimReuseAuthorization(fabricated as unknown as ClaimReuseAuthorizationReplayInput),
    typedRefusal("EVALUATION_INPUT_INVALID"),
  );
  await assert.rejects(
    evaluateClaimReuse(fabricated as unknown as Parameters<typeof evaluateClaimReuse>[0]),
    typedRefusal("EVALUATION_INPUT_INVALID"),
  );
  await assert.rejects(
    writeClaimReuseAuthorization(
      await mkdtemp(join(tmpdir(), "ebr-reuse-fabricated-")),
      fabricated as unknown as Parameters<typeof evaluateClaimReuse>[0],
    ),
    typedRefusal("EVALUATION_INPUT_INVALID"),
  );
  await assert.rejects(
    readClaimReuseAuthorization(fabricated as unknown as string),
    typedRefusal("AUTHORIZATION_INVALID_JSON"),
  );

  // Nor can the fabrication ride alongside real paths: the input is closed, so
  // a caller is never left believing the smuggled fields were honoured.
  await assert.rejects(
    authorizedClaimReuses({
      authorizationPath,
      revisionPlanTracePath: tracePath,
      ...fabricated,
    } as unknown as ClaimReuseAuthorizationReplayInput),
    (error: unknown) => {
      typedRefusal("EVALUATION_INPUT_INVALID")(error);
      const spoken = (error as ClaimReusePolicyError).issues.join(" ");
      assert.match(spoken, /replayInput\.matches is not an allowed property/u);
      assert.match(spoken, /replayInput\.recomputed is not an allowed property/u);
      return true;
    },
  );

  // The refusals above are the fabrication, not the harness: the same scenario
  // authorizes exactly the one honest reuse through the path-based helper.
  const authorized = await authorizedClaimReuses({
    authorizationPath,
    revisionPlanTracePath: tracePath,
  });
  assert.deepEqual(authorized.map((item) => item.claimId), ["SYN-001"]);
});

test("the path-based helper refuses malformed input without an untyped error", async () => {
  const { tracePath, authorizationPath } = await writeScenario();
  const cases: Array<{ label: string; input: unknown }> = [
    { label: "undefined", input: undefined },
    { label: "null", input: null },
    { label: "array", input: [authorizationPath, tracePath] },
    { label: "string", input: authorizationPath },
    { label: "empty-object", input: {} },
    { label: "blank-authorization-path", input: { authorizationPath: "  ", revisionPlanTracePath: tracePath } },
    { label: "missing-trace-path", input: { authorizationPath } },
    { label: "numeric-trace-path", input: { authorizationPath, revisionPlanTracePath: 7 } },
  ];
  for (const scenario of cases) {
    await assert.rejects(
      authorizedClaimReuses(scenario.input as ClaimReuseAuthorizationReplayInput),
      typedRefusal("EVALUATION_INPUT_INVALID"),
      scenario.label,
    );
  }

  // An absent artifact is a refusal too, never an empty pass.
  await assert.rejects(
    authorizedClaimReuses({
      authorizationPath: join(tmpdir(), "ebr-absent-authorization.json"),
      revisionPlanTracePath: tracePath,
    }),
    typedRefusal("AUTHORIZATION_INVALID_JSON"),
  );
});
