import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashObject, sha256File, sha256Text } from "./canonical.js";
import { ingestLocalFile, type IngestResult, type OcrPolicy } from "./ingest.js";
import { createLegalManifestSkeleton, loadLegalManifest } from "./legal.js";
import { writeAuditTrace } from "./trace.js";
import {
  ensurePrivateDirectory,
  isNonEmptyString,
  isRecord,
  isSha256Hex,
  newTraceId,
  readJsonFile,
} from "./trace-io.js";
import type {
  AtomicClaim,
  EvidenceChunk,
  SourceRecord,
  VerificationResult,
  VerifyRequest,
} from "./types.js";
import { assertVerifyRequest, ContractError } from "./validate.js";
import { ENGINE_VERSION, verifyRequest } from "./verify.js";

// A private, local-only workspace for the first internal BC-legal dogfood run.
//
// What this module is: a bounded, deterministic wrapper that snapshots one
// draft, enumerates one evidence directory, runs the existing `ingestLocalFile`
// over every regular file it finds, and writes a private manifest skeleton plus
// a human review checklist. Everything it does is mechanical.
//
// What this module is NOT: it does not extract claims, does not classify source
// authority, does not decide that evidence supports a draft, and does not treat
// "every file parsed" as "the evidence is complete". `ready` from ingestion
// still means technical extraction only. Coverage stays `complete=false` and the
// claims array stays empty until a human fills them in, and the review
// checklist starts entirely `false` because it records human work that this
// runtime cannot perform or observe.
//
// The verification gate below therefore refuses far more often than it allows.
// A blocked run writes no trace at all, so a refusal never leaves an artifact
// that could later be mistaken for a verification record.

export const DOGFOOD_WORKSPACE_SCHEMA_VERSION = "0.1.0-alpha";
export const DOGFOOD_WORKSPACE_KIND = "dogfood-workspace";
export const DOGFOOD_INVENTORY_KIND = "dogfood-evidence-inventory";
export const DOGFOOD_REVIEW_KIND = "dogfood-review-checklist";

// Fixed artifact names. `workspace.json` records these too, but only so the
// file is self-describing: every reader compares the recorded value against the
// constant below and refuses anything else, so a resealed metadata file cannot
// redirect a read or a write to another name, to a parent directory, or to an
// absolute path outside the workspace.
export const WORKSPACE_METADATA_FILE = "workspace.json";
export const EVIDENCE_INVENTORY_FILE = "evidence-inventory.json";
export const MANIFEST_FILE = "manifest.json";
export const REVIEW_FILE = "review.json";
export const DRAFT_SNAPSHOT_FILE = "draft/draft.snapshot";
export const DEFAULT_TRACE_DIRECTORY = "traces";

const DRAFT_DIRECTORY = "draft";
const DRAFT_SNAPSHOT_NAME = "draft.snapshot";

export const DEFAULT_MAX_EVIDENCE_FILES = 500;
export const DEFAULT_MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_EVIDENCE_ENTRIES = 5_000;
export const DEFAULT_MAX_EVIDENCE_DEPTH = 32;
export const DEFAULT_MAX_DRAFT_BYTES = 8 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Typed failures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Conditions that stop the utility entirely. These are contract failures, not
 * findings about the work: the caller passed something this workflow refuses to
 * operate on, or the workspace root itself cannot be read.
 */
export type DogfoodIssueCode =
  | "WORKSPACE_INPUT_INVALID"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_PATH_OVERLAP"
  | "WORKSPACE_PATH_UNSAFE"
  | "DRAFT_UNREADABLE"
  | "EVIDENCE_ROOT_UNREADABLE"
  | "EVIDENCE_LIMIT_EXCEEDED"
  | "EVIDENCE_ID_COLLISION"
  | "WORKSPACE_WRITE_FAILED"
  | "WORKSPACE_METADATA_UNREADABLE";

export class DogfoodWorkspaceError extends Error {
  constructor(
    public readonly codes: DogfoodIssueCode[],
    public readonly issues: string[],
  ) {
    super(`Dogfood workspace failed closed: ${issues.join("; ")}`);
    this.name = "DogfoodWorkspaceError";
  }
}

function fail(code: DogfoodIssueCode, issue: string): never {
  throw new DogfoodWorkspaceError([code], [issue]);
}

/**
 * Conditions that keep the workspace from reaching the verifier. Unlike the
 * codes above these are expected output: a freshly initialised workspace always
 * carries several, because a human has not done the review work yet.
 */
export type DogfoodBlockerCode =
  | "EVIDENCE_ENTRY_SKIPPED"
  | "EVIDENCE_ENTRY_UNRESOLVED"
  | "EVIDENCE_NO_READY_SOURCE"
  | "DRAFT_SNAPSHOT_MISSING"
  | "DRAFT_SNAPSHOT_CHANGED"
  | "INVENTORY_MISSING"
  | "INVENTORY_INVALID"
  | "INVENTORY_CHANGED"
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "MANIFEST_IDENTITY_CHANGED"
  | "MANIFEST_SUBJECT_HASH_MISMATCH"
  | "MANIFEST_POLICY_WEAKENED"
  | "MANIFEST_COVERAGE_INCOMPLETE"
  | "MANIFEST_CLAIMS_EMPTY"
  | "MANIFEST_CLAIM_JURISDICTION_MISSING"
  | "MANIFEST_CLAIM_AUTHORITY_MISSING"
  | "MANIFEST_SOURCE_NOT_IN_INVENTORY"
  | "MANIFEST_SOURCE_AUTHORITY_UNCLASSIFIED"
  | "MANIFEST_SOURCE_JURISDICTION_MISSING"
  | "MANIFEST_CHUNK_NOT_IN_INVENTORY"
  | "MANIFEST_PROVENANCE_UNBOUND"
  | "MANIFEST_STRUCTURED_FACTS_UNBOUND"
  | "MANIFEST_CHANGED_DURING_VERIFICATION"
  | "REVIEW_MISSING"
  | "REVIEW_INVALID"
  | "REVIEW_CONFIRMATION_MISSING";

export interface DogfoodBlocker {
  code: DogfoodBlockerCode;
  message: string;
}

function blocker(code: DogfoodBlockerCode, message: string): DogfoodBlocker {
  return { code, message };
}

function sortBlockers(blockers: readonly DogfoodBlocker[]): DogfoodBlocker[] {
  return [...blockers].sort((left, right) =>
    left.code === right.code
      ? compareStrings(left.message, right.message)
      : compareStrings(left.code, right.code)
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Artifact shapes                                                            */
/* -------------------------------------------------------------------------- */

export type EvidenceEntryType =
  | "file"
  | "symlink"
  | "socket"
  | "fifo"
  | "character_device"
  | "block_device"
  | "unknown";

export type EvidenceEntryStatus = "ready" | "unresolved" | "skipped";

export interface DogfoodEvidencePage {
  pageNumber: number;
  chunkId: string;
  locator: string;
  textSha256: string;
  characterCount: number;
  nonWhitespaceCharacterCount: number;
}

/**
 * One enumerated filesystem entry. Every entry the walk saw appears here,
 * including the ones that were skipped, so a non-regular entry can never
 * disappear quietly between enumeration and ingestion.
 *
 * Paths are evidence-root-relative. Extracted text lives in the manifest, not
 * here: this artifact is the deterministic index, and it stays readable.
 */
export interface DogfoodEvidenceEntry {
  entryId: string;
  relativePath: string;
  entryType: EvidenceEntryType;
  status: EvidenceEntryStatus;
  byteLength: number;
  code?: string;
  message?: string;
  sourceId?: string;
  sha256?: string;
  mediaType?: string;
  extractionMethod?: string;
  ocr?: { required: boolean; performed: boolean; reason: string };
  quality?: {
    meaningOfReady: string;
    extractionAccuracy: string;
    ocrAccuracy: string;
    legalAccuracy: string;
    exactQuoteReview: string;
  };
  pages?: DogfoodEvidencePage[];
}

export interface DogfoodEvidenceInventory {
  schemaVersion: string;
  kind: string;
  createdAt: string;
  ocrPolicy: OcrPolicy;
  totals: {
    entries: number;
    ready: number;
    unresolved: number;
    skipped: number;
    directoriesTraversed: number;
    readyPages: number;
    readyBytes: number;
  };
  entries: DogfoodEvidenceEntry[];
}

export type DogfoodConfirmationName =
  | "materialClaimCoverageReviewed"
  | "sourceSelectionAndAuthorityReviewed"
  | "exactQuotationAndPinpointReviewed"
  | "pdfVisualQuoteReviewCompleted"
  | "ocrVisualReviewCompleted";

export const DOGFOOD_CONFIRMATION_NAMES: readonly DogfoodConfirmationName[] = [
  "materialClaimCoverageReviewed",
  "sourceSelectionAndAuthorityReviewed",
  "exactQuotationAndPinpointReviewed",
  "pdfVisualQuoteReviewCompleted",
  "ocrVisualReviewCompleted",
];

/**
 * The human gate. Every value starts `false` and only a person may change one.
 * Nothing in this runtime writes `true` here, and nothing infers a confirmation
 * from the fact that extraction succeeded. It is not a `SemanticAttestation`:
 * it is not hash-bound to a claim and it authorises no reuse.
 */
export interface DogfoodReviewChecklist {
  schemaVersion: string;
  kind: string;
  createdAt: string;
  note: string;
  confirmations: Record<DogfoodConfirmationName, boolean>;
}

export interface DogfoodWorkspaceMetadataCore {
  schemaVersion: string;
  kind: string;
  workspaceId: string;
  createdAt: string;
  engineVersion: string;
  ocrPolicy: OcrPolicy;
  limits: {
    maxEvidenceFiles: number;
    maxEvidenceBytes: number;
    maxEvidenceEntries: number;
    maxEvidenceDepth: number;
    maxDraftBytes: number;
  };
  /** Absolute host paths. Private metadata only; never printed to stdout. */
  hostPaths: {
    draftPath: string;
    evidenceRoot: string;
  };
  draftSnapshot: {
    file: string;
    sha256: string;
    byteLength: number;
  };
  inventory: {
    file: string;
    sha256: string;
    inventoryHash: string;
    entryCount: number;
  };
  manifest: {
    file: string;
    initialSha256: string;
    requestId: string;
    snapshotId: string;
    subjectSha256: string;
  };
  review: {
    file: string;
    initialSha256: string;
  };
  traceDirectory: string;
}

export interface DogfoodWorkspaceMetadata extends DogfoodWorkspaceMetadataCore {
  metadataHash: string;
}

/* -------------------------------------------------------------------------- */
/* Path safety                                                                */
/* -------------------------------------------------------------------------- */

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

/**
 * True when `child` sits strictly inside `parent`. Both must be resolved.
 *
 * The outside test is the exact relative segment `..`, or a path whose first
 * segment is `..`. Testing for the string prefix `..` instead would call a
 * child literally named `..workspace` "outside" its own parent, which would let
 * a workspace be created inside the evidence directory it is enumerating.
 */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

/**
 * Resolves a path that must already exist and refuses any symlinked component.
 *
 * A symlinked component makes two different questions ("is this inside the
 * evidence root?" and "is this inside the workspace?") answerable two different
 * ways, which is exactly the ambiguity an overlap check must not have. Rather
 * than silently following the link and operating somewhere the caller did not
 * name, this refuses and asks for the resolved path.
 */
async function resolveExistingPath(
  input: string,
  label: string,
): Promise<{ path: string; isDirectory: boolean; isFile: boolean; byteLength: number }> {
  const absolute = resolve(input);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    fail(
      label === "--evidence-dir" ? "EVIDENCE_ROOT_UNREADABLE" : "WORKSPACE_INPUT_INVALID",
      `${label} could not be read: ${errorMessage(error)}`,
    );
  }
  if (stats.isSymbolicLink()) {
    fail("WORKSPACE_PATH_UNSAFE", `${label} is a symbolic link; pass the resolved path instead`);
  }
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (error) {
    fail("WORKSPACE_PATH_UNSAFE", `${label} could not be resolved: ${errorMessage(error)}`);
  }
  if (resolved !== absolute) {
    fail(
      "WORKSPACE_PATH_UNSAFE",
      `${label} resolves through a symbolic link to a different path; pass ${resolved} instead`,
    );
  }
  return {
    path: resolved,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    byteLength: stats.size,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Resolves an existing workspace root for a reopen (`status` or `verify`).
 *
 * `init` only ever creates a workspace under a `realpath`-clean parent, so a
 * later run finding a symbolic link anywhere along the path means the workspace
 * moved or something is standing in front of it. Reading the artifacts through
 * that link would attribute whatever is on the other side to this workspace, so
 * the reopen refuses and names the path it actually resolved to.
 */
async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  const absolute = resolve(workspacePath);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    fail("WORKSPACE_METADATA_UNREADABLE", `--workspace could not be read: ${errorMessage(error)}`);
  }
  if (stats.isSymbolicLink()) {
    fail("WORKSPACE_PATH_UNSAFE", "--workspace is a symbolic link; pass the resolved path instead");
  }
  if (!stats.isDirectory()) {
    fail("WORKSPACE_INPUT_INVALID", "--workspace must be a directory");
  }
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (error) {
    fail("WORKSPACE_PATH_UNSAFE", `--workspace could not be resolved: ${errorMessage(error)}`);
  }
  if (resolved !== absolute) {
    fail(
      "WORKSPACE_PATH_UNSAFE",
      `--workspace resolves through a symbolic link to a different path; pass ${resolved} instead`,
    );
  }
  return resolved;
}

/**
 * Checks one fixed artifact before it is opened, and reports whether it is
 * there at all.
 *
 * Every component of the relative path is inspected, so a symlinked `draft/`
 * directory is refused just like a symlinked `draft/draft.snapshot`. A missing
 * artifact returns `false` and stays an ordinary blocker — that is a workspace
 * someone deleted a file from, not an unsafe one. A symlink or a non-regular
 * file in a fixed artifact's place is a contract failure: the workspace no
 * longer contains its own artifacts, and no blocker list can express that
 * honestly.
 */
async function assertSafeWorkspaceArtifact(
  workspace: string,
  relativePath: string,
  label: string,
): Promise<boolean> {
  const components = relativePath.split("/");
  let current = workspace;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const isLeaf = index === components.length - 1;
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return false;
      fail("WORKSPACE_PATH_UNSAFE", `${label} could not be inspected: ${errorMessage(error)}`);
    }
    if (stats.isSymbolicLink()) {
      fail(
        "WORKSPACE_PATH_UNSAFE",
        `${label} passes through a symbolic link inside the workspace; refusing to read it`,
      );
    }
    if (isLeaf ? !stats.isFile() : !stats.isDirectory()) {
      fail(
        "WORKSPACE_PATH_UNSAFE",
        isLeaf
          ? `${label} is not a regular file`
          : `${label} is not held in a real directory`,
      );
    }
  }
  return true;
}

/** Refuses a symlink or a non-directory standing where a trace directory goes. */
async function assertSafeTraceDirectory(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    fail("WORKSPACE_PATH_UNSAFE", `trace directory could not be inspected: ${errorMessage(error)}`);
  }
  if (stats.isSymbolicLink()) {
    fail("WORKSPACE_PATH_UNSAFE", "trace directory is a symbolic link; refusing to write through it");
  }
  if (!stats.isDirectory()) {
    fail("WORKSPACE_PATH_UNSAFE", "trace directory exists and is not a directory");
  }
}

/* -------------------------------------------------------------------------- */
/* Evidence enumeration                                                       */
/* -------------------------------------------------------------------------- */

interface EnumeratedEntry {
  relativePath: string;
  absolutePath: string;
  entryType: EvidenceEntryType;
  byteLength: number;
}

interface EnumerationResult {
  entries: EnumeratedEntry[];
  directoriesTraversed: number;
}

export interface DogfoodEvidenceLimits {
  maxEvidenceFiles: number;
  maxEvidenceBytes: number;
  maxEvidenceEntries: number;
  maxEvidenceDepth: number;
  maxDraftBytes: number;
}

function classifyEntry(stats: Awaited<ReturnType<typeof lstat>>): EvidenceEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  return "unknown";
}

/**
 * Walks the evidence root without ever following a symbolic link, enforcing
 * every configured bound before a single byte is handed to a parser.
 *
 * Real directories are traversal structure and are counted, not listed. A
 * symlink to a directory is listed as a skipped entry and is never entered, so
 * the walk cannot leave the evidence root.
 */
async function enumerateEvidence(
  root: string,
  limits: DogfoodEvidenceLimits,
): Promise<EnumerationResult> {
  const entries: EnumeratedEntry[] = [];
  let directoriesTraversed = 0;
  let visited = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxEvidenceDepth) {
      fail(
        "EVIDENCE_LIMIT_EXCEEDED",
        `evidence directory nests deeper than the configured limit of ${limits.maxEvidenceDepth}`,
      );
    }
    directoriesTraversed += 1;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      fail("EVIDENCE_ROOT_UNREADABLE", `evidence directory could not be listed: ${errorMessage(error)}`);
    }
    for (const name of [...names].sort(compareStrings)) {
      const absolutePath = join(directory, name);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        fail("EVIDENCE_ROOT_UNREADABLE", `evidence entry could not be inspected: ${errorMessage(error)}`);
      }
      visited += 1;
      if (visited > limits.maxEvidenceEntries) {
        fail(
          "EVIDENCE_LIMIT_EXCEEDED",
          `evidence directory holds more than the configured limit of ${limits.maxEvidenceEntries} entries`,
        );
      }
      // A real directory is descended into. A symlinked one never is.
      if (!stats.isSymbolicLink() && stats.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      const entryType = classifyEntry(stats);
      if (entryType === "file") {
        fileCount += 1;
        if (fileCount > limits.maxEvidenceFiles) {
          fail(
            "EVIDENCE_LIMIT_EXCEEDED",
            `evidence directory holds more than the configured limit of ${limits.maxEvidenceFiles} files`,
          );
        }
        totalBytes += stats.size;
        if (totalBytes > limits.maxEvidenceBytes) {
          fail(
            "EVIDENCE_LIMIT_EXCEEDED",
            `evidence files total more than the configured limit of ${limits.maxEvidenceBytes} bytes`,
          );
        }
      }
      entries.push({
        relativePath: toPosix(relative(root, absolutePath)),
        absolutePath,
        entryType,
        byteLength: stats.size,
      });
    }
  };

  await walk(root, 0);
  entries.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return { entries, directoriesTraversed };
}

/* -------------------------------------------------------------------------- */
/* Inventory construction                                                     */
/* -------------------------------------------------------------------------- */

function entryToken(relativePath: string): string {
  return sha256Text(relativePath).slice(0, 16);
}

function skipMessage(entryType: EvidenceEntryType): string {
  if (entryType === "symlink") {
    return "symbolic link; the walk never follows or reads link targets";
  }
  return `${entryType} is not a regular file and was not read`;
}

function readyEntryFrom(
  entry: EnumeratedEntry,
  token: string,
  result: Extract<IngestResult, { status: "ready" }>,
): DogfoodEvidenceEntry {
  return {
    entryId: "ev-" + token,
    relativePath: entry.relativePath,
    entryType: entry.entryType,
    status: "ready",
    byteLength: result.source.byteLength,
    sourceId: "src-" + token,
    sha256: result.source.sha256,
    mediaType: result.source.mediaType,
    extractionMethod: result.extraction.method,
    ocr: {
      required: result.ocr.required,
      performed: result.ocr.performed,
      reason: result.ocr.reason,
    },
    quality: {
      meaningOfReady: result.quality.meaningOfReady,
      extractionAccuracy: result.quality.extractionAccuracy,
      ocrAccuracy: result.quality.ocrAccuracy,
      legalAccuracy: result.quality.legalAccuracy,
      exactQuoteReview: result.quality.exactQuoteReview,
    },
    pages: result.pages.map((page) => ({
      pageNumber: page.pageNumber,
      chunkId: `chk-${token}:p${page.pageNumber}`,
      locator: page.locator,
      textSha256: page.textSha256,
      characterCount: page.characterCount,
      nonWhitespaceCharacterCount: page.nonWhitespaceCharacterCount,
    })),
  };
}

function unresolvedEntryFrom(
  entry: EnumeratedEntry,
  token: string,
  result: Extract<IngestResult, { status: "unresolved" }>,
): DogfoodEvidenceEntry {
  const base: DogfoodEvidenceEntry = {
    entryId: "ev-" + token,
    relativePath: entry.relativePath,
    entryType: entry.entryType,
    status: "unresolved",
    byteLength: result.source?.byteLength ?? entry.byteLength,
    code: result.code,
    message: result.message,
    quality: {
      meaningOfReady: result.quality.meaningOfReady,
      extractionAccuracy: result.quality.extractionAccuracy,
      ocrAccuracy: result.quality.ocrAccuracy,
      legalAccuracy: result.quality.legalAccuracy,
      exactQuoteReview: result.quality.exactQuoteReview,
    },
  };
  if (result.source !== undefined) {
    base.sha256 = result.source.sha256;
    base.mediaType = result.source.mediaType;
  }
  if (result.ocr !== undefined) {
    base.ocr = {
      required: result.ocr.required,
      performed: result.ocr.performed,
      reason: result.ocr.reason,
    };
  }
  return base;
}

interface BuiltInventory {
  inventory: DogfoodEvidenceInventory;
  /** Extracted page text, kept in memory so nothing is ingested twice. */
  chunkText: Map<string, string>;
}

/**
 * Compares what the bounded preflight enumerated against what ingestion
 * actually read.
 *
 * Every limit is enforced during enumeration, before a parser sees a byte. If
 * the entry changed after that — a different resolved path, or a different size
 * — then the bytes that were ingested are not the bytes that were counted, so a
 * small file swapped for a large one after the preflight would otherwise be
 * admitted as a ready source without ever being weighed against
 * `maxEvidenceBytes`. Neither case refuses to look at the file: it refuses to
 * attribute this extraction to the enumerated entry, and the entry then blocks
 * the run as unresolved.
 */
function ingestionMismatch(
  entry: EnumeratedEntry,
  result: Extract<IngestResult, { status: "ready" }>,
): { code: string; message: string } | undefined {
  if (result.source.path !== entry.absolutePath) {
    return {
      code: "ENTRY_PATH_AMBIGUOUS",
      message: "entry resolved to a different path during ingestion",
    };
  }
  if (result.source.byteLength !== entry.byteLength) {
    return {
      code: "ENTRY_SIZE_CHANGED",
      message:
        `entry was ${entry.byteLength} bytes when it was enumerated and bounded, `
        + `and ${result.source.byteLength} bytes when it was ingested`,
    };
  }
  return undefined;
}

async function buildInventory(
  enumeration: EnumerationResult,
  ocrPolicy: OcrPolicy,
  createdAt: string,
): Promise<BuiltInventory> {
  const entries: DogfoodEvidenceEntry[] = [];
  const chunkText = new Map<string, string>();
  const tokens = new Set<string>();
  for (const entry of enumeration.entries) {
    const token = entryToken(entry.relativePath);
    if (tokens.has(token)) {
      fail(
        "EVIDENCE_ID_COLLISION",
        `two evidence entries derive the same identifier token ${token}; refusing to build an ambiguous inventory`,
      );
    }
    tokens.add(token);
    if (entry.entryType !== "file") {
      entries.push({
        entryId: "ev-" + token,
        relativePath: entry.relativePath,
        entryType: entry.entryType,
        status: "skipped",
        byteLength: entry.byteLength,
        code: "NON_REGULAR_ENTRY",
        message: skipMessage(entry.entryType),
      });
      continue;
    }
    const result = await ingestLocalFile(entry.absolutePath, { ocrPolicy });
    if (result.status === "ready") {
      // `ingestLocalFile` resolves its own realpath and reports the size it
      // actually snapshotted. The walk already refused symlinks and already
      // weighed this entry against the limits, so either value differing means
      // the tree changed underneath us.
      const mismatch = ingestionMismatch(entry, result);
      if (mismatch !== undefined) {
        entries.push({
          entryId: "ev-" + token,
          relativePath: entry.relativePath,
          entryType: entry.entryType,
          status: "unresolved",
          byteLength: entry.byteLength,
          code: mismatch.code,
          message: mismatch.message,
        });
        continue;
      }
      const readyEntry = readyEntryFrom(entry, token, result);
      for (const [index, page] of (readyEntry.pages ?? []).entries()) {
        chunkText.set(page.chunkId, result.pages[index]?.text ?? "");
      }
      entries.push(readyEntry);
      continue;
    }
    entries.push(unresolvedEntryFrom(entry, token, result));
  }

  const ready = entries.filter((entry) => entry.status === "ready");
  return {
    inventory: {
      schemaVersion: DOGFOOD_WORKSPACE_SCHEMA_VERSION,
      kind: DOGFOOD_INVENTORY_KIND,
      createdAt,
      ocrPolicy,
      totals: {
        entries: entries.length,
        ready: ready.length,
        unresolved: entries.filter((entry) => entry.status === "unresolved").length,
        skipped: entries.filter((entry) => entry.status === "skipped").length,
        directoriesTraversed: enumeration.directoriesTraversed,
        readyPages: ready.reduce((sum, entry) => sum + (entry.pages?.length ?? 0), 0),
        readyBytes: ready.reduce((sum, entry) => sum + entry.byteLength, 0),
      },
      entries,
    },
    chunkText,
  };
}

/* -------------------------------------------------------------------------- */
/* Manifest and checklist construction                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prepopulates the legal skeleton from technically ready extraction only.
 *
 * Authority tier is `unknown` for every source without exception. The file name
 * is not evidence of what a document is, so nothing here reads "BC-Laws.pdf" as
 * primary authority. Coverage stays incomplete and claims stay empty: this
 * function knows what was parsed, not what the draft asserts.
 */
async function buildManifest(
  snapshotPath: string,
  subjectId: string,
  built: BuiltInventory,
): Promise<VerifyRequest> {
  const skeleton = await createLegalManifestSkeleton(snapshotPath, subjectId);
  const sources: SourceRecord[] = [];
  const chunks: EvidenceChunk[] = [];
  const retrievedChunkIds: string[] = [];

  for (const entry of built.inventory.entries) {
    if (entry.status !== "ready" || entry.sourceId === undefined) continue;
    const source: SourceRecord = {
      sourceId: entry.sourceId,
      title: entry.relativePath,
      sourceType: "local_file",
      authorityTier: "unknown",
    };
    if (entry.sha256 !== undefined) source.sha256 = entry.sha256;
    sources.push(source);
    for (const page of entry.pages ?? []) {
      // The inventory stores page hashes only. The manifest is the one artifact
      // that carries extracted text, and it stays owner-only in the workspace.
      chunks.push({
        chunkId: page.chunkId,
        sourceId: entry.sourceId,
        text: built.chunkText.get(page.chunkId) ?? "",
        sha256: page.textSha256,
        locator: page.locator,
      });
      retrievedChunkIds.push(page.chunkId);
    }
  }

  return {
    ...skeleton,
    subject: { ...skeleton.subject, path: DRAFT_SNAPSHOT_FILE },
    evidence: { ...skeleton.evidence, sources, chunks },
    retrievedChunkIds,
  };
}

function buildReviewChecklist(createdAt: string): DogfoodReviewChecklist {
  return {
    schemaVersion: DOGFOOD_WORKSPACE_SCHEMA_VERSION,
    kind: DOGFOOD_REVIEW_KIND,
    createdAt,
    note: [
      "Every confirmation below records work a person did, not work this runtime performed.",
      "Set a value to true only after doing that review yourself.",
      "This file is not a semantic attestation: it is not bound to any claim hash and it authorises no reuse.",
    ].join(" "),
    confirmations: {
      materialClaimCoverageReviewed: false,
      sourceSelectionAndAuthorityReviewed: false,
      exactQuotationAndPinpointReviewed: false,
      pdfVisualQuoteReviewCompleted: false,
      ocrVisualReviewCompleted: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

export interface DogfoodInitInput {
  draftPath: string;
  evidenceDirectory: string;
  workspacePath: string;
  ocrPolicy?: OcrPolicy;
  limits?: Partial<DogfoodEvidenceLimits>;
}

export interface DogfoodCounts {
  evidenceEntries: number;
  ready: number;
  unresolved: number;
  skipped: number;
  sources: number;
  chunks: number;
  claims: number;
  confirmationsRequired: number;
  confirmationsMet: number;
}

export interface DogfoodInitSummary {
  workspace: string;
  status: DogfoodWorkspaceStatus;
  counts: DogfoodCounts;
  blockers: DogfoodBlocker[];
}

function resolveLimits(overrides: Partial<DogfoodEvidenceLimits> | undefined): DogfoodEvidenceLimits {
  const limits: DogfoodEvidenceLimits = {
    maxEvidenceFiles: overrides?.maxEvidenceFiles ?? DEFAULT_MAX_EVIDENCE_FILES,
    maxEvidenceBytes: overrides?.maxEvidenceBytes ?? DEFAULT_MAX_EVIDENCE_BYTES,
    maxEvidenceEntries: overrides?.maxEvidenceEntries ?? DEFAULT_MAX_EVIDENCE_ENTRIES,
    maxEvidenceDepth: overrides?.maxEvidenceDepth ?? DEFAULT_MAX_EVIDENCE_DEPTH,
    maxDraftBytes: overrides?.maxDraftBytes ?? DEFAULT_MAX_DRAFT_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("WORKSPACE_INPUT_INVALID", `${name} must be a positive integer`);
    }
  }
  return limits;
}

/**
 * Creates a brand-new private workspace. Refuses an existing path, refuses any
 * overlap with the draft or the evidence directory, and never writes over
 * anything.
 *
 * A partially written workspace is left in place if this throws part way
 * through. That is deliberate: removing a directory tree is not something this
 * tool does on its own. Delete it yourself and rerun.
 */
export async function initDogfoodWorkspace(
  input: DogfoodInitInput,
): Promise<DogfoodInitSummary> {
  const ocrPolicy = input.ocrPolicy ?? "report";
  if (ocrPolicy !== "report" && ocrPolicy !== "perform") {
    fail("WORKSPACE_INPUT_INVALID", "--ocr must be report or perform");
  }
  const limits = resolveLimits(input.limits);

  const draft = await resolveExistingPath(input.draftPath, "--draft");
  if (!draft.isFile) fail("WORKSPACE_INPUT_INVALID", "--draft must be a regular file");
  if (draft.byteLength > limits.maxDraftBytes) {
    fail(
      "DRAFT_UNREADABLE",
      `draft is ${draft.byteLength} bytes; configured limit is ${limits.maxDraftBytes} bytes`,
    );
  }
  const evidence = await resolveExistingPath(input.evidenceDirectory, "--evidence-dir");
  if (!evidence.isDirectory) {
    fail("WORKSPACE_INPUT_INVALID", "--evidence-dir must be a directory");
  }

  const workspace = resolve(input.workspacePath);
  const workspaceParent = await resolveExistingPath(join(workspace, ".."), "--workspace parent");
  if (!workspaceParent.isDirectory) {
    fail("WORKSPACE_INPUT_INVALID", "--workspace parent must be a directory");
  }
  const workspaceResolved = join(workspaceParent.path, basename(workspace));

  assertNoOverlap(workspaceResolved, draft.path, evidence.path);

  try {
    await mkdir(workspaceResolved, { mode: 0o700 });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      fail(
        "WORKSPACE_ALREADY_EXISTS",
        "--workspace already exists; init only creates a new workspace, so choose another path",
      );
    }
    fail("WORKSPACE_WRITE_FAILED", `workspace could not be created: ${errorMessage(error)}`);
  }
  // mkdir modes pass through the umask, so set the mode explicitly.
  await chmod(workspaceResolved, 0o700);

  const createdAt = new Date().toISOString();
  const snapshotSha256 = await snapshotDraft(draft.path, workspaceResolved, limits.maxDraftBytes);
  const enumeration = await enumerateEvidence(evidence.path, limits);
  const built = await buildInventory(enumeration, ocrPolicy, createdAt);
  const inventory = built.inventory;
  const snapshotPath = join(workspaceResolved, DRAFT_DIRECTORY, DRAFT_SNAPSHOT_NAME);
  const manifest = await buildManifest(snapshotPath, basename(draft.path), built);
  const review = buildReviewChecklist(createdAt);

  const inventoryPath = await writeWorkspaceArtifact(workspaceResolved, EVIDENCE_INVENTORY_FILE, inventory);
  const manifestPath = await writeWorkspaceArtifact(workspaceResolved, MANIFEST_FILE, manifest);
  const reviewPath = await writeWorkspaceArtifact(workspaceResolved, REVIEW_FILE, review);

  const core: DogfoodWorkspaceMetadataCore = {
    schemaVersion: DOGFOOD_WORKSPACE_SCHEMA_VERSION,
    kind: DOGFOOD_WORKSPACE_KIND,
    workspaceId: newTraceId(createdAt),
    createdAt,
    engineVersion: ENGINE_VERSION,
    ocrPolicy,
    limits,
    hostPaths: { draftPath: draft.path, evidenceRoot: evidence.path },
    draftSnapshot: {
      file: DRAFT_SNAPSHOT_FILE,
      sha256: snapshotSha256,
      byteLength: draft.byteLength,
    },
    inventory: {
      file: EVIDENCE_INVENTORY_FILE,
      sha256: await sha256File(inventoryPath),
      inventoryHash: hashObject(inventory),
      entryCount: inventory.entries.length,
    },
    manifest: {
      file: MANIFEST_FILE,
      initialSha256: await sha256File(manifestPath),
      requestId: manifest.requestId,
      snapshotId: manifest.evidence.snapshotId,
      subjectSha256: manifest.subject.sha256,
    },
    review: {
      file: REVIEW_FILE,
      initialSha256: await sha256File(reviewPath),
    },
    traceDirectory: DEFAULT_TRACE_DIRECTORY,
  };
  await writeWorkspaceArtifact(workspaceResolved, WORKSPACE_METADATA_FILE, {
    ...core,
    metadataHash: hashObject(core),
  });

  const report = await evaluateDogfoodWorkspace(workspaceResolved);
  return {
    workspace: workspaceResolved,
    status: report.status,
    counts: report.counts,
    blockers: report.blockers,
  };
}

function assertNoOverlap(workspace: string, draftPath: string, evidenceRoot: string): void {
  const issues: string[] = [];
  if (workspace === evidenceRoot) issues.push("--workspace is the evidence directory");
  if (contains(evidenceRoot, workspace)) issues.push("--workspace is inside the evidence directory");
  if (contains(workspace, evidenceRoot)) issues.push("--evidence-dir is inside the workspace");
  if (workspace === draftPath) issues.push("--workspace is the draft path");
  if (contains(workspace, draftPath)) issues.push("--draft is inside the workspace");
  if (issues.length > 0) {
    throw new DogfoodWorkspaceError(issues.map(() => "WORKSPACE_PATH_OVERLAP"), issues);
  }
}

async function snapshotDraft(
  draftPath: string,
  workspace: string,
  maxDraftBytes: number,
): Promise<string> {
  // Ingestion validates UTF-8 and rejects binary input; the snapshot copies the
  // original bytes, because re-encoding decoded text would silently drop a BOM.
  const ingested = await ingestLocalFile(draftPath, {
    mediaType: "text/plain",
    maxFileBytes: maxDraftBytes,
  });
  if (ingested.status !== "ready") {
    fail("DRAFT_UNREADABLE", `${ingested.code}: ${ingested.message}`);
  }
  const directory = join(workspace, DRAFT_DIRECTORY);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const snapshotPath = join(directory, DRAFT_SNAPSHOT_NAME);
  try {
    await writeFile(snapshotPath, await readFile(draftPath), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fail("WORKSPACE_WRITE_FAILED", `draft snapshot could not be written: ${errorMessage(error)}`);
  }
  const snapshotSha256 = await sha256File(snapshotPath);
  if (snapshotSha256 !== ingested.source.sha256) {
    fail("DRAFT_UNREADABLE", "draft changed while it was being snapshotted");
  }
  return snapshotSha256;
}

async function writeWorkspaceArtifact(
  workspace: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  const target = join(workspace, fileName);
  try {
    await writeFile(target, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    fail("WORKSPACE_WRITE_FAILED", `${fileName} could not be written: ${errorMessage(error)}`);
  }
  return target;
}

/* -------------------------------------------------------------------------- */
/* Closed-contract artifact readers                                           */
/* -------------------------------------------------------------------------- */

const METADATA_KEYS = [
  "schemaVersion",
  "kind",
  "workspaceId",
  "createdAt",
  "engineVersion",
  "ocrPolicy",
  "limits",
  "hostPaths",
  "draftSnapshot",
  "inventory",
  "manifest",
  "review",
  "traceDirectory",
  "metadataHash",
] as const;

const INVENTORY_KEYS = [
  "schemaVersion",
  "kind",
  "createdAt",
  "ocrPolicy",
  "totals",
  "entries",
] as const;

const INVENTORY_ENTRY_KEYS = [
  "entryId",
  "relativePath",
  "entryType",
  "status",
  "byteLength",
  "code",
  "message",
  "sourceId",
  "sha256",
  "mediaType",
  "extractionMethod",
  "ocr",
  "quality",
  "pages",
] as const;

const REVIEW_KEYS = ["schemaVersion", "kind", "createdAt", "note", "confirmations"] as const;

/**
 * Every nested section of `workspace.json`, with its exact key set. A section
 * is closed in both directions: an unknown key and a missing key are equally a
 * failure, so no shape can be widened, narrowed, or retyped and then resealed.
 */
const METADATA_SECTION_KEYS = {
  limits: [
    "maxEvidenceFiles",
    "maxEvidenceBytes",
    "maxEvidenceEntries",
    "maxEvidenceDepth",
    "maxDraftBytes",
  ],
  hostPaths: ["draftPath", "evidenceRoot"],
  draftSnapshot: ["file", "sha256", "byteLength"],
  inventory: ["file", "sha256", "inventoryHash", "entryCount"],
  manifest: ["file", "initialSha256", "requestId", "snapshotId", "subjectSha256"],
  review: ["file", "initialSha256"],
} as const satisfies Record<string, readonly string[]>;

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const permitted = new Set<string>(allowed);
  return Object.keys(value).filter((key) => !permitted.has(key));
}

function missingKeys(value: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
}

function metadataFailure(detail: string): never {
  fail("WORKSPACE_METADATA_UNREADABLE", `${WORKSPACE_METADATA_FILE} ${detail}`);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isByteCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Checks one recorded artifact name against the constant this build uses.
 *
 * `metadataHash` proves the metadata is internally consistent, not that it is
 * trustworthy: anyone who can write the file can recompute the hash. So the
 * artifact names are never taken from the file. `review.file` set to
 * `../outside-review.json` would otherwise make the workspace read a checklist
 * that belongs to nobody, and `traceDirectory` set to `../outside-traces` would
 * write a verification trace outside the workspace it claims to describe.
 */
function assertFixedArtifactName(recorded: unknown, expected: string, field: string): void {
  if (recorded !== expected) {
    metadataFailure(`${field} must be exactly ${expected}`);
  }
}

function assertMetadataSections(value: Record<string, unknown>): void {
  for (const [section, keys] of Object.entries(METADATA_SECTION_KEYS)) {
    const body = value[section];
    if (!isRecord(body)) metadataFailure(`.${section} must be an object`);
    const extra = unknownKeys(body, keys);
    if (extra.length > 0) {
      metadataFailure(`.${section} has unknown properties: ${extra.join(", ")}`);
    }
    const missing = missingKeys(body, keys);
    if (missing.length > 0) {
      metadataFailure(`.${section} is missing: ${missing.join(", ")}`);
    }
  }

  const limits = value.limits as Record<string, unknown>;
  for (const key of METADATA_SECTION_KEYS.limits) {
    if (!isPositiveInteger(limits[key])) {
      metadataFailure(`.limits.${key} must be a positive integer`);
    }
  }

  const hostPaths = value.hostPaths as Record<string, unknown>;
  for (const key of METADATA_SECTION_KEYS.hostPaths) {
    const recorded = hostPaths[key];
    if (!isNonEmptyString(recorded) || !isAbsolute(recorded)) {
      metadataFailure(`.hostPaths.${key} must be an absolute path`);
    }
  }

  const draftSnapshot = value.draftSnapshot as Record<string, unknown>;
  assertFixedArtifactName(draftSnapshot.file, DRAFT_SNAPSHOT_FILE, ".draftSnapshot.file");
  if (!isSha256Hex(draftSnapshot.sha256)) metadataFailure(".draftSnapshot.sha256 must be a SHA-256 hex digest");
  if (!isByteCount(draftSnapshot.byteLength)) metadataFailure(".draftSnapshot.byteLength must be a byte count");

  const inventory = value.inventory as Record<string, unknown>;
  assertFixedArtifactName(inventory.file, EVIDENCE_INVENTORY_FILE, ".inventory.file");
  if (!isSha256Hex(inventory.sha256)) metadataFailure(".inventory.sha256 must be a SHA-256 hex digest");
  if (!isSha256Hex(inventory.inventoryHash)) metadataFailure(".inventory.inventoryHash must be a SHA-256 hex digest");
  if (!isByteCount(inventory.entryCount)) metadataFailure(".inventory.entryCount must be an entry count");

  const manifest = value.manifest as Record<string, unknown>;
  assertFixedArtifactName(manifest.file, MANIFEST_FILE, ".manifest.file");
  if (!isSha256Hex(manifest.initialSha256)) metadataFailure(".manifest.initialSha256 must be a SHA-256 hex digest");
  if (!isSha256Hex(manifest.subjectSha256)) metadataFailure(".manifest.subjectSha256 must be a SHA-256 hex digest");
  if (!isNonEmptyString(manifest.requestId)) metadataFailure(".manifest.requestId must be a non-empty string");
  if (!isNonEmptyString(manifest.snapshotId)) metadataFailure(".manifest.snapshotId must be a non-empty string");

  const review = value.review as Record<string, unknown>;
  assertFixedArtifactName(review.file, REVIEW_FILE, ".review.file");
  if (!isSha256Hex(review.initialSha256)) metadataFailure(".review.initialSha256 must be a SHA-256 hex digest");
}

/**
 * Reads the workspace metadata. This one artifact is a hard requirement: if it
 * is missing, malformed, carries an unknown field, names an artifact this build
 * does not use, or does not match its own hash, there is no workspace to report
 * on and the utility refuses.
 */
export async function readWorkspaceMetadata(
  workspacePath: string,
): Promise<DogfoodWorkspaceMetadata> {
  const workspace = await resolveWorkspaceRoot(workspacePath);
  await assertSafeWorkspaceArtifact(workspace, WORKSPACE_METADATA_FILE, WORKSPACE_METADATA_FILE);
  const path = join(workspace, WORKSPACE_METADATA_FILE);
  const outcome = await readJsonFile(path);
  if (!outcome.ok) {
    fail("WORKSPACE_METADATA_UNREADABLE", `${WORKSPACE_METADATA_FILE} could not be read: ${outcome.message}`);
  }
  const value = outcome.value;
  if (!isRecord(value)) metadataFailure("must be an object");
  const extra = unknownKeys(value, METADATA_KEYS);
  if (extra.length > 0) metadataFailure(`has unknown properties: ${extra.join(", ")}`);
  const missing = missingKeys(value, METADATA_KEYS);
  if (missing.length > 0) metadataFailure(`is missing: ${missing.join(", ")}`);
  if (value.kind !== DOGFOOD_WORKSPACE_KIND) metadataFailure(`is not a ${DOGFOOD_WORKSPACE_KIND}`);
  if (value.schemaVersion !== DOGFOOD_WORKSPACE_SCHEMA_VERSION) {
    metadataFailure(`schemaVersion must be ${DOGFOOD_WORKSPACE_SCHEMA_VERSION}`);
  }
  const { metadataHash, ...rest } = value;
  if (typeof metadataHash !== "string" || hashObject(rest) !== metadataHash) {
    metadataFailure("does not match its recorded metadataHash");
  }
  if (!isNonEmptyString(value.workspaceId)) metadataFailure(".workspaceId must be a non-empty string");
  if (!isNonEmptyString(value.createdAt)) metadataFailure(".createdAt must be a non-empty string");
  if (!isNonEmptyString(value.engineVersion)) metadataFailure(".engineVersion must be a non-empty string");
  if (value.ocrPolicy !== "report" && value.ocrPolicy !== "perform") {
    metadataFailure(".ocrPolicy must be report or perform");
  }
  assertMetadataSections(value);
  assertFixedArtifactName(value.traceDirectory, DEFAULT_TRACE_DIRECTORY, ".traceDirectory");
  return value as unknown as DogfoodWorkspaceMetadata;
}

type InventoryRead =
  | { ok: true; inventory: DogfoodEvidenceInventory }
  | { ok: false; code: DogfoodBlockerCode; message: string };

async function readInventoryArtifact(
  workspacePath: string,
  metadata: DogfoodWorkspaceMetadata,
): Promise<InventoryRead> {
  const present = await assertSafeWorkspaceArtifact(
    workspacePath,
    EVIDENCE_INVENTORY_FILE,
    EVIDENCE_INVENTORY_FILE,
  );
  if (!present) {
    return {
      ok: false,
      code: "INVENTORY_MISSING",
      message: `${EVIDENCE_INVENTORY_FILE} is not in the workspace`,
    };
  }
  const path = join(workspacePath, EVIDENCE_INVENTORY_FILE);
  const outcome = await readJsonFile(path);
  if (!outcome.ok) {
    return { ok: false, code: "INVENTORY_MISSING", message: `${EVIDENCE_INVENTORY_FILE}: ${outcome.message}` };
  }
  const value = outcome.value;
  if (!isRecord(value)) {
    return { ok: false, code: "INVENTORY_INVALID", message: `${EVIDENCE_INVENTORY_FILE} must be an object` };
  }
  const extra = unknownKeys(value, INVENTORY_KEYS);
  if (extra.length > 0) {
    return {
      ok: false,
      code: "INVENTORY_INVALID",
      message: `${EVIDENCE_INVENTORY_FILE} has unknown properties: ${extra.join(", ")}`,
    };
  }
  const absent = missingKeys(value, INVENTORY_KEYS);
  if (absent.length > 0) {
    return {
      ok: false,
      code: "INVENTORY_INVALID",
      message: `${EVIDENCE_INVENTORY_FILE} is missing: ${absent.join(", ")}`,
    };
  }
  if (value.kind !== DOGFOOD_INVENTORY_KIND) {
    return { ok: false, code: "INVENTORY_INVALID", message: `${EVIDENCE_INVENTORY_FILE} is not a ${DOGFOOD_INVENTORY_KIND}` };
  }
  if (value.schemaVersion !== DOGFOOD_WORKSPACE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "INVENTORY_INVALID",
      message: `${EVIDENCE_INVENTORY_FILE} schemaVersion must be ${DOGFOOD_WORKSPACE_SCHEMA_VERSION}`,
    };
  }
  if (!Array.isArray(value.entries) || !isRecord(value.totals)) {
    return { ok: false, code: "INVENTORY_INVALID", message: `${EVIDENCE_INVENTORY_FILE} is structurally invalid` };
  }
  for (const entry of value.entries) {
    if (!isRecord(entry)) {
      return { ok: false, code: "INVENTORY_INVALID", message: `${EVIDENCE_INVENTORY_FILE} has a non-object entry` };
    }
    const entryExtra = unknownKeys(entry, INVENTORY_ENTRY_KEYS);
    if (entryExtra.length > 0) {
      return {
        ok: false,
        code: "INVENTORY_INVALID",
        message: `${EVIDENCE_INVENTORY_FILE} entry has unknown properties: ${entryExtra.join(", ")}`,
      };
    }
    if (typeof entry.entryId !== "string" || typeof entry.status !== "string") {
      return { ok: false, code: "INVENTORY_INVALID", message: `${EVIDENCE_INVENTORY_FILE} entry is structurally invalid` };
    }
  }
  const inventory = value as unknown as DogfoodEvidenceInventory;
  const fileHash = await sha256File(path).catch(() => "");
  if (fileHash !== metadata.inventory.sha256 || hashObject(inventory) !== metadata.inventory.inventoryHash) {
    return {
      ok: false,
      code: "INVENTORY_CHANGED",
      message: `${EVIDENCE_INVENTORY_FILE} no longer matches the hash recorded at init; the machine-generated inventory must never be edited`,
    };
  }
  return { ok: true, inventory };
}

type ReviewRead =
  | { ok: true; review: DogfoodReviewChecklist }
  | { ok: false; code: DogfoodBlockerCode; message: string };

/**
 * Reads the human checklist under the same closed contract as every other
 * artifact: exact kind, exact schema version, no unknown or missing field, and
 * a boolean for every confirmation.
 *
 * What this still cannot do is tell whose checklist it is. There is no secret
 * and no identity field, so a checklist copied from another workspace whose
 * confirmations are already `true` reads as valid here. That is an operator and
 * authentication limitation, stated in the README and the roadmap rather than
 * papered over with a hash that anyone who can write the file can recompute.
 */
async function readReviewArtifact(workspacePath: string): Promise<ReviewRead> {
  const present = await assertSafeWorkspaceArtifact(workspacePath, REVIEW_FILE, REVIEW_FILE);
  if (!present) {
    return { ok: false, code: "REVIEW_MISSING", message: `${REVIEW_FILE} is not in the workspace` };
  }
  const path = join(workspacePath, REVIEW_FILE);
  const outcome = await readJsonFile(path);
  if (!outcome.ok) {
    return { ok: false, code: "REVIEW_MISSING", message: `${REVIEW_FILE}: ${outcome.message}` };
  }
  const value = outcome.value;
  if (!isRecord(value)) {
    return { ok: false, code: "REVIEW_INVALID", message: `${REVIEW_FILE} must be an object` };
  }
  const extra = unknownKeys(value, REVIEW_KEYS);
  if (extra.length > 0) {
    return {
      ok: false,
      code: "REVIEW_INVALID",
      message: `${REVIEW_FILE} has unknown properties: ${extra.join(", ")}`,
    };
  }
  const absent = missingKeys(value, REVIEW_KEYS);
  if (absent.length > 0) {
    return {
      ok: false,
      code: "REVIEW_INVALID",
      message: `${REVIEW_FILE} is missing: ${absent.join(", ")}`,
    };
  }
  if (value.kind !== DOGFOOD_REVIEW_KIND) {
    return { ok: false, code: "REVIEW_INVALID", message: `${REVIEW_FILE} is not a ${DOGFOOD_REVIEW_KIND}` };
  }
  if (value.schemaVersion !== DOGFOOD_WORKSPACE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "REVIEW_INVALID",
      message: `${REVIEW_FILE} schemaVersion must be ${DOGFOOD_WORKSPACE_SCHEMA_VERSION}`,
    };
  }
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.note)) {
    return {
      ok: false,
      code: "REVIEW_INVALID",
      message: `${REVIEW_FILE}.createdAt and .note must be non-empty strings`,
    };
  }
  if (!isRecord(value.confirmations)) {
    return { ok: false, code: "REVIEW_INVALID", message: `${REVIEW_FILE}.confirmations must be an object` };
  }
  const confirmationExtra = unknownKeys(value.confirmations, DOGFOOD_CONFIRMATION_NAMES);
  if (confirmationExtra.length > 0) {
    return {
      ok: false,
      code: "REVIEW_INVALID",
      message: `${REVIEW_FILE}.confirmations has unknown properties: ${confirmationExtra.join(", ")}`,
    };
  }
  for (const name of DOGFOOD_CONFIRMATION_NAMES) {
    if (typeof value.confirmations[name] !== "boolean") {
      return {
        ok: false,
        code: "REVIEW_INVALID",
        message: `${REVIEW_FILE}.confirmations.${name} must be a boolean`,
      };
    }
  }
  return { ok: true, review: value as unknown as DogfoodReviewChecklist };
}

/* -------------------------------------------------------------------------- */
/* Status evaluation                                                          */
/* -------------------------------------------------------------------------- */

export type DogfoodWorkspaceStatus = "NEEDS_REVIEW" | "READY_FOR_VERIFICATION";

export interface DogfoodStatusReport {
  workspace: string;
  status: DogfoodWorkspaceStatus;
  counts: DogfoodCounts;
  blockers: DogfoodBlocker[];
  /** Present only when the manifest read and validated. */
  manifest?: VerifyRequest;
  metadata: DogfoodWorkspaceMetadata;
  draftSnapshotPath: string;
  manifestPath: string;
}

/**
 * Rebuilds the entire picture from the bytes on disk on every call.
 *
 * No stored status field is read, and none is written: `NEEDS_REVIEW` and
 * `READY_FOR_VERIFICATION` are recomputed each time from the draft hash, the
 * inventory hash, the manifest content, and the human checklist. Neither value
 * is ever a verification `PASS`.
 */
export async function evaluateDogfoodWorkspace(
  workspacePath: string,
): Promise<DogfoodStatusReport> {
  const workspace = await resolveWorkspaceRoot(workspacePath);
  const metadata = await readWorkspaceMetadata(workspace);
  const blockers: DogfoodBlocker[] = [];
  // Built from the fixed constants, never from the recorded names. The metadata
  // reader has already refused anything that does not equal them.
  const draftSnapshotPath = join(workspace, DRAFT_DIRECTORY, DRAFT_SNAPSHOT_NAME);
  const manifestPath = join(workspace, MANIFEST_FILE);

  let draftText: string | undefined;
  const draftPresent = await assertSafeWorkspaceArtifact(
    workspace,
    DRAFT_SNAPSHOT_FILE,
    DRAFT_SNAPSHOT_FILE,
  );
  if (!draftPresent) {
    blockers.push(blocker(
      "DRAFT_SNAPSHOT_MISSING",
      "the draft snapshot is not in the workspace",
    ));
  } else {
    try {
      const currentHash = await sha256File(draftSnapshotPath);
      if (currentHash !== metadata.draftSnapshot.sha256) {
        blockers.push(blocker(
          "DRAFT_SNAPSHOT_CHANGED",
          "the draft snapshot no longer matches the hash recorded at init",
        ));
      } else {
        draftText = await readFile(draftSnapshotPath, "utf8");
      }
    } catch (error) {
      blockers.push(blocker(
        "DRAFT_SNAPSHOT_MISSING",
        `the draft snapshot could not be read: ${errorMessage(error)}`,
      ));
    }
  }

  const inventoryRead = await readInventoryArtifact(workspace, metadata);
  const inventory = inventoryRead.ok ? inventoryRead.inventory : undefined;
  if (!inventoryRead.ok) blockers.push(blocker(inventoryRead.code, inventoryRead.message));

  if (inventory !== undefined) {
    for (const entry of inventory.entries) {
      if (entry.status === "skipped") {
        blockers.push(blocker(
          "EVIDENCE_ENTRY_SKIPPED",
          `${entry.entryId} was enumerated but never read (${entry.entryType}); resolve or remove it`,
        ));
      } else if (entry.status === "unresolved") {
        blockers.push(blocker(
          "EVIDENCE_ENTRY_UNRESOLVED",
          `${entry.entryId} did not extract (${entry.code ?? "unknown"}); see ${EVIDENCE_INVENTORY_FILE}`,
        ));
      }
    }
    if (inventory.entries.every((entry) => entry.status !== "ready")) {
      blockers.push(blocker(
        "EVIDENCE_NO_READY_SOURCE",
        "no evidence entry extracted successfully, so there is nothing for a claim to cite",
      ));
    }
  }

  const reviewRead = await readReviewArtifact(workspace);
  if (!reviewRead.ok) blockers.push(blocker(reviewRead.code, reviewRead.message));

  const manifestOutcome = await readManifestArtifact(workspace);
  if (!manifestOutcome.ok) blockers.push(blocker(manifestOutcome.code, manifestOutcome.message));
  const manifest = manifestOutcome.ok ? manifestOutcome.manifest : undefined;

  if (manifest !== undefined) {
    blockers.push(...manifestBlockers(manifest, metadata, inventory, draftText));
  }

  const requirement = confirmationRequirement(inventory);
  if (reviewRead.ok) {
    for (const name of requirement.required) {
      if (reviewRead.review.confirmations[name] !== true) {
        blockers.push(blocker(
          "REVIEW_CONFIRMATION_MISSING",
          `${name} is still false in ${REVIEW_FILE}; only a human may set it`,
        ));
      }
    }
  }

  const confirmationsMet = reviewRead.ok
    ? requirement.required.filter((name) => reviewRead.review.confirmations[name] === true).length
    : 0;
  const sorted = sortBlockers(blockers);
  const report: DogfoodStatusReport = {
    workspace,
    status: sorted.length === 0 ? "READY_FOR_VERIFICATION" : "NEEDS_REVIEW",
    counts: {
      evidenceEntries: inventory?.entries.length ?? 0,
      ready: inventory?.totals.ready ?? 0,
      unresolved: inventory?.totals.unresolved ?? 0,
      skipped: inventory?.totals.skipped ?? 0,
      sources: manifest?.evidence.sources.length ?? 0,
      chunks: manifest?.evidence.chunks.length ?? 0,
      claims: manifest?.claims.length ?? 0,
      confirmationsRequired: requirement.required.length,
      confirmationsMet,
    },
    blockers: sorted,
    metadata,
    draftSnapshotPath,
    manifestPath,
  };
  if (manifest !== undefined) report.manifest = manifest;
  return report;
}

type ManifestRead =
  | { ok: true; manifest: VerifyRequest }
  | { ok: false; code: DogfoodBlockerCode; message: string };

async function readManifestArtifact(workspacePath: string): Promise<ManifestRead> {
  const present = await assertSafeWorkspaceArtifact(workspacePath, MANIFEST_FILE, MANIFEST_FILE);
  if (!present) {
    return { ok: false, code: "MANIFEST_MISSING", message: `${MANIFEST_FILE} is not in the workspace` };
  }
  const outcome = await readJsonFile(join(workspacePath, MANIFEST_FILE));
  if (!outcome.ok) {
    return { ok: false, code: "MANIFEST_MISSING", message: `${MANIFEST_FILE}: ${outcome.message}` };
  }
  try {
    // The manifest contract is already closed by the v0.1 request validator,
    // which rejects unknown properties at every level.
    assertVerifyRequest(outcome.value);
    return { ok: true, manifest: outcome.value };
  } catch (error) {
    const issues = error instanceof ContractError ? error.issues.join("; ") : errorMessage(error);
    return { ok: false, code: "MANIFEST_INVALID", message: `${MANIFEST_FILE}: ${issues}` };
  }
}

/**
 * The mechanical half of the verification gate.
 *
 * Everything here is a pre-check that mirrors a blocking condition the legal
 * adapter or the verifier would raise anyway. Running it first is what lets a
 * refusal be a typed blocker with no trace written, instead of a stored
 * verification record of a manifest that was never fit to verify.
 */
function manifestBlockers(
  manifest: VerifyRequest,
  metadata: DogfoodWorkspaceMetadata,
  inventory: DogfoodEvidenceInventory | undefined,
  draftText: string | undefined,
): DogfoodBlocker[] {
  const blockers: DogfoodBlocker[] = [];

  if (
    manifest.requestId !== metadata.manifest.requestId
    || manifest.evidence.snapshotId !== metadata.manifest.snapshotId
  ) {
    blockers.push(blocker(
      "MANIFEST_IDENTITY_CHANGED",
      "manifest requestId or evidence snapshotId differs from the one recorded at init; this may be a file from another workspace",
    ));
  }
  if (
    manifest.subject.sha256 !== metadata.draftSnapshot.sha256
    || manifest.coverage.subjectSha256 !== metadata.draftSnapshot.sha256
  ) {
    blockers.push(blocker(
      "MANIFEST_SUBJECT_HASH_MISMATCH",
      "manifest subject or coverage hash does not match the current draft snapshot",
    ));
  }
  if (
    manifest.domain !== "bc-legal"
    || manifest.policy.riskTier !== "high"
    || manifest.policy.requireCompleteCoverage !== true
    || manifest.policy.requireRetrievedCitationClosure !== true
  ) {
    blockers.push(blocker(
      "MANIFEST_POLICY_WEAKENED",
      "manifest must stay domain=bc-legal, riskTier=high, requireCompleteCoverage=true, requireRetrievedCitationClosure=true",
    ));
  }
  if (manifest.coverage.complete !== true) {
    blockers.push(blocker(
      "MANIFEST_COVERAGE_INCOMPLETE",
      "coverage.complete is false; set it only after a human has inventoried every material assertion",
    ));
  }
  if (manifest.claims.length === 0 && (draftText ?? "").trim().length > 0) {
    blockers.push(blocker(
      "MANIFEST_CLAIMS_EMPTY",
      "the draft has content but the manifest lists no claims",
    ));
  }
  if (manifest.subject.path !== DRAFT_SNAPSHOT_FILE) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest subject.path must be exactly ${DRAFT_SNAPSHOT_FILE}; verification always reads the workspace draft snapshot`,
    ));
  }

  // Structured and derived proofs read `chunk.structuredFacts` and treat what
  // they find there as evidence. Ingestion produces page text and page hashes
  // and nothing else, so there is no ingested value for a structured fact to be
  // bound to and no hash that would catch an invented one. Until a separately
  // validated structured-fact ingestion contract exists, a chunk carrying the
  // field is refused outright rather than silently trusted.
  for (const chunk of manifest.evidence.chunks) {
    if (chunk.structuredFacts !== undefined) {
      blockers.push(blocker(
        "MANIFEST_STRUCTURED_FACTS_UNBOUND",
        `manifest chunk ${chunk.chunkId} carries structuredFacts, which this workflow cannot bind to anything that was ingested; remove the field`,
      ));
    }
  }

  const sourceById = new Map(manifest.evidence.sources.map((source) => [source.sourceId, source]));
  if (inventory !== undefined) {
    const readyById = new Map(
      inventory.entries
        .filter((entry) => entry.status === "ready" && entry.sourceId !== undefined)
        .map((entry) => [entry.sourceId as string, entry]),
    );
    for (const source of manifest.evidence.sources) {
      const entry = readyById.get(source.sourceId);
      if (entry === undefined) {
        blockers.push(blocker(
          "MANIFEST_SOURCE_NOT_IN_INVENTORY",
          `manifest source ${source.sourceId} is not a ready entry in ${EVIDENCE_INVENTORY_FILE}`,
        ));
        continue;
      }
      blockers.push(...machineDerivedSourceBlockers(source, entry));
    }
    const pageByChunk = new Map(
      inventory.entries.flatMap((entry) =>
        (entry.pages ?? []).map((page) => [page.chunkId, { entry, page }] as const)
      ),
    );
    for (const chunk of manifest.evidence.chunks) {
      const found = pageByChunk.get(chunk.chunkId);
      if (found === undefined || found.entry.sourceId !== chunk.sourceId) {
        blockers.push(blocker(
          "MANIFEST_CHUNK_NOT_IN_INVENTORY",
          `manifest chunk ${chunk.chunkId} does not correspond to an ingested page of the source it names`,
        ));
        continue;
      }
      blockers.push(...machineDerivedChunkBlockers(chunk, found.page));
    }
  }

  for (const claim of manifest.claims) {
    blockers.push(...materialClaimBlockers(claim, sourceById));
  }
  return blockers;
}

/**
 * Holds a manifest source to the parts of it the machine produced.
 *
 * `manifest.json` is meant to be edited: a person classifies authority, scopes
 * jurisdictions, and fills in issuer, version, and dates, and none of that is
 * checkable here. What is not theirs to edit is the provenance — which file
 * this is, what type it is, and what its bytes hashed to at ingestion. A source
 * whose `sha256` is simply deleted is the important case: without this, an
 * omitted hash passed silently and left the cited authority bound to nothing.
 */
function machineDerivedSourceBlockers(
  source: SourceRecord,
  entry: DogfoodEvidenceEntry,
): DogfoodBlocker[] {
  const blockers: DogfoodBlocker[] = [];
  if (source.sha256 === undefined) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest source ${source.sourceId} omits sha256; the content hash recorded at ingestion is required`,
    ));
  } else if (source.sha256 !== entry.sha256) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest source ${source.sourceId} sha256 differs from the hash recorded at ingestion`,
    ));
  }
  if (source.title !== entry.relativePath) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest source ${source.sourceId} title must stay the ingested evidence-relative path recorded in ${EVIDENCE_INVENTORY_FILE}`,
    ));
  }
  if (source.sourceType !== "local_file") {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest source ${source.sourceId} sourceType must stay local_file; every source in this workflow is a local file that was ingested`,
    ));
  }
  return blockers;
}

/**
 * Holds a manifest chunk to the page it came from: the recorded hash, the text
 * behind that hash, and the pinpoint locator a reader would check the quote
 * against. A forged locator points a human at the wrong page of a real source,
 * which no text hash would catch.
 */
function machineDerivedChunkBlockers(
  chunk: EvidenceChunk,
  page: DogfoodEvidencePage,
): DogfoodBlocker[] {
  const blockers: DogfoodBlocker[] = [];
  if (chunk.sha256 !== page.textSha256) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest chunk ${chunk.chunkId} sha256 differs from the page hash recorded at ingestion`,
    ));
  }
  if (sha256Text(chunk.text) !== page.textSha256) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest chunk ${chunk.chunkId} text does not hash to the page hash recorded at ingestion`,
    ));
  }
  if (chunk.locator !== page.locator) {
    blockers.push(blocker(
      "MANIFEST_PROVENANCE_UNBOUND",
      `manifest chunk ${chunk.chunkId} locator differs from the one recorded at ingestion`,
    ));
  }
  return blockers;
}

function materialClaimBlockers(
  claim: AtomicClaim,
  sourceById: Map<string, SourceRecord>,
): DogfoodBlocker[] {
  if (!claim.material) return [];
  const blockers: DogfoodBlocker[] = [];
  if (claim.jurisdiction === undefined || claim.jurisdiction.trim() === "") {
    blockers.push(blocker(
      "MANIFEST_CLAIM_JURISDICTION_MISSING",
      `material claim ${claim.claimId} has no jurisdiction`,
    ));
  }
  if (
    claim.proof.kind === "semantic"
    && (claim.requiredAuthority === undefined || claim.requiredAuthority.length === 0)
  ) {
    blockers.push(blocker(
      "MANIFEST_CLAIM_AUTHORITY_MISSING",
      `material semantic claim ${claim.claimId} declares no requiredAuthority`,
    ));
  }
  for (const citation of claim.citations) {
    const source = sourceById.get(citation.sourceId);
    if (source === undefined) continue;
    if (source.authorityTier === "unknown") {
      blockers.push(blocker(
        "MANIFEST_SOURCE_AUTHORITY_UNCLASSIFIED",
        `material claim ${claim.claimId} cites ${source.sourceId}, whose authorityTier is still the init default "unknown"`,
      ));
    }
    if (
      claim.jurisdiction !== undefined
      && !(source.jurisdictions ?? []).includes(claim.jurisdiction)
    ) {
      blockers.push(blocker(
        "MANIFEST_SOURCE_JURISDICTION_MISSING",
        `material claim ${claim.claimId} cites ${source.sourceId}, which is not scoped to ${claim.jurisdiction}`,
      ));
    }
  }
  return blockers;
}

/**
 * Which checklist items apply to this workspace.
 *
 * The PDF and OCR items are only required when a PDF or an OCR run actually
 * exists. Dropping an inapplicable requirement is allowed; writing `true` into
 * the file on a human's behalf is not, so this only ever narrows what must be
 * confirmed and never edits the checklist.
 */
function confirmationRequirement(
  inventory: DogfoodEvidenceInventory | undefined,
): { required: DogfoodConfirmationName[] } {
  const required: DogfoodConfirmationName[] = [
    "materialClaimCoverageReviewed",
    "sourceSelectionAndAuthorityReviewed",
    "exactQuotationAndPinpointReviewed",
  ];
  const ready = (inventory?.entries ?? []).filter((entry) => entry.status === "ready");
  if (ready.some((entry) => entry.quality?.exactQuoteReview === "PDF_VISUAL_REVIEW_REQUIRED")) {
    required.push("pdfVisualQuoteReviewCompleted");
  }
  if (ready.some((entry) => entry.ocr?.performed === true)) {
    required.push("ocrVisualReviewCompleted");
  }
  return { required };
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export interface DogfoodVerifyInput {
  workspacePath: string;
  traceDirectory?: string;
}

export interface DogfoodBlockedResult {
  workspace: string;
  status: "BLOCKED";
  counts: DogfoodCounts;
  blockers: DogfoodBlocker[];
}

/**
 * A verification that ran to completion. `CHECK_COMPLETED` says only that: the
 * gates passed, the verifier ran, and a trace was written. It is deliberately
 * not "VERIFIED", because this same wrapper carries `ABSTAIN`, `HUMAN_REVIEW`,
 * `REWRITE`, and `ASK` outcomes, and a status field reading "VERIFIED" next to
 * `decision: "ABSTAIN"` would be read by a human as the opposite of what the
 * verifier decided. The decision is the verdict; this is the envelope.
 */
export interface DogfoodCheckCompletedResult {
  workspace: string;
  status: "CHECK_COMPLETED";
  tracePath: string;
  decision: VerificationResult["decision"];
  coverage: VerificationResult["coverage"];
  shippable: boolean;
  counts: DogfoodCounts & {
    claimResults: number;
    actionResults: number;
    blockerFindings: number;
  };
}

export type DogfoodVerifyResult = DogfoodBlockedResult | DogfoodCheckCompletedResult;

/**
 * Runs the existing legal verification, but only after every mechanical and
 * human gate has passed.
 *
 * A blocked run returns `BLOCKED` and writes nothing at all. There is no path
 * through this function that produces a partial trace, and no path that reports
 * `PASS` without the verifier having actually said so.
 */
export async function verifyDogfoodWorkspace(
  input: DogfoodVerifyInput,
): Promise<DogfoodVerifyResult> {
  const report = await evaluateDogfoodWorkspace(input.workspacePath);
  if (report.blockers.length > 0) {
    return {
      workspace: report.workspace,
      status: "BLOCKED",
      counts: report.counts,
      blockers: report.blockers,
    };
  }

  // The legal adapter re-reads and re-validates both files itself. The gates
  // above are pre-checks; this call remains the authority on the legal contract.
  const request = await loadLegalManifest(report.draftSnapshotPath, report.manifestPath);
  // That second read reopens the file, so confirm it is still the manifest the
  // gates just cleared. Otherwise a manifest swapped in between the two reads
  // would be verified without ever passing the gates.
  if (report.manifest === undefined || hashObject(request) !== hashObject(report.manifest)) {
    return {
      workspace: report.workspace,
      status: "BLOCKED",
      counts: report.counts,
      blockers: [blocker(
        "MANIFEST_CHANGED_DURING_VERIFICATION",
        "the manifest changed between the gate check and verification; nothing was verified",
      )],
    };
  }

  // Created only once there is definitely a result to store. The in-workspace
  // default is a fixed name and is checked for a symlink standing in its place;
  // an explicit `--trace-dir` is a path the caller named on this command line,
  // so it is used as given.
  const traceDirectory = input.traceDirectory === undefined
    ? join(report.workspace, DEFAULT_TRACE_DIRECTORY)
    : resolve(input.traceDirectory);
  if (input.traceDirectory === undefined) await assertSafeTraceDirectory(traceDirectory);
  // Only tighten a directory this run created. An existing directory the caller
  // pointed at keeps its own permissions; the trace file itself is always 0600
  // and is written exclusively, so an existing artifact is never replaced.
  await ensurePrivateDirectory(traceDirectory);

  const result = await verifyRequest(request);
  const tracePath = await writeAuditTrace(traceDirectory, request, result, { exclusive: true });
  return {
    workspace: report.workspace,
    status: "CHECK_COMPLETED",
    tracePath,
    decision: result.decision,
    coverage: result.coverage,
    shippable: result.decision === "PASS"
      && result.actions.every((action) => action.decision === "ALLOW"),
    counts: {
      ...report.counts,
      claimResults: result.claims.length,
      actionResults: result.actions.length,
      blockerFindings: result.findings.filter((item) => item.severity === "BLOCKER").length,
    },
  };
}
