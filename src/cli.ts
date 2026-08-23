#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildSemanticAttestation } from "./attestation.js";
import { sha256Text } from "./canonical.js";
import { compareInventories, extractClaimInventory } from "./claims.js";
import {
  DogfoodWorkspaceError,
  evaluateDogfoodWorkspace,
  initDogfoodWorkspace,
  verifyDogfoodWorkspace,
} from "./dogfood.js";
import { ingestLocalFile, type OcrPolicy } from "./ingest.js";
import { createLegalManifestSkeleton, loadLegalManifest } from "./legal.js";
import {
  LEGAL_SCOPE_PROFILE_VERSION,
  planDraftLegalCandidates,
} from "./legal-authority-scope.js";
import {
  LegalSourceCacheError,
  loadOrIngestLegalAuthority,
  type ExternalLegalAuthorityIdentity,
} from "./legal-source-cache.js";
import {
  readRevisionPlanTrace,
  replayRevisionPlanTrace,
  writeRevisionPlanTrace,
} from "./revision-trace.js";
import { readAuditTrace, replayAuditTrace, writeAuditTrace } from "./trace.js";
import type { VerificationResult, VerifyRequest } from "./types.js";
import { ContractError } from "./validate.js";
import { verifyRequest } from "./verify.js";

function usage(): string {
  return [
    "Evidence-Bound Runtime 0.1.1 (v0.2 alpha modules available)",
    "",
    "Usage:",
    "  ebr verify --request REQUEST.json [--trace-dir DIR]",
    "  ebr claims extract --input DRAFT.txt",
    "  ebr claims diff --before OLD.txt --after NEW.txt [--trace-dir DIR]",
    "  ebr revision show PLAN.json",
    "  ebr revision replay PLAN.json",
    "  ebr ingest --input SOURCE [--ocr report|perform]",
    "  ebr legal scope --draft DRAFT",
    "  ebr legal cache-source --source FILE --cache-dir DIR --canonical-id ID",
    "             --title TITLE --issuer ISSUER --class CLASS --tier TIER",
    "             --jurisdiction JURISDICTION [--uri URI] [--ocr report|perform]",
    "  ebr legal init --draft DRAFT --out MANIFEST.json",
    "  ebr legal --draft DRAFT --manifest MANIFEST.json [--trace-dir DIR]",
    "  ebr dogfood init --draft DRAFT --evidence-dir DIR --workspace DIR",
    "                   [--ocr report|perform]",
    "  ebr dogfood status --workspace DIR",
    "  ebr dogfood verify --workspace DIR [--trace-dir DIR]",
    "  ebr attest --request REQUEST.json --claim-id ID --checker NAME@VERSION",
    "             --kind human|model|hybrid [--scope subject|claim]",
    "             --verdict VERDICT --score 0..1 --reason TEXT",
    "  ebr trace show TRACE.json",
    "  ebr replay TRACE.json",
    "",
    "For verify/legal only: exit 0 means PASS and every proposed action is ALLOW.",
    "dogfood verify exits 0 only on that same rule; exit 1 means BLOCKED or not shippable.",
    "Other commands use exit 0 for successful utility execution. Exit 2 means invalid input.",
  ].join("\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function shippable(result: VerificationResult): boolean {
  return result.decision === "PASS"
    && result.actions.every((action) => action.decision === "ALLOW");
}

async function loadRequest(path: string): Promise<VerifyRequest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const result = await verifyRequest(value);
  return {
    ...(value as VerifyRequest),
    requestId: result.requestId,
  };
}

async function loadClaimText(path: string, label: string): Promise<string> {
  const result = await ingestLocalFile(resolve(path), { mediaType: "text/plain" });
  if (result.status === "unresolved") {
    throw new ContractError([`${label}: ${result.code}: ${result.message}`]);
  }
  return result.pages[0]?.text ?? "";
}

async function runVerification(
  request: VerifyRequest,
  traceDirectory: string,
): Promise<number> {
  const result = await verifyRequest(request);
  const tracePath = await writeAuditTrace(traceDirectory, request, result);
  process.stdout.write(JSON.stringify({ tracePath, result }, null, 2) + "\n");
  return shippable(result) ? 0 : 1;
}

/**
 * Local dogfood workspace commands. All of the workflow lives in `dogfood.ts`;
 * this only parses options and decides an exit code.
 *
 * `status` exits 0 whenever the workspace was readable, which says nothing
 * about legal outcome. `verify` exits 1 when it is blocked and never prints a
 * result the runtime did not compute.
 */
async function runDogfood(args: string[]): Promise<number> {
  const subcommand = args[1];
  if (subcommand === "init") {
    const draftPath = option(args, "--draft");
    const evidenceDirectory = option(args, "--evidence-dir");
    const workspacePath = option(args, "--workspace");
    const ocrPolicy = option(args, "--ocr") ?? "report";
    if (!draftPath || !evidenceDirectory || !workspacePath) {
      throw new ContractError([
        "dogfood init requires --draft, --evidence-dir, and --workspace",
      ]);
    }
    if (!["report", "perform"].includes(ocrPolicy)) {
      throw new ContractError(["--ocr must be report or perform"]);
    }
    const summary = await initDogfoodWorkspace({
      draftPath,
      evidenceDirectory,
      workspacePath,
      ocrPolicy: ocrPolicy as OcrPolicy,
    });
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  if (subcommand === "status") {
    const workspacePath = option(args, "--workspace");
    if (!workspacePath) throw new ContractError(["dogfood status requires --workspace"]);
    const report = await evaluateDogfoodWorkspace(workspacePath);
    process.stdout.write(JSON.stringify({
      workspace: report.workspace,
      status: report.status,
      counts: report.counts,
      blockers: report.blockers,
    }, null, 2) + "\n");
    return 0;
  }
  if (subcommand === "verify") {
    const workspacePath = option(args, "--workspace");
    if (!workspacePath) throw new ContractError(["dogfood verify requires --workspace"]);
    const traceDirectory = option(args, "--trace-dir");
    const result = await verifyDogfoodWorkspace({
      workspacePath,
      ...(traceDirectory === undefined ? {} : { traceDirectory }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    // `CHECK_COMPLETED` only means the verifier ran. Exit zero still requires
    // the same shippable rule as `verify` and `legal`: decision PASS with every
    // proposed action ALLOW.
    if (result.status !== "CHECK_COMPLETED") return 1;
    return result.shippable ? 0 : 1;
  }
  throw new ContractError(["dogfood requires the init, status, or verify subcommand"]);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (command === "verify") {
    const requestPath = option(args, "--request");
    if (!requestPath) throw new ContractError(["--request is required"]);
    const request = await loadRequest(resolve(requestPath));
    const traceDirectory = resolve(option(args, "--trace-dir") ?? "traces");
    return runVerification(request, traceDirectory);
  }
  if (command === "claims" && args[1] === "extract") {
    const inputPath = option(args, "--input");
    if (!inputPath) throw new ContractError(["claims extract requires --input"]);
    const inventory = extractClaimInventory(await loadClaimText(inputPath, "--input"));
    process.stdout.write(JSON.stringify(inventory, null, 2) + "\n");
    return 0;
  }
  if (command === "claims" && args[1] === "diff") {
    const beforePath = option(args, "--before");
    const afterPath = option(args, "--after");
    if (!beforePath || !afterPath) {
      throw new ContractError(["claims diff requires --before and --after"]);
    }
    const [before, after] = await Promise.all([
      loadClaimText(beforePath, "--before"),
      loadClaimText(afterPath, "--after"),
    ]);
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    const traceDirectory = option(args, "--trace-dir");
    if (traceDirectory === undefined) {
      process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
      return 0;
    }
    // The persisted artifact stores both raw drafts, so it is written private
    // and owner-only just like a verification trace.
    const tracePath = await writeRevisionPlanTrace(resolve(traceDirectory), {
      previousText: before,
      currentText: after,
    });
    process.stdout.write(JSON.stringify({ tracePath, comparison }, null, 2) + "\n");
    return 0;
  }
  if (command === "revision" && args[1] === "show" && args[2]) {
    const trace = await readRevisionPlanTrace(resolve(args[2]));
    process.stdout.write(JSON.stringify(trace, null, 2) + "\n");
    return 0;
  }
  if (command === "revision" && args[1] === "replay" && args[2]) {
    const replay = await replayRevisionPlanTrace(resolve(args[2]));
    process.stdout.write(JSON.stringify(replay, null, 2) + "\n");
    return replay.matches ? 0 : 1;
  }
  if (command === "ingest") {
    const inputPath = option(args, "--input");
    const ocrPolicy = option(args, "--ocr") ?? "report";
    if (!inputPath) throw new ContractError(["ingest requires --input"]);
    if (!["report", "perform"].includes(ocrPolicy)) {
      throw new ContractError(["--ocr must be report or perform"]);
    }
    const result = await ingestLocalFile(resolve(inputPath), {
      ocrPolicy: ocrPolicy as OcrPolicy,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.status === "ready" ? 0 : 1;
  }
  if (command === "legal") {
    if (args[1] === "scope") {
      const draftPath = option(args, "--draft");
      if (!draftPath) throw new ContractError(["legal scope requires --draft"]);
      const draft = await loadClaimText(draftPath, "--draft");
      const plan = planDraftLegalCandidates(draft);
      const selected = plan.filter((item) => item.action !== "SKIP_BY_SCOPE");
      process.stdout.write(JSON.stringify({
        profileVersion: LEGAL_SCOPE_PROFILE_VERSION,
        subjectSha256: sha256Text(draft),
        counts: {
          verify: plan.filter((item) => item.action === "VERIFY_EXTERNAL_AUTHORITY").length,
          reviewScope: plan.filter((item) => item.action === "REVIEW_SCOPE").length,
          skipped: plan.filter((item) => item.action === "SKIP_BY_SCOPE").length,
        },
        items: selected.map((item) => ({
          action: item.action,
          fingerprint: item.candidate.fingerprint,
          locator: item.candidate.locator,
          legalReferences: item.legalReferences,
        })),
        scopedCoverageComplete: false,
      }, null, 2) + "\n");
      return 0;
    }
    if (args[1] === "cache-source") {
      const sourcePath = option(args, "--source");
      const cacheDirectory = option(args, "--cache-dir");
      const canonicalId = option(args, "--canonical-id");
      const title = option(args, "--title");
      const issuer = option(args, "--issuer");
      const legalClass = option(args, "--class");
      const authorityTier = option(args, "--tier");
      const jurisdiction = option(args, "--jurisdiction");
      const ocrPolicy = option(args, "--ocr") ?? "report";
      if (!sourcePath || !cacheDirectory || !canonicalId || !title || !issuer
        || !legalClass || !authorityTier || !jurisdiction) {
        throw new ContractError([
          "legal cache-source requires --source, --cache-dir, --canonical-id, --title, --issuer, --class, --tier, and --jurisdiction",
        ]);
      }
      const legalClasses = [
        "enacted_law",
        "adjudicative_decision",
        "official_policy",
        "official_guidance",
        "secondary_commentary",
      ];
      if (!legalClasses.includes(legalClass)) {
        throw new ContractError([`--class must be one of: ${legalClasses.join(", ")}`]);
      }
      if (!["primary", "official_guidance", "secondary"].includes(authorityTier)) {
        throw new ContractError(["--tier must be primary, official_guidance, or secondary"]);
      }
      if (!["report", "perform"].includes(ocrPolicy)) {
        throw new ContractError(["--ocr must be report or perform"]);
      }
      const canonicalUri = option(args, "--uri");
      const effectiveFrom = option(args, "--effective-from");
      const effectiveTo = option(args, "--effective-to");
      const identity: ExternalLegalAuthorityIdentity = {
        canonicalId,
        title,
        issuer,
        legalClass: legalClass as ExternalLegalAuthorityIdentity["legalClass"],
        authorityTier: authorityTier as ExternalLegalAuthorityIdentity["authorityTier"],
        jurisdiction,
        ...(canonicalUri === undefined ? {} : { canonicalUri }),
        ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
        ...(effectiveTo === undefined ? {} : { effectiveTo }),
      };
      const cached = await loadOrIngestLegalAuthority({
        sourcePath,
        cacheDirectory,
        identity,
        ingestOptions: { ocrPolicy: ocrPolicy as OcrPolicy },
      });
      process.stdout.write(JSON.stringify({
        status: cached.status,
        ingestKey: cached.entry.ingestKey,
        extractionEntryHash: cached.entry.entryHash,
        authorityLockHash: cached.lock.lockHash,
        sourceSha256: cached.lock.sourceSha256,
        pageCount: cached.ingestion.pages.length,
        quality: cached.ingestion.quality,
      }, null, 2) + "\n");
      return 0;
    }
    if (args[1] === "init") {
      const draftPath = option(args, "--draft");
      const outputPath = option(args, "--out");
      if (!draftPath || !outputPath) {
        throw new ContractError(["legal init requires --draft and --out"]);
      }
      const resolvedDraft = resolve(draftPath);
      const manifest = await createLegalManifestSkeleton(
        resolvedDraft,
        basename(resolvedDraft),
      );
      const resolvedOutput = resolve(outputPath);
      await writeFile(resolvedOutput, JSON.stringify(manifest, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(JSON.stringify({
        manifestPath: resolvedOutput,
        draftSha256: manifest.subject.sha256,
        status: "INCOMPLETE",
      }, null, 2) + "\n");
      return 0;
    }
    const draftPath = option(args, "--draft");
    const manifestPath = option(args, "--manifest");
    if (!draftPath || !manifestPath) {
      throw new ContractError(["--draft and --manifest are required"]);
    }
    const request = await loadLegalManifest(resolve(draftPath), resolve(manifestPath));
    const defaultTraceDir = resolve(draftPath + ".source-integrity-traces");
    return runVerification(request, resolve(option(args, "--trace-dir") ?? defaultTraceDir));
  }
  if (command === "dogfood") {
    return runDogfood(args);
  }
  if (command === "attest") {
    const requestPath = option(args, "--request");
    const claimId = option(args, "--claim-id");
    const checker = option(args, "--checker");
    const checkerKind = option(args, "--kind");
    const bindingScope = option(args, "--scope") ?? "subject";
    const verdict = option(args, "--verdict");
    const rawScore = option(args, "--score");
    const reason = option(args, "--reason");
    if (
      !requestPath
      || !claimId
      || !checker
      || !checkerKind
      || !verdict
      || rawScore === undefined
      || !reason
    ) {
      throw new ContractError([
        "attest requires --request, --claim-id, --checker, --kind, --verdict, --score, and --reason",
      ]);
    }
    const splitAt = checker.lastIndexOf("@");
    if (splitAt <= 0 || splitAt === checker.length - 1) {
      throw new ContractError(["--checker must be NAME@VERSION"]);
    }
    if (!["human", "model", "hybrid"].includes(checkerKind)) {
      throw new ContractError(["--kind must be human, model, or hybrid"]);
    }
    if (!["subject", "claim"].includes(bindingScope)) {
      throw new ContractError(["--scope must be subject or claim"]);
    }
    if (!["SUPPORTED", "PARTIAL", "CONTRADICTED", "NOT_FOUND"].includes(verdict)) {
      throw new ContractError([
        "--verdict must be SUPPORTED, PARTIAL, CONTRADICTED, or NOT_FOUND",
      ]);
    }
    const request = await loadRequest(resolve(requestPath));
    const attestation = buildSemanticAttestation(request, {
      claimId,
      checkerName: checker.slice(0, splitAt),
      checkerVersion: checker.slice(splitAt + 1),
      checkerKind: checkerKind as "human" | "model" | "hybrid",
      bindingScope: bindingScope as "subject" | "claim",
      verdict: verdict as "SUPPORTED" | "PARTIAL" | "CONTRADICTED" | "NOT_FOUND",
      score: Number(rawScore),
      reasons: [reason],
    });
    process.stdout.write(JSON.stringify(attestation, null, 2) + "\n");
    return 0;
  }
  if (command === "trace" && args[1] === "show" && args[2]) {
    process.stdout.write(JSON.stringify(await readAuditTrace(resolve(args[2])), null, 2) + "\n");
    return 0;
  }
  if (command === "replay" && args[1]) {
    const replay = await replayAuditTrace(resolve(args[1]));
    process.stdout.write(JSON.stringify(replay, null, 2) + "\n");
    return replay.matches ? 0 : 1;
  }
  process.stderr.write(usage() + "\n");
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ContractError) {
      process.stderr.write(JSON.stringify({ error: error.message, issues: error.issues }, null, 2) + "\n");
    } else if (error instanceof DogfoodWorkspaceError) {
      // The typed codes are the useful half of a workspace refusal; collapsing
      // them into one prose string would make the caller parse English to find
      // out whether the workspace was unsafe, already present, or unreadable.
      process.stderr.write(JSON.stringify({
        error: error.message,
        codes: error.codes,
        issues: error.issues,
      }, null, 2) + "\n");
    } else if (error instanceof LegalSourceCacheError) {
      process.stderr.write(JSON.stringify({
        error: error.message,
        issues: error.issues,
      }, null, 2) + "\n");
    } else {
      process.stderr.write(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }, null, 2) + "\n",
      );
    }
    process.exitCode = 2;
  });
