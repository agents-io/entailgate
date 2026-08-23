import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { hashObject, sha256File, sha256Text } from "../src/canonical.js";
import {
  LegalSourceCacheError,
  legalIngestKey,
  legalPacketKey,
  loadOrIngestLegalAuthority,
  type ExternalLegalAuthorityIdentity,
} from "../src/legal-source-cache.js";

const execFileAsync = promisify(execFile);

const identity: ExternalLegalAuthorityIdentity = {
  canonicalId: "BCSC-2024-994",
  title: "Fixture v Example",
  issuer: "Supreme Court of British Columbia",
  legalClass: "adjudicative_decision",
  authorityTier: "primary",
  jurisdiction: "BC",
  canonicalUri: "https://example.invalid/2024-bcsc-994",
};

test("external legal sources are extracted once and reused by content identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-cache-"));
  const cacheDirectory = join(root, "cache");
  const firstPath = join(root, "opaque-a.txt");
  const secondPath = join(root, "opaque-b.txt");
  const text = "The tribunal must give written reasons.\n";
  await writeFile(firstPath, text, "utf8");
  await writeFile(secondPath, text, "utf8");

  const first = await loadOrIngestLegalAuthority({ sourcePath: firstPath, cacheDirectory, identity });
  const second = await loadOrIngestLegalAuthority({ sourcePath: secondPath, cacheDirectory, identity });
  assert.equal(first.status, "CACHE_MISS");
  assert.equal(second.status, "CACHE_HIT");
  assert.equal(second.entry.entryHash, first.entry.entryHash);
  assert.equal(second.lock.lockHash, first.lock.lockHash);
  assert.equal(second.ingestion.source.path, secondPath);
  assert.equal(JSON.stringify(first.entry).includes(firstPath), false);
  assert.equal(JSON.stringify(first.entry).includes(secondPath), false);
  assert.equal((await stat(cacheDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.cachePath)).mode & 0o777, 0o600);
});

test("concurrent callers share one in-process extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-cache-concurrent-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "One source for simultaneous claim packets.\n", "utf8");
  const [first, second] = await Promise.all([
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["CACHE_HIT", "CACHE_MISS"]);
  assert.equal(first.entry.entryHash, second.entry.entryHash);
  assert.equal(first.lock.lockHash, second.lock.lockHash);
});

test("source bytes and extraction policy invalidate only the extraction cache key", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-cache-invalidation-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Original authority text.\n", "utf8");
  const original = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });

  await writeFile(path, "Changed authority text.\n", "utf8");
  const changedBytes = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  assert.equal(changedBytes.status, "CACHE_MISS");
  assert.notEqual(changedBytes.entry.ingestKey, original.entry.ingestKey);
  assert.notEqual(changedBytes.lock.lockHash, original.lock.lockHash);

  const changedPolicy = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory,
    identity,
    ingestOptions: { sparsePageThreshold: 41 },
  });
  assert.equal(changedPolicy.status, "CACHE_MISS");
  assert.notEqual(changedPolicy.entry.ingestKey, changedBytes.entry.ingestKey);
});

test("omitted and explicit ingestion defaults share one cache identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-cache-defaults-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Stable authority text.\n", "utf8");
  const first = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const second = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory,
    identity,
    ingestOptions: {
      ocrPolicy: "report",
      sparsePageThreshold: 40,
      maxFileBytes: 100 * 1024 * 1024,
      commandTimeoutMs: 60_000,
      maxCommandOutputBytes: 32 * 1024 * 1024,
      maxPdfPages: 2_000,
      maxExtractedTextBytes: 64 * 1024 * 1024,
      totalTimeoutMs: 5 * 60_000,
      maxOcrOutputBytes: 256 * 1024 * 1024,
    },
  });
  assert.equal(second.status, "CACHE_HIT");
  assert.equal(second.entry.ingestKey, first.entry.ingestKey);
});

test("authority identity changes rebuild the lock without repeating extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-lock-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Stable official source bytes.\n", "utf8");
  const first = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const second = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory,
    identity: { ...identity, jurisdiction: "CA" },
  });
  assert.equal(second.status, "CACHE_HIT");
  assert.equal(second.entry.entryHash, first.entry.entryHash);
  assert.notEqual(second.lock.lockHash, first.lock.lockHash);
});

test("packet keys enforce lock closure and invalidate checker semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-packet-key-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Locked authority paragraph.\n", "utf8");
  const firstAuthority = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory,
    identity,
  });
  const secondAuthority = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory,
    identity: { ...identity, canonicalId: "BCSC-2024-994-alt" },
  });
  const chunkHash = firstAuthority.lock.orderedChunkHashes[0]!;
  const firstCitation = {
    authorityLockHash: firstAuthority.lock.lockHash,
    chunkHash,
  };
  const secondCitation = {
    authorityLockHash: secondAuthority.lock.lockHash,
    chunkHash,
  };
  const base = {
    claimBindingHash: sha256Text("claim"),
    authorityLocks: [secondAuthority.lock, firstAuthority.lock, firstAuthority.lock],
    citedChunks: [firstCitation, secondCitation, secondCitation],
    contextClosureHash: sha256Text("context"),
    jurisdiction: "BC",
    asOf: "2026-08-23",
    checkerName: "legal-verifier",
    checkerVersion: "1.0.0",
    checkerKind: "model" as const,
  };
  const first = legalPacketKey(base);
  const reordered = legalPacketKey({
    ...base,
    authorityLocks: [firstAuthority.lock, secondAuthority.lock],
    citedChunks: [secondCitation, firstCitation],
  });
  assert.equal(reordered, first);
  assert.notEqual(legalPacketKey({ ...base, checkerVersion: "1.0.1" }), first);
  assert.notEqual(legalPacketKey({
    ...base,
    authorityLocks: [firstAuthority.lock],
    citedChunks: [firstCitation],
  }), first);
  assert.throws(
    () => legalPacketKey({
      ...base,
      citedChunks: [{
        authorityLockHash: firstAuthority.lock.lockHash,
        chunkHash: sha256Text("forged unrelated chunk"),
      }],
    }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("citedChunks[0] is outside its authority lock"),
  );
});

test("returned cache entries, locks, and ingestion views are deeply immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-immutable-"));
  const path = join(root, "authority.txt");
  await writeFile(path, "Immutable authority paragraph.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({
    sourcePath: path,
    cacheDirectory: join(root, "cache"),
    identity,
  });
  assert.equal(Object.isFrozen(result.entry.pages), true);
  assert.equal(Object.isFrozen(result.entry.pages[0]), true);
  assert.equal(Object.isFrozen(result.lock), true);
  assert.equal(Object.isFrozen(result.ingestion.pages), true);
  assert.throws(() => {
    (result.entry.pages[0] as { text: string }).text = "mutated";
  }, TypeError);
  assert.throws(() => {
    (result.ingestion.pages[0] as { text: string }).text = "mutated";
  }, TypeError);
});

test("cache entries carry extraction only and cannot smuggle a semantic verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-no-verdict-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Authority source.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const serialized = await readFile(result.cachePath, "utf8");
  for (const forbidden of ["SUPPORTED", "CONTRADICTED", "PASS", "verdict", "semantic"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(result.ingestion.quality.legalAccuracy, "UNCHECKED");
});

test("tampered cache entries fail closed instead of being trusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-tamper-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Authority source.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const record = JSON.parse(await readFile(result.cachePath, "utf8")) as Record<string, unknown>;
  record.entryHash = "0".repeat(64);
  await chmod(result.cachePath, 0o600);
  await writeFile(result.cachePath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("entryHash mismatch"),
  );
});

test("a rehashed forged plain-text page still fails closed against source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-forged-page-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Original authority source.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const record = JSON.parse(await readFile(result.cachePath, "utf8")) as Record<string, unknown>;
  const pages = record.pages as Array<Record<string, unknown>>;
  pages[0]!.text = "Forged legal proposition.\n";
  pages[0]!.textSha256 = sha256Text(String(pages[0]!.text));
  pages[0]!.pageId = `${record.sourceSha256}:page:1:${pages[0]!.textSha256}`;
  pages[0]!.characterCount = [...String(pages[0]!.text)].length;
  pages[0]!.nonWhitespaceCharacterCount = (String(pages[0]!.text).match(/\S/gu) ?? []).length;
  const { entryHash: _oldHash, ...core } = record;
  record.entryHash = hashObject(core);
  await writeFile(result.cachePath, JSON.stringify(record), "utf8");

  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("plain-text cached extraction does not match source bytes"),
  );
});

test("a rehashed cache entry cannot inject a semantic verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-injected-verdict-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Original authority source.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const record = JSON.parse(await readFile(result.cachePath, "utf8")) as Record<string, unknown>;
  record.verdict = "SUPPORTED";
  const { entryHash: _oldHash, ...core } = record;
  record.entryHash = hashObject(core);
  await writeFile(result.cachePath, JSON.stringify(record), "utf8");
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("cache entry contains unknown field: verdict"),
  );
});

test("malformed nested cache pages fail typed without a raw TypeError", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-malformed-page-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Original authority source.\n", "utf8");
  const result = await loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity });
  const record = JSON.parse(await readFile(result.cachePath, "utf8")) as Record<string, unknown>;
  record.pages = [null];
  const { entryHash: _oldHash, ...core } = record;
  record.entryHash = hashObject(core);
  await writeFile(result.cachePath, JSON.stringify(record), "utf8");
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("pages[0] must be an object"),
  );
});

test("an existing permissive cache directory is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-cache-permissions-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Authority source.\n", "utf8");
  await mkdir(cacheDirectory, { mode: 0o755 });
  await chmod(cacheDirectory, 0o755);
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("cache directory must be owner-only (0700 or stricter)"),
  );
});

test("oversized sources are refused before the preliminary hash read", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-size-preflight-"));
  const path = join(root, "oversized.txt");
  const handle = await open(path, "w", 0o600);
  await handle.truncate(1024 * 1024);
  await handle.close();
  await assert.rejects(
    loadOrIngestLegalAuthority({
      sourcePath: path,
      cacheDirectory: join(root, "cache"),
      identity,
      ingestOptions: { maxFileBytes: 128 },
    }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.some((issue) => issue.startsWith("SOURCE_TOO_LARGE:")),
  );
});

test("a FIFO is rejected promptly before any blocking hash read", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-fifo-"));
  const path = join(root, "source.fifo");
  await execFileAsync("mkfifo", [path]);
  const startedAt = Date.now();
  await assert.rejects(
    loadOrIngestLegalAuthority({
      sourcePath: path,
      cacheDirectory: join(root, "cache"),
      identity,
      ingestOptions: { totalTimeoutMs: 100 },
    }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.some((issue) => issue.startsWith("SOURCE_NOT_REGULAR_FILE:")),
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("malformed existing cache JSON fails before cache-miss ingestion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-malformed-cache-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "authority.txt");
  await writeFile(path, "Authority source.\n", "utf8");
  const sourceSha256 = await sha256File(path);
  const key = legalIngestKey(sourceSha256);
  await mkdir(cacheDirectory, { mode: 0o700 });
  await writeFile(join(cacheDirectory, `${key}.legal-source-cache.json`), "{broken", {
    encoding: "utf8",
    mode: 0o600,
  });
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.some((issue) => issue.startsWith("cache entry could not be read:")),
  );
});

test("runtime authority identities are closed and temporally ordered", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-identity-"));
  const path = join(root, "authority.txt");
  await writeFile(path, "Authority source.\n", "utf8");
  await assert.rejects(
    loadOrIngestLegalAuthority({
      sourcePath: path,
      cacheDirectory: join(root, "cache"),
      identity: {
        ...identity,
        effectiveFrom: "2026-12-31",
        effectiveTo: "2026-01-01",
        secretPrivateField: "must not enter lock",
      } as ExternalLegalAuthorityIdentity,
    }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("identity contains unknown field: secretPrivateField")
      && error.issues.includes("identity effective interval is inverted"),
  );
});

test("packet keys reject incomplete or malformed semantic bindings", () => {
  const validHash = sha256Text("valid");
  assert.throws(
    () => legalPacketKey({
      claimBindingHash: validHash,
      authorityLocks: [],
      citedChunks: [],
      contextClosureHash: validHash,
      jurisdiction: " ",
      asOf: "not-a-date",
      checkerName: "",
      checkerVersion: "",
      checkerKind: "remote" as "model",
      privateScopeHash: "bad",
    }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.includes("authorityLocks must not be empty")
      && error.issues.includes("citedChunks must not be empty")
      && error.issues.includes("checkerKind is invalid")
      && error.issues.includes("privateScopeHash must be lowercase SHA-256"),
  );
});

test("unresolved extraction is never cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebr-legal-unresolved-"));
  const cacheDirectory = join(root, "cache");
  const path = join(root, "invalid.txt");
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    loadOrIngestLegalAuthority({ sourcePath: path, cacheDirectory, identity }),
    (error: unknown) => error instanceof LegalSourceCacheError
      && error.issues.some((issue) => issue.startsWith("INVALID_UTF8:")),
  );
  await assert.rejects(stat(cacheDirectory));
  assert.equal((await sha256File(path)).length, 64);
});
