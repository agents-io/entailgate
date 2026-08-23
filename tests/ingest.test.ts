import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { sha256File, sha256Text } from "../src/canonical.js";
import {
  assessOcrRequirement,
  buildIngestedPages,
  ingestLocalFile,
  inspectIngestionTools,
  parsePdfInfoPageCount,
} from "../src/ingest.js";

const execFileAsync = promisify(execFile);

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

test("ingests valid UTF-8 text with source and stable page provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-text-ingest-"));
  const path = join(directory, "evidence.txt");
  const content = "Document A says X.\nDocument B says Y.\n";
  await writeFile(path, content, "utf8");

  const result = await ingestLocalFile(path);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.source.sha256, await sha256File(path));
  assert.equal(result.source.snapshot.sha256, result.source.sha256);
  assert.equal(result.source.snapshot.policy, "private_read_only_temp");
  assert.equal(result.source.byteLength, (await readFile(path)).length);
  assert.equal(result.extraction.method, "node_utf8");
  assert.equal(result.extraction.tools[0]?.version, process.version);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]?.text, content);
  assert.equal(result.pages[0]?.textSha256, sha256Text(content));
  assert.equal(result.pages[0]?.locator, "text:page=1");
  assert.equal(result.quality.legalAccuracy, "UNCHECKED");
  assert.equal(result.quality.exactQuoteReview, "SOURCE_TEXT_REVIEW_REQUIRED");
  assert.match(result.pages[0]?.pageId ?? "", new RegExp(`^${result.source.sha256}:page:1:`));

  const replay = await ingestLocalFile(path);
  assert.equal(replay.status, "ready");
  if (replay.status === "ready") {
    assert.equal(replay.pages[0]?.pageId, result.pages[0]?.pageId);
    assert.equal(replay.pages[0]?.textSha256, result.pages[0]?.textSha256);
  }
});

test("invalid UTF-8 is typed unresolved instead of replacement-decoded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-invalid-text-"));
  const path = join(directory, "invalid.txt");
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  const result = await ingestLocalFile(path);
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.code, "INVALID_UTF8");
    assert.equal(result.source?.sha256, await sha256File(path));
  }
});

test("rejects obvious binary control bytes instead of labelling them plain text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-binary-text-"));
  const path = join(directory, "binary.dat");
  await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42, 0x43]));
  const result = await ingestLocalFile(path);
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") assert.equal(result.code, "BINARY_TEXT_REJECTED");
});

test("enforces the aggregate extracted-text byte limit for plain text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-text-limit-"));
  const path = join(directory, "evidence.txt");
  await writeFile(path, "more than ten bytes", "utf8");
  const result = await ingestLocalFile(path, { maxExtractedTextBytes: 10 });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.code, "EXTRACTED_TEXT_LIMIT_EXCEEDED");
  }
});

test("OCR assessment identifies empty and sparse pages deterministically", () => {
  assert.deepEqual(assessOcrRequirement(["", "three words"], 20), {
    required: true,
    reason: "page_text_missing",
    sparsePageThreshold: 20,
    emptyPages: [1],
    sparsePages: [2],
  });
  assert.deepEqual(assessOcrRequirement(["", ""], 20), {
    required: true,
    reason: "no_text",
    sparsePageThreshold: 20,
    emptyPages: [1, 2],
    sparsePages: [],
  });
  assert.equal(assessOcrRequirement(["Enough extracted characters for this page."], 20).required, false);
});

test("stable page identity binds source, page number, and extracted text", () => {
  const sourceHash = "a".repeat(64);
  const first = buildIngestedPages(sourceHash, "application/pdf", ["one", "two"]);
  const second = buildIngestedPages(sourceHash, "application/pdf", ["one", "changed"]);
  assert.equal(first[0]?.pageId, second[0]?.pageId);
  assert.notEqual(first[1]?.pageId, second[1]?.pageId);
  assert.equal(first[1]?.locator, "pdf:page=2");
});

test("parses only a positive explicit pdfinfo page count", () => {
  assert.equal(parsePdfInfoPageCount("Title: X\nPages:           12\nEncrypted: no\n"), 12);
  assert.equal(parsePdfInfoPageCount("Pages: 0\n"), undefined);
  assert.equal(parsePdfInfoPageCount("Page size: 612 x 792 pts\n"), undefined);
});

test("tool inventory captures exact local versions or explicit absence", async () => {
  const tools = await inspectIngestionTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    "node",
    "pdfinfo",
    "pdftotext",
    "pdffonts",
    "tesseract",
    "ocrmypdf",
  ]);
  assert.equal(tools[0]?.status, "available");
  assert.equal(tools[0]?.version, process.version);
  for (const tool of tools) {
    if (tool.status === "available") {
      assert.ok(tool.path);
      assert.ok(tool.version);
    }
  }
});

const canGeneratePdf = await Promise.all([
  executableAvailable("ps2pdf"),
  executableAvailable("pdfinfo"),
  executableAvailable("pdftotext"),
]).then((values) => values.every(Boolean));

test("extracts a generated PDF page through local Poppler tools", { skip: !canGeneratePdf }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-pdf-ingest-"));
  const psPath = join(directory, "fixture.ps");
  const pdfPath = join(directory, "fixture.pdf");
  const postscript = [
    "%!PS-Adobe-3.0",
    "%%Pages: 1",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(A sufficiently long searchable evidence sentence for deterministic extraction.) show",
    "showpage",
    "%%EOF",
    "",
  ].join("\n");
  await writeFile(psPath, postscript, "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);

  const before = await sha256File(pdfPath);
  const result = await ingestLocalFile(pdfPath);
  const after = await sha256File(pdfPath);
  assert.equal(after, before, "raw source must remain byte-identical");
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.source.sha256, before);
  assert.equal(result.extraction.method, "pdftotext");
  assert.equal(result.extraction.pdfPageCount, 1);
  assert.equal(result.pages[0]?.locator, "pdf:page=1");
  assert.match(result.pages[0]?.text ?? "", /sufficiently long searchable evidence sentence/u);
  assert.equal(result.ocr.required, false);
  assert.equal(result.ocr.performed, false);
  assert.equal(result.quality.meaningOfReady, "TECHNICAL_EXTRACTION_COMPLETED_NOT_ACCURACY_VERIFIED");
  assert.equal(result.quality.extractionAccuracy, "UNCHECKED");
  assert.equal(result.quality.exactQuoteReview, "PDF_VISUAL_REVIEW_REQUIRED");
  assert.ok(result.quality.limitations.some((item) => item.includes("visual comparison")));
});

test("sparse searchable PDF requires explicit OCR rather than silently running it", { skip: !canGeneratePdf }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-sparse-pdf-"));
  const psPath = join(directory, "sparse.ps");
  const pdfPath = join(directory, "sparse.pdf");
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(tiny) show",
    "showpage",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);

  const result = await ingestLocalFile(pdfPath, { sparsePageThreshold: 20 });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.code, "OCR_REQUIRED");
    assert.equal(result.ocr?.performed, false);
    assert.deepEqual(result.ocr?.sparsePages, [1]);
    assert.equal(result.pages?.[0]?.text.trim(), "tiny");
  }
});

test("rejects a PDF whose declared page count exceeds maxPdfPages", { skip: !canGeneratePdf }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-page-limit-"));
  const psPath = join(directory, "two-pages.ps");
  const pdfPath = join(directory, "two-pages.pdf");
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "%%Pages: 2",
    "%%Page: 1 1",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(First page has enough searchable evidence characters for extraction.) show",
    "showpage",
    "%%Page: 2 2",
    "72 720 moveto",
    "(Second page has enough searchable evidence characters for extraction.) show",
    "showpage",
    "%%EOF",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);

  const result = await ingestLocalFile(pdfPath, { maxPdfPages: 1 });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") assert.equal(result.code, "PDF_PAGE_LIMIT_EXCEEDED");
});

test("enforces aggregate extracted-text bytes for PDF output", { skip: !canGeneratePdf }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-pdf-text-limit-"));
  const psPath = join(directory, "fixture.ps");
  const pdfPath = join(directory, "fixture.pdf");
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(This extracted sentence is intentionally longer than ten bytes.) show",
    "showpage",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);

  const result = await ingestLocalFile(pdfPath, { maxExtractedTextBytes: 10 });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.code, "EXTRACTED_TEXT_LIMIT_EXCEEDED");
  }
});

test("enforces one total wall-clock deadline across PDF tool discovery and extraction", { skip: !canGeneratePdf }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-deadline-"));
  const psPath = join(directory, "fixture.ps");
  const pdfPath = join(directory, "fixture.pdf");
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(A searchable PDF sentence used to exercise the total deadline.) show",
    "showpage",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);

  const result = await ingestLocalFile(pdfPath, { totalTimeoutMs: 1 });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") assert.equal(result.code, "INGEST_DEADLINE_EXCEEDED");
});

const canGenerateOcrFixture = await Promise.all([
  executableAvailable("convert"),
  executableAvailable("img2pdf"),
  executableAvailable("ocrmypdf"),
  executableAvailable("tesseract"),
  executableAvailable("pdfinfo"),
  executableAvailable("pdftotext"),
]).then((values) => values.every(Boolean));

async function createImageOnlyPdf(directory: string): Promise<string> {
  const imagePath = join(directory, "page.png");
  const pdfPath = join(directory, "image-only.pdf");
  await execFileAsync("convert", [
    "-size", "1600x300",
    "xc:white",
    "-fill", "black",
    "-pointsize", "52",
    "-gravity", "center",
    "-annotate", "+0+0",
    "Local OCR evidence sentence has enough searchable characters.",
    imagePath,
  ]);
  await execFileAsync("img2pdf", [imagePath, "-o", pdfPath]);
  return pdfPath;
}

test("enforces maxOcrOutputBytes with a typed unresolved result", { skip: !canGenerateOcrFixture }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-ocr-output-limit-"));
  const pdfPath = await createImageOnlyPdf(directory);
  const result = await ingestLocalFile(pdfPath, {
    ocrPolicy: "perform",
    maxOcrOutputBytes: 1,
    commandTimeoutMs: 120_000,
  });
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") assert.equal(result.code, "OCR_OUTPUT_LIMIT_EXCEEDED");
});

test("successful OCR remains explicitly accuracy-unchecked and requires visual quote review", { skip: !canGenerateOcrFixture }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-ocr-quality-"));
  const pdfPath = await createImageOnlyPdf(directory);
  const result = await ingestLocalFile(pdfPath, {
    ocrPolicy: "perform",
    commandTimeoutMs: 120_000,
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.ocr.performed, true);
  assert.equal(result.quality.ocrAccuracy, "UNCHECKED");
  assert.equal(result.quality.legalAccuracy, "UNCHECKED");
  assert.equal(result.quality.exactQuoteReview, "PDF_VISUAL_REVIEW_REQUIRED");
  assert.ok(result.quality.limitations.some((item) => item.includes("OCR character accuracy")));
});

test("POSIX timeout terminates the spawned command process group", {
  skip: process.platform === "win32" || !canGeneratePdf,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-process-group-"));
  const psPath = join(directory, "fixture.ps");
  const pdfPath = join(directory, "fixture.pdf");
  const fakeBin = join(directory, "bin");
  const pidPath = join(directory, "child.pid");
  const sourceArgPath = join(directory, "source-arg.txt");
  const sourceModePath = join(directory, "source-mode.txt");
  await (await import("node:fs/promises")).mkdir(fakeBin);
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(A searchable sentence for process group timeout testing.) show",
    "showpage",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);
  const fakePdfinfo = join(fakeBin, "pdfinfo");
  await writeFile(fakePdfinfo, [
    "#!/bin/sh",
    "if [ \"$1\" = \"-v\" ]; then",
    "  echo \"pdfinfo version fixture\"",
    "  exit 0",
    "fi",
    `echo \"$1\" > \"${sourceArgPath}\"`,
    `stat -c %a \"$1\" > \"${sourceModePath}\"`,
    "sleep 30 &",
    "child_pid=$!",
    `echo \"$child_pid\" > \"${pidPath}\"`,
    "wait \"$child_pid\"",
    "",
  ].join("\n"), "utf8");
  await chmod(fakePdfinfo, 0o700);

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const result = await ingestLocalFile(pdfPath, {
      commandTimeoutMs: 100,
      totalTimeoutMs: 5_000,
    });
    assert.equal(result.status, "unresolved");
    if (result.status === "unresolved") assert.equal(result.code, "PDF_METADATA_FAILED");
  } finally {
    process.env.PATH = originalPath;
  }

  const childPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
  const parserSourceArg = (await readFile(sourceArgPath, "utf8")).trim();
  assert.notEqual(parserSourceArg, pdfPath);
  assert.match(parserSourceArg, /\/ebr-ingest-[^/]+\/source\.snapshot$/u);
  assert.equal((await readFile(sourceModePath, "utf8")).trim(), "400");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("POSIX output-limit termination also kills spawned descendants", {
  skip: process.platform === "win32" || !canGeneratePdf,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebr-output-group-"));
  const psPath = join(directory, "fixture.ps");
  const pdfPath = join(directory, "fixture.pdf");
  const fakeBin = join(directory, "bin");
  const pidPath = join(directory, "child.pid");
  await (await import("node:fs/promises")).mkdir(fakeBin);
  await writeFile(psPath, [
    "%!PS-Adobe-3.0",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(A searchable sentence for process group output testing.) show",
    "showpage",
    "",
  ].join("\n"), "ascii");
  await execFileAsync("ps2pdf", [psPath, pdfPath]);
  const fakePdfinfo = join(fakeBin, "pdfinfo");
  await writeFile(fakePdfinfo, [
    "#!/bin/sh",
    "if [ \"$1\" = \"-v\" ]; then",
    "  echo \"pdfinfo version fixture\"",
    "  exit 0",
    "fi",
    "sleep 30 &",
    "child_pid=$!",
    `echo \"$child_pid\" > \"${pidPath}\"`,
    "head -c 65536 /dev/zero",
    "wait \"$child_pid\"",
    "",
  ].join("\n"), "utf8");
  await chmod(fakePdfinfo, 0o700);

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const result = await ingestLocalFile(pdfPath, {
      maxCommandOutputBytes: 1_024,
      commandTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    assert.equal(result.status, "unresolved");
    if (result.status === "unresolved") assert.equal(result.code, "PDF_METADATA_FAILED");
  } finally {
    process.env.PATH = originalPath;
  }

  const childPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});
