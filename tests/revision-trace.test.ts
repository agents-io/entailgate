import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashObject, sha256Text } from "../src/canonical.js";
import {
  CLAIM_EXTRACTOR_VERSION,
  extractCandidateAssertions,
  extractClaimInventory,
  normalizedAtomicClaimFingerprint,
  type ClaimInventory,
} from "../src/claims.js";
import {
  bindSemanticAttestationToDraftCandidate,
  type BoundSemanticAttestation,
} from "../src/draft-binding.js";
import { PriorMappingError } from "../src/prior-mapping.js";
import {
  buildRevisionPlanTrace,
  readRevisionPlanTrace,
  replayRevisionPlanTrace,
  RevisionTraceIntegrityError,
  revisionPlanArtifactHash,
  writeRevisionPlanTrace,
  type RevisionPlanTrace,
} from "../src/revision-trace.js";
import type { SemanticAttestation } from "../src/types.js";

const PREVIOUS_DRAFT = [
  "Me made the request.",
  "Section 23 requires the employer to respond within 30 days.",
  "This is a short introduction.",
].join("\n\n");

const CURRENT_DRAFT = [
  "I made the request.",
  "Section 23 requires the employer to respond within 30 days.",
  "This is a substantially clearer introduction for the reader.",
].join("\n\n");

async function writePlan(
  previousText = PREVIOUS_DRAFT,
  currentText = CURRENT_DRAFT,
  priorAttestations: readonly BoundSemanticAttestation[] = [],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ebr-revision-plan-"));
  return writeRevisionPlanTrace(directory, { previousText, currentText, priorAttestations });
}

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

/** Binds one previous-draft candidate position by index, never by text. */
function boundFor(
  previousText: string,
  fragment: string,
  overrides: Partial<SemanticAttestation> = {},
  occurrence = 0,
): BoundSemanticAttestation {
  const inventory = extractClaimInventory(previousText);
  const indices = inventory.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.text.includes(fragment))
    .map((entry) => entry.index);
  const candidateIndex = indices[occurrence];
  assert.ok(candidateIndex !== undefined, `no candidate ${occurrence} containing ${fragment}`);
  return bindSemanticAttestationToDraftCandidate(
    attestationFor(inventory, candidateIndex, overrides),
    inventory,
    candidateIndex,
  );
}

async function loadRawPlan(path: string): Promise<RevisionPlanTrace> {
  return JSON.parse(await readFile(path, "utf8")) as RevisionPlanTrace;
}

async function overwriteRawPlan(path: string, trace: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
}

/** Rebinds every hash so only a replay can expose the edit. */
function rebindEveryHash(trace: RevisionPlanTrace): RevisionPlanTrace {
  trace.previousSubject.sha256 = sha256Text(trace.previousSubject.text);
  trace.currentSubject.sha256 = sha256Text(trace.currentSubject.text);
  trace.previousInventory.subjectSha256 = trace.previousSubject.sha256;
  trace.currentInventory.subjectSha256 = trace.currentSubject.sha256;
  trace.comparison.previousSubjectSha256 = trace.previousSubject.sha256;
  trace.comparison.currentSubjectSha256 = trace.currentSubject.sha256;
  trace.previousInventoryHash = hashObject(trace.previousInventory);
  trace.currentInventoryHash = hashObject(trace.currentInventory);
  trace.planHash = hashObject(trace.comparison);
  trace.priorAttestationsHash = hashObject(trace.priorAttestations);
  trace.artifactHash = revisionPlanArtifactHash(trace);
  return trace;
}

/** Reseals an edited mapping so only a replay can expose the edit. */
function rebindMapping(trace: RevisionPlanTrace): RevisionPlanTrace {
  const mapping = trace.priorAttestationMapping;
  mapping.mappingHash = hashObject({
    schemaVersion: mapping.schemaVersion,
    kind: mapping.kind,
    status: mapping.status,
    priorAttestationsHash: mapping.priorAttestationsHash,
    entries: mapping.entries,
    unmappedBoundAttestationHashes: mapping.unmappedBoundAttestationHashes,
    reasons: mapping.reasons,
  });
  return rebindEveryHash(trace);
}

test("a legitimate revision plan round-trips and replays", async () => {
  const path = await writePlan();
  const trace = await readRevisionPlanTrace(path);

  assert.equal(trace.schemaVersion, "0.2.1");
  assert.equal(trace.kind, "revision-plan");
  assert.equal(trace.extractorVersion, CLAIM_EXTRACTOR_VERSION);
  assert.equal(trace.previousSubject.sha256, sha256Text(PREVIOUS_DRAFT));
  assert.equal(trace.currentSubject.sha256, sha256Text(CURRENT_DRAFT));
  assert.equal(trace.previousInventoryHash, hashObject(trace.previousInventory));
  assert.equal(trace.currentInventoryHash, hashObject(trace.currentInventory));
  assert.equal(trace.planHash, hashObject(trace.comparison));
  assert.equal(trace.priorAttestationsHash, hashObject(trace.priorAttestations));
  assert.equal(trace.artifactHash, revisionPlanArtifactHash(trace));

  // No attestation supplied, so the mapping reports that honestly instead of
  // reporting an empty success.
  assert.deepEqual(trace.priorAttestations, []);
  assert.equal(trace.priorAttestationMapping.status, "NOT_ATTEMPTED");
  assert.deepEqual(trace.priorAttestationMapping.entries, []);

  const replay = await replayRevisionPlanTrace(path);
  assert.equal(replay.matches, true);
  assert.equal(replay.expectedArtifactHash, replay.actualArtifactHash);
  assert.equal(replay.extractorVersionMatches, true);
  assert.deepEqual(replay.componentMatches, {
    previousInventory: true,
    currentInventory: true,
    plan: true,
    priorAttestations: true,
    priorAttestationMapping: true,
  });
  assert.deepEqual(replay.comparison, trace.comparison);
  assert.deepEqual(replay.priorAttestationMapping, trace.priorAttestationMapping);
});

test("the stored artifact is private and never claims a semantic verdict", async () => {
  const path = await writePlan();
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, received ${mode.toString(8)}`);

  const trace = await readRevisionPlanTrace(path);
  assert.equal(trace.comparison.coverageComplete, false);
  assert.equal(trace.previousInventory.coverage.complete, false);
  assert.equal(trace.currentInventory.coverage.complete, false);
  assert.equal(trace.priorAttestationMapping.status, "NOT_ATTEMPTED");
  assert.match(
    trace.reasons.join(" "),
    /audit identit(?:y|ies).*not a semantic verdict|not a semantic verdict/i,
  );
  const replay = await replayRevisionPlanTrace(path);
  assert.match(replay.reasons.join(" "), /not a semantic verdict/i);
});

test("identical drafts produce an identical artifact hash", async () => {
  const first = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
  });
  const second = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
  });

  assert.equal(first.artifactHash, second.artifactHash);
  assert.equal(first.previousInventoryHash, second.previousInventoryHash);
  assert.equal(first.currentInventoryHash, second.currentInventoryHash);
  assert.equal(first.planHash, second.planHash);
  // The envelope is deliberately outside the hash so replay stays comparable.
  assert.notEqual(first.traceId, second.traceId);

  const swapped = buildRevisionPlanTrace({
    previousText: CURRENT_DRAFT,
    currentText: PREVIOUS_DRAFT,
  });
  assert.notEqual(swapped.artifactHash, first.artifactHash);
});

test("the persisted plan preserves harmless Me/I selective reuse", async () => {
  const path = await writePlan();
  const trace = await readRevisionPlanTrace(path);
  const plan = trace.comparison.plan;

  const firstPerson = plan.find((item) => item.before?.text === "Me made the request.");
  assert.equal(firstPerson?.action, "REUSE");
  assert.equal(firstPerson?.requiresRevalidation, false);
  assert.equal(firstPerson?.after?.text, "I made the request.");

  const legal = plan.find((item) =>
    item.before?.materialSignals.some((signal) => signal.kind === "legal_section")
  );
  assert.equal(legal?.action, "REUSE");
  assert.equal(legal?.requiresRevalidation, false);
  assert.equal(legal?.reviewKind, "NONE");

  // The rewritten introduction is the only thing that still needs a look, and
  // it is the cheap materiality route rather than a source recheck.
  assert.equal(plan.filter((item) => item.reviewKind === "SOURCE_SUPPORT").length, 0);
  assert.ok(plan.some((item) => item.reviewKind === "MATERIALITY"));
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("a protected material change is persisted as REVERIFY and replays", async () => {
  const path = await writePlan(
    "Section 23 requires disclosure within 30 days.",
    "Section 24 requires disclosure within 30 days.",
  );
  const trace = await readRevisionPlanTrace(path);
  const changed = trace.comparison.plan.find((item) => item.before && item.after);

  assert.equal(changed?.action, "REVERIFY");
  assert.equal(changed?.requiresRevalidation, true);
  assert.equal(changed?.reviewKind, "SOURCE_SUPPORT");
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("stored subject text tampering fails closed", async () => {
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  trace.currentSubject.text = trace.currentSubject.text.replace("Section 23", "Section 24");
  await overwriteRawPlan(path, trace);

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_SUBJECT_TEXT_HASH_MISMATCH"),
  );
  await assert.rejects(replayRevisionPlanTrace(path), RevisionTraceIntegrityError);
});

test("subject text tampering with every hash rebound is caught by replay", async () => {
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  trace.currentSubject.text = trace.currentSubject.text.replace("Section 23", "Section 24");
  await overwriteRawPlan(path, rebindEveryHash(trace));

  // Internally consistent, so the reader cannot reject it.
  await readRevisionPlanTrace(path);
  const replay = await replayRevisionPlanTrace(path);
  assert.equal(replay.matches, false);
  assert.equal(replay.componentMatches.previousInventory, true);
  assert.equal(replay.componentMatches.currentInventory, false);
  assert.equal(replay.componentMatches.plan, false);
  assert.equal(replay.extractorVersionMatches, true);
  // The recomputed plan tells the truth about the swapped section.
  const changed = replay.comparison.plan.find((item) => item.action === "REVERIFY");
  assert.ok(changed, "a changed legal section must recompute to REVERIFY");
  assert.match(replay.reasons.join(" "), /diverged .*currentInventory, plan/);
});

test("stored plan tampering that forges REUSE fails closed", async () => {
  const path = await writePlan(
    "Section 23 requires disclosure within 30 days.",
    "Section 24 requires disclosure within 30 days.",
  );
  const trace = await loadRawPlan(path);
  const item = trace.comparison.plan.find((entry) => entry.action === "REVERIFY");
  assert.ok(item);
  item.action = "REUSE";
  item.requiresRevalidation = false;
  item.reviewKind = "NONE";
  await overwriteRawPlan(path, trace);

  // artifactHash binds planHash, and planHash binds the comparison, so the
  // inner link of the chain is the one that reports an edited plan.
  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_PLAN_HASH_MISMATCH")
      && !error.issueCodes.includes("REVISION_ARTIFACT_HASH_MISMATCH"),
  );
  await assert.rejects(replayRevisionPlanTrace(path), RevisionTraceIntegrityError);
});

test("breaking the plan link and rehashing only the plan still fails closed", async () => {
  const path = await writePlan(
    "Section 23 requires disclosure within 30 days.",
    "Section 24 requires disclosure within 30 days.",
  );
  const trace = await loadRawPlan(path);
  const item = trace.comparison.plan.find((entry) => entry.action === "REVERIFY");
  assert.ok(item);
  item.reason = "A reason nobody in this plan produced.";
  trace.planHash = hashObject(trace.comparison);
  await overwriteRawPlan(path, trace);

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_ARTIFACT_HASH_MISMATCH")
      && !error.issueCodes.includes("REVISION_PLAN_HASH_MISMATCH"),
  );
});

test("a forged REUSE whose consequences still say revalidate fails shape validation", async () => {
  const path = await writePlan(
    "Section 23 requires disclosure within 30 days.",
    "Section 24 requires disclosure within 30 days.",
  );
  const trace = await loadRawPlan(path);
  const item = trace.comparison.plan.find((entry) => entry.action === "REVERIFY");
  assert.ok(item);
  item.action = "REUSE";
  await overwriteRawPlan(path, rebindEveryHash(trace));

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.some((issue) => /requiresRevalidation contradicts/.test(issue))
      && error.issues.some((issue) => /reviewKind contradicts/.test(issue)),
  );
});

test("plan tampering with every hash rebound is caught by replay", async () => {
  const path = await writePlan(
    "Section 23 requires disclosure within 30 days.",
    "Section 24 requires disclosure within 30 days.",
  );
  const trace = await loadRawPlan(path);
  const item = trace.comparison.plan.find((entry) => entry.action === "REVERIFY");
  assert.ok(item);
  item.action = "REUSE";
  item.requiresRevalidation = false;
  item.reviewKind = "NONE";
  item.reason = "The location-independent claim fingerprint is unchanged.";
  await overwriteRawPlan(path, rebindEveryHash(trace));

  await readRevisionPlanTrace(path);
  const replay = await replayRevisionPlanTrace(path);
  assert.equal(replay.matches, false);
  assert.equal(replay.componentMatches.plan, false);
  assert.equal(
    replay.comparison.plan.find((entry) => entry.before && entry.after)?.action,
    "REVERIFY",
  );
});

test("only the artifact hash left stale still fails closed", async () => {
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  trace.artifactHash = "0".repeat(64);
  await overwriteRawPlan(path, trace);

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_ARTIFACT_HASH_MISMATCH")
      && !error.issueCodes.includes("REVISION_PLAN_HASH_MISMATCH"),
  );
});

test("malformed stored plans fail closed with typed codes and no raw TypeError", async () => {
  const path = await writePlan();
  const raw = await loadRawPlan(path) as unknown as Record<string, unknown>;
  const comparison = raw.comparison as Record<string, unknown>;
  comparison.plan = "not-an-array";
  await writeFile(path, JSON.stringify(raw), "utf8");

  await assert.rejects(
    replayRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.includes("trace.comparison.plan must be an array")
      && !(error instanceof TypeError),
  );

  await writeFile(path, JSON.stringify({ schemaVersion: "0.2.0" }), "utf8");
  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && !(error instanceof TypeError),
  );

  for (const body of ["[]", '"a string"', "null", "{ not json"]) {
    await writeFile(path, body, "utf8");
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && !(error instanceof TypeError),
      `body ${body} must fail closed`,
    );
  }
});

test("a candidate stripped of its fingerprint is rejected before any hashing", async () => {
  const path = await writePlan();
  const raw = await loadRawPlan(path) as unknown as Record<string, unknown>;
  const inventory = raw.previousInventory as { candidates: Array<Record<string, unknown>> };
  delete inventory.candidates[0]?.fingerprint;
  await writeFile(path, JSON.stringify(raw), "utf8");

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issues.includes(
        "trace.previousInventory.candidates[0].fingerprint must be lowercase SHA-256",
      ),
  );
});

test("strict validation still accepts every shape the extractor really emits", async () => {
  // Closed-shape and deep-field rules must not reject a legitimate trace. This
  // document exercises headings, setext headings, fenced and indented code,
  // tables, list markers, a quotation, and a pronoun-dependent sentence that
  // carries a priorContextHash.
  const previous = [
    "# Notice",
    "",
    "## Background",
    "",
    "The employer wrote: \"The record was sent.\"",
    "This confirms it.",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "    indented code",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "Setext heading",
    "==============",
    "",
    "- Section 23 applies.",
  ].join("\n");
  const path = await writePlan(previous, previous.replace("Section 23", "Section 24"));
  const trace = await readRevisionPlanTrace(path);
  const candidates = [...trace.previousInventory.candidates, ...trace.currentInventory.candidates];
  const roles = new Set(candidates.map((candidate) => candidate.semanticRole));

  assert.deepEqual(
    [...roles].sort(),
    ["assertion", "fenced_code", "heading", "indented_code"],
    "fixture must cover every semantic role",
  );
  assert.ok(
    candidates.some((candidate) => candidate.context.priorContextHash !== undefined),
    "fixture must cover a candidate that binds prior context",
  );
  assert.ok(candidates.some((candidate) => candidate.context.headingLevels.length > 0));
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);

  // A literal block keeps blank lines as empty candidates, so empty text and
  // empty token arrays are legitimate and must not be rejected as malformed.
  const literal = ["```", "line one", "   ", "line two", "```"].join("\n");
  const literalPath = await writePlan(literal, literal.replace("line two", "line three"));
  const literalTrace = await readRevisionPlanTrace(literalPath);
  assert.ok(
    literalTrace.previousInventory.candidates.some(
      (candidate) => candidate.text === "" && candidate.comparisonTokens.length === 0,
    ),
    "fixture must cover an empty literal candidate",
  );
  assert.equal((await replayRevisionPlanTrace(literalPath)).matches, true);
});

test("unknown properties are rejected at every level of the stored artifact", async () => {
  // artifactHash binds a fixed field list, so an unknown top-level key would
  // never be authenticated by it. Every closed object is checked, matching
  // additionalProperties:false in the published schema.
  const injections: Array<[string, (trace: RevisionPlanTrace) => void, string]> = [
    [
      "top level",
      (trace) => {
        (trace as unknown as Record<string, unknown>).attackerNote = "ride along";
      },
      "trace.attackerNote is not an allowed property",
    ],
    [
      "subject record",
      (trace) => {
        (trace.previousSubject as unknown as Record<string, unknown>).origin = "/etc/passwd";
      },
      "trace.previousSubject.origin is not an allowed property",
    ],
    [
      "comparison options",
      (trace) => {
        (trace.comparisonOptions as unknown as Record<string, unknown>).unbounded = true;
      },
      "trace.comparisonOptions.unbounded is not an allowed property",
    ],
    [
      "prior attestation mapping",
      (trace) => {
        (trace.priorAttestationMapping as unknown as Record<string, unknown>).reusedClaims = ["L-1"];
      },
      "trace.priorAttestationMapping root has unknown property: reusedClaims",
    ],
    [
      "inventory",
      (trace) => {
        (trace.previousInventory as unknown as Record<string, unknown>).completeReally = true;
      },
      "trace.previousInventory.completeReally is not an allowed property",
    ],
    [
      "coverage",
      (trace) => {
        (trace.previousInventory.coverage as unknown as Record<string, unknown>).attested = true;
      },
      "trace.previousInventory.coverage.attested is not an allowed property",
    ],
    [
      "candidate",
      (trace) => {
        (trace.previousInventory.candidates[0] as unknown as Record<string, unknown>).verdict =
          "SUPPORTED";
      },
      "trace.previousInventory.candidates[0].verdict is not an allowed property",
    ],
    [
      "candidate context",
      (trace) => {
        (trace.previousInventory.candidates[0]!.context as unknown as Record<string, unknown>)
          .selfContained = true;
      },
      "trace.previousInventory.candidates[0].context.selfContained is not an allowed property",
    ],
    [
      "candidate locator",
      (trace) => {
        (trace.previousInventory.candidates[0]!.locator as unknown as Record<string, unknown>)
          .page = 3;
      },
      "trace.previousInventory.candidates[0].locator.page is not an allowed property",
    ],
    [
      "comparison",
      (trace) => {
        (trace.comparison as unknown as Record<string, unknown>).decision = "PASS";
      },
      "trace.comparison.decision is not an allowed property",
    ],
    [
      "plan item",
      (trace) => {
        (trace.comparison.plan[0] as unknown as Record<string, unknown>).attestationId = "A-1";
      },
      "trace.comparison.plan[0].attestationId is not an allowed property",
    ],
  ];

  for (const [label, mutate, expected] of injections) {
    const path = await writePlan();
    const trace = await loadRawPlan(path);
    mutate(trace);
    // Rebound so only the closed-shape rule can reject it.
    await overwriteRawPlan(path, rebindEveryHash(trace));
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
        && error.issues.includes(expected),
      label,
    );
  }
});

test("malformed nested candidate fields are rejected even with every hash rebound", async () => {
  const mutations: Array<[string, (trace: RevisionPlanTrace) => void, RegExp]> = [
    [
      "missing normalizedText",
      (trace) => {
        delete (trace.previousInventory.candidates[0] as unknown as Record<string, unknown>)
          .normalizedText;
      },
      /candidates\[0\]\.normalizedText must be a string/,
    ],
    [
      "comparisonTokens holding a non-string",
      (trace) => {
        (trace.previousInventory.candidates[0]!.comparisonTokens as unknown[])[0] = 42;
      },
      /candidates\[0\]\.comparisonTokens must contain only strings/,
    ],
    [
      "invalid semanticRole",
      (trace) => {
        (trace.previousInventory.candidates[0] as unknown as Record<string, unknown>).semanticRole =
          "verdict";
      },
      /candidates\[0\]\.semanticRole is invalid/,
    ],
    [
      "invalid uncertainty level",
      (trace) => {
        trace.previousInventory.candidates[0]!.uncertainty.level =
          "NONE" as unknown as "LOW";
      },
      /candidates\[0\]\.uncertainty\.level is invalid/,
    ],
    [
      "uncertainty reasons holding a non-string",
      (trace) => {
        (trace.previousInventory.candidates[0]!.uncertainty.reasons as unknown[])[0] = { a: 1 };
      },
      /candidates\[0\]\.uncertainty\.reasons must contain only strings/,
    ],
    [
      "invalid material signal kind",
      (trace) => {
        const candidate = trace.currentInventory.candidates
          .find((entry) => entry.materialSignals.length > 0);
        assert.ok(candidate, "fixture must contain a material signal");
        candidate.materialSignals[0]!.kind = "verdict" as never;
      },
      /materialSignals\[0\]\.kind is invalid/,
    ],
    [
      "headingLevels holding a string",
      (trace) => {
        (trace.previousInventory.candidates[0]!.context.headingLevels as unknown[])[0] = "1";
      },
      /context\.headingLevels must contain only integers/,
    ],
    [
      "non-hash priorContextHash",
      (trace) => {
        trace.previousInventory.candidates[0]!.context.priorContextHash = "unbound";
      },
      /context\.priorContextHash must be lowercase SHA-256/,
    ],
    [
      "negative locator offset",
      (trace) => {
        trace.previousInventory.candidates[0]!.locator.startOffset = -1;
      },
      /locator\.startOffset must be a non-negative safe integer/,
    ],
    [
      "locator that runs backwards",
      (trace) => {
        const locator = trace.previousInventory.candidates[0]!.locator;
        locator.lineEnd = locator.lineStart - 1;
      },
      /locator\.lineEnd must not precede/,
    ],
    [
      "coverage method renamed to something authoritative",
      (trace) => {
        (trace.previousInventory.coverage as unknown as Record<string, unknown>).method =
          "manual_inventory";
      },
      /coverage\.method must be deterministic_candidate_extraction/,
    ],
    [
      "comparison reasons holding a non-string",
      (trace) => {
        (trace.comparison.reasons as unknown[])[0] = 7;
      },
      /trace\.comparison\.reasons must contain only strings/,
    ],
    [
      "prior attestation reasons holding a non-string",
      (trace) => {
        (trace.priorAttestationMapping.reasons as unknown[])[0] = null;
      },
      /trace\.priorAttestationMapping reasons must be an array of strings/,
    ],
  ];

  for (const [label, mutate, expected] of mutations) {
    const path = await writePlan();
    const trace = await loadRawPlan(path);
    mutate(trace);
    await overwriteRawPlan(path, rebindEveryHash(trace));
    await assert.rejects(
      replayRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
        && error.issues.some((issue) => expected.test(issue))
        && !(error instanceof TypeError),
      `${label}: expected ${expected}`,
    );
  }
});

test("a plan item cannot claim a pairing it does not carry", async () => {
  const cases: Array<[string, (trace: RevisionPlanTrace) => void, RegExp]> = [
    [
      "REUSE with no counterpart",
      (trace) => {
        const item = trace.comparison.plan.find((entry) => entry.action === "REUSE");
        assert.ok(item);
        delete item.after;
      },
      /action REUSE requires both/,
    ],
    [
      "ADDED that invents a predecessor",
      (trace) => {
        const added = trace.comparison.plan.find((entry) => entry.action === "ADDED");
        const reuse = trace.comparison.plan.find((entry) => entry.action === "REUSE");
        assert.ok(added && reuse?.before);
        added.before = reuse.before;
      },
      /action ADDED requires .*after and no .*before/,
    ],
    [
      "REMOVED that invents a successor",
      (trace) => {
        const removed = trace.comparison.plan.find((entry) => entry.action === "REMOVED");
        const reuse = trace.comparison.plan.find((entry) => entry.action === "REUSE");
        assert.ok(removed && reuse?.after);
        removed.after = reuse.after;
      },
      /action REMOVED requires .*before and no .*after/,
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const path = await writePlan();
    const trace = await loadRawPlan(path);
    mutate(trace);
    await overwriteRawPlan(path, rebindEveryHash(trace));
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issues.some((issue) => expected.test(issue)),
      label,
    );
  }
});

test("swapped subject roles are rejected", async () => {
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  const previous = trace.previousSubject;
  trace.previousSubject = trace.currentSubject;
  trace.currentSubject = previous;
  await overwriteRawPlan(path, trace);

  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.includes("trace.previousSubject.role must be previous")
      && error.issues.includes("trace.currentSubject.role must be current"),
  );

  // Relabelling the roles to match their new position does not launder the
  // swap either: the inventories and plan still bind the original sides.
  const relabelled = await loadRawPlan(await writePlan());
  const before = relabelled.previousSubject;
  relabelled.previousSubject = { ...relabelled.currentSubject, role: "previous" };
  relabelled.currentSubject = { ...before, role: "current" };
  const swappedPath = join(await mkdtemp(join(tmpdir(), "ebr-swap-")), "swapped.json");
  await overwriteRawPlan(swappedPath, relabelled);
  await assert.rejects(
    readRevisionPlanTrace(swappedPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_INVENTORY_SUBJECT_MISMATCH"),
  );
});

test("createdAt must be a real date-time and traceId must be a real string", async () => {
  for (const createdAt of ["", "   ", "not-a-date", "2026-13-45T99:99:99Z", 1_724_400_000]) {
    const path = await writePlan();
    const trace = await loadRawPlan(path);
    (trace as unknown as Record<string, unknown>).createdAt = createdAt;
    await overwriteRawPlan(path, trace);
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issues.includes("trace.createdAt must be a date-time"),
      `createdAt ${JSON.stringify(createdAt)} must be rejected`,
    );
  }

  const path = await writePlan();
  const trace = await loadRawPlan(path);
  (trace as unknown as Record<string, unknown>).traceId = "   ";
  await overwriteRawPlan(path, trace);
  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issues.includes("trace.traceId must be a non-empty string"),
  );
});

test("an old engine version is reported as a version change, not a phantom envelope fault", async () => {
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  trace.engineVersion = "0.0.9-archived";
  await overwriteRawPlan(path, rebindEveryHash(trace));

  const stored = await readRevisionPlanTrace(path);
  assert.equal(stored.engineVersion, "0.0.9-archived");

  const replay = await replayRevisionPlanTrace(path);
  assert.equal(replay.matches, false);
  assert.equal(replay.engineVersionMatches, false);
  assert.equal(replay.extractorVersionMatches, true);
  assert.equal(replay.storedEngineVersion, "0.0.9-archived");
  assert.notEqual(replay.currentEngineVersion, "0.0.9-archived");
  // Every component reproduced, so the only honest explanation is the version.
  assert.deepEqual(replay.componentMatches, {
    previousInventory: true,
    currentInventory: true,
    plan: true,
    priorAttestations: true,
    priorAttestationMapping: true,
  });
  const reasons = replay.reasons.join(" ");
  assert.match(reasons, /engine 0\.0\.9-archived/);
  assert.match(reasons, /only because of the recorded version change/);
  assert.doesNotMatch(reasons, /envelope itself does not bind/);
  assert.doesNotMatch(reasons, /recorded reasons or prior-attestation mapping text/);
});

test("an artifact carrying another build's constant text is named accurately", async () => {
  // The hashed core includes the artifact's own reasons text, so an artifact
  // written by a build with different wording reads fine but cannot replay.
  // Replay must say that plainly rather than blame the plan or the envelope.
  const path = await writePlan();
  const trace = await loadRawPlan(path);
  trace.reasons = [...trace.reasons, "A disclaimer from some other build."];
  await overwriteRawPlan(path, rebindEveryHash(trace));

  const replay = await replayRevisionPlanTrace(path);
  assert.equal(replay.matches, false);
  assert.equal(replay.engineVersionMatches, true);
  assert.equal(replay.extractorVersionMatches, true);
  assert.deepEqual(replay.componentMatches, {
    previousInventory: true,
    currentInventory: true,
    plan: true,
    priorAttestations: true,
    priorAttestationMapping: true,
  });
  assert.match(replay.reasons.join(" "), /recorded reasons or prior-attestation mapping text/);
});

test("awkward subject text still round-trips byte for byte", async () => {
  const loneSurrogate = String.fromCharCode(0xd800);
  const cases: Array<[string, string, string]> = [
    ["both empty", "", ""],
    ["empty to text", "", "Section 23 applies."],
    ["lone surrogate", `A ${loneSurrogate} sentence.`, `B ${loneSurrogate} sentence.`],
    ["CRLF line endings", "Line one.\r\nLine two.", "Line one.\r\nLine three."],
    ["CJK and emoji", "公司必須在30日內回覆。🙂", "公司必須在24日內回覆。🙂"],
  ];

  for (const [label, previousText, currentText] of cases) {
    const path = await writePlan(previousText, currentText);
    const trace = await readRevisionPlanTrace(path);
    assert.equal(trace.previousSubject.text, previousText, label);
    assert.equal(trace.currentSubject.text, currentText, label);
    assert.equal((await replayRevisionPlanTrace(path)).matches, true, label);
  }
});

test("an exhausted fuzzy budget is persisted and replays as UNCERTAIN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-revision-budget-"));
  const path = await writeRevisionPlanTrace(directory, {
    previousText: "Section 23 requires disclosure within 30 days.",
    currentText: "Section 24 requires disclosure within 30 days.",
    options: { maxFuzzyComparisons: 0 },
  });
  const trace = await readRevisionPlanTrace(path);

  // The stored budget is the resolved value, not the default, so a replay
  // reproduces the same fallback instead of quietly matching the pair.
  assert.equal(trace.comparisonOptions.maxFuzzyComparisons, 0);
  assert.equal(trace.comparison.fuzzyComparisonLimitReached, true);
  assert.ok(trace.comparison.plan.some((item) => item.action === "UNCERTAIN"));
  assert.equal(trace.comparison.plan.some((item) => item.action === "REUSE"), false);
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("supplying no prior attestation is NOT_ATTEMPTED, not an empty success", () => {
  const trace = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
  });
  assert.deepEqual(trace.priorAttestations, []);
  assert.equal(trace.priorAttestationMapping.status, "NOT_ATTEMPTED");
  assert.equal(trace.priorAttestationMapping.priorAttestationsHash, hashObject([]));
  assert.equal(trace.priorAttestationsHash, hashObject([]));

  // Omitting the field entirely must produce the identical artifact.
  const omitted = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
    priorAttestations: [],
  });
  assert.equal(omitted.artifactHash, trace.artifactHash);
});

test("a claim bound under a heading maps even though the fingerprint spaces differ", async () => {
  const sentence = "Section 23 requires disclosure within 30 days.";
  const previous = "# Background\n\n" + sentence;

  // The two fingerprints are different identity spaces: the attestation's own
  // isolated fingerprint only coincides with a candidate at the document root.
  const attestationFingerprint = normalizedAtomicClaimFingerprint(sentence);
  const atRoot = extractCandidateAssertions(sentence)[0];
  assert.equal(attestationFingerprint, atRoot?.fingerprint);
  const bound = boundFor(previous, "Section 23 requires");
  assert.notEqual(attestationFingerprint, bound.draftBinding.candidateFingerprint);

  const path = await writePlan(previous, previous, [bound]);
  const trace = await readRevisionPlanTrace(path);
  const [entry] = trace.priorAttestationMapping.entries;

  // The explicit binding carries the association across that difference.
  assert.equal(trace.priorAttestationMapping.status, "COMPLETE");
  assert.equal(entry?.result, "MATCHED_REUSE_ITEM");
  assert.equal(entry?.boundAttestationHash, bound.boundAttestationHash);
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("repeated identical sentences stay position-distinct in the stored trace", async () => {
  const previous = [
    "- The officer received the application.",
    "- The officer received the application.",
  ].join("\n");
  const candidates = extractCandidateAssertions(previous);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.fingerprint, candidates[1]?.fingerprint);

  const first = boundFor(previous, "The officer received", { claimId: "claim-a" }, 0);
  const second = boundFor(previous, "The officer received", { claimId: "claim-b" }, 1);
  const path = await writePlan(previous, previous, [first, second]);
  const trace = await readRevisionPlanTrace(path);

  const byClaimId = new Map(
    trace.priorAttestationMapping.entries.map((entry) => [entry.claimId, entry]),
  );
  const entryA = byClaimId.get("claim-a");
  const entryB = byClaimId.get("claim-b");
  assert.ok(entryA && entryB);
  // One shared fingerprint, two positions, two plan items. Nothing collapses.
  assert.notEqual(entryA.previousCandidateIndex, entryB.previousCandidateIndex);
  assert.notEqual(entryA.planIndex, entryB.planIndex);
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("a trivial Me/I rewording maps MATCHED_REUSE_ITEM where the plan says REUSE", async () => {
  const bound = boundFor(PREVIOUS_DRAFT, "Me made the request");
  const path = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [bound]);
  const trace = await readRevisionPlanTrace(path);
  const [entry] = trace.priorAttestationMapping.entries;

  assert.equal(entry?.result, "MATCHED_REUSE_ITEM");
  assert.equal(entry?.planAction, "REUSE");
  const item = trace.comparison.plan[entry!.planIndex!];
  assert.equal(item?.action, "REUSE");
  assert.equal(item?.before?.text, "Me made the request.");
  assert.equal(item?.after?.text, "I made the request.");

  // Association only. The artifact must not read as a reuse licence.
  assert.match(
    trace.reasons.join(" "),
    /not reuse authorization|does not authorize reuse/i,
  );
  assert.match(trace.priorAttestationMapping.reasons.join(" "), /does not authorize reuse/i);
  assert.equal((await replayRevisionPlanTrace(path)).matches, true);
});

test("a changed section and a changed context both map REVALIDATION_REQUIRED", async () => {
  const sectionPrevious = "The applicant relied on section 23 of the Act.";
  const sectionPath = await writePlan(
    sectionPrevious,
    "The applicant relied on section 24 of the Act.",
    [boundFor(sectionPrevious, "section 23")],
  );
  const sectionTrace = await readRevisionPlanTrace(sectionPath);
  assert.equal(sectionTrace.priorAttestationMapping.entries[0]?.result, "REVALIDATION_REQUIRED");
  assert.equal(sectionTrace.priorAttestationMapping.entries[0]?.planAction, "REVERIFY");
  assert.equal((await replayRevisionPlanTrace(sectionPath)).matches, true);

  // Same sentence, different section of the document. The wording did not
  // change; the position it holds did, so the old check cannot stand.
  const contextPrevious = "# Background\n\nThe employer replied within 30 days.";
  const contextCurrent = "# Remedy\n\nThe employer replied within 30 days.";
  const contextPath = await writePlan(
    contextPrevious,
    contextCurrent,
    [boundFor(contextPrevious, "The employer replied")],
  );
  const contextTrace = await readRevisionPlanTrace(contextPath);
  const [contextEntry] = contextTrace.priorAttestationMapping.entries;
  assert.equal(contextEntry?.result, "REVALIDATION_REQUIRED");
  assert.notEqual(contextEntry?.planAction, "REUSE");
  assert.equal((await replayRevisionPlanTrace(contextPath)).matches, true);
});

test("attestation input order does not change the trace or any of its hashes", () => {
  const first = boundFor(PREVIOUS_DRAFT, "Me made the request", { claimId: "claim-a" });
  const second = boundFor(PREVIOUS_DRAFT, "Section 23 requires", { claimId: "claim-b" });

  const forward = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
    priorAttestations: [first, second],
  });
  const reversed = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
    priorAttestations: [second, first],
  });

  assert.equal(forward.priorAttestationsHash, reversed.priorAttestationsHash);
  assert.equal(
    forward.priorAttestationMapping.mappingHash,
    reversed.priorAttestationMapping.mappingHash,
  );
  assert.equal(forward.artifactHash, reversed.artifactHash);
  assert.deepEqual(forward.priorAttestations, reversed.priorAttestations);
  // Stored ascending by boundAttestationHash, whatever the caller passed.
  assert.deepEqual(
    forward.priorAttestations.map((bound) => bound.boundAttestationHash),
    [first.boundAttestationHash, second.boundAttestationHash].sort(),
  );

  // A different attestation set must not reproduce the same artifact.
  const single = buildRevisionPlanTrace({
    previousText: PREVIOUS_DRAFT,
    currentText: CURRENT_DRAFT,
    priorAttestations: [first],
  });
  assert.notEqual(single.artifactHash, forward.artifactHash);
});

test("a duplicate bound attestation is rejected at build time", () => {
  const bound = boundFor(PREVIOUS_DRAFT, "Me made the request");
  assert.throws(
    () => buildRevisionPlanTrace({
      previousText: PREVIOUS_DRAFT,
      currentText: CURRENT_DRAFT,
      priorAttestations: [bound, bound],
    }),
    (error: unknown) => error instanceof PriorMappingError
      && error.codes.includes("DUPLICATE_BOUND_ATTESTATION_HASH")
      && !(error instanceof TypeError),
  );
});

test("an artifact in the old 0.2.0 shape is never read as this version", async () => {
  const bound = boundFor(PREVIOUS_DRAFT, "Me made the request");
  const path = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [bound]);

  // Only the version string moved back. The bytes are otherwise current.
  const relabelled = await loadRawPlan(path);
  (relabelled as unknown as Record<string, unknown>).schemaVersion = "0.2.0";
  await overwriteRawPlan(path, rebindEveryHash(relabelled));
  await assert.rejects(
    readRevisionPlanTrace(path),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.includes("trace.schemaVersion must be 0.2.1"),
  );

  // And a genuine 0.2.0 artifact: no wrappers, no hash, the reserved mapping.
  const legacyPath = join(await mkdtemp(join(tmpdir(), "ebr-legacy-")), "legacy.json");
  const legacy = await loadRawPlan(await writePlan()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = "0.2.0";
  delete legacy.priorAttestations;
  delete legacy.priorAttestationsHash;
  legacy.priorAttestationMapping = { status: "NOT_ATTEMPTED", reasons: ["reserved"] };
  await overwriteRawPlan(legacyPath, legacy);
  await assert.rejects(
    readRevisionPlanTrace(legacyPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.includes("trace.schemaVersion must be 0.2.1")
      && error.issues.includes("trace.priorAttestations must be an array")
      && !(error instanceof TypeError),
  );
});

test("tampering with a stored attestation wrapper fails closed", async () => {
  const bound = boundFor(PREVIOUS_DRAFT, "Me made the request");

  // 1. Edit the attestation content and leave every hash alone.
  const contentPath = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [bound]);
  const contentTrace = await loadRawPlan(contentPath);
  contentTrace.priorAttestations[0]!.attestation.verdict = "CONTRADICTED";
  await overwriteRawPlan(contentPath, contentTrace);
  await assert.rejects(
    readRevisionPlanTrace(contentPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
      && error.issues.some((issue) =>
        /priorAttestations\[0\] attestationHash does not match/.test(issue)
      ),
  );

  // 2. Edit the content and reseal the wrapper's own hashes. The wrapper is
  //    now self-consistent, so the artifact-level hash has to catch it.
  const resealedPath = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [bound]);
  const resealed = await loadRawPlan(resealedPath);
  const wrapper = resealed.priorAttestations[0]!;
  wrapper.attestation.verdict = "CONTRADICTED";
  wrapper.attestationHash = hashObject(wrapper.attestation);
  wrapper.boundAttestationHash = hashObject({
    attestationHash: wrapper.attestationHash,
    bindingHash: wrapper.draftBinding.bindingHash,
  });
  await overwriteRawPlan(resealedPath, resealed);
  await assert.rejects(
    readRevisionPlanTrace(resealedPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_PRIOR_ATTESTATIONS_HASH_MISMATCH"),
  );

  // 3. Reseal the wrapper and the stored wrapper hash, leaving the mapping
  //    naming an attestation that is no longer there.
  const orphanPath = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [bound]);
  const orphan = await loadRawPlan(orphanPath);
  const orphanWrapper = orphan.priorAttestations[0]!;
  orphanWrapper.attestation.verdict = "CONTRADICTED";
  orphanWrapper.attestationHash = hashObject(orphanWrapper.attestation);
  orphanWrapper.boundAttestationHash = hashObject({
    attestationHash: orphanWrapper.attestationHash,
    bindingHash: orphanWrapper.draftBinding.bindingHash,
  });
  await overwriteRawPlan(orphanPath, rebindEveryHash(orphan));
  await assert.rejects(
    readRevisionPlanTrace(orphanPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_PRIOR_MAPPING_BINDING_MISMATCH"),
  );
});

test("wrapper hashes, stored hashes, ordering, and duplicates all fail closed", async () => {
  const first = boundFor(PREVIOUS_DRAFT, "Me made the request", { claimId: "claim-a" });
  const second = boundFor(PREVIOUS_DRAFT, "Section 23 requires", { claimId: "claim-b" });

  const cases: Array<[string, (trace: RevisionPlanTrace) => void, RegExp, boolean?]> = [
    [
      "a wrapper hash pointing at nothing",
      (trace) => {
        trace.priorAttestations[0]!.boundAttestationHash = "0".repeat(64);
      },
      /priorAttestations\[0\] boundAttestationHash does not match/,
    ],
    [
      "a binding hash resealed over a different candidate index",
      (trace) => {
        trace.priorAttestations[0]!.draftBinding.candidateIndex += 1;
      },
      /priorAttestations\[0\] draftBinding\.bindingHash does not match/,
    ],
    [
      "the stored prior-attestation hash edited on its own",
      (trace) => {
        trace.priorAttestationsHash = "0".repeat(64);
      },
      /priorAttestationsHash does not match hashObject/,
      // Applied after resealing, so this is the one field left inconsistent.
      true,
    ],
    [
      "the canonical order reversed",
      (trace) => {
        trace.priorAttestations.reverse();
      },
      /priorAttestations must be sorted ascending and unique/,
    ],
    [
      "a duplicated wrapper",
      (trace) => {
        trace.priorAttestations[1] = JSON.parse(JSON.stringify(trace.priorAttestations[0]));
      },
      /priorAttestations must be sorted ascending and unique/,
    ],
    [
      "an unknown field smuggled into a wrapper",
      (trace) => {
        (trace.priorAttestations[0] as unknown as Record<string, unknown>).reuseApproved = true;
      },
      /priorAttestations\[0\] root has unknown property: reuseApproved/,
    ],
    [
      "an unknown field smuggled into an embedded attestation",
      (trace) => {
        (trace.priorAttestations[0]!.attestation as unknown as Record<string, unknown>)
          .stillValid = true;
      },
      /priorAttestations\[0\] attestation has unknown property: stillValid/,
    ],
  ];

  for (const [label, mutate, expected, mutateAfterResealing] of cases) {
    const path = await writePlan(PREVIOUS_DRAFT, CURRENT_DRAFT, [first, second]);
    const trace = await loadRawPlan(path);
    // Everything the tamperer can legitimately recompute is recomputed, so
    // only the rule under test can reject the artifact.
    if (mutateAfterResealing) {
      rebindEveryHash(trace);
      mutate(trace);
    } else {
      mutate(trace);
      rebindEveryHash(trace);
    }
    await overwriteRawPlan(path, trace);
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issues.some((issue) => expected.test(issue))
        && !(error instanceof TypeError),
      `${label}: expected ${expected}`,
    );
  }
});

test("a mapping edited to claim reuse fails read, and a resealed one fails replay", async () => {
  const previous = "The applicant relied on section 23 of the Act.";
  const current = "The applicant relied on section 24 of the Act.";
  const bound = boundFor(previous, "section 23");

  // A forged MATCHED_REUSE_ITEM contradicts its own recorded plan action, so
  // the mapping contract rejects it before any hash is compared.
  const forgedPath = await writePlan(previous, current, [bound]);
  const forged = await loadRawPlan(forgedPath);
  forged.priorAttestationMapping.entries[0]!.result = "MATCHED_REUSE_ITEM";
  await overwriteRawPlan(forgedPath, rebindMapping(forged));
  await assert.rejects(
    readRevisionPlanTrace(forgedPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issues.some((issue) =>
        /planAction must be REUSE when result is MATCHED_REUSE_ITEM/.test(issue)
      ),
  );

  // Emptying the mapping to hide an attestation that is still stored beside
  // it. NOT_ATTEMPTED is only honest when nothing was supplied.
  const emptiedPath = await writePlan(previous, current, [bound]);
  const emptied = await loadRawPlan(emptiedPath);
  emptied.priorAttestationMapping.status = "NOT_ATTEMPTED";
  emptied.priorAttestationMapping.entries = [];
  await overwriteRawPlan(emptiedPath, rebindMapping(emptied));
  await assert.rejects(
    readRevisionPlanTrace(emptiedPath),
    (error: unknown) => error instanceof RevisionTraceIntegrityError
      && error.issueCodes.includes("REVISION_PRIOR_MAPPING_BINDING_MISMATCH")
      && error.issues.some((issue) =>
        /exactly one entry per stored prior attestation/.test(issue)
      ),
  );

  // A self-consistent edit that the reader cannot refute: the recorded plan
  // index is simply wrong. Only recomputing the mapping exposes it.
  const shiftedPath = await writePlan(previous, current, [bound]);
  const shifted = await loadRawPlan(shiftedPath);
  const entry = shifted.priorAttestationMapping.entries[0]!;
  assert.equal(entry.planIndex, 0);
  entry.planIndex = 7;
  await overwriteRawPlan(shiftedPath, rebindMapping(shifted));

  await readRevisionPlanTrace(shiftedPath);
  const replay = await replayRevisionPlanTrace(shiftedPath);
  assert.equal(replay.matches, false);
  // The wrapper set is intact; the mapping is what moved.
  assert.equal(replay.componentMatches.priorAttestations, true);
  assert.equal(replay.componentMatches.priorAttestationMapping, false);
  assert.equal(replay.componentMatches.previousInventory, true);
  assert.equal(replay.componentMatches.plan, true);
  assert.equal(replay.priorAttestationMapping.entries[0]?.planIndex, 0);
  assert.match(replay.reasons.join(" "), /divergence is in the recorded prior-attestation mapping/);
});

test("attestations transplanted from another plan are caught by replay", async () => {
  const previous = "The applicant relied on section 23 of the Act.";
  const bound = boundFor(previous, "section 23");
  const sourcePath = await writePlan(previous, previous, [bound]);
  const source = await loadRawPlan(sourcePath);
  assert.equal(source.priorAttestationMapping.entries[0]?.result, "MATCHED_REUSE_ITEM");

  // Move an attestation set, and the mapping that flatters it, onto a plan for
  // a different draft. The pair is internally consistent: the mapping names
  // exactly these wrappers and reseals cleanly, so the reader cannot refute it.
  const strayPath = await writePlan(
    "A completely different previous sentence about nothing.",
    "A completely different current sentence about nothing.",
  );
  const stray = await loadRawPlan(strayPath);
  stray.priorAttestations = source.priorAttestations;
  stray.priorAttestationMapping = source.priorAttestationMapping;
  await overwriteRawPlan(strayPath, rebindEveryHash(stray));
  await readRevisionPlanTrace(strayPath);

  // Recomputation is what tells the truth: the binding belongs to an inventory
  // this plan never had, so the honest result is NOT_IN_PLAN, not a match.
  const replay = await replayRevisionPlanTrace(strayPath);
  assert.equal(replay.matches, false);
  assert.equal(replay.componentMatches.priorAttestations, true);
  assert.equal(replay.componentMatches.priorAttestationMapping, false);
  assert.equal(replay.componentMatches.previousInventory, true);
  assert.equal(replay.componentMatches.plan, true);
  assert.equal(replay.priorAttestationMapping.status, "INCOMPLETE");
  assert.equal(replay.priorAttestationMapping.entries[0]?.result, "NOT_IN_PLAN");
  assert.match(replay.reasons.join(" "), /divergence is in the recorded prior-attestation mapping/);

  // The untouched original still replays.
  const original = await replayRevisionPlanTrace(sourcePath);
  assert.equal(original.matches, true);
  assert.equal(original.priorAttestationMapping.status, "COMPLETE");
});
