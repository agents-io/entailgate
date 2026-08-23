import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRevisionPlanTrace,
  readRevisionPlanTrace,
  RevisionTraceIntegrityError,
} from "../src/revision-trace.js";
import { validate, type Schema } from "./fixtures/json-schema-subset.js";
import { buildExampleTrace } from "./fixtures/revision-plan-example.js";

const schemaPath = fileURLToPath(
  new URL("../../schemas/revision-plan-trace.schema.json", import.meta.url),
);

async function loadSchema(): Promise<Schema> {
  return JSON.parse(await readFile(schemaPath, "utf8")) as Schema;
}

function sampleTrace(): unknown {
  // Headings, a quotation, a code fence, a reused sentence, a changed section,
  // a removed sentence, and an added sentence, so the sample exercises every
  // plan action and candidate shape the schema declares.
  const previous = [
    "# Notice",
    "",
    "Section 23 requires disclosure within 30 days.",
    "The employer wrote: \"The record was sent.\"",
    "",
    "    npm run verify",
    "",
    "This paragraph will be deleted.",
  ].join("\n");
  const current = [
    "# Notice",
    "",
    "Section 24 requires disclosure within 30 days.",
    "The employer wrote: \"The record was sent.\"",
    "",
    "    npm run verify",
    "",
    "A newly drafted closing paragraph.",
  ].join("\n");
  return JSON.parse(JSON.stringify(
    buildRevisionPlanTrace({ previousText: previous, currentText: current }),
  ));
}

/** The published example, which additionally carries bound prior attestations. */
function sampleTraceWithPriorAttestations(): unknown {
  return JSON.parse(JSON.stringify(buildExampleTrace()));
}

test("the published schema accepts a real revision-plan trace", async () => {
  const schema = await loadSchema();
  const trace = sampleTrace() as Record<string, unknown>;
  assert.deepEqual(validate(schema, schema, trace, "trace"), []);

  const comparison = trace.comparison as { plan: Array<{ action: string }> };
  const actions = new Set(comparison.plan.map((item) => item.action));
  assert.ok(actions.has("REUSE"), "sample must contain a reused candidate");
  assert.ok(actions.has("REVERIFY"), "sample must contain a changed candidate");
  assert.ok(
    actions.has("ADDED") || actions.has("REMOVED"),
    "sample must contain an added or removed candidate",
  );
});

test("the published schema accepts the checked-in public example", async () => {
  const schema = await loadSchema();
  const examplePath = fileURLToPath(
    new URL("../../examples/revision-plan-trace.example.json", import.meta.url),
  );
  const example = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(
    validate(schema, schema, example, "trace"),
    [],
    "regenerate with: npm run build && node dist/tests/fixtures/revision-plan-example.js",
  );

  // The example is the only fixture that exercises the embedded attestation,
  // draft-binding, and mapping definitions, so it must keep carrying them.
  const attestations = example.priorAttestations as unknown[];
  assert.equal(attestations.length, 2);
  const mapping = example.priorAttestationMapping as { entries: unknown[] };
  assert.equal(mapping.entries.length, 2);
});

test("the schema models the embedded attestation and mapping structures", async () => {
  const schema = await loadSchema();

  // A bound attestation whose score leaves [0, 1].
  const badScore = sampleTraceWithPriorAttestations() as {
    priorAttestations: Array<{ attestation: { score: number } }>;
  };
  badScore.priorAttestations[0]!.attestation.score = 1.5;
  assert.ok(
    validate(schema, schema, badScore, "trace")
      .some((issue) => /score is above 1/.test(issue)),
  );

  // A subject-scoped attestation can never be bound to a draft position.
  const badScope = sampleTraceWithPriorAttestations() as {
    priorAttestations: Array<{ attestation: { bindingScope: string } }>;
  };
  badScope.priorAttestations[0]!.attestation.bindingScope = "subject";
  assert.ok(validate(schema, schema, badScope, "trace").length > 0);

  // A mapping entry that claims a reuse match without a plan action.
  const missingAction = sampleTraceWithPriorAttestations() as {
    priorAttestationMapping: { entries: Array<Record<string, unknown>> };
  };
  const entry = missingAction.priorAttestationMapping.entries
    .find((item) => item.result === "MATCHED_REUSE_ITEM");
  assert.ok(entry);
  delete entry.planAction;
  assert.ok(
    validate(schema, schema, missingAction, "trace")
      .some((issue) => /planAction is required/.test(issue)),
  );

  // A mapping entry that relabels a REVERIFY item as a reuse match.
  const forgedReuse = sampleTraceWithPriorAttestations() as {
    priorAttestationMapping: { entries: Array<Record<string, unknown>> };
  };
  const revalidate = forgedReuse.priorAttestationMapping.entries
    .find((item) => item.result === "REVALIDATION_REQUIRED");
  assert.ok(revalidate);
  revalidate.result = "MATCHED_REUSE_ITEM";
  assert.ok(
    validate(schema, schema, forgedReuse, "trace")
      .some((issue) => /planAction must equal "REUSE"/.test(issue)),
  );

  // And a missing prior-attestation binding hash at the top level.
  const missingHash = sampleTraceWithPriorAttestations() as Record<string, unknown>;
  delete missingHash.priorAttestationsHash;
  assert.ok(
    validate(schema, schema, missingHash, "trace")
      .includes("trace.priorAttestationsHash is required"),
  );
});

test("the schema check is not vacuous", async () => {
  const schema = await loadSchema();

  const missing = sampleTrace() as Record<string, unknown>;
  delete missing.planHash;
  assert.ok(validate(schema, schema, missing, "trace").includes("trace.planHash is required"));

  const extra = sampleTrace() as Record<string, unknown>;
  extra.unexpectedField = true;
  assert.ok(
    validate(schema, schema, extra, "trace")
      .includes("trace.unexpectedField is not an allowed property"),
  );

  const badHash = sampleTrace() as Record<string, unknown>;
  badHash.artifactHash = "NOT-A-HASH";
  assert.ok(validate(schema, schema, badHash, "trace").length > 0);

  // The conditional that stops a stored REUSE from waiving revalidation.
  const forged = sampleTrace() as {
    comparison: { plan: Array<{ action: string; requiresRevalidation: boolean }> };
  };
  const reverify = forged.comparison.plan.find((item) => item.action === "REVERIFY");
  assert.ok(reverify);
  reverify.action = "REUSE";
  const errors = validate(schema, schema, forged, "trace");
  assert.ok(
    errors.some((issue) => /requiresRevalidation must equal false/.test(issue)),
    `expected a REUSE conditional failure, received ${JSON.stringify(errors)}`,
  );
});

test("the schema pins each subject to its own role", async () => {
  const schema = await loadSchema();

  const swapped = sampleTrace() as {
    previousSubject: { role: string };
    currentSubject: { role: string };
  };
  swapped.previousSubject.role = "current";
  swapped.currentSubject.role = "previous";
  const errors = validate(schema, schema, swapped, "trace");
  assert.ok(
    errors.includes("trace.previousSubject.role must equal \"previous\""),
    `expected a previous-role failure, received ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.includes("trace.currentSubject.role must equal \"current\""),
    `expected a current-role failure, received ${JSON.stringify(errors)}`,
  );

  // Both sides set to the same legal enum value must still fail, otherwise the
  // shared definition is being used and the role is unpinned.
  const bothPrevious = sampleTrace() as { currentSubject: { role: string } };
  bothPrevious.currentSubject.role = "previous";
  assert.ok(validate(schema, schema, bothPrevious, "trace").length > 0);

  // And a role outside the enum fails at the shared definition.
  const nonsense = sampleTrace() as { currentSubject: { role: string } };
  nonsense.currentSubject.role = "draft";
  assert.ok(validate(schema, schema, nonsense, "trace").length > 0);
});

test("the runtime reader closes the same objects the schema closes", async () => {
  const schema = await loadSchema();
  const directory = await mkdtemp(join(tmpdir(), "ebr-schema-parity-"));

  // One unknown key per closed object in the artifact. Both the published
  // schema and the runtime reader must reject each one. Where the reader
  // delegates to another contract's validator, the reader's own wording is
  // given explicitly instead of assuming the schema's phrasing.
  type ClosedTarget = {
    label: string;
    select: (trace: Record<string, unknown>) => Record<string, unknown>;
    readerIssue?: RegExp;
    withPriorAttestations?: boolean;
  };
  const plain = (
    label: string,
    select: (trace: Record<string, unknown>) => Record<string, unknown>,
  ): ClosedTarget => ({ label, select });
  const targets: ClosedTarget[] = [
    plain("trace", (trace) => trace),
    plain("trace.previousSubject", (trace) => trace.previousSubject as Record<string, unknown>),
    plain("trace.currentSubject", (trace) => trace.currentSubject as Record<string, unknown>),
    plain("trace.comparisonOptions", (trace) => trace.comparisonOptions as Record<string, unknown>),
    {
      label: "trace.priorAttestationMapping",
      select: (trace) => trace.priorAttestationMapping as Record<string, unknown>,
      readerIssue: /^trace\.priorAttestationMapping root has unknown property: smuggledField$/u,
    },
    {
      label: "trace.priorAttestationMapping.entries[0]",
      select: (trace) => ((trace.priorAttestationMapping as Record<string, unknown>)
        .entries as Array<Record<string, unknown>>)[0]!,
      readerIssue: /^trace\.priorAttestationMapping entries\[0\] has unknown property: smuggledField$/u,
      withPriorAttestations: true,
    },
    {
      label: "trace.priorAttestations[0]",
      select: (trace) => (trace.priorAttestations as Array<Record<string, unknown>>)[0]!,
      readerIssue: /^trace\.priorAttestations\[0\] root has unknown property: smuggledField$/u,
      withPriorAttestations: true,
    },
    {
      label: "trace.priorAttestations[0].attestation",
      select: (trace) => (trace.priorAttestations as Array<Record<string, unknown>>)[0]!
        .attestation as Record<string, unknown>,
      readerIssue: /^trace\.priorAttestations\[0\] attestation has unknown property: smuggledField$/u,
      withPriorAttestations: true,
    },
    {
      label: "trace.priorAttestations[0].draftBinding",
      select: (trace) => (trace.priorAttestations as Array<Record<string, unknown>>)[0]!
        .draftBinding as Record<string, unknown>,
      readerIssue: /^trace\.priorAttestations\[0\] draftBinding has unknown property: smuggledField$/u,
      withPriorAttestations: true,
    },
    plain("trace.previousInventory", (trace) => trace.previousInventory as Record<string, unknown>),
    plain(
      "trace.previousInventory.coverage",
      (trace) => (trace.previousInventory as Record<string, unknown>)
        .coverage as Record<string, unknown>,
    ),
    plain(
      "trace.previousInventory.candidates[0]",
      (trace) => ((trace.previousInventory as Record<string, unknown>)
        .candidates as Array<Record<string, unknown>>)[0]!,
    ),
    plain(
      "trace.previousInventory.candidates[0].context",
      (trace) => (((trace.previousInventory as Record<string, unknown>)
        .candidates as Array<Record<string, unknown>>)[0]!
        .context) as Record<string, unknown>,
    ),
    plain(
      "trace.previousInventory.candidates[0].locator",
      (trace) => (((trace.previousInventory as Record<string, unknown>)
        .candidates as Array<Record<string, unknown>>)[0]!
        .locator) as Record<string, unknown>,
    ),
    plain(
      "trace.previousInventory.candidates[0].uncertainty",
      (trace) => (((trace.previousInventory as Record<string, unknown>)
        .candidates as Array<Record<string, unknown>>)[0]!
        .uncertainty) as Record<string, unknown>,
    ),
    plain("trace.comparison", (trace) => trace.comparison as Record<string, unknown>),
    plain(
      "trace.comparison.plan[0]",
      (trace) => ((trace.comparison as Record<string, unknown>)
        .plan as Array<Record<string, unknown>>)[0]!,
    ),
  ];

  for (const target of targets) {
    const { label, select, readerIssue } = target;
    const trace = (target.withPriorAttestations
      ? sampleTraceWithPriorAttestations()
      : sampleTrace()) as Record<string, unknown>;
    select(trace).smuggledField = "unauthenticated";
    const expected = `${label}.smuggledField is not an allowed property`;

    assert.ok(
      validate(schema, schema, trace, "trace").includes(expected),
      `${label}: the published schema must reject it`,
    );

    // The reader is given an artifact whose hashes are untouched; the shape
    // rule must fire before any hash comparison.
    const path = join(directory, `${label.replace(/[^a-z0-9]/giu, "-")}.json`);
    await writeFile(path, JSON.stringify(trace), "utf8");
    await assert.rejects(
      readRevisionPlanTrace(path),
      (error: unknown) => error instanceof RevisionTraceIntegrityError
        && error.issueCodes.includes("REVISION_TRACE_INVALID_SHAPE")
        && (readerIssue
          ? error.issues.some((issue) => readerIssue.test(issue))
          : error.issues.includes(expected)),
      `${label}: the runtime reader must reject it too`,
    );
  }
});
