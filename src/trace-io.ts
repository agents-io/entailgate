import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Shared shape predicates and private-file hygiene for every persisted audit
// artifact. Verification traces and revision-plan traces are different
// contracts, but both can contain raw subject or evidence text, so they must
// not diverge on how bytes reach the disk.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function newTraceId(createdAt: string): string {
  return createdAt.replace(/[^0-9]/gu, "").slice(0, 17) + "-" + randomUUID().slice(0, 12);
}

export type JsonReadOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Reads and parses an artifact without throwing. Each artifact reader owns its
 * own typed integrity error, so the failure is returned rather than raised.
 */
export async function readJsonFile(path: string): Promise<JsonReadOutcome> {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "artifact JSON could not be read",
    };
  }
}

export class ArtifactExistsError extends Error {
  constructor(public readonly path: string) {
    super(`refusing to replace an existing artifact: ${path}`);
    this.name = "ArtifactExistsError";
  }
}

export interface PrivateArtifactWriteOptions {
  /**
   * Refuse to replace an existing target instead of renaming over it. Audit
   * traces carry a random trace ID and keep the historical rename behaviour;
   * fixed-name artifacts opt in so a second write can never silently destroy
   * the first one.
   */
  exclusive?: boolean;
}

/**
 * Creates a directory, giving every component this call brings into existence
 * mode `0700`.
 *
 * `mkdir` masks its `mode` through the process umask, so a permissive umask
 * would otherwise leave a directory holding private subject or evidence text
 * group- or world-readable. Recursive `mkdir` reports the first component it
 * created, and every component below that one is new too, so each is chmod-ed
 * explicitly. A directory that already existed is left exactly as the caller
 * set it up: this never widens or narrows someone else's permissions.
 */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (firstCreated === undefined) return;
  await chmod(firstCreated, 0o700);
  const remainder = relative(firstCreated, directory);
  if (remainder === "") return;
  let current = firstCreated;
  for (const component of remainder.split(sep)) {
    current = join(current, component);
    await chmod(current, 0o700);
  }
}

/**
 * Writes an owner-only artifact through an exclusive temporary file and moves
 * it into place, so a concurrent reader never observes a partial artifact and
 * the stored text is not world-readable.
 *
 * `exclusive` swaps the final `rename` for a `link`, which fails with `EEXIST`
 * rather than replacing an existing target. The temporary file is removed on
 * both paths.
 */
export async function writePrivateJsonArtifact(
  directory: string,
  fileName: string,
  value: unknown,
  options: PrivateArtifactWriteOptions = {},
): Promise<string> {
  await ensurePrivateDirectory(directory);
  const target = join(directory, fileName);
  const temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (options.exclusive !== true) {
    await rename(temporary, target);
    return target;
  }
  try {
    await link(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (isExistsError(error)) throw new ArtifactExistsError(target);
    throw error;
  }
  await rm(temporary, { force: true });
  return target;
}

function isExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
