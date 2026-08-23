import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("claims diff CLI ignores unrelated prose while reusing the legal claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-claims-cli-"));
  const beforePath = join(directory, "before.txt");
  const afterPath = join(directory, "after.txt");
  await Promise.all([
    writeFile(beforePath, [
      "Section 23 requires disclosure within 30 days.",
      "This is an introduction.",
    ].join("\n\n"), "utf8"),
    writeFile(afterPath, [
      "Section 23 requires disclosure within 30 days.",
      "This introduction is clearer for the reader.",
    ].join("\n\n"), "utf8"),
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "claims",
    "diff",
    "--before",
    beforePath,
    "--after",
    afterPath,
  ]);
  const result = JSON.parse(stdout) as {
    wholeDocumentChanged: boolean;
    plan: Array<{
      action: string;
      requiresRevalidation: boolean;
      reviewKind: string;
      before?: { material: boolean };
    }>;
  };
  assert.equal(result.wholeDocumentChanged, true);
  assert.equal(
    result.plan.find((item) => item.before?.material)?.action,
    "REUSE",
  );
  assert.equal(result.plan.some((item) => item.reviewKind === "SOURCE_SUPPORT"), false);
  assert.ok(result.plan.some((item) => item.reviewKind === "MATERIALITY"));
});

test("claims diff CLI persists a revision plan that the replay command reproduces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-revision-cli-"));
  const beforePath = join(directory, "before.txt");
  const afterPath = join(directory, "after.txt");
  const traceDirectory = join(directory, "plans");
  await Promise.all([
    writeFile(beforePath, "Section 23 requires disclosure within 30 days.\n", "utf8"),
    writeFile(afterPath, "Section 24 requires disclosure within 30 days.\n", "utf8"),
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "claims",
    "diff",
    "--before",
    beforePath,
    "--after",
    afterPath,
    "--trace-dir",
    traceDirectory,
  ]);
  const written = JSON.parse(stdout) as {
    tracePath: string;
    comparison: { plan: Array<{ action: string }> };
  };
  assert.ok(written.tracePath.startsWith(traceDirectory));
  assert.ok(written.comparison.plan.some((item) => item.action === "REVERIFY"));

  const replay = await execFileAsync(process.execPath, [
    cliPath,
    "revision",
    "replay",
    written.tracePath,
  ]);
  const outcome = JSON.parse(replay.stdout) as {
    matches: boolean;
    expectedArtifactHash: string;
    actualArtifactHash: string;
  };
  assert.equal(outcome.matches, true);
  assert.equal(outcome.expectedArtifactHash, outcome.actualArtifactHash);
});

test("ingest CLI returns source and page provenance for local text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-ingest-cli-"));
  const sourcePath = join(directory, "source.txt");
  await writeFile(sourcePath, "A local evidence sentence.\n", "utf8");

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "ingest",
    "--input",
    sourcePath,
  ]);
  const result = JSON.parse(stdout) as {
    status: string;
    source: { sha256: string };
    pages: Array<{ locator: string; text: string }>;
  };
  assert.equal(result.status, "ready");
  assert.match(result.source.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.pages[0]?.locator, "text:page=1");
  assert.equal(result.pages[0]?.text, "A local evidence sentence.\n");
});

test("legal scope CLI emits only external legal candidates and unresolved legal propositions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-legal-scope-cli-"));
  const draftPath = join(directory, "draft.txt");
  await writeFile(draftPath, [
    "WCAT A1802705 supports my private diagnosis SECRET under the cumulative approach.",
    "The statute requires written reasons.",
    "Thank you for reading this letter.",
  ].join("\n\n"), "utf8");
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "legal",
    "scope",
    "--draft",
    draftPath,
  ]);
  const result = JSON.parse(stdout) as {
    counts: { verify: number; reviewScope: number; skipped: number };
    items: Array<{ action: string; text?: string; legalReferences: string[] }>;
    scopedCoverageComplete: boolean;
  };
  assert.deepEqual(result.counts, { verify: 1, reviewScope: 1, skipped: 1 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items.some((item) => item.text !== undefined), false);
  assert.equal(stdout.includes("Thank you"), false);
  assert.equal(stdout.includes("SECRET"), false);
  assert.equal(result.scopedCoverageComplete, false);
});

test("legal cache-source CLI reports a content-cache hit without printing source text or path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-legal-cache-cli-"));
  const sourcePath = join(directory, "authority.txt");
  const cacheDirectory = join(directory, "cache");
  const sourceText = "The official authority requires written reasons.\n";
  await writeFile(sourcePath, sourceText, "utf8");
  const args = [
    cliPath,
    "legal",
    "cache-source",
    "--source",
    sourcePath,
    "--cache-dir",
    cacheDirectory,
    "--canonical-id",
    "BCSC-2024-994",
    "--title",
    "Fixture v Example",
    "--issuer",
    "Supreme Court of British Columbia",
    "--class",
    "adjudicative_decision",
    "--tier",
    "primary",
    "--jurisdiction",
    "BC",
  ];
  const first = await execFileAsync(process.execPath, args);
  const second = await execFileAsync(process.execPath, args);
  assert.equal((JSON.parse(first.stdout) as { status: string }).status, "CACHE_MISS");
  assert.equal((JSON.parse(second.stdout) as { status: string }).status, "CACHE_HIT");
  assert.equal(second.stdout.includes(sourceText.trim()), false);
  assert.equal(second.stdout.includes(sourcePath), false);
});
