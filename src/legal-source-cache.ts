import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hashObject } from "./canonical.js";
import {
  buildIngestedPages,
  ingestLocalFile,
  type IngestOptions,
  type IngestReady,
} from "./ingest.js";
import {
  ArtifactExistsError,
  isNonEmptyString,
  isRecord,
  isSha256Hex,
  readJsonFile,
  writePrivateJsonArtifact,
} from "./trace-io.js";
import type { LegalSourceClass } from "./legal-authority-scope.js";

export const LEGAL_SOURCE_CACHE_SCHEMA_VERSION = "0.1.0-alpha";
export const LEGAL_INGEST_CONTRACT_VERSION = "ingest@0.1.0-alpha";
export const LEGAL_AUTHORITY_LOCK_VERSION = "authority-lock@0.1.0-alpha";
export const LEGAL_PACKET_KEY_VERSION = "legal-packet@0.1.0-alpha";

export type CacheStatus = "CACHE_HIT" | "CACHE_MISS";

export interface ExternalLegalAuthorityIdentity {
  canonicalId: string;
  title: string;
  issuer: string;
  legalClass: Exclude<LegalSourceClass, "non_legal_record" | "unknown">;
  authorityTier: "primary" | "official_guidance" | "secondary";
  jurisdiction: string;
  canonicalUri?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

interface CachedSourceShape {
  mediaType: IngestReady["source"]["mediaType"];
  byteLength: number;
  sha256: string;
  snapshot: IngestReady["source"]["snapshot"];
}

export interface LegalSourceCacheEntryCore {
  schemaVersion: typeof LEGAL_SOURCE_CACHE_SCHEMA_VERSION;
  kind: "legal-source-extraction-cache";
  ingestContractVersion: typeof LEGAL_INGEST_CONTRACT_VERSION;
  ingestKey: string;
  sourceSha256: string;
  normalizedOptions: Record<string, string | number>;
  source: CachedSourceShape;
  pages: IngestReady["pages"];
  extraction: IngestReady["extraction"];
  ocr: IngestReady["ocr"];
  quality: IngestReady["quality"];
}

export interface LegalSourceCacheEntry extends LegalSourceCacheEntryCore {
  entryHash: string;
}

export interface LegalAuthorityLockCore {
  schemaVersion: typeof LEGAL_SOURCE_CACHE_SCHEMA_VERSION;
  kind: "legal-authority-lock";
  lockVersion: typeof LEGAL_AUTHORITY_LOCK_VERSION;
  ingestKey: string;
  extractionEntryHash: string;
  sourceSha256: string;
  identity: ExternalLegalAuthorityIdentity;
  orderedChunkHashes: string[];
}

export interface LegalAuthorityLock extends LegalAuthorityLockCore {
  lockHash: string;
}

export interface CachedLegalAuthority {
  status: CacheStatus;
  cachePath: string;
  entry: LegalSourceCacheEntry;
  lock: LegalAuthorityLock;
  ingestion: IngestReady;
}

export interface LoadOrIngestLegalAuthorityInput {
  sourcePath: string;
  cacheDirectory: string;
  identity: ExternalLegalAuthorityIdentity;
  ingestOptions?: IngestOptions;
}

export class LegalSourceCacheError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Legal source cache failed closed: ${issues.join("; ")}`);
    this.name = "LegalSourceCacheError";
  }
}

const inFlightExtractions = new Map<string, Promise<CachedLegalAuthority>>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedIngestOptions(options: IngestOptions = {}): Record<string, string | number> {
  return {
    mediaType: options.mediaType ?? "auto",
    ocrPolicy: options.ocrPolicy ?? "report",
    // These values mirror ingest.ts. Any ingestion-default change must bump
    // LEGAL_INGEST_CONTRACT_VERSION so omitted and explicit defaults remain
    // one content identity instead of causing duplicate extraction work.
    sparsePageThreshold: options.sparsePageThreshold ?? 40,
    maxFileBytes: options.maxFileBytes ?? 100 * 1024 * 1024,
    commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
    maxCommandOutputBytes: options.maxCommandOutputBytes ?? 32 * 1024 * 1024,
    maxPdfPages: options.maxPdfPages ?? 2_000,
    maxExtractedTextBytes: options.maxExtractedTextBytes ?? 64 * 1024 * 1024,
    totalTimeoutMs: options.totalTimeoutMs ?? 5 * 60_000,
    maxOcrOutputBytes: options.maxOcrOutputBytes ?? 256 * 1024 * 1024,
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): string[] {
  const expected = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !expected.has(key))
    .map((key) => `${label} contains unknown field: ${key}`);
}

function validateNormalizedOptions(options: Record<string, string | number>): void {
  const issues: string[] = [];
  if (!["auto", "text/plain", "application/pdf"].includes(String(options.mediaType))) {
    issues.push("normalizedOptions.mediaType is invalid");
  }
  if (!["report", "perform"].includes(String(options.ocrPolicy))) {
    issues.push("normalizedOptions.ocrPolicy is invalid");
  }
  for (const key of [
    "maxFileBytes",
    "commandTimeoutMs",
    "maxCommandOutputBytes",
    "maxPdfPages",
    "maxExtractedTextBytes",
    "totalTimeoutMs",
    "maxOcrOutputBytes",
  ]) {
    const value = options[key];
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      issues.push(`normalizedOptions.${key} must be a positive integer`);
    }
  }
  if (!Number.isSafeInteger(options.sparsePageThreshold)
    || Number(options.sparsePageThreshold) < 0) {
    issues.push("normalizedOptions.sparsePageThreshold must be a non-negative integer");
  }
  if (issues.length > 0) throw new LegalSourceCacheError(issues);
}

interface SafeSourceIdentity {
  path: string;
  sha256: string;
}

async function safelyHashSource(
  inputPath: string,
  normalizedOptions: Record<string, string | number>,
): Promise<SafeSourceIdentity> {
  validateNormalizedOptions(normalizedOptions);
  const requestedPath = resolve(inputPath);
  try {
    const link = await lstat(requestedPath);
    if (!link.isFile() && !link.isSymbolicLink()) {
      throw new LegalSourceCacheError(["SOURCE_NOT_REGULAR_FILE: source must be a regular file"]);
    }
    const path = await realpath(requestedPath);
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new LegalSourceCacheError(["SOURCE_NOT_REGULAR_FILE: source must be a regular file"]);
      }
      const maxFileBytes = Number(normalizedOptions.maxFileBytes);
      if (before.size > maxFileBytes) {
        throw new LegalSourceCacheError([
          `SOURCE_TOO_LARGE: source is ${before.size} bytes; configured limit is ${maxFileBytes} bytes`,
        ]);
      }
      const deadlineAt = Date.now() + Number(normalizedOptions.totalTimeoutMs);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytesReadTotal = 0;
      while (true) {
        if (Date.now() > deadlineAt) {
          throw new LegalSourceCacheError(["INGEST_DEADLINE_EXCEEDED: source hashing timed out"]);
        }
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytesReadTotal += bytesRead;
        if (bytesReadTotal > maxFileBytes) {
          throw new LegalSourceCacheError(["SOURCE_TOO_LARGE: source exceeded the configured limit"]);
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (bytesReadTotal !== before.size || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new LegalSourceCacheError(["SOURCE_CHANGED: source changed while being hashed"]);
      }
      return { path, sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LegalSourceCacheError) throw error;
    throw new LegalSourceCacheError([
      `SOURCE_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

export function legalIngestKey(sourceSha256: string, options: IngestOptions = {}): string {
  if (!isSha256Hex(sourceSha256)) {
    throw new LegalSourceCacheError(["sourceSha256 must be lowercase SHA-256"]);
  }
  return hashObject({
    schemaVersion: LEGAL_SOURCE_CACHE_SCHEMA_VERSION,
    ingestContractVersion: LEGAL_INGEST_CONTRACT_VERSION,
    sourceSha256,
    normalizedOptions: normalizedIngestOptions(options),
  });
}

function validateIdentity(identity: ExternalLegalAuthorityIdentity): void {
  const issues: string[] = [];
  if (!isRecord(identity)) throw new LegalSourceCacheError(["identity must be an object"]);
  issues.push(...exactKeys(identity as unknown as Record<string, unknown>, [
    "canonicalId",
    "title",
    "issuer",
    "legalClass",
    "authorityTier",
    "jurisdiction",
    "canonicalUri",
    "effectiveFrom",
    "effectiveTo",
  ], "identity"));
  for (const field of ["canonicalId", "title", "issuer", "jurisdiction"] as const) {
    if (!isNonEmptyString(identity[field])) issues.push(`identity.${field} is required`);
  }
  if (!["enacted_law", "adjudicative_decision", "official_policy", "official_guidance", "secondary_commentary"].includes(identity.legalClass)) {
    issues.push("identity.legalClass must be an external legal class");
  }
  if (!["primary", "official_guidance", "secondary"].includes(identity.authorityTier)) {
    issues.push("identity.authorityTier is invalid");
  }
  if (identity.canonicalUri !== undefined) {
    try {
      const uri = new URL(identity.canonicalUri);
      if (!["http:", "https:"].includes(uri.protocol)) issues.push("identity.canonicalUri must be HTTP(S)");
    } catch {
      issues.push("identity.canonicalUri must be a valid URL");
    }
  }
  for (const field of ["effectiveFrom", "effectiveTo"] as const) {
    const value = identity[field];
    if (value !== undefined && (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value)))) {
      issues.push(`identity.${field} must be a valid date or date-time`);
    }
  }
  if (identity.effectiveFrom !== undefined && identity.effectiveTo !== undefined
    && Number.isFinite(Date.parse(identity.effectiveFrom))
    && Number.isFinite(Date.parse(identity.effectiveTo))
    && Date.parse(identity.effectiveFrom) > Date.parse(identity.effectiveTo)) {
    issues.push("identity effective interval is inverted");
  }
  if (issues.length > 0) throw new LegalSourceCacheError(issues);
}

function entryCore(result: IngestReady, ingestKey: string, options: IngestOptions): LegalSourceCacheEntryCore {
  return {
    schemaVersion: LEGAL_SOURCE_CACHE_SCHEMA_VERSION,
    kind: "legal-source-extraction-cache",
    ingestContractVersion: LEGAL_INGEST_CONTRACT_VERSION,
    ingestKey,
    sourceSha256: result.source.sha256,
    normalizedOptions: normalizedIngestOptions(options),
    source: {
      mediaType: result.source.mediaType,
      byteLength: result.source.byteLength,
      sha256: result.source.sha256,
      snapshot: result.source.snapshot,
    },
    pages: result.pages,
    extraction: result.extraction,
    ocr: result.ocr,
    quality: result.quality,
  };
}

function withEntryHash(core: LegalSourceCacheEntryCore): LegalSourceCacheEntry {
  return deepFreeze({ ...core, entryHash: hashObject(core) });
}

function validateCachedEntryShape(
  entry: LegalSourceCacheEntry,
  expectedOptions: Record<string, string | number>,
): string[] {
  const issues: string[] = [];
  issues.push(...exactKeys(entry as unknown as Record<string, unknown>, [
    "schemaVersion",
    "kind",
    "ingestContractVersion",
    "ingestKey",
    "sourceSha256",
    "normalizedOptions",
    "source",
    "pages",
    "extraction",
    "ocr",
    "quality",
    "entryHash",
  ], "cache entry"));
  if (!isRecord(entry.normalizedOptions)
    || hashObject(entry.normalizedOptions) !== hashObject(expectedOptions)) {
    issues.push("normalizedOptions mismatch");
  }
  if (isRecord(entry.source)) {
    issues.push(...exactKeys(entry.source as unknown as Record<string, unknown>, [
      "mediaType", "byteLength", "sha256", "snapshot",
    ], "source"));
    if (!["text/plain", "application/pdf"].includes(entry.source.mediaType)) {
      issues.push("source.mediaType is invalid");
    }
    if (!Number.isSafeInteger(entry.source.byteLength) || entry.source.byteLength < 0) {
      issues.push("source.byteLength must be a non-negative integer");
    }
    if (!isRecord(entry.source.snapshot)) {
      issues.push("source.snapshot must be an object");
    } else {
      issues.push(...exactKeys(entry.source.snapshot as unknown as Record<string, unknown>, [
        "sha256", "byteLength", "policy",
      ], "source.snapshot"));
      if (entry.source.snapshot.sha256 !== entry.source.sha256
        || entry.source.snapshot.byteLength !== entry.source.byteLength
        || entry.source.snapshot.policy !== "private_read_only_temp") {
        issues.push("source.snapshot does not bind the cached source");
      }
    }
  }
  if (Array.isArray(entry.pages) && isRecord(entry.source)) {
    const pagesAreRecords = entry.pages.every((page) => isRecord(page));
    for (const [index, page] of entry.pages.entries()) {
      if (!isRecord(page)) {
        issues.push(`pages[${index}] must be an object`);
        continue;
      }
      issues.push(...exactKeys(page, [
        "pageNumber", "pageId", "locator", "text", "textSha256",
        "characterCount", "nonWhitespaceCharacterCount",
      ], `pages[${index}]`));
    }
    const texts = pagesAreRecords ? entry.pages.map((page) => page.text) : [];
    if (!pagesAreRecords || texts.some((text) => typeof text !== "string")) {
      issues.push("cached page text must be a string");
    } else if (hashObject(buildIngestedPages(
      entry.sourceSha256,
      entry.source.mediaType,
      texts,
    )) !== hashObject(entry.pages)) {
      issues.push("cached page provenance or text hash mismatch");
    }
    if (entry.source.mediaType === "text/plain"
      && (entry.pages.length !== 1 || entry.pages[0]?.textSha256 !== entry.sourceSha256)) {
      issues.push("plain-text cached extraction does not match source bytes");
    }
  }
  if (!isRecord(entry.extraction)) {
    issues.push("extraction must be an object");
  } else {
    issues.push(...exactKeys(entry.extraction as unknown as Record<string, unknown>, [
      "method", "tools", "invocations", "pdfPageCount", "pdfFontInspection",
    ], "extraction"));
    if (!["node_utf8", "pdftotext", "ocrmypdf_pdftotext"].includes(entry.extraction.method)) {
      issues.push("extraction.method is invalid");
    }
    if (!Array.isArray(entry.extraction.tools) || !Array.isArray(entry.extraction.invocations)) {
      issues.push("extraction tools and invocations must be arrays");
    }
  }
  if (!isRecord(entry.ocr)) {
    issues.push("ocr must be an object");
  } else {
    issues.push(...exactKeys(entry.ocr as unknown as Record<string, unknown>, [
      "required", "reason", "sparsePageThreshold", "emptyPages", "sparsePages", "performed",
    ], "ocr"));
    if (typeof entry.ocr.required !== "boolean" || typeof entry.ocr.performed !== "boolean"
      || !Array.isArray(entry.ocr.emptyPages) || !Array.isArray(entry.ocr.sparsePages)) {
      issues.push("ocr shape is invalid");
    }
  }
  if (!isRecord(entry.quality)) {
    issues.push("quality must be an object");
  } else {
    issues.push(...exactKeys(entry.quality as unknown as Record<string, unknown>, [
      "meaningOfReady", "extractionAccuracy", "ocrAccuracy", "legalAccuracy",
      "exactQuoteReview", "limitations",
    ], "quality"));
    if (entry.quality.meaningOfReady !== "TECHNICAL_EXTRACTION_COMPLETED_NOT_ACCURACY_VERIFIED"
      || entry.quality.extractionAccuracy !== "UNCHECKED"
      || entry.quality.legalAccuracy !== "UNCHECKED"
      || !Array.isArray(entry.quality.limitations)) {
      issues.push("quality cannot claim verified extraction or legal accuracy");
    }
  }
  return issues;
}

function parseEntry(
  value: unknown,
  expectedKey: string,
  expectedSha256: string,
  expectedOptions: Record<string, string | number>,
): LegalSourceCacheEntry {
  if (!isRecord(value)) throw new LegalSourceCacheError(["cache entry must be an object"]);
  const entry = value as unknown as LegalSourceCacheEntry;
  const issues: string[] = [];
  if (entry.schemaVersion !== LEGAL_SOURCE_CACHE_SCHEMA_VERSION) issues.push("cache schemaVersion mismatch");
  if (entry.kind !== "legal-source-extraction-cache") issues.push("cache kind mismatch");
  if (entry.ingestContractVersion !== LEGAL_INGEST_CONTRACT_VERSION) issues.push("ingest contract mismatch");
  if (entry.ingestKey !== expectedKey) issues.push("ingest key mismatch");
  if (entry.sourceSha256 !== expectedSha256) issues.push("source SHA-256 mismatch");
  if (!isSha256Hex(entry.entryHash)) issues.push("entryHash must be lowercase SHA-256");
  const { entryHash: _entryHash, ...core } = entry;
  if (isSha256Hex(entry.entryHash) && hashObject(core) !== entry.entryHash) issues.push("entryHash mismatch");
  if (!isRecord(entry.source) || entry.source.sha256 !== expectedSha256) issues.push("cached source mismatch");
  if (!Array.isArray(entry.pages)) issues.push("cached pages must be an array");
  issues.push(...validateCachedEntryShape(entry, expectedOptions));
  if (issues.length > 0) throw new LegalSourceCacheError(issues);
  return deepFreeze(entry);
}

function restoreIngestion(entry: LegalSourceCacheEntry, currentPath: string): IngestReady {
  return deepFreeze({
    status: "ready",
    source: { path: currentPath, ...entry.source },
    pages: entry.pages,
    extraction: entry.extraction,
    ocr: entry.ocr,
    quality: entry.quality,
  });
}

function buildLock(entry: LegalSourceCacheEntry, identity: ExternalLegalAuthorityIdentity): LegalAuthorityLock {
  const lockedIdentity: ExternalLegalAuthorityIdentity = {
    canonicalId: identity.canonicalId,
    title: identity.title,
    issuer: identity.issuer,
    legalClass: identity.legalClass,
    authorityTier: identity.authorityTier,
    jurisdiction: identity.jurisdiction,
    ...(identity.canonicalUri === undefined ? {} : { canonicalUri: identity.canonicalUri }),
    ...(identity.effectiveFrom === undefined ? {} : { effectiveFrom: identity.effectiveFrom }),
    ...(identity.effectiveTo === undefined ? {} : { effectiveTo: identity.effectiveTo }),
  };
  const core: LegalAuthorityLockCore = {
    schemaVersion: LEGAL_SOURCE_CACHE_SCHEMA_VERSION,
    kind: "legal-authority-lock",
    lockVersion: LEGAL_AUTHORITY_LOCK_VERSION,
    ingestKey: entry.ingestKey,
    extractionEntryHash: entry.entryHash,
    sourceSha256: entry.sourceSha256,
    identity: lockedIdentity,
    orderedChunkHashes: entry.pages.map((page) => page.textSha256),
  };
  return deepFreeze({ ...core, lockHash: hashObject(core) });
}

async function readEntry(
  path: string,
  key: string,
  sourceSha256: string,
  expectedOptions: Record<string, string | number>,
): Promise<LegalSourceCacheEntry> {
  const loaded = await readJsonFile(path);
  if (!loaded.ok) throw new LegalSourceCacheError([`cache entry could not be read: ${loaded.message}`]);
  return parseEntry(loaded.value, key, sourceSha256, expectedOptions);
}

async function cacheRecordExists(path: string): Promise<boolean> {
  try {
    const record = await lstat(path);
    if (record.isSymbolicLink() || !record.isFile()) {
      throw new LegalSourceCacheError(["cache entry must be a regular non-symbolic file"]);
    }
    if ((record.mode & 0o077) !== 0) {
      throw new LegalSourceCacheError(["cache entry must be owner-only (0600 or stricter)"]);
    }
    return true;
  } catch (error) {
    if (error instanceof LegalSourceCacheError) throw error;
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw new LegalSourceCacheError([
      `cache entry could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

async function validateExistingCacheDirectory(directory: string): Promise<void> {
  try {
    const state = await lstat(directory);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new LegalSourceCacheError(["cache directory must be a non-symbolic directory"]);
    }
    if ((state.mode & 0o077) !== 0) {
      throw new LegalSourceCacheError(["cache directory must be owner-only (0700 or stricter)"]);
    }
  } catch (error) {
    if (error instanceof LegalSourceCacheError) throw error;
    if (isRecord(error) && error.code === "ENOENT") return;
    throw new LegalSourceCacheError([
      `cache directory could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

export async function loadOrIngestLegalAuthority(
  input: LoadOrIngestLegalAuthorityInput,
): Promise<CachedLegalAuthority> {
  validateIdentity(input.identity);
  const cacheDirectory = resolve(input.cacheDirectory);
  await validateExistingCacheDirectory(cacheDirectory);
  const options = input.ingestOptions ?? {};
  const normalizedOptions = normalizedIngestOptions(options);
  const safeSource = await safelyHashSource(input.sourcePath, normalizedOptions);
  const sourcePath = safeSource.path;
  const sourceSha256 = safeSource.sha256;
  const ingestKey = legalIngestKey(sourceSha256, options);
  const cachePath = resolve(cacheDirectory, `${ingestKey}.legal-source-cache.json`);
  const running = inFlightExtractions.get(cachePath);
  if (running) {
    const winner = await running;
    return {
      status: "CACHE_HIT",
      cachePath,
      entry: winner.entry,
      lock: buildLock(winner.entry, input.identity),
      ingestion: restoreIngestion(winner.entry, sourcePath),
    };
  }
  const task = (async (): Promise<CachedLegalAuthority> => {
    if (await cacheRecordExists(cachePath)) {
      const entry = await readEntry(cachePath, ingestKey, sourceSha256, normalizedOptions);
      return {
        status: "CACHE_HIT",
        cachePath,
        entry,
        lock: buildLock(entry, input.identity),
        ingestion: restoreIngestion(entry, sourcePath),
      };
    }

    const ingestion = await ingestLocalFile(sourcePath, options);
    if (ingestion.status !== "ready") {
      throw new LegalSourceCacheError([`${ingestion.code}: ${ingestion.message}`]);
    }
    if (ingestion.source.sha256 !== sourceSha256) {
      throw new LegalSourceCacheError(["source changed between cache-key hashing and ingestion"]);
    }
    const entry = withEntryHash(entryCore(ingestion, ingestKey, options));
    try {
      await writePrivateJsonArtifact(
        cacheDirectory,
        `${ingestKey}.legal-source-cache.json`,
        entry,
        { exclusive: true },
      );
    } catch (error) {
      if (!(error instanceof ArtifactExistsError)) throw error;
      const winner = await readEntry(cachePath, ingestKey, sourceSha256, normalizedOptions);
      return {
        status: "CACHE_HIT",
        cachePath,
        entry: winner,
        lock: buildLock(winner, input.identity),
        ingestion: restoreIngestion(winner, sourcePath),
      };
    }
    return {
      status: "CACHE_MISS",
      cachePath,
      entry,
      lock: buildLock(entry, input.identity),
      ingestion: restoreIngestion(entry, sourcePath),
    };
  })();
  inFlightExtractions.set(cachePath, task);
  try {
    return await task;
  } finally {
    if (inFlightExtractions.get(cachePath) === task) inFlightExtractions.delete(cachePath);
  }
}

export interface LegalPacketKeyInput {
  claimBindingHash: string;
  authorityLocks: readonly LegalAuthorityLock[];
  citedChunks: readonly {
    authorityLockHash: string;
    chunkHash: string;
  }[];
  contextClosureHash: string;
  jurisdiction: string;
  asOf: string;
  checkerName: string;
  checkerVersion: string;
  checkerKind: "human" | "model" | "hybrid";
  privateScopeHash?: string;
}

export function legalPacketKey(input: LegalPacketKeyInput): string {
  if (!isRecord(input)) throw new LegalSourceCacheError(["packet key input must be an object"]);
  const issues: string[] = [];
  issues.push(...exactKeys(input as unknown as Record<string, unknown>, [
    "claimBindingHash",
    "authorityLocks",
    "citedChunks",
    "contextClosureHash",
    "jurisdiction",
    "asOf",
    "checkerName",
    "checkerVersion",
    "checkerKind",
    "privateScopeHash",
  ], "packet key input"));
  const authorityLocks = Array.isArray(input.authorityLocks)
    ? input.authorityLocks
    : [];
  const citedChunks = Array.isArray(input.citedChunks)
    ? input.citedChunks
    : [];
  if (!Array.isArray(input.authorityLocks)) issues.push("authorityLocks must be an array");
  if (!Array.isArray(input.citedChunks)) issues.push("citedChunks must be an array");
  for (const field of ["claimBindingHash", "contextClosureHash"] as const) {
    if (!isSha256Hex(input[field])) issues.push(`${field} must be lowercase SHA-256`);
  }
  const locksByHash = new Map<string, LegalAuthorityLock>();
  for (const [index, lock] of authorityLocks.entries()) {
    if (!isRecord(lock)) {
      issues.push(`authorityLocks[${index}] must be an object`);
      continue;
    }
    if (!isSha256Hex(lock.lockHash)) {
      issues.push(`authorityLocks[${index}].lockHash must be lowercase SHA-256`);
      continue;
    }
    const { lockHash: _lockHash, ...core } = lock;
    if (hashObject(core) !== lock.lockHash) {
      issues.push(`authorityLocks[${index}] lockHash mismatch`);
      continue;
    }
    if (!Array.isArray(lock.orderedChunkHashes)
      || lock.orderedChunkHashes.some((hash) => !isSha256Hex(hash))) {
      issues.push(`authorityLocks[${index}].orderedChunkHashes is invalid`);
      continue;
    }
    locksByHash.set(lock.lockHash, lock as unknown as LegalAuthorityLock);
  }
  const validatedCitations: Array<{ authorityLockHash: string; chunkHash: string }> = [];
  for (const [index, citation] of citedChunks.entries()) {
    if (!isRecord(citation)) {
      issues.push(`citedChunks[${index}] must be an object`);
      continue;
    }
    issues.push(...exactKeys(citation, ["authorityLockHash", "chunkHash"], `citedChunks[${index}]`));
    if (!isSha256Hex(citation.authorityLockHash) || !isSha256Hex(citation.chunkHash)) {
      issues.push(`citedChunks[${index}] hashes must be lowercase SHA-256`);
      continue;
    }
    const lock = locksByHash.get(citation.authorityLockHash);
    if (!lock) {
      issues.push(`citedChunks[${index}] references an unlocked authority`);
      continue;
    }
    if (!lock.orderedChunkHashes.includes(citation.chunkHash)) {
      issues.push(`citedChunks[${index}] is outside its authority lock`);
      continue;
    }
    validatedCitations.push({
      authorityLockHash: citation.authorityLockHash,
      chunkHash: citation.chunkHash,
    });
  }
  if (authorityLocks.length === 0) issues.push("authorityLocks must not be empty");
  if (citedChunks.length === 0) issues.push("citedChunks must not be empty");
  for (const field of ["jurisdiction", "asOf", "checkerName", "checkerVersion"] as const) {
    if (!isNonEmptyString(input[field])) issues.push(`${field} is required`);
  }
  if (isNonEmptyString(input.asOf) && !Number.isFinite(Date.parse(input.asOf))) {
    issues.push("asOf must be a valid date or date-time");
  }
  if (!["human", "model", "hybrid"].includes(input.checkerKind)) {
    issues.push("checkerKind is invalid");
  }
  if (input.privateScopeHash !== undefined && !isSha256Hex(input.privateScopeHash)) {
    issues.push("privateScopeHash must be lowercase SHA-256");
  }
  if (issues.length > 0) throw new LegalSourceCacheError([...new Set(issues)]);
  return hashObject({
    packetKeyVersion: LEGAL_PACKET_KEY_VERSION,
    claimBindingHash: input.claimBindingHash,
    authorityLockHashes: [...locksByHash.keys()].sort(),
    citedChunks: [...new Map(validatedCitations.map((citation) => [
      `${citation.authorityLockHash}\u0000${citation.chunkHash}`,
      citation,
    ])).values()].sort((left, right) => {
      const lockOrder = left.authorityLockHash.localeCompare(right.authorityLockHash);
      return lockOrder === 0 ? left.chunkHash.localeCompare(right.chunkHash) : lockOrder;
    }),
    contextClosureHash: input.contextClosureHash,
    jurisdiction: input.jurisdiction,
    asOf: input.asOf,
    checker: {
      name: input.checkerName,
      version: input.checkerVersion,
      kind: input.checkerKind,
    },
    privateScopeHash: input.privateScopeHash ?? null,
  });
}
