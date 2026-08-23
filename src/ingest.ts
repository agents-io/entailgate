import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { sha256File, sha256Text } from "./canonical.js";

export type IngestMediaType = "text/plain" | "application/pdf";
export type OcrPolicy = "report" | "perform";
export type LocalToolName =
  | "node"
  | "pdfinfo"
  | "pdftotext"
  | "pdffonts"
  | "tesseract"
  | "ocrmypdf";

export interface ToolProvenance {
  name: LocalToolName;
  status: "available" | "unavailable";
  path?: string;
  version?: string;
  versionArgs: string[];
}

export interface ToolInvocation {
  tool: LocalToolName;
  args: string[];
  exitCode: number;
}

export interface SourceProvenance {
  path: string;
  mediaType: IngestMediaType;
  byteLength: number;
  sha256: string;
  snapshot: {
    sha256: string;
    byteLength: number;
    policy: "private_read_only_temp";
  };
}

export interface IngestedPage {
  pageNumber: number;
  pageId: string;
  locator: string;
  text: string;
  textSha256: string;
  characterCount: number;
  nonWhitespaceCharacterCount: number;
}

export type OcrReason =
  | "none"
  | "no_text"
  | "page_text_missing"
  | "page_text_sparse";

export interface OcrAssessment {
  required: boolean;
  reason: OcrReason;
  sparsePageThreshold: number;
  emptyPages: number[];
  sparsePages: number[];
}

export interface ExtractionProvenance {
  method: "node_utf8" | "pdftotext" | "ocrmypdf_pdftotext";
  tools: ToolProvenance[];
  invocations: ToolInvocation[];
  pdfPageCount?: number;
  pdfFontInspection?: "succeeded" | "failed" | "unavailable";
}

export interface OutputQualityProvenance {
  meaningOfReady: "TECHNICAL_EXTRACTION_COMPLETED_NOT_ACCURACY_VERIFIED";
  extractionAccuracy: "UNCHECKED";
  ocrAccuracy: "NOT_APPLICABLE" | "UNCHECKED";
  legalAccuracy: "UNCHECKED";
  exactQuoteReview: "SOURCE_TEXT_REVIEW_REQUIRED" | "PDF_VISUAL_REVIEW_REQUIRED";
  limitations: string[];
}

export interface IngestReady {
  status: "ready";
  source: SourceProvenance;
  pages: IngestedPage[];
  extraction: ExtractionProvenance;
  ocr: OcrAssessment & { performed: boolean };
  quality: OutputQualityProvenance;
}

export type IngestUnresolvedCode =
  | "SOURCE_UNREADABLE"
  | "SOURCE_NOT_REGULAR_FILE"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_CHANGED"
  | "SOURCE_SNAPSHOT_FAILED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_UTF8"
  | "BINARY_TEXT_REJECTED"
  | "PDF_TOOL_UNAVAILABLE"
  | "PDF_METADATA_FAILED"
  | "PDF_TEXT_EXTRACTION_FAILED"
  | "PDF_PAGE_LIMIT_EXCEEDED"
  | "EXTRACTED_TEXT_LIMIT_EXCEEDED"
  | "INGEST_DEADLINE_EXCEEDED"
  | "OCR_REQUIRED"
  | "OCR_TOOL_UNAVAILABLE"
  | "OCR_FAILED"
  | "OCR_OUTPUT_LIMIT_EXCEEDED"
  | "OCR_INCOMPLETE";

export interface IngestUnresolved {
  status: "unresolved";
  code: IngestUnresolvedCode;
  message: string;
  source?: SourceProvenance;
  pages?: IngestedPage[];
  extraction?: ExtractionProvenance;
  ocr?: OcrAssessment & { performed: boolean };
  missingTools?: LocalToolName[];
  quality: OutputQualityProvenance;
}

export type IngestResult = IngestReady | IngestUnresolved;

export interface IngestOptions {
  mediaType?: IngestMediaType;
  ocrPolicy?: OcrPolicy;
  sparsePageThreshold?: number;
  maxFileBytes?: number;
  commandTimeoutMs?: number;
  maxCommandOutputBytes?: number;
  maxPdfPages?: number;
  maxExtractedTextBytes?: number;
  totalTimeoutMs?: number;
  maxOcrOutputBytes?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  deadlineExceeded: boolean;
  outputLimitExceeded: boolean;
  fileOutputLimitExceeded: boolean;
}

interface PdfExtraction {
  pageCount: number;
  pageTexts: string[];
  invocations: ToolInvocation[];
}

interface PdfExtractionFailure {
  code:
    | "PDF_METADATA_FAILED"
    | "PDF_TEXT_EXTRACTION_FAILED"
    | "PDF_PAGE_LIMIT_EXCEEDED"
    | "EXTRACTED_TEXT_LIMIT_EXCEEDED"
    | "INGEST_DEADLINE_EXCEEDED";
  detail: string;
  invocations: ToolInvocation[];
}

interface ExtractionBudget {
  usedBytes: number;
  maxBytes: number;
}

interface MonitoredOutputFile {
  path: string;
  maxBytes: number;
}

interface SnapshotCopy {
  status: "ready";
  byteLength: number;
  sha256: string;
  magic: Buffer;
}

interface SnapshotFailure {
  status: "too_large" | "deadline" | "failed";
  byteLength?: number;
  detail: string;
}

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_SPARSE_PAGE_THRESHOLD = 40;
const DEFAULT_MAX_PDF_PAGES = 2_000;
const DEFAULT_MAX_EXTRACTED_TEXT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OCR_OUTPUT_BYTES = 256 * 1024 * 1024;

const TOOL_VERSION_ARGS: Record<Exclude<LocalToolName, "node">, string[]> = {
  pdfinfo: ["-v"],
  pdftotext: ["-v"],
  pdffonts: ["-v"],
  tesseract: ["--version"],
  ocrmypdf: ["--version"],
};

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function commandFailureMessage(result: CommandResult): string {
  if (result.deadlineExceeded) return "total ingestion deadline exceeded";
  if (result.fileOutputLimitExceeded) return "generated file exceeded the configured limit";
  if (result.timedOut) return "command timed out";
  if (result.outputLimitExceeded) return "command output exceeded the configured limit";
  const detail = firstNonEmptyLine(result.stderr.toString("utf8"));
  return detail === undefined ? `command exited with code ${result.exitCode}` : detail;
}

function terminateChildProcessGroup(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct process if the group has already exited.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may already have exited.
  }
}

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  deadlineAt?: number,
  monitoredOutputFile?: MonitoredOutputFile,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const remainingMs = deadlineAt === undefined ? timeoutMs : deadlineAt - Date.now();
    if (remainingMs <= 0) {
      resolveResult({
        exitCode: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        deadlineExceeded: true,
        outputLimitExceeded: false,
        fileOutputLimitExceeded: false,
      });
      return;
    }
    const deadlineControlsTimer = deadlineAt !== undefined && remainingMs <= timeoutMs;
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let deadlineExceeded = false;
    let outputLimitExceeded = false;
    let fileOutputLimitExceeded = false;
    let finishing = false;
    let fileCheckPromise: Promise<void> | undefined;

    const checkMonitoredFile = async (): Promise<void> => {
      if (monitoredOutputFile === undefined) return;
      if (fileCheckPromise !== undefined) {
        await fileCheckPromise;
        return;
      }
      fileCheckPromise = (async () => {
        try {
          const outputStat = await stat(monitoredOutputFile.path);
          if (outputStat.size > monitoredOutputFile.maxBytes) {
            fileOutputLimitExceeded = true;
            terminateChildProcessGroup(child);
          }
        } catch {
          // The output may not exist yet. The producing command decides whether that is an error.
        } finally {
          fileCheckPromise = undefined;
        }
      })();
      await fileCheckPromise;
    };

    const finish = async (exitCode: number): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearInterval(fileMonitor);
      if (fileCheckPromise !== undefined) await fileCheckPromise;
      await checkMonitoredFile();
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        deadlineExceeded,
        outputLimitExceeded,
        fileOutputLimitExceeded,
      });
    };

    const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (outputLimitExceeded) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        terminateChildProcessGroup(child);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", () => void finish(-1));
    child.once("close", (code) => void finish(code ?? -1));

    const timer = setTimeout(() => {
      if (deadlineControlsTimer) deadlineExceeded = true;
      else timedOut = true;
      terminateChildProcessGroup(child);
    }, effectiveTimeoutMs);
    timer.unref();
    const fileMonitor = monitoredOutputFile === undefined
      ? undefined
      : setInterval(() => void checkMonitoredFile(), 100);
    fileMonitor?.unref();
  });
}

async function resolveExecutable(name: string): Promise<string | undefined> {
  const candidates = name.includes("/")
    ? [isAbsolute(name) ? name : resolve(name)]
    : (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, name));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH. Absence is represented in ToolProvenance.
    }
  }
  return undefined;
}

export async function inspectIngestionTools(
  timeoutMs = 5_000,
  maxOutputBytes = 1024 * 1024,
  deadlineAt?: number,
): Promise<ToolProvenance[]> {
  const node = nodeToolProvenance();
  const names = Object.keys(TOOL_VERSION_ARGS) as Array<Exclude<LocalToolName, "node">>;
  const external = await Promise.all(names.map(async (name): Promise<ToolProvenance> => {
    const versionArgs = TOOL_VERSION_ARGS[name];
    const path = await resolveExecutable(name);
    if (path === undefined) return { name, status: "unavailable", versionArgs };
    const result = await runCommand(path, versionArgs, timeoutMs, maxOutputBytes, deadlineAt);
    const combined = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
    const version = firstNonEmptyLine(combined);
    if (result.exitCode !== 0 || version === undefined) {
      return { name, status: "unavailable", path, versionArgs };
    }
    return { name, status: "available", path, version, versionArgs };
  }));
  return [node, ...external];
}

function nodeToolProvenance(): ToolProvenance {
  return {
    name: "node",
    status: "available",
    path: process.execPath,
    version: process.version,
    versionArgs: ["--version"],
  };
}

function buildOutputQuality(
  mediaType: IngestMediaType | undefined,
  ocrUsedOrAttempted: boolean,
): OutputQualityProvenance {
  const limitations = [
    "READY means only that technical extraction completed within configured limits; it does not verify transcription, quotation, or legal accuracy.",
    "Local parser executables inherit PATH and environment and are not a complete security sandbox.",
    "A process crash or forced host termination may leave a private temporary snapshot behind.",
  ];
  if (mediaType === "application/pdf") {
    limitations.push(
      "Every exact quote from a PDF, including native text layers, requires visual comparison with the cited page.",
    );
  }
  if (ocrUsedOrAttempted) {
    limitations.push(
      "OCR character accuracy, reading order, language selection, and omitted content remain unchecked.",
    );
  }
  return {
    meaningOfReady: "TECHNICAL_EXTRACTION_COMPLETED_NOT_ACCURACY_VERIFIED",
    extractionAccuracy: "UNCHECKED",
    ocrAccuracy: ocrUsedOrAttempted ? "UNCHECKED" : "NOT_APPLICABLE",
    legalAccuracy: "UNCHECKED",
    exactQuoteReview: mediaType === "application/pdf"
      ? "PDF_VISUAL_REVIEW_REQUIRED"
      : "SOURCE_TEXT_REVIEW_REQUIRED",
    limitations,
  };
}

function isDeadlineExceeded(deadlineAt: number): boolean {
  return Date.now() >= deadlineAt;
}

async function copyPrivateSnapshot(
  sourcePath: string,
  snapshotPath: string,
  maxFileBytes: number,
  deadlineAt: number,
): Promise<SnapshotCopy | SnapshotFailure> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let input: Awaited<ReturnType<typeof open>> | undefined;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    input = await open(sourcePath, constants.O_RDONLY | noFollow);
    const openedStat = await input.stat();
    if (!openedStat.isFile()) {
      return { status: "failed", detail: "source must resolve to a regular file" };
    }
    if (openedStat.size > maxFileBytes) {
      return {
        status: "too_large",
        byteLength: openedStat.size,
        detail: `source is ${openedStat.size} bytes; configured limit is ${maxFileBytes} bytes`,
      };
    }
    output = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const hash = createHash("sha256");
    const magic = Buffer.alloc(5);
    let magicBytes = 0;
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      if (isDeadlineExceeded(deadlineAt)) {
        return { status: "deadline", byteLength: total, detail: "total ingestion deadline exceeded" };
      }
      const { bytesRead } = await input.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) {
        return {
          status: "too_large",
          byteLength: total,
          detail: `source exceeded the configured ${maxFileBytes}-byte limit while being snapshotted`,
        };
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (magicBytes < magic.length) {
        const copied = chunk.copy(magic, magicBytes, 0, magic.length - magicBytes);
        magicBytes += copied;
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, total - bytesRead + written);
        if (result.bytesWritten === 0) throw new Error("zero-byte snapshot write");
        written += result.bytesWritten;
      }
    }
    await output.sync();
    await chmod(snapshotPath, 0o400);
    const sha256 = hash.digest("hex");
    if (await sha256File(snapshotPath) !== sha256) {
      return { status: "failed", byteLength: total, detail: "snapshot hash verification failed" };
    }
    if (isDeadlineExceeded(deadlineAt)) {
      return { status: "deadline", byteLength: total, detail: "total ingestion deadline exceeded" };
    }
    return {
      status: "ready",
      byteLength: total,
      sha256,
      magic: magic.subarray(0, magicBytes),
    };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : "source snapshot failed",
    };
  } finally {
    await Promise.allSettled([input?.close(), output?.close()].filter(Boolean));
  }
}

function hasObviousBinaryControls(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
    if ((byte < 0x20 && !allowedWhitespace) || byte === 0x7f) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

function getTool(
  tools: ToolProvenance[],
  name: LocalToolName,
): ToolProvenance | undefined {
  return tools.find((tool) => tool.name === name && tool.status === "available");
}

export function parsePdfInfoPageCount(output: string): number | undefined {
  const match = /^Pages:\s+(\d+)\s*$/mu.exec(output);
  if (match?.[1] === undefined) return undefined;
  const count = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

export function assessOcrRequirement(
  pageTexts: readonly string[],
  sparsePageThreshold = DEFAULT_SPARSE_PAGE_THRESHOLD,
): OcrAssessment {
  if (!Number.isSafeInteger(sparsePageThreshold) || sparsePageThreshold < 0) {
    throw new RangeError("sparsePageThreshold must be a non-negative integer");
  }
  const counts = pageTexts.map((text) => (text.match(/\S/gu) ?? []).length);
  const emptyPages = counts
    .map((count, index) => ({ count, pageNumber: index + 1 }))
    .filter(({ count }) => count === 0)
    .map(({ pageNumber }) => pageNumber);
  const sparsePages = counts
    .map((count, index) => ({ count, pageNumber: index + 1 }))
    .filter(({ count }) => count > 0 && count < sparsePageThreshold)
    .map(({ pageNumber }) => pageNumber);
  const total = counts.reduce((sum, count) => sum + count, 0);

  let reason: OcrReason = "none";
  if (total === 0) reason = "no_text";
  else if (emptyPages.length > 0) reason = "page_text_missing";
  else if (sparsePages.length > 0) reason = "page_text_sparse";
  return {
    required: reason !== "none",
    reason,
    sparsePageThreshold,
    emptyPages,
    sparsePages,
  };
}

export function buildIngestedPages(
  sourceSha256: string,
  mediaType: IngestMediaType,
  pageTexts: readonly string[],
): IngestedPage[] {
  return pageTexts.map((text, index) => {
    const pageNumber = index + 1;
    const textSha256 = sha256Text(text);
    return {
      pageNumber,
      pageId: `${sourceSha256}:page:${pageNumber}:${textSha256}`,
      locator: mediaType === "application/pdf" ? `pdf:page=${pageNumber}` : "text:page=1",
      text,
      textSha256,
      characterCount: [...text].length,
      nonWhitespaceCharacterCount: (text.match(/\S/gu) ?? []).length,
    };
  });
}

function detectMediaType(magic: Buffer): IngestMediaType {
  return magic.toString("ascii") === "%PDF-" ? "application/pdf" : "text/plain";
}

async function extractPdfPages(
  sourcePath: string,
  pdfinfo: ToolProvenance,
  pdftotext: ToolProvenance,
  timeoutMs: number,
  maxOutputBytes: number,
  maxPdfPages: number,
  extractionBudget: ExtractionBudget,
  deadlineAt: number,
): Promise<PdfExtraction | PdfExtractionFailure> {
  const invocations: ToolInvocation[] = [];
  const infoArgs = [sourcePath];
  const info = await runCommand(pdfinfo.path!, infoArgs, timeoutMs, maxOutputBytes, deadlineAt);
  invocations.push({ tool: "pdfinfo", args: ["<SOURCE>"], exitCode: info.exitCode });
  if (info.deadlineExceeded) {
    return {
      code: "INGEST_DEADLINE_EXCEEDED",
      detail: commandFailureMessage(info),
      invocations,
    };
  }
  if (info.exitCode !== 0) {
    return { code: "PDF_METADATA_FAILED", detail: commandFailureMessage(info), invocations };
  }
  const pageCount = parsePdfInfoPageCount(info.stdout.toString("utf8"));
  if (pageCount === undefined) {
    return {
      code: "PDF_METADATA_FAILED",
      detail: "pdfinfo did not report a positive page count",
      invocations,
    };
  }
  if (pageCount > maxPdfPages) {
    return {
      code: "PDF_PAGE_LIMIT_EXCEEDED",
      detail: `PDF has ${pageCount} pages; configured limit is ${maxPdfPages}`,
      invocations,
    };
  }

  const pageTexts: string[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const args = [
      "-f", String(page),
      "-l", String(page),
      "-enc", "UTF-8",
      "-layout",
      "-nopgbrk",
      sourcePath,
      "-",
    ];
    const extracted = await runCommand(
      pdftotext.path!,
      args,
      timeoutMs,
      maxOutputBytes,
      deadlineAt,
    );
    invocations.push({
      tool: "pdftotext",
      args: [
        "-f", String(page),
        "-l", String(page),
        "-enc", "UTF-8",
        "-layout",
        "-nopgbrk",
        "<SOURCE>",
        "<STDOUT>",
      ],
      exitCode: extracted.exitCode,
    });
    if (extracted.deadlineExceeded) {
      return {
        code: "INGEST_DEADLINE_EXCEEDED",
        detail: commandFailureMessage(extracted),
        invocations,
      };
    }
    if (extracted.exitCode !== 0) {
      return {
        code: "PDF_TEXT_EXTRACTION_FAILED",
        detail: commandFailureMessage(extracted),
        invocations,
      };
    }
    extractionBudget.usedBytes += extracted.stdout.length;
    if (extractionBudget.usedBytes > extractionBudget.maxBytes) {
      return {
        code: "EXTRACTED_TEXT_LIMIT_EXCEEDED",
        detail: `extracted text exceeded the configured ${extractionBudget.maxBytes}-byte total limit`,
        invocations,
      };
    }
    pageTexts.push(extracted.stdout.toString("utf8"));
  }
  return { pageCount, pageTexts, invocations };
}

function makeExtraction(
  method: ExtractionProvenance["method"],
  tools: ToolProvenance[],
  invocations: ToolInvocation[],
  pageCount: number | undefined,
  fontInspection: ExtractionProvenance["pdfFontInspection"] | undefined,
): ExtractionProvenance {
  const result: ExtractionProvenance = { method, tools, invocations };
  if (pageCount !== undefined) result.pdfPageCount = pageCount;
  if (fontInspection !== undefined) result.pdfFontInspection = fontInspection;
  return result;
}

async function verifySourceUnchanged(source: SourceProvenance): Promise<boolean> {
  try {
    const current = await stat(source.path);
    if (!current.isFile() || current.size !== source.byteLength) return false;
    return await sha256File(source.path) === source.sha256;
  } catch {
    return false;
  }
}

async function sourceChangedResult(
  source: SourceProvenance,
  fields: Omit<IngestUnresolved, "status" | "code" | "message" | "source" | "quality"> = {},
  deadlineAt?: number,
): Promise<IngestUnresolved | undefined> {
  const unchanged = await verifySourceUnchanged(source);
  if (deadlineAt !== undefined && isDeadlineExceeded(deadlineAt)) {
    return unresolved("INGEST_DEADLINE_EXCEEDED", "total ingestion deadline exceeded", {
      source,
      ...fields,
    });
  }
  if (unchanged) return undefined;
  return unresolved("SOURCE_CHANGED", "source content changed during ingestion", {
    source,
    ...fields,
  });
}

function unresolved(
  code: IngestUnresolvedCode,
  message: string,
  fields: Omit<IngestUnresolved, "status" | "code" | "message" | "quality"> = {},
): IngestUnresolved {
  const ocrUsedOrAttempted = fields.ocr?.performed === true
    || fields.extraction?.method === "ocrmypdf_pdftotext";
  return {
    status: "unresolved",
    code,
    message,
    ...fields,
    quality: buildOutputQuality(fields.source?.mediaType, ocrUsedOrAttempted),
  };
}

export async function ingestLocalFile(
  inputPath: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxCommandOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  const sparsePageThreshold = options.sparsePageThreshold ?? DEFAULT_SPARSE_PAGE_THRESHOLD;
  const maxPdfPages = options.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES;
  const maxExtractedTextBytes = options.maxExtractedTextBytes
    ?? DEFAULT_MAX_EXTRACTED_TEXT_BYTES;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxOcrOutputBytes = options.maxOcrOutputBytes ?? DEFAULT_MAX_OCR_OUTPUT_BYTES;
  const ocrPolicy = options.ocrPolicy ?? "report";
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new RangeError("maxFileBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("commandTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxCommandOutputBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(sparsePageThreshold) || sparsePageThreshold < 0) {
    throw new RangeError("sparsePageThreshold must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxPdfPages) || maxPdfPages <= 0) {
    throw new RangeError("maxPdfPages must be a positive integer");
  }
  if (!Number.isSafeInteger(maxExtractedTextBytes) || maxExtractedTextBytes <= 0) {
    throw new RangeError("maxExtractedTextBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError("totalTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOcrOutputBytes) || maxOcrOutputBytes <= 0) {
    throw new RangeError("maxOcrOutputBytes must be a positive integer");
  }
  const deadlineAt = Date.now() + totalTimeoutMs;

  let sourcePath: string;
  let sourceStat: Awaited<ReturnType<typeof stat>>;
  try {
    const linkStat = await lstat(inputPath);
    if (!linkStat.isFile() && !linkStat.isSymbolicLink()) {
      return unresolved("SOURCE_NOT_REGULAR_FILE", "source must be a regular file");
    }
    sourcePath = await realpath(inputPath);
    sourceStat = await stat(sourcePath);
  } catch (error) {
    return unresolved(
      "SOURCE_UNREADABLE",
      error instanceof Error ? error.message : "source could not be opened",
    );
  }
  if (!sourceStat.isFile()) {
    return unresolved("SOURCE_NOT_REGULAR_FILE", "source must resolve to a regular file");
  }
  if (sourceStat.size > maxFileBytes) {
    return unresolved(
      "SOURCE_TOO_LARGE",
      `source is ${sourceStat.size} bytes; configured limit is ${maxFileBytes} bytes`,
    );
  }

  let temporaryDirectory: string;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "ebr-ingest-"));
    await chmod(temporaryDirectory, 0o700);
  } catch (error) {
    return unresolved(
      isDeadlineExceeded(deadlineAt) ? "INGEST_DEADLINE_EXCEEDED" : "SOURCE_SNAPSHOT_FAILED",
      error instanceof Error ? error.message : "private snapshot directory could not be created",
    );
  }
  const snapshotPath = join(temporaryDirectory, "source.snapshot");
  try {
    const snapshot = await copyPrivateSnapshot(
      sourcePath,
      snapshotPath,
      maxFileBytes,
      deadlineAt,
    );
    if (snapshot.status !== "ready") {
      const code: IngestUnresolvedCode = snapshot.status === "too_large"
        ? "SOURCE_TOO_LARGE"
        : snapshot.status === "deadline"
          ? "INGEST_DEADLINE_EXCEEDED"
          : "SOURCE_SNAPSHOT_FAILED";
      return unresolved(code, snapshot.detail);
    }

    const detectedMediaType = detectMediaType(snapshot.magic);
    const mediaType = options.mediaType ?? detectedMediaType;
    const source: SourceProvenance = {
      path: sourcePath,
      mediaType: options.mediaType !== undefined && options.mediaType !== detectedMediaType
        ? detectedMediaType
        : mediaType,
      byteLength: snapshot.byteLength,
      sha256: snapshot.sha256,
      snapshot: {
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength,
        policy: "private_read_only_temp",
      },
    };
    const changed = await sourceChangedResult(source, {}, deadlineAt);
    if (changed !== undefined) return changed;
    if (options.mediaType !== undefined && options.mediaType !== detectedMediaType) {
      return unresolved(
        "UNSUPPORTED_MEDIA_TYPE",
        `declared ${options.mediaType} but file signature indicates ${detectedMediaType}`,
        { source },
      );
    }

    if (mediaType === "text/plain") {
      let bytes: Buffer;
      try {
        bytes = await readFile(snapshotPath);
      } catch (error) {
        return unresolved(
          "SOURCE_SNAPSHOT_FAILED",
          error instanceof Error ? error.message : "private snapshot could not be read",
          { source },
        );
      }
      if (bytes.length > maxExtractedTextBytes) {
        return unresolved(
          "EXTRACTED_TEXT_LIMIT_EXCEEDED",
          `plain text is ${bytes.length} bytes; configured extracted-text limit is ${maxExtractedTextBytes} bytes`,
          { source },
        );
      }
      if (hasObviousBinaryControls(bytes)) {
        return unresolved(
          "BINARY_TEXT_REJECTED",
          "non-PDF input contains NUL bytes or an excessive control-byte ratio",
          { source },
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        const changedText = await sourceChangedResult(source, {}, deadlineAt);
        if (changedText !== undefined) return changedText;
        return unresolved(
          "INVALID_UTF8",
          error instanceof Error ? error.message : "plain-text source is not valid UTF-8",
          { source },
        );
      }
      const changedText = await sourceChangedResult(source, {}, deadlineAt);
      if (changedText !== undefined) return changedText;
      const tools = [nodeToolProvenance()];
      const pages = buildIngestedPages(source.sha256, mediaType, [text]);
      return {
        status: "ready",
        source,
        pages,
        extraction: {
          method: "node_utf8",
          tools,
          invocations: [{ tool: "node", args: ["TextDecoder(utf-8,fatal=true)"], exitCode: 0 }],
        },
        ocr: {
          required: false,
          performed: false,
          reason: "none",
          sparsePageThreshold,
          emptyPages: [],
          sparsePages: [],
        },
        quality: buildOutputQuality(mediaType, false),
      };
    }

    const tools = await inspectIngestionTools(timeoutMs, maxOutputBytes, deadlineAt);
    if (isDeadlineExceeded(deadlineAt)) {
      return unresolved("INGEST_DEADLINE_EXCEEDED", "total ingestion deadline exceeded", { source });
    }
    const pdfinfo = getTool(tools, "pdfinfo");
    const pdftotext = getTool(tools, "pdftotext");
    const missingPdfTools = ([
      ["pdfinfo", pdfinfo],
      ["pdftotext", pdftotext],
    ] as const).filter((entry) => entry[1] === undefined).map((entry) => entry[0]);
    if (pdfinfo === undefined || pdftotext === undefined) {
      const extraction = makeExtraction("pdftotext", tools, [], undefined, undefined);
      const changedTools = await sourceChangedResult(source, { extraction }, deadlineAt);
      if (changedTools !== undefined) return changedTools;
      return unresolved(
        "PDF_TOOL_UNAVAILABLE",
        `required PDF tools unavailable: ${missingPdfTools.join(", ")}`,
        {
          source,
          extraction,
          missingTools: missingPdfTools,
        },
      );
    }

    let fontInspection: ExtractionProvenance["pdfFontInspection"] = "unavailable";
    const preliminaryInvocations: ToolInvocation[] = [];
    const pdffonts = getTool(tools, "pdffonts");
    if (pdffonts !== undefined) {
      const fontResult = await runCommand(
        pdffonts.path!,
        [snapshotPath],
        timeoutMs,
        maxOutputBytes,
        deadlineAt,
      );
      preliminaryInvocations.push({
        tool: "pdffonts",
        args: ["<PRIVATE_SOURCE_SNAPSHOT>"],
        exitCode: fontResult.exitCode,
      });
      if (fontResult.deadlineExceeded) {
        const extraction = makeExtraction(
          "pdftotext",
          tools,
          preliminaryInvocations,
          undefined,
          "failed",
        );
        return unresolved("INGEST_DEADLINE_EXCEEDED", commandFailureMessage(fontResult), {
          source,
          extraction,
        });
      }
      fontInspection = fontResult.exitCode === 0 ? "succeeded" : "failed";
    }

    const extractionBudget: ExtractionBudget = {
      usedBytes: 0,
      maxBytes: maxExtractedTextBytes,
    };
    const initial = await extractPdfPages(
      snapshotPath,
      pdfinfo,
      pdftotext,
      timeoutMs,
      maxOutputBytes,
      maxPdfPages,
      extractionBudget,
      deadlineAt,
    );
    if ("code" in initial) {
      const extraction = makeExtraction(
        "pdftotext",
        tools,
        [...preliminaryInvocations, ...initial.invocations],
        undefined,
        fontInspection,
      );
      const changedInitial = await sourceChangedResult(source, { extraction }, deadlineAt);
      if (changedInitial !== undefined) return changedInitial;
      return unresolved(initial.code, initial.detail, { source, extraction });
    }
    const initialPages = buildIngestedPages(source.sha256, mediaType, initial.pageTexts);
    const initialOcr = assessOcrRequirement(initial.pageTexts, sparsePageThreshold);
    const initialExtraction = makeExtraction(
      "pdftotext",
      tools,
      [...preliminaryInvocations, ...initial.invocations],
      initial.pageCount,
      fontInspection,
    );
    if (!initialOcr.required) {
      const changedInitial = await sourceChangedResult(source, {
        pages: initialPages,
        extraction: initialExtraction,
        ocr: { ...initialOcr, performed: false },
      }, deadlineAt);
      if (changedInitial !== undefined) return changedInitial;
      return {
        status: "ready",
        source,
        pages: initialPages,
        extraction: initialExtraction,
        ocr: { ...initialOcr, performed: false },
        quality: buildOutputQuality(mediaType, false),
      };
    }
    if (ocrPolicy === "report") {
      const changedInitial = await sourceChangedResult(source, {
        pages: initialPages,
        extraction: initialExtraction,
        ocr: { ...initialOcr, performed: false },
      }, deadlineAt);
      if (changedInitial !== undefined) return changedInitial;
      return unresolved(
        "OCR_REQUIRED",
        `PDF extraction is incomplete (${initialOcr.reason}); explicit OCR authorization is required`,
        {
          source,
          pages: initialPages,
          extraction: initialExtraction,
          ocr: { ...initialOcr, performed: false },
        },
      );
    }

    const ocrmypdf = getTool(tools, "ocrmypdf");
    const tesseract = getTool(tools, "tesseract");
    const missingOcrTools = ([
      ["ocrmypdf", ocrmypdf],
      ["tesseract", tesseract],
    ] as const).filter((entry) => entry[1] === undefined).map((entry) => entry[0]);
    if (ocrmypdf === undefined || tesseract === undefined) {
      const changedOcrTools = await sourceChangedResult(source, {
        pages: initialPages,
        extraction: initialExtraction,
        ocr: { ...initialOcr, performed: false },
        missingTools: missingOcrTools,
      }, deadlineAt);
      if (changedOcrTools !== undefined) return changedOcrTools;
      return unresolved(
        "OCR_TOOL_UNAVAILABLE",
        `OCR was explicitly requested but tools are unavailable: ${missingOcrTools.join(", ")}`,
        {
          source,
          pages: initialPages,
          extraction: initialExtraction,
          ocr: { ...initialOcr, performed: false },
          missingTools: missingOcrTools,
        },
      );
    }

    const ocrPath = join(temporaryDirectory, "ocr-output.pdf");
    const ocrArgs = [
      "--redo-ocr",
      "--output-type", "pdf",
      "--quiet",
      snapshotPath,
      ocrPath,
    ];
    const ocrResult = await runCommand(
      ocrmypdf.path!,
      ocrArgs,
      timeoutMs,
      maxOutputBytes,
      deadlineAt,
      { path: ocrPath, maxBytes: maxOcrOutputBytes },
    );
    const ocrInvocation: ToolInvocation = {
      tool: "ocrmypdf",
      args: [
        "--redo-ocr",
        "--output-type", "pdf",
        "--quiet",
        "<PRIVATE_SOURCE_SNAPSHOT>",
        "<PRIVATE_TEMP_OUTPUT>",
      ],
      exitCode: ocrResult.exitCode,
    };
    const attemptedOcrExtraction = makeExtraction(
      "ocrmypdf_pdftotext",
      tools,
      [...initialExtraction.invocations, ocrInvocation],
      initial.pageCount,
      fontInspection,
    );
    if (ocrResult.fileOutputLimitExceeded) {
      return unresolved(
        "OCR_OUTPUT_LIMIT_EXCEEDED",
        `OCR output exceeded the configured ${maxOcrOutputBytes}-byte limit`,
        {
          source,
          pages: initialPages,
          extraction: attemptedOcrExtraction,
          ocr: { ...initialOcr, performed: false },
        },
      );
    }
    if (ocrResult.deadlineExceeded) {
      return unresolved("INGEST_DEADLINE_EXCEEDED", commandFailureMessage(ocrResult), {
        source,
        pages: initialPages,
        extraction: attemptedOcrExtraction,
        ocr: { ...initialOcr, performed: false },
      });
    }
    if (ocrResult.exitCode !== 0) {
      const changedOcr = await sourceChangedResult(source, {
        pages: initialPages,
        extraction: attemptedOcrExtraction,
        ocr: { ...initialOcr, performed: false },
      }, deadlineAt);
      if (changedOcr !== undefined) return changedOcr;
      return unresolved("OCR_FAILED", commandFailureMessage(ocrResult), {
        source,
        pages: initialPages,
        extraction: attemptedOcrExtraction,
        ocr: { ...initialOcr, performed: false },
      });
    }

    const extractedOcr = await extractPdfPages(
      ocrPath,
      pdfinfo,
      pdftotext,
      timeoutMs,
      maxOutputBytes,
      maxPdfPages,
      extractionBudget,
      deadlineAt,
    );
    if ("code" in extractedOcr) {
      const extraction = makeExtraction(
        "ocrmypdf_pdftotext",
        tools,
        [...attemptedOcrExtraction.invocations, ...extractedOcr.invocations],
        initial.pageCount,
        fontInspection,
      );
      const changedExtractedOcr = await sourceChangedResult(source, {
        pages: initialPages,
        extraction,
        ocr: { ...initialOcr, performed: true },
      }, deadlineAt);
      if (changedExtractedOcr !== undefined) return changedExtractedOcr;
      const code = extractedOcr.code === "PDF_METADATA_FAILED"
        || extractedOcr.code === "PDF_TEXT_EXTRACTION_FAILED"
        ? "OCR_FAILED"
        : extractedOcr.code;
      return unresolved(code, extractedOcr.detail, {
        source,
        pages: initialPages,
        extraction,
        ocr: { ...initialOcr, performed: true },
      });
    }
    const ocrPages = buildIngestedPages(source.sha256, mediaType, extractedOcr.pageTexts);
    const postOcrAssessment = assessOcrRequirement(extractedOcr.pageTexts, sparsePageThreshold);
    const ocrExtraction = makeExtraction(
      "ocrmypdf_pdftotext",
      tools,
      [...attemptedOcrExtraction.invocations, ...extractedOcr.invocations],
      extractedOcr.pageCount,
      fontInspection,
    );
    const changedOcrResult = await sourceChangedResult(source, {
      pages: ocrPages,
      extraction: ocrExtraction,
      ocr: { ...postOcrAssessment, performed: true },
    }, deadlineAt);
    if (changedOcrResult !== undefined) return changedOcrResult;
    if (postOcrAssessment.required) {
      return unresolved(
        "OCR_INCOMPLETE",
        `OCR completed but text remains incomplete (${postOcrAssessment.reason})`,
        {
          source,
          pages: ocrPages,
          extraction: ocrExtraction,
          ocr: { ...postOcrAssessment, performed: true },
        },
      );
    }
    return {
      status: "ready",
      source,
      pages: ocrPages,
      extraction: ocrExtraction,
      ocr: { ...postOcrAssessment, performed: true },
      quality: buildOutputQuality(mediaType, true),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
