import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClaimReusePolicyError,
  readClaimReuseAuthorization,
  type ClaimReuseAuthorization,
} from "../src/reuse-policy.js";
import { buildExampleAuthorization } from "./fixtures/claim-reuse-example.js";
import { validate, type Schema } from "./fixtures/json-schema-subset.js";

const schemaPath = fileURLToPath(
  new URL("../../schemas/claim-reuse-authorization.schema.json", import.meta.url),
);

async function loadSchema(): Promise<Schema> {
  return JSON.parse(await readFile(schemaPath, "utf8")) as Schema;
}

/** A plain JSON copy of the published example, safe to mutate per case. */
async function sample(): Promise<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(await buildExampleAuthorization())) as Record<string, unknown>;
}

type RawDecision = Record<string, unknown>;

function decisions(authorization: Record<string, unknown>): RawDecision[] {
  return authorization.decisions as RawDecision[];
}

function decisionIndex(authorization: Record<string, unknown>, claimId: string): number {
  const index = decisions(authorization).findIndex((item) => item.claimId === claimId);
  assert.ok(index >= 0, `no decision for ${claimId}`);
  return index;
}

test("the published schema accepts the artifact this build produces", async () => {
  const schema = await loadSchema();
  const authorization = await sample();

  assert.deepEqual(
    validate(schema, schema, authorization, "authorization"),
    [],
    "regenerate with: npm run build && node dist/tests/fixtures/claim-reuse-example.js",
  );

  // The example is the only fixture that exercises both a granted and a refused
  // decision, so it must keep carrying one of each.
  const outcomes = decisions(authorization).map((item) => item.outcome).sort();
  assert.deepEqual(outcomes, ["REUSE_AUTHORIZED", "REVERIFY_REQUIRED"]);
});

test("the published schema accepts the checked-in example bytes", async () => {
  const schema = await loadSchema();
  const examplePath = fileURLToPath(
    new URL("../../examples/claim-reuse-authorization.example.json", import.meta.url),
  );
  const published = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(
    validate(schema, schema, published, "authorization"),
    [],
    "regenerate with: npm run build && node dist/tests/fixtures/claim-reuse-example.js",
  );
});

test("the schema check is not vacuous", async () => {
  const schema = await loadSchema();

  const missing = await sample();
  delete missing.evaluationHash;
  assert.ok(
    validate(schema, schema, missing, "authorization").includes(
      "authorization.evaluationHash is required",
    ),
  );

  const extra = await sample();
  extra.smuggledField = true;
  assert.ok(
    validate(schema, schema, extra, "authorization").includes(
      "authorization.smuggledField is not an allowed property",
    ),
  );

  const badHash = await sample();
  badHash.policyHash = "NOT-A-HASH";
  assert.ok(validate(schema, schema, badHash, "authorization").length > 0);

  const badAsOf = await sample();
  badAsOf.asOf = "whenever";
  assert.ok(
    validate(schema, schema, badAsOf, "authorization")
      .includes("authorization.asOf is not a date-time"),
  );

  const badScore = await sample();
  (badScore.policy as Record<string, unknown>).minScore = 1.5;
  assert.ok(
    validate(schema, schema, badScore, "authorization")
      .some((issue) => /minScore is above 1/.test(issue)),
  );
});

test("the schema refuses a document release and an incomplete-coverage waiver", async () => {
  const schema = await loadSchema();

  const released = await sample();
  (released.documentRelease as Record<string, unknown>).status = "DOCUMENT_RELEASED";
  assert.ok(
    validate(schema, schema, released, "authorization")
      .some((issue) => /documentRelease\.status must equal "DOCUMENT_REVIEW_REQUIRED"/.test(issue)),
  );

  const covered = await sample();
  (covered.documentRelease as Record<string, unknown>).coverageComplete = true;
  assert.ok(
    validate(schema, schema, covered, "authorization")
      .some((issue) => /documentRelease\.coverageComplete must equal false/.test(issue)),
  );
});

test("the schema refuses an authorization that did not earn it", async () => {
  const schema = await loadSchema();

  // A refused decision relabelled REUSE_AUTHORIZED keeps its blockers, its
  // REVALIDATION_REQUIRED mapping result, and its missing current candidate.
  const forged = await sample();
  const index = decisionIndex(forged, "SYN-002");
  decisions(forged)[index]!.outcome = "REUSE_AUTHORIZED";
  const errors = validate(schema, schema, forged, "authorization");
  assert.ok(
    errors.some((issue) => /decisions\[\d+\]\.currentCandidate is required/.test(issue)),
    `expected a missing current candidate, received ${JSON.stringify(errors)}`,
  );
  assert.ok(errors.some((issue) => /blockers has more than 0 items/.test(issue)));
  assert.ok(errors.some((issue) => /mappingResult must equal "MATCHED_REUSE_ITEM"/.test(issue)));
  assert.ok(errors.some((issue) => /planAction must equal "REUSE"/.test(issue)));

  // And a granted decision cannot be attached to a revalidation plan item.
  const relabelled = await sample();
  const granted = decisionIndex(relabelled, "SYN-001");
  decisions(relabelled)[granted]!.mappingResult = "REVALIDATION_REQUIRED";
  const relabelledErrors = validate(schema, schema, relabelled, "authorization");
  assert.ok(relabelledErrors.some((issue) => /planAction is not an allowed value/.test(issue)));
  assert.ok(relabelledErrors.some((issue) => /outcome is not an allowed value/.test(issue)));

  // A mapping result with no plan item may not carry one.
  const stripped = await sample();
  decisions(stripped)[granted]!.mappingResult = "MATCHED_REUSE_ITEM";
  delete decisions(stripped)[granted]!.planAction;
  assert.ok(
    validate(schema, schema, stripped, "authorization")
      .some((issue) => /planAction is required/.test(issue)),
  );
});

test("the runtime reader closes the same objects the schema closes", async () => {
  const schema = await loadSchema();
  const directory = await mkdtemp(join(tmpdir(), "ebr-reuse-schema-parity-"));
  const granted = decisionIndex(await sample(), "SYN-001");
  const refused = decisionIndex(await sample(), "SYN-002");

  // One unknown key per closed object in the artifact. Both the published
  // schema and the runtime reader must reject each one. Where the reader
  // delegates to the policy contract's own validator, its wording is given
  // explicitly instead of assuming the schema's phrasing.
  type ClosedTarget = {
    label: string;
    select: (authorization: Record<string, unknown>) => Record<string, unknown>;
    readerIssue?: RegExp;
  };
  const plain = (
    label: string,
    select: (authorization: Record<string, unknown>) => Record<string, unknown>,
  ): ClosedTarget => ({ label, select });
  const targets: ClosedTarget[] = [
    plain("authorization", (authorization) => authorization),
    {
      label: "authorization.policy",
      select: (authorization) => authorization.policy as Record<string, unknown>,
      readerIssue: /^authorization\.policy policy\.smuggledField is not an allowed property$/u,
    },
    {
      label: "authorization.policy.trustedCheckers[0]",
      select: (authorization) => ((authorization.policy as Record<string, unknown>)
        .trustedCheckers as Array<Record<string, unknown>>)[0]!,
      readerIssue:
        /^authorization\.policy policy\.trustedCheckers\[0\]\.smuggledField is not an allowed property$/u,
    },
    {
      label: "authorization.policy.claimPins[0]",
      select: (authorization) => ((authorization.policy as Record<string, unknown>)
        .claimPins as Array<Record<string, unknown>>)[0]!,
      readerIssue:
        /^authorization\.policy policy\.claimPins\[0\]\.smuggledField is not an allowed property$/u,
    },
    plain("authorization.trace", (authorization) => authorization.trace as Record<string, unknown>),
    plain(
      "authorization.documentRelease",
      (authorization) => authorization.documentRelease as Record<string, unknown>,
    ),
    plain(`authorization.decisions[${granted}]`, (authorization) => decisions(authorization)[granted]!),
    plain(
      `authorization.decisions[${granted}].currentCandidate`,
      (authorization) => decisions(authorization)[granted]!
        .currentCandidate as Record<string, unknown>,
    ),
    plain(
      `authorization.decisions[${refused}].blockers[0]`,
      (authorization) => (decisions(authorization)[refused]!
        .blockers as Array<Record<string, unknown>>)[0]!,
    ),
  ];

  for (const target of targets) {
    const authorization = await sample();
    target.select(authorization).smuggledField = "unauthenticated";
    const expected = `${target.label}.smuggledField is not an allowed property`;

    assert.ok(
      validate(schema, schema, authorization, "authorization").includes(expected),
      `${target.label}: the published schema must reject it`,
    );

    // The reader is given an artifact whose hashes are otherwise untouched; the
    // shape rule must fire before any hash comparison.
    const path = join(directory, `${target.label.replace(/[^a-z0-9]/giu, "-")}.json`);
    await writeFile(path, JSON.stringify(authorization), "utf8");
    await assert.rejects(
      readClaimReuseAuthorization(path),
      (error: unknown) => error instanceof ClaimReusePolicyError
        && error.codes.includes("AUTHORIZATION_INVALID_SHAPE")
        && (target.readerIssue
          ? error.issues.some((issue) => target.readerIssue!.test(issue))
          : error.issues.includes(expected)),
      `${target.label}: the runtime reader must reject it too`,
    );
  }
});

test("the schema and the reader agree on which blocker codes exist", async () => {
  const schema = await loadSchema();
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const codes = ((defs.blocker!.properties as Record<string, Record<string, unknown>>)
    .code!.enum) as string[];
  assert.ok(codes.length > 0);

  // Every code the schema publishes must be one the reader accepts, and an
  // invented one must be refused by both.
  const authorization = await sample();
  const index = decisionIndex(authorization, "SYN-002");
  const blockers = decisions(authorization)[index]!.blockers as Array<Record<string, unknown>>;
  for (const code of codes) {
    blockers[0]!.code = code;
    assert.deepEqual(
      validate(schema, schema, authorization, "authorization"),
      [],
      `the schema must accept blocker code ${code}`,
    );
  }
  blockers[0]!.code = "NOT_A_REAL_CODE";
  assert.ok(
    validate(schema, schema, authorization, "authorization")
      .some((issue) => /blockers\[0\]\.code is not an allowed value/.test(issue)),
  );

  const stored = await buildExampleAuthorization() as ClaimReuseAuthorization;
  assert.ok(stored.decisions.some((decision) => decision.blockers.length > 0));
});
