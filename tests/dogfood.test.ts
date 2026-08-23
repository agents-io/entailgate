import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashObject } from "../src/canonical.js";
import {
  DogfoodWorkspaceError,
  evaluateDogfoodWorkspace,
  initDogfoodWorkspace,
  verifyDogfoodWorkspace,
  type DogfoodBlocker,
} from "../src/dogfood.js";
import { ArtifactExistsError, writePrivateJsonArtifact } from "../src/trace-io.js";
import type { AtomicClaim, VerifyRequest } from "../src/types.js";
import { verifyRequest } from "../src/verify.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const EVIDENCE_SENTENCE = "The Act says disclosure is required within 30 days.\n";
const QUOTE = "disclosure is required within 30 days";
const DRAFT_TEXT = "Section 23 requires disclosure within 30 days.\n";

interface Fixture {
  root: string;
  draftPath: string;
  evidenceDirectory: string;
  workspacePath: string;
}

/**
 * Every fixture lives under a `realpath`-resolved temporary root, because the
 * workspace contract deliberately refuses a path that resolves through a
 * symbolic link.
 */
async function makeFixture(label: string): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `ebr-dogfood-${label}-`)));
  const evidenceDirectory = join(root, "evidence");
  await mkdir(join(evidenceDirectory, "sub"), { recursive: true });
  const draftPath = join(root, "draft.md");
  await writeFile(draftPath, DRAFT_TEXT, "utf8");
  await writeFile(join(evidenceDirectory, "a-statute.txt"), EVIDENCE_SENTENCE, "utf8");
  await writeFile(join(evidenceDirectory, "sub", "b-note.txt"), "Second note.\n", "utf8");
  return { root, draftPath, evidenceDirectory, workspacePath: join(root, "ws") };
}

async function initFixture(fixture: Fixture): Promise<void> {
  await initDogfoodWorkspace({
    draftPath: fixture.draftPath,
    evidenceDirectory: fixture.evidenceDirectory,
    workspacePath: fixture.workspacePath,
  });
}

async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function codes(blockers: readonly DogfoodBlocker[]): string[] {
  return blockers.map((item) => item.code);
}

interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Does by hand exactly what a human reviewer would have to do before the
 * workspace may reach the verifier: classify the source, write one material
 * claim, declare coverage complete, and sign the checklist.
 */
async function prepareForVerification(
  workspacePath: string,
  options: { confirm?: boolean; claims?: boolean; coverage?: boolean } = {},
): Promise<void> {
  const manifestPath = join(workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath) as unknown as VerifyRequest;
  const source = manifest.evidence.sources.find((item) => item.title === "a-statute.txt");
  assert.ok(source, "fixture source must be present");
  source.authorityTier = "primary";
  source.jurisdictions = ["BC"];
  const chunk = manifest.evidence.chunks.find((item) => item.sourceId === source.sourceId);
  assert.ok(chunk, "fixture chunk must be present");
  if (options.claims !== false) {
    const claim: AtomicClaim = {
      claimId: "L-001",
      text: QUOTE,
      material: true,
      risk: "high",
      jurisdiction: "BC",
      citations: [{ sourceId: source.sourceId, chunkId: chunk.chunkId }],
      proof: { kind: "exact_quote", quote: QUOTE },
    };
    manifest.claims = [claim];
  }
  if (options.coverage !== false) manifest.coverage.complete = true;
  await writeJson(manifestPath, manifest);

  if (options.confirm === false) return;
  const reviewPath = join(workspacePath, "review.json");
  const review = await readJson(reviewPath);
  const confirmations = review.confirmations as Record<string, boolean>;
  confirmations.materialClaimCoverageReviewed = true;
  confirmations.sourceSelectionAndAuthorityReviewed = true;
  confirmations.exactQuotationAndPinpointReviewed = true;
  await writeJson(reviewPath, review);
}

/**
 * Rewrites `workspace.json` with a mutated body and a freshly computed
 * `metadataHash`, exactly as someone with write access to the workspace could.
 * The seal is not authentication, so every containment check has to hold
 * against a correctly resealed file rather than relying on the hash.
 */
async function reseal(
  workspacePath: string,
  mutate: (core: Record<string, unknown>) => void,
): Promise<void> {
  const metadataPath = join(workspacePath, "workspace.json");
  const { metadataHash: _sealed, ...core } = await readJson(metadataPath);
  mutate(core);
  await writeJson(metadataPath, { ...core, metadataHash: hashObject(core) });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableAvailable(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory === "") continue;
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Continue through PATH.
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

test("init creates an owner-only workspace and leaks no evidence text or path", async () => {
  const fixture = await makeFixture("init");
  const outcome = await runCli([
    "dogfood",
    "init",
    "--draft",
    fixture.draftPath,
    "--evidence-dir",
    fixture.evidenceDirectory,
    "--workspace",
    fixture.workspacePath,
  ]);
  assert.equal(outcome.code, 0);

  assert.equal(await mode(fixture.workspacePath), "700");
  assert.equal(await mode(join(fixture.workspacePath, "draft")), "700");
  for (const file of [
    "workspace.json",
    "evidence-inventory.json",
    "manifest.json",
    "review.json",
    join("draft", "draft.snapshot"),
  ]) {
    assert.equal(await mode(join(fixture.workspacePath, file)), "600", file);
  }

  const summary = JSON.parse(outcome.stdout) as { status: string; blockers: DogfoodBlocker[] };
  assert.equal(summary.status, "NEEDS_REVIEW");
  assert.ok(summary.blockers.length > 0);
  // Nothing that identifies or reproduces private evidence may appear here.
  assert.doesNotMatch(outcome.stdout, /The Act says disclosure/u);
  assert.doesNotMatch(outcome.stdout, /a-statute\.txt|b-note\.txt/u);
  assert.doesNotMatch(outcome.stdout, new RegExp(fixture.evidenceDirectory, "u"));
  assert.doesNotMatch(outcome.stdout, /Section 23 requires/u);
});

test("init writes a deterministic inventory in relative-path order with stable ids", async () => {
  const fixture = await makeFixture("determinism");
  await initFixture(fixture);
  const second = join(fixture.root, "ws-2");
  await initDogfoodWorkspace({
    draftPath: fixture.draftPath,
    evidenceDirectory: fixture.evidenceDirectory,
    workspacePath: second,
  });

  const first = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const repeat = await readJson(join(second, "evidence-inventory.json"));
  assert.deepEqual(first.entries, repeat.entries, "entries must be byte-for-byte reproducible");

  const entries = first.entries as Array<Record<string, string>>;
  assert.deepEqual(
    entries.map((entry) => entry.relativePath),
    ["a-statute.txt", "sub/b-note.txt"],
    "entries must be sorted by relative path, not by directory walk order",
  );
  assert.deepEqual(entries.map((entry) => entry.status), ["ready", "ready"]);
  assert.ok(entries.every((entry) => entry.sourceId?.startsWith("src-")));

  // No extracted text belongs in the index artifact.
  assert.doesNotMatch(JSON.stringify(first), /The Act says disclosure/u);
});

test("init prepopulates evidence only, leaving coverage incomplete and claims empty", async () => {
  const fixture = await makeFixture("skeleton");
  await initFixture(fixture);
  const manifest = await readJson(join(fixture.workspacePath, "manifest.json")) as unknown as VerifyRequest;

  assert.equal(manifest.domain, "bc-legal");
  assert.equal(manifest.policy.riskTier, "high");
  assert.equal(manifest.policy.requireCompleteCoverage, true);
  assert.equal(manifest.policy.requireRetrievedCitationClosure, true);
  assert.equal(manifest.coverage.complete, false);
  assert.deepEqual(manifest.claims, []);
  assert.equal(manifest.evidence.sources.length, 2);
  assert.equal(manifest.evidence.chunks.length, 2);
  assert.deepEqual(
    manifest.retrievedChunkIds,
    manifest.evidence.chunks.map((chunk) => chunk.chunkId),
  );
  // Authority is never guessed from a file name.
  assert.ok(manifest.evidence.sources.every((source) => source.authorityTier === "unknown"));
  assert.equal(manifest.subject.path, "draft/draft.snapshot");
});

test("init refuses an existing workspace path without touching what is there", async () => {
  const fixture = await makeFixture("exists");
  await mkdir(fixture.workspacePath, { recursive: true });
  const sentinel = join(fixture.workspacePath, "manifest.json");
  await writeFile(sentinel, "PRIOR CONTENT\n", "utf8");

  const outcome = await runCli([
    "dogfood",
    "init",
    "--draft",
    fixture.draftPath,
    "--evidence-dir",
    fixture.evidenceDirectory,
    "--workspace",
    fixture.workspacePath,
  ]);
  assert.equal(outcome.code, 2);
  assert.match(outcome.stderr, /WORKSPACE_ALREADY_EXISTS|already exists/u);
  assert.equal(await readFile(sentinel, "utf8"), "PRIOR CONTENT\n");
});

test("init refuses a workspace that overlaps the evidence directory or the draft", async () => {
  const fixture = await makeFixture("overlap");
  const cases: Array<[string, string]> = [
    ["workspace inside evidence", join(fixture.evidenceDirectory, "ws")],
    ["workspace is the evidence directory", fixture.evidenceDirectory],
    ["workspace containing the draft", fixture.root],
  ];
  for (const [label, workspacePath] of cases) {
    await assert.rejects(
      initDogfoodWorkspace({
        draftPath: fixture.draftPath,
        evidenceDirectory: fixture.evidenceDirectory,
        workspacePath,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DogfoodWorkspaceError, label);
        assert.ok(
          error.codes.includes("WORKSPACE_PATH_OVERLAP")
            || error.codes.includes("WORKSPACE_ALREADY_EXISTS"),
          `${label}: ${error.codes.join(",")}`,
        );
        return true;
      },
    );
  }

  // The reverse direction: evidence nested inside the workspace. The overlap
  // check runs before the workspace directory is claimed, so this is reported
  // as an overlap rather than as an existing path.
  const nested = join(fixture.root, "outer");
  await mkdir(join(nested, "evidence"), { recursive: true });
  await writeFile(join(nested, "evidence", "note.txt"), "note\n", "utf8");
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: join(nested, "evidence"),
      workspacePath: nested,
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("WORKSPACE_PATH_OVERLAP")
      && error.issues.some((issue) => issue.includes("--evidence-dir is inside the workspace")),
  );
});

test("a child whose name begins with .. is still inside its parent", async () => {
  const fixture = await makeFixture("dotdot-overlap");

  // `..ws` is an ordinary child of the evidence directory. Treating any name
  // starting with `..` as outside would let the workspace — which holds the
  // draft snapshot and extracted evidence text — be created inside the very
  // directory it is enumerating.
  const inside = join(fixture.evidenceDirectory, "..ws");
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: fixture.evidenceDirectory,
      workspacePath: inside,
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("WORKSPACE_PATH_OVERLAP")
      && error.issues.some((issue) => issue.includes("--workspace is inside the evidence directory")),
  );
  assert.equal(await exists(inside), false);

  // The same mistake in the other direction.
  const outer = join(fixture.root, "outer");
  await mkdir(join(outer, "..evidence"), { recursive: true });
  await writeFile(join(outer, "..evidence", "note.txt"), "note\n", "utf8");
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: join(outer, "..evidence"),
      workspacePath: outer,
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("WORKSPACE_PATH_OVERLAP")
      && error.issues.some((issue) => issue.includes("--evidence-dir is inside the workspace")),
  );

  // And a genuine sibling pair is still accepted: the fix must not start
  // rejecting ordinary directories whose names happen to begin with `..`.
  const siblingEvidence = join(fixture.root, "..sibling-evidence");
  await mkdir(siblingEvidence);
  await writeFile(join(siblingEvidence, "note.txt"), "note\n", "utf8");
  const siblingWorkspace = join(fixture.root, "..sibling-ws");
  const summary = await initDogfoodWorkspace({
    draftPath: fixture.draftPath,
    evidenceDirectory: siblingEvidence,
    workspacePath: siblingWorkspace,
  });
  assert.equal(summary.status, "NEEDS_REVIEW");
  assert.equal(await exists(join(siblingWorkspace, "workspace.json")), true);
});

test("init refuses a draft or evidence root that resolves through a symbolic link", async () => {
  const fixture = await makeFixture("symlink-input");
  const linkedEvidence = join(fixture.root, "evidence-link");
  await symlink(fixture.evidenceDirectory, linkedEvidence);
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: linkedEvidence,
      workspacePath: fixture.workspacePath,
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError && error.codes.includes("WORKSPACE_PATH_UNSAFE"),
  );
  assert.equal(await exists(fixture.workspacePath), false);
});

/* -------------------------------------------------------------------------- */
/* Enumeration safety                                                         */
/* -------------------------------------------------------------------------- */

test("a symlinked evidence entry is recorded as skipped and its target is never read", async () => {
  const fixture = await makeFixture("symlink-entry");
  const outside = join(fixture.root, "outside-secret.txt");
  await writeFile(outside, "SECRET OUTSIDE THE EVIDENCE ROOT\n", "utf8");
  await symlink(outside, join(fixture.evidenceDirectory, "linked.txt"));
  await initFixture(fixture);

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const linked = entries.find((entry) => entry.relativePath === "linked.txt");
  assert.ok(linked);
  assert.equal(linked.entryType, "symlink");
  assert.equal(linked.status, "skipped");
  assert.equal(linked.sourceId, undefined);

  const manifestText = await readFile(join(fixture.workspacePath, "manifest.json"), "utf8");
  assert.doesNotMatch(manifestText, /SECRET OUTSIDE THE EVIDENCE ROOT/u);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("EVIDENCE_ENTRY_SKIPPED"));
});

test("a symlinked evidence directory is never traversed", async () => {
  const fixture = await makeFixture("symlink-dir");
  const outside = join(fixture.root, "outside-tree");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "hidden.txt"), "HIDDEN TREE CONTENT\n", "utf8");
  await symlink(outside, join(fixture.evidenceDirectory, "tree-link"));
  await initFixture(fixture);

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  assert.equal(entries.some((entry) => String(entry.relativePath).includes("hidden.txt")), false);
  const link = entries.find((entry) => entry.relativePath === "tree-link");
  assert.equal(link?.status, "skipped");
  assert.equal(link?.entryType, "symlink");
});

test("a non-regular evidence entry cannot enter the ready set", async () => {
  const fixture = await makeFixture("fifo");
  const hasMkfifo = await executableAvailable("mkfifo");
  if (!hasMkfifo) return;
  await execFileAsync("mkfifo", [join(fixture.evidenceDirectory, "pipe")]);
  await initFixture(fixture);

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const pipe = entries.find((entry) => entry.relativePath === "pipe");
  assert.ok(pipe);
  assert.equal(pipe.entryType, "fifo");
  assert.equal(pipe.status, "skipped");

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("EVIDENCE_ENTRY_SKIPPED"));
});

test("the file-count bound fails before any ingestion artifact is written", async () => {
  const fixture = await makeFixture("count-limit");
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: fixture.evidenceDirectory,
      workspacePath: fixture.workspacePath,
      limits: { maxEvidenceFiles: 1 },
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("EVIDENCE_LIMIT_EXCEEDED"),
  );
  // Enumeration runs to completion before ingestion begins, so no inventory or
  // manifest exists. (This shows the artifacts were never produced; it does not
  // by itself time the parser calls.)
  assert.equal(await exists(join(fixture.workspacePath, "evidence-inventory.json")), false);
  assert.equal(await exists(join(fixture.workspacePath, "manifest.json")), false);
});

test("the aggregate byte bound fails before any ingestion artifact is written", async () => {
  const fixture = await makeFixture("byte-limit");
  await assert.rejects(
    initDogfoodWorkspace({
      draftPath: fixture.draftPath,
      evidenceDirectory: fixture.evidenceDirectory,
      workspacePath: fixture.workspacePath,
      limits: { maxEvidenceBytes: 4 },
    }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("EVIDENCE_LIMIT_EXCEEDED"),
  );
  assert.equal(await exists(join(fixture.workspacePath, "evidence-inventory.json")), false);
});

/**
 * Waits until some ingestion has copied more than `minimumBytes` into its
 * private snapshot.
 *
 * `ingestLocalFile` snapshots each source into a fresh `ebr-ingest-*` directory
 * under the temporary root, so pointing a child process at a private `TMPDIR`
 * makes its progress observable. Only one file in the fixture is large enough
 * to pass the threshold, which makes this a signal rather than a timer: it
 * cannot fire before that file's ingestion begins, and that ingestion cannot
 * begin until the whole bounded enumeration is finished.
 */
async function waitForLargeIngestSnapshot(
  temporaryRoot: string,
  minimumBytes: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names: string[] = [];
    try {
      names = await readdir(temporaryRoot);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.startsWith("ebr-ingest-")) continue;
      try {
        const snapshot = await stat(join(temporaryRoot, name, "source.snapshot"));
        if (snapshot.size >= minimumBytes) return true;
      } catch {
        // This ingestion has not written its snapshot yet.
      }
    }
    await new Promise((settle) => setTimeout(settle, 1));
  }
  return false;
}

test("an evidence file replaced after the bounded preflight cannot become a ready source", async () => {
  const fixture = await makeFixture("size-swap");
  // Enumerated first, and large enough that its ingestion is a wide window.
  // Binary, so it stays out of the manifest and keeps this fixture small.
  await writeFile(join(fixture.evidenceDirectory, "a-large.bin"), Buffer.alloc(16 * 1024 * 1024));
  const victim = join(fixture.evidenceDirectory, "zz-victim.txt");
  await writeFile(victim, "small\n", "utf8");

  const temporaryRoot = join(fixture.root, "ingest-temp");
  await mkdir(temporaryRoot);
  const moduleUrl = new URL("../src/dogfood.js", import.meta.url).href;
  const child = execFileAsync(process.execPath, ["--input-type=module", "-e", [
    `const dogfood = await import(${JSON.stringify(moduleUrl)});`,
    `await dogfood.initDogfoodWorkspace(${JSON.stringify({
      draftPath: fixture.draftPath,
      evidenceDirectory: fixture.evidenceDirectory,
      workspacePath: fixture.workspacePath,
    })});`,
  ].join("\n")], { env: { ...process.env, TMPDIR: temporaryRoot } });

  const inWindow = await waitForLargeIngestSnapshot(temporaryRoot, 4 * 1024 * 1024, 60_000);
  assert.ok(inWindow, "the large file's ingestion window was never observed");
  // Enumeration weighed six bytes against the limits; ingestion is about to
  // read two megabytes.
  await writeFile(victim, "B".repeat(2 * 1024 * 1024), "utf8");
  await child;

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const swapped = entries.find((entry) => entry.relativePath === "zz-victim.txt");
  assert.ok(swapped);
  assert.equal(swapped.status, "unresolved");
  assert.equal(swapped.code, "ENTRY_SIZE_CHANGED");
  assert.equal(swapped.byteLength, 6, "the inventory keeps what the preflight actually weighed");

  const manifest = await readJson(join(fixture.workspacePath, "manifest.json")) as unknown as VerifyRequest;
  assert.equal(
    manifest.evidence.sources.some((source) => source.title === "zz-victim.txt"),
    false,
    "a file that changed under the preflight is never a citable source",
  );
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("EVIDENCE_ENTRY_UNRESOLVED"));
});

test("binary and invalid UTF-8 evidence become unresolved blockers, never ready sources", async () => {
  const fixture = await makeFixture("binary");
  await writeFile(join(fixture.evidenceDirectory, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
  await writeFile(join(fixture.evidenceDirectory, "bad-utf8.txt"), Buffer.from([0xc3, 0x28, 0x41]));
  await initFixture(fixture);

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const blob = entries.find((entry) => entry.relativePath === "blob.bin");
  const bad = entries.find((entry) => entry.relativePath === "bad-utf8.txt");
  assert.equal(blob?.status, "unresolved");
  assert.equal(blob?.code, "BINARY_TEXT_REJECTED");
  assert.equal(bad?.status, "unresolved");
  assert.equal(bad?.code, "INVALID_UTF8");

  const manifest = await readJson(join(fixture.workspacePath, "manifest.json")) as unknown as VerifyRequest;
  assert.equal(manifest.evidence.sources.length, 2, "only ready entries become sources");

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.equal(codes(report.blockers).filter((code) => code === "EVIDENCE_ENTRY_UNRESOLVED").length, 2);
});

const canGeneratePdf = await Promise.all([
  executableAvailable("ps2pdf"),
  executableAvailable("pdfinfo"),
  executableAvailable("pdftotext"),
]).then((values) => values.every(Boolean));

async function writePdf(directory: string, name: string, sentence: string): Promise<void> {
  const psPath = join(directory, name.replace(/\.pdf$/u, ".ps"));
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "%%Pages: 1",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    `(${sentence}) show`,
    "showpage",
    "%%EOF",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, join(directory, name)]);
  await rm(psPath, { force: true });
}

test("an OCR-required PDF is a blocker rather than a silent OCR run", { skip: !canGeneratePdf }, async () => {
  const fixture = await makeFixture("ocr-required");
  await writePdf(fixture.evidenceDirectory, "sparse.pdf", "tiny");
  await initDogfoodWorkspace({
    draftPath: fixture.draftPath,
    evidenceDirectory: fixture.evidenceDirectory,
    workspacePath: fixture.workspacePath,
  });

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const sparse = entries.find((entry) => entry.relativePath === "sparse.pdf");
  assert.equal(sparse?.status, "unresolved");
  assert.equal(sparse?.code, "OCR_REQUIRED");
  assert.equal((sparse?.ocr as Record<string, unknown>).performed, false);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("EVIDENCE_ENTRY_UNRESOLVED"));
});

/* -------------------------------------------------------------------------- */
/* Tampering and staleness                                                    */
/* -------------------------------------------------------------------------- */

test("editing the machine-generated inventory is detected", async () => {
  const fixture = await makeFixture("inventory-tamper");
  await initFixture(fixture);
  const inventoryPath = join(fixture.workspacePath, "evidence-inventory.json");
  const inventory = await readJson(inventoryPath);
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const first = entries[0];
  assert.ok(first);
  first.status = "ready";
  first.sha256 = "0".repeat(64);
  await writeJson(inventoryPath, inventory);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("INVENTORY_CHANGED"));
});

test("an inventory carrying an unknown field fails closed", async () => {
  const fixture = await makeFixture("inventory-unknown");
  await initFixture(fixture);
  const inventoryPath = join(fixture.workspacePath, "evidence-inventory.json");
  const inventory = await readJson(inventoryPath);
  inventory.verified = true;
  await writeJson(inventoryPath, inventory);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("INVENTORY_INVALID"));
  assert.match(
    report.blockers.find((item) => item.code === "INVENTORY_INVALID")?.message ?? "",
    /unknown properties: verified/u,
  );
});

test("a checklist carrying an unknown confirmation fails closed", async () => {
  const fixture = await makeFixture("review-unknown");
  await initFixture(fixture);
  const reviewPath = join(fixture.workspacePath, "review.json");
  const review = await readJson(reviewPath);
  (review.confirmations as Record<string, unknown>).everythingIsFine = true;
  await writeJson(reviewPath, review);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("REVIEW_INVALID"));
});

test("workspace metadata carrying an injected status field fails closed", async () => {
  const fixture = await makeFixture("metadata-unknown");
  await initFixture(fixture);
  const metadataPath = join(fixture.workspacePath, "workspace.json");
  const metadata = await readJson(metadataPath);
  metadata.status = "PASS";
  await writeJson(metadataPath, metadata);

  await assert.rejects(
    evaluateDogfoodWorkspace(fixture.workspacePath),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("WORKSPACE_METADATA_UNREADABLE"),
    "there is no stored status field, and one cannot be smuggled in",
  );
});

test("workspace metadata edited without re-sealing is detected", async () => {
  const fixture = await makeFixture("metadata-tamper");
  await initFixture(fixture);
  const metadataPath = join(fixture.workspacePath, "workspace.json");
  const metadata = await readJson(metadataPath);
  (metadata.draftSnapshot as Record<string, unknown>).sha256 = "0".repeat(64);
  await writeJson(metadataPath, metadata);

  await assert.rejects(
    evaluateDogfoodWorkspace(fixture.workspacePath),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError
      && error.codes.includes("WORKSPACE_METADATA_UNREADABLE"),
  );
});

test("draft snapshot tampering is detected on every read", async () => {
  const fixture = await makeFixture("draft-tamper");
  await initFixture(fixture);
  await writeFile(
    join(fixture.workspacePath, "draft", "draft.snapshot"),
    "Section 24 requires disclosure within 60 days.\n",
    "utf8",
  );
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("DRAFT_SNAPSHOT_CHANGED"));
});

test("a manifest from another workspace is detected by identity, not by content alone", async () => {
  const fixture = await makeFixture("manifest-identity");
  await initFixture(fixture);
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.requestId = "legal-99999999999999999";
  await writeJson(manifestPath, manifest);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("MANIFEST_IDENTITY_CHANGED"));
});

test("a missing artifact is a blocker, and missing workspace metadata exits 2", async () => {
  const fixture = await makeFixture("missing");
  await initFixture(fixture);
  await rm(join(fixture.workspacePath, "review.json"));
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("REVIEW_MISSING"));

  await rm(join(fixture.workspacePath, "workspace.json"));
  const outcome = await runCli(["dogfood", "status", "--workspace", fixture.workspacePath]);
  assert.equal(outcome.code, 2);
});

test("a workspace refusal reports its typed codes and issues, not one prose string", async () => {
  const fixture = await makeFixture("cli-error-shape");
  const outcome = await runCli([
    "dogfood",
    "status",
    "--workspace",
    join(fixture.root, "no-such-workspace"),
  ]);
  assert.equal(outcome.code, 2);
  const failure = JSON.parse(outcome.stderr) as {
    error: string;
    codes: string[];
    issues: string[];
  };
  assert.deepEqual(failure.codes, ["WORKSPACE_METADATA_UNREADABLE"]);
  assert.equal(failure.issues.length, 1);
  assert.match(failure.error, /failed closed/u);
});

test("a resealed workspace.json cannot point an artifact or the trace directory outside the workspace", async () => {
  const fixture = await makeFixture("metadata-escape");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const metadataPath = join(fixture.workspacePath, "workspace.json");
  const pristine = await readFile(metadataPath, "utf8");

  // A complete, valid checklist with every confirmation already true, sitting
  // outside the workspace. If a resealed pointer were honoured, this file would
  // clear the human gate for a workspace nobody reviewed.
  const plantedReview = join(fixture.root, "outside-review.json");
  await writeJson(plantedReview, {
    schemaVersion: "0.1.0-alpha",
    kind: "dogfood-review-checklist",
    createdAt: new Date().toISOString(),
    note: "planted from outside the workspace",
    confirmations: {
      materialClaimCoverageReviewed: true,
      sourceSelectionAndAuthorityReviewed: true,
      exactQuotationAndPinpointReviewed: true,
      pdfVisualQuoteReviewCompleted: true,
      ocrVisualReviewCompleted: true,
    },
  });

  const escapes: Array<[string, string, (core: Record<string, unknown>) => void]> = [
    ["review.file", "review.file", (core) => {
      (core.review as Record<string, unknown>).file = "../outside-review.json";
    }],
    ["traceDirectory", "traceDirectory", (core) => {
      core.traceDirectory = "../outside-traces";
    }],
    ["manifest.file absolute", "manifest.file", (core) => {
      (core.manifest as Record<string, unknown>).file = join(fixture.root, "outside-manifest.json");
    }],
    ["draftSnapshot.file traversal", "draftSnapshot.file", (core) => {
      (core.draftSnapshot as Record<string, unknown>).file = "draft/../../outside.snapshot";
    }],
    ["inventory.file renamed", "inventory.file", (core) => {
      (core.inventory as Record<string, unknown>).file = "evidence-inventory.json.bak";
    }],
    ["nested type swapped", "review", (core) => {
      core.review = "../outside-review.json";
    }],
    ["nested key added", "review", (core) => {
      (core.review as Record<string, unknown>).alternateFile = "../outside-review.json";
    }],
  ];

  for (const [label, field, mutate] of escapes) {
    await writeFile(metadataPath, pristine, "utf8");
    await reseal(fixture.workspacePath, mutate);
    // Started one at a time: two rejected promises created together would
    // surface the second as an unhandled rejection before it is awaited.
    for (const run of [
      () => evaluateDogfoodWorkspace(fixture.workspacePath),
      () => verifyDogfoodWorkspace({ workspacePath: fixture.workspacePath }),
    ]) {
      await assert.rejects(
        run(),
        (error: unknown) => {
          assert.ok(error instanceof DogfoodWorkspaceError, label);
          assert.ok(error.codes.includes("WORKSPACE_METADATA_UNREADABLE"), `${label}: ${error.codes.join(",")}`);
          assert.ok(
            error.issues.some((issue) => issue.includes(field)),
            `${label}: ${error.issues.join(" | ")}`,
          );
          return true;
        },
        label,
      );
    }
  }

  // Nothing was read from or written to the planted locations.
  assert.equal(await exists(join(fixture.root, "outside-traces")), false);
  assert.equal(await exists(join(fixture.workspacePath, "traces")), false);
  assert.equal(await exists(join(fixture.root, "outside.snapshot")), false);

  // Restoring the untouched metadata makes the same workspace ready again, so
  // each refusal above was the escape and not a broken fixture.
  await writeFile(metadataPath, pristine, "utf8");
  const restored = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.deepEqual(restored.blockers, []);
  assert.equal(restored.status, "READY_FOR_VERIFICATION");
});

test("a symbolic link standing in for the workspace root or a fixed artifact is refused before it is read", async () => {
  const fixture = await makeFixture("artifact-symlink");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);

  const unsafe = (error: unknown): boolean =>
    error instanceof DogfoodWorkspaceError && error.codes.includes("WORKSPACE_PATH_UNSAFE");

  // The workspace root itself.
  const linkedWorkspace = join(fixture.root, "ws-link");
  await symlink(fixture.workspacePath, linkedWorkspace);
  await assert.rejects(evaluateDogfoodWorkspace(linkedWorkspace), unsafe, "symlinked workspace root");

  // One fixed artifact, pointing at a file the workspace never wrote.
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const outsideManifest = join(fixture.root, "outside-manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  await writeFile(outsideManifest, manifestText, "utf8");
  await rm(manifestPath);
  await symlink(outsideManifest, manifestPath);
  await assert.rejects(evaluateDogfoodWorkspace(fixture.workspacePath), unsafe, "symlinked manifest");
  await rm(manifestPath);
  await writeFile(manifestPath, manifestText, "utf8");

  // A directory component of a fixed artifact, not just its last segment.
  const outsideDraft = join(fixture.root, "outside-draft");
  await mkdir(outsideDraft);
  await writeFile(join(outsideDraft, "draft.snapshot"), DRAFT_TEXT, "utf8");
  const draftDirectory = join(fixture.workspacePath, "draft");
  await rm(draftDirectory, { recursive: true });
  await symlink(outsideDraft, draftDirectory);
  await assert.rejects(evaluateDogfoodWorkspace(fixture.workspacePath), unsafe, "symlinked draft directory");
});

test("a symbolic link standing in for the workspace trace directory is never written through", async () => {
  const fixture = await makeFixture("trace-symlink");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const outside = join(fixture.root, "outside-traces");
  await mkdir(outside);
  await symlink(outside, join(fixture.workspacePath, "traces"));

  await assert.rejects(
    verifyDogfoodWorkspace({ workspacePath: fixture.workspacePath }),
    (error: unknown) =>
      error instanceof DogfoodWorkspaceError && error.codes.includes("WORKSPACE_PATH_UNSAFE"),
  );
  assert.deepEqual(await readdir(outside), [], "no trace may be written through the link");
});

test("a checklist with the wrong kind, schema version, or a missing field fails closed", async () => {
  const fixture = await makeFixture("review-shape");
  await initFixture(fixture);
  const reviewPath = join(fixture.workspacePath, "review.json");
  const pristine = await readFile(reviewPath, "utf8");

  const cases: Array<[string, (review: Record<string, unknown>) => void, RegExp]> = [
    ["wrong kind", (review) => {
      review.kind = "dogfood-review-checklist-v2";
    }, /is not a dogfood-review-checklist/u],
    ["wrong schema version", (review) => {
      review.schemaVersion = "9.9.9";
    }, /schemaVersion must be/u],
    ["missing note", (review) => {
      delete review.note;
    }, /is missing: note/u],
    ["empty createdAt", (review) => {
      review.createdAt = "   ";
    }, /createdAt and \.note must be non-empty/u],
    ["missing confirmation", (review) => {
      delete (review.confirmations as Record<string, unknown>).ocrVisualReviewCompleted;
    }, /ocrVisualReviewCompleted must be a boolean/u],
  ];

  for (const [label, mutate, expected] of cases) {
    const review = JSON.parse(pristine) as Record<string, unknown>;
    mutate(review);
    await writeJson(reviewPath, review);
    const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
    const invalid = report.blockers.filter((item) => item.code === "REVIEW_INVALID");
    assert.ok(invalid.length > 0, `${label}: saw ${codes(report.blockers).join(",")}`);
    assert.ok(
      invalid.some((item) => expected.test(item.message)),
      `${label}: ${invalid.map((item) => item.message).join(" | ")}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

test("status recomputes from disk and never reports PASS", async () => {
  const fixture = await makeFixture("status");
  await initFixture(fixture);

  const before = await runCli(["dogfood", "status", "--workspace", fixture.workspacePath]);
  assert.equal(before.code, 0);
  const beforeReport = JSON.parse(before.stdout) as { status: string; blockers: DogfoodBlocker[] };
  assert.equal(beforeReport.status, "NEEDS_REVIEW");
  assert.doesNotMatch(before.stdout, /"status": "PASS"/u);
  assert.ok(codes(beforeReport.blockers).includes("MANIFEST_COVERAGE_INCOMPLETE"));
  assert.ok(codes(beforeReport.blockers).includes("MANIFEST_CLAIMS_EMPTY"));

  await prepareForVerification(fixture.workspacePath);
  const after = await runCli(["dogfood", "status", "--workspace", fixture.workspacePath]);
  assert.equal(after.code, 0);
  const afterReport = JSON.parse(after.stdout) as { status: string; blockers: DogfoodBlocker[] };
  assert.equal(afterReport.status, "READY_FOR_VERIFICATION");
  assert.deepEqual(afterReport.blockers, []);
  assert.doesNotMatch(after.stdout, /PASS/u, "readiness is still not a verification outcome");
});

test("status blocks a material claim that still rests on an unclassified source", async () => {
  const fixture = await makeFixture("authority");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  // Undo only the authority classification; everything else stays prepared.
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath) as unknown as VerifyRequest;
  const source = manifest.evidence.sources.find((item) => item.title === "a-statute.txt");
  assert.ok(source);
  source.authorityTier = "unknown";
  await writeJson(manifestPath, manifest);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("MANIFEST_SOURCE_AUTHORITY_UNCLASSIFIED"));
});

test("status blocks a fabricated source that was never ingested", async () => {
  const fixture = await makeFixture("source-injection");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath) as unknown as VerifyRequest;
  manifest.evidence.sources.push({
    sourceId: "src-invented",
    title: "Invented Authority Act",
    sourceType: "local_file",
    authorityTier: "primary",
    jurisdictions: ["BC"],
  });
  await writeJson(manifestPath, manifest);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("MANIFEST_SOURCE_NOT_IN_INVENTORY"));

  // Keeping the id but changing the recorded content hash is refused too, as a
  // provenance-binding failure rather than an unknown source.
  const swapped = await readJson(manifestPath) as unknown as VerifyRequest;
  swapped.evidence.sources = swapped.evidence.sources.filter(
    (source) => source.sourceId !== "src-invented",
  );
  const first = swapped.evidence.sources[0];
  assert.ok(first);
  first.sha256 = "1".repeat(64);
  await writeJson(manifestPath, swapped);
  const rehashed = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(rehashed.blockers).includes("MANIFEST_PROVENANCE_UNBOUND"));
});

test("status blocks a manifest chunk that does not match the ingested page", async () => {
  const fixture = await makeFixture("chunk-swap");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath) as unknown as VerifyRequest;
  const chunk = manifest.evidence.chunks[0];
  assert.ok(chunk);
  chunk.text = "Fabricated evidence text that was never ingested.";
  await writeJson(manifestPath, manifest);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("MANIFEST_PROVENANCE_UNBOUND"));

  // An unknown chunk id is a different failure: it corresponds to no page at all.
  const invented = await readJson(manifestPath) as unknown as VerifyRequest;
  const target = invented.evidence.chunks[0];
  assert.ok(target);
  target.chunkId = "chk-invented:p1";
  invented.retrievedChunkIds = invented.evidence.chunks.map((item) => item.chunkId);
  invented.claims = [];
  await writeJson(manifestPath, invented);
  const unknownChunk = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(unknownChunk.blockers).includes("MANIFEST_CHUNK_NOT_IN_INVENTORY"));
});

test("machine-derived source and chunk provenance cannot be edited out of the manifest", async () => {
  const fixture = await makeFixture("provenance");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const pristine = await readFile(manifestPath, "utf8");

  const cases: Array<[string, (manifest: VerifyRequest) => void, RegExp]> = [
    ["omitted source sha256", (manifest) => {
      delete manifest.evidence.sources[0]?.sha256;
    }, /omits sha256/u],
    ["forged source title", (manifest) => {
      const source = manifest.evidence.sources[0];
      if (source) source.title = "Freedom of Information and Protection of Privacy Act";
    }, /title must stay/u],
    ["forged source type", (manifest) => {
      const source = manifest.evidence.sources[0];
      if (source) source.sourceType = "statute";
    }, /sourceType must stay/u],
    ["forged chunk locator", (manifest) => {
      const chunk = manifest.evidence.chunks[0];
      if (chunk) chunk.locator = "page 42";
    }, /locator differs/u],
    ["escaped subject path", (manifest) => {
      manifest.subject.path = "../../outside/draft.snapshot";
    }, /subject\.path must be exactly/u],
  ];

  for (const [label, mutate, expected] of cases) {
    const manifest = JSON.parse(pristine) as VerifyRequest;
    mutate(manifest);
    await writeJson(manifestPath, manifest);
    const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
    const bound = report.blockers.filter((item) => item.code === "MANIFEST_PROVENANCE_UNBOUND");
    assert.ok(bound.length > 0, `${label}: saw ${codes(report.blockers).join(",")}`);
    assert.ok(
      bound.some((item) => expected.test(item.message)),
      `${label}: ${bound.map((item) => item.message).join(" | ")}`,
    );
  }

  // The untouched manifest is still ready, so every rejection above came from
  // the edit and not from something the fixture was already failing.
  await writeFile(manifestPath, pristine, "utf8");
  assert.deepEqual((await evaluateDogfoodWorkspace(fixture.workspacePath)).blockers, []);
});

test("a fabricated structured fact is refused, and the generic verifier alone would have passed it", async () => {
  const fixture = await makeFixture("structured-facts");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);

  const manifestPath = join(fixture.workspacePath, "manifest.json");
  const manifest = await readJson(manifestPath) as unknown as VerifyRequest;
  const claim = manifest.claims[0];
  assert.ok(claim);
  const cited = claim.citations[0];
  assert.ok(cited);
  const chunk = manifest.evidence.chunks.find((item) => item.chunkId === cited.chunkId);
  assert.ok(chunk);

  // Nothing ingested this. The page says thirty days; the field says five, and
  // it is simply typed into the manifest beside the real text.
  chunk.structuredFacts = { disclosureDeadlineDays: 5 };
  claim.text = "Disclosure is required within 5 days.";
  claim.proof = { kind: "structured_fact", field: "disclosureDeadlineDays", expected: 5 };
  await writeJson(manifestPath, manifest);

  // The generic verifier has no way to know the field was invented: it is a
  // structured proof over a cited, retrieved chunk, so it is supported.
  const generic = await verifyRequest(manifest);
  assert.equal(generic.claims[0]?.assurance, "STRUCTURED");
  assert.equal(generic.claims[0]?.verdict, "SUPPORTED");
  assert.equal(generic.decision, "PASS");

  // The workspace gate is what stops it, before any of that runs.
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(codes(report.blockers).includes("MANIFEST_STRUCTURED_FACTS_UNBOUND"));
  assert.equal(report.status, "NEEDS_REVIEW");
  await assertBlockedWithoutTrace(fixture, "MANIFEST_STRUCTURED_FACTS_UNBOUND");
});

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

async function assertBlockedWithoutTrace(
  fixture: Fixture,
  expected: string,
): Promise<void> {
  const outcome = await runCli(["dogfood", "verify", "--workspace", fixture.workspacePath]);
  assert.equal(outcome.code, 1, expected);
  const result = JSON.parse(outcome.stdout) as { status: string; blockers: DogfoodBlocker[] };
  assert.equal(result.status, "BLOCKED");
  assert.ok(codes(result.blockers).includes(expected), `${expected} not in ${codes(result.blockers).join(",")}`);
  assert.doesNotMatch(outcome.stdout, /"decision"|PASS/u);
  assert.equal(
    await exists(join(fixture.workspacePath, "traces")),
    false,
    "a blocked run must not write a verification trace",
  );
}

test("verify is blocked with no trace while coverage is incomplete", async () => {
  const fixture = await makeFixture("verify-coverage");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath, { coverage: false });
  await assertBlockedWithoutTrace(fixture, "MANIFEST_COVERAGE_INCOMPLETE");
});

test("verify is blocked with no trace while the claim inventory is empty", async () => {
  const fixture = await makeFixture("verify-claims");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath, { claims: false });
  await assertBlockedWithoutTrace(fixture, "MANIFEST_CLAIMS_EMPTY");
});

test("verify is blocked with no trace while a checklist confirmation is false", async () => {
  const fixture = await makeFixture("verify-confirm");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath, { confirm: false });
  await assertBlockedWithoutTrace(fixture, "REVIEW_CONFIRMATION_MISSING");
});

test("verify is blocked with no trace while an evidence entry is unresolved", async () => {
  const fixture = await makeFixture("verify-unresolved");
  await writeFile(join(fixture.evidenceDirectory, "blob.bin"), Buffer.from([0, 1, 2, 0]));
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  await assertBlockedWithoutTrace(fixture, "EVIDENCE_ENTRY_UNRESOLVED");
});

test("a PDF source requires an explicit visual quote review before verification", { skip: !canGeneratePdf }, async () => {
  const fixture = await makeFixture("verify-pdf");
  await writePdf(
    fixture.evidenceDirectory,
    "authority.pdf",
    "A sufficiently long searchable evidence sentence for deterministic extraction.",
  );
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);

  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.ok(
    report.blockers.some((item) =>
      item.code === "REVIEW_CONFIRMATION_MISSING"
      && item.message.includes("pdfVisualQuoteReviewCompleted")
    ),
    `expected a PDF visual review requirement, saw ${codes(report.blockers).join(",")}`,
  );
  await assertBlockedWithoutTrace(fixture, "REVIEW_CONFIRMATION_MISSING");

  // Confirming it clears exactly that requirement and nothing else.
  const reviewPath = join(fixture.workspacePath, "review.json");
  const review = await readJson(reviewPath);
  (review.confirmations as Record<string, boolean>).pdfVisualQuoteReviewCompleted = true;
  await writeJson(reviewPath, review);
  const cleared = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.deepEqual(cleared.blockers, []);
});

const canRunOcr = await Promise.all([
  Promise.resolve(canGeneratePdf),
  executableAvailable("gs"),
  executableAvailable("ocrmypdf"),
  executableAvailable("tesseract"),
]).then((values) => values.every(Boolean));

/** Rasterises a text PDF so the result carries no text layer at all. */
async function writeScannedPdf(directory: string, name: string, sentence: string): Promise<void> {
  await writePdf(directory, "pre-scan-source.pdf", sentence);
  const source = join(directory, "pre-scan-source.pdf");
  await execFileAsync("gs", [
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-sDEVICE=pdfimage24",
    "-r150",
    "-o",
    join(directory, name),
    source,
  ]);
  await rm(source, { force: true });
}

test("performed OCR requires an explicit visual review before verification", { skip: !canRunOcr }, async () => {
  const fixture = await makeFixture("verify-ocr");
  await writeScannedPdf(
    fixture.evidenceDirectory,
    "scanned.pdf",
    "Disclosure must occur within thirty days of the request.",
  );
  await initDogfoodWorkspace({
    draftPath: fixture.draftPath,
    evidenceDirectory: fixture.evidenceDirectory,
    workspacePath: fixture.workspacePath,
    ocrPolicy: "perform",
  });

  const inventory = await readJson(join(fixture.workspacePath, "evidence-inventory.json"));
  const entries = inventory.entries as Array<Record<string, unknown>>;
  const scanned = entries.find((entry) => entry.relativePath === "scanned.pdf");
  assert.equal(scanned?.status, "ready");
  assert.equal((scanned?.ocr as Record<string, unknown>).performed, true);
  assert.equal((scanned?.quality as Record<string, unknown>).ocrAccuracy, "UNCHECKED");

  await prepareForVerification(fixture.workspacePath);
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.equal(report.counts.confirmationsRequired, 5, "both PDF and OCR reviews now apply");
  assert.ok(
    report.blockers.some((item) => item.message.includes("ocrVisualReviewCompleted")),
    `expected an OCR review requirement, saw ${codes(report.blockers).join(",")}`,
  );
  await assertBlockedWithoutTrace(fixture, "REVIEW_CONFIRMATION_MISSING");
});

test("a text-only workspace does not require the PDF or OCR confirmations", async () => {
  const fixture = await makeFixture("no-pdf");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const report = await evaluateDogfoodWorkspace(fixture.workspacePath);
  assert.equal(report.counts.confirmationsRequired, 3);
  assert.deepEqual(report.blockers, []);

  // The irrelevant items are reported as not required; they are still false on
  // disk, because nothing may flip a human confirmation.
  const review = await readJson(join(fixture.workspacePath, "review.json"));
  const confirmations = review.confirmations as Record<string, boolean>;
  assert.equal(confirmations.pdfVisualQuoteReviewCompleted, false);
  assert.equal(confirmations.ocrVisualReviewCompleted, false);
});

test("a fully prepared workspace reaches the verifier and writes a replayable owner-only trace", async () => {
  const fixture = await makeFixture("verify-pass");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);

  const outcome = await runCli(["dogfood", "verify", "--workspace", fixture.workspacePath]);
  assert.equal(outcome.code, 0, outcome.stderr);
  const result = JSON.parse(outcome.stdout) as {
    status: string;
    tracePath: string;
    decision: string;
    coverage: string;
    shippable: boolean;
  };
  // The envelope says the check ran; the decision is the verdict. Nothing in
  // the wrapper is allowed to read as "VERIFIED" on its own.
  assert.equal(result.status, "CHECK_COMPLETED");
  assert.doesNotMatch(outcome.stdout, /"VERIFIED"/u);
  assert.equal(result.decision, "PASS");
  assert.equal(result.coverage, "COMPLETE");
  assert.equal(result.shippable, true);
  assert.ok(result.tracePath.startsWith(join(fixture.workspacePath, "traces")));
  assert.equal(await mode(result.tracePath), "600");
  assert.equal(await mode(join(fixture.workspacePath, "traces")), "700");
  // The wrapper result carries no source or evidence text.
  assert.doesNotMatch(outcome.stdout, /The Act says disclosure/u);

  const replay = await runCli(["replay", result.tracePath]);
  assert.equal(replay.code, 0);
  assert.equal((JSON.parse(replay.stdout) as { matches: boolean }).matches, true);
});

test("verify accepts an explicit trace directory and keeps the workspace clean", async () => {
  const fixture = await makeFixture("verify-trace-dir");
  await initFixture(fixture);
  await prepareForVerification(fixture.workspacePath);
  const traceDirectory = join(fixture.root, "external-traces");

  const result = await verifyDogfoodWorkspace({
    workspacePath: fixture.workspacePath,
    traceDirectory,
  });
  assert.equal(result.status, "CHECK_COMPLETED");
  if (result.status !== "CHECK_COMPLETED") return;
  assert.ok(result.tracePath.startsWith(traceDirectory));
  assert.equal(await mode(traceDirectory), "700");
  assert.equal(await exists(join(fixture.workspacePath, "traces")), false);
});

test("newly created private directories are 0700 even under a permissive umask", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ebr-umask-")));
  const target = join(root, "outer", "inner");
  const moduleUrl = new URL("../src/trace-io.js", import.meta.url).href;
  // Run in a child process so `umask(0)` cannot leak into the rest of the suite.
  await execFileAsync(process.execPath, ["--input-type=module", "-e", [
    "process.umask(0);",
    `const io = await import(${JSON.stringify(moduleUrl)});`,
    `await io.writePrivateJsonArtifact(${JSON.stringify(target)}, "artifact.json", { value: 1 });`,
  ].join("\n")]);

  assert.equal(await mode(join(root, "outer")), "700", "an intermediate component this call created");
  assert.equal(await mode(target), "700");
  assert.equal(await mode(join(target, "artifact.json")), "600");

  // A directory the caller set up beforehand keeps the permissions it had.
  const existing = join(root, "existing");
  await mkdir(existing);
  await chmod(existing, 0o755);
  await writePrivateJsonArtifact(existing, "artifact.json", { value: 2 });
  assert.equal(await mode(existing), "755");
  assert.equal(await mode(join(existing, "artifact.json")), "600");
});

test("an exclusive private artifact write refuses to replace an existing file", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ebr-exclusive-")));
  const first = await writePrivateJsonArtifact(directory, "fixed.json", { value: 1 }, {
    exclusive: true,
  });
  assert.equal(((await stat(first)).mode & 0o777).toString(8), "600");
  await assert.rejects(
    writePrivateJsonArtifact(directory, "fixed.json", { value: 2 }, { exclusive: true }),
    (error: unknown) => error instanceof ArtifactExistsError,
  );
  assert.deepEqual(await readJson(first), { value: 1 });
  // No temporary file is left behind by the refusal.
  const remaining = await lstat(first);
  assert.ok(remaining.isFile());
});
