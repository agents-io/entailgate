#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const seedPath = new URL("../data/raw/synthetic-seed-v0.1.jsonl", import.meta.url);
const splitPath = new URL("../splits/splits-v0.1.json", import.meta.url);

function parseRecords(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function groupId(record) {
  if (
    typeof record.authority_family !== "string"
    || typeof record.document_family !== "string"
    || !record.authority_family
    || !record.document_family
  ) {
    throw new Error("every record requires non-empty authority_family and document_family");
  }
  return record.authority_family + "::" + record.document_family;
}

class DisjointSet {
  constructor(keys) {
    this.parent = new Map(keys.map((key) => [key, key]));
  }

  find(key) {
    const parent = this.parent.get(key);
    if (parent === undefined) throw new Error("unknown component key: " + key);
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    this.parent.set(second, first);
  }
}

function hashedSplit(seed, canonicalComponentId) {
  const prefix = createHash("sha256")
    .update(String(seed) + ":" + canonicalComponentId)
    .digest("hex")
    .slice(0, 8);
  const bucket = Number.parseInt(prefix, 16) % 100;
  return bucket < 60 ? "train" : bucket < 80 ? "dev" : "test";
}

export function assignSplitComponents(frozenRecords, frozenManifest, candidateRecords) {
  const allRecords = [...frozenRecords, ...candidateRecords];
  const groups = new Map();
  for (const record of allRecords) {
    const id = groupId(record);
    const existing = groups.get(id);
    if (
      existing
      && (
        existing.authority_family !== record.authority_family
        || existing.document_family !== record.document_family
      )
    ) throw new Error("group ID collision: " + id);
    groups.set(id, {
      group_id: id,
      authority_family: record.authority_family,
      document_family: record.document_family,
    });
  }

  const keys = [...groups.keys()].sort();
  const components = new DisjointSet(keys);
  const firstByAuthority = new Map();
  const firstByDocument = new Map();
  for (const key of keys) {
    const group = groups.get(key);
    const authorityPeer = firstByAuthority.get(group.authority_family);
    const documentPeer = firstByDocument.get(group.document_family);
    if (authorityPeer) components.union(key, authorityPeer);
    else firstByAuthority.set(group.authority_family, key);
    if (documentPeer) components.union(key, documentPeer);
    else firstByDocument.set(group.document_family, key);
  }

  const groupsByRoot = new Map();
  for (const key of keys) {
    const root = components.find(key);
    const members = groupsByRoot.get(root) ?? [];
    members.push(key);
    groupsByRoot.set(root, members);
  }

  const assignmentByGroup = new Map();
  const componentByGroup = new Map();
  const assignmentSourceByGroup = new Map();
  for (const members of groupsByRoot.values()) {
    const canonicalComponentId = [...members].sort().join("|");
    const inherited = new Set(
      members
        .map((member) => frozenManifest.assignments[member])
        .filter(Boolean),
    );
    if (inherited.size > 1) {
      throw new Error(
        "component touches conflicting frozen splits and requires adjudication: "
          + canonicalComponentId + " -> " + [...inherited].sort().join(","),
      );
    }
    const split = inherited.size === 1
      ? [...inherited][0]
      : hashedSplit(frozenManifest.seed, canonicalComponentId);
    const assignmentSource = inherited.size === 1 ? "frozen_component_inheritance" : "seeded_hash";
    for (const member of members) {
      assignmentByGroup.set(member, split);
      componentByGroup.set(member, canonicalComponentId);
      assignmentSourceByGroup.set(member, assignmentSource);
    }
  }

  return candidateRecords.map((record) => {
    const id = groupId(record);
    const split = assignmentByGroup.get(id);
    const canonicalComponentId = componentByGroup.get(id);
    if (!split || !canonicalComponentId) throw new Error("assignment failed for " + id);
    return {
      ...(record.item_id === undefined ? {} : { item_id: record.item_id }),
      group_id: id,
      canonical_component_id: canonicalComponentId,
      split,
      assignment_source: frozenManifest.assignments[id] === undefined
        ? assignmentSourceByGroup.get(id)
        : "frozen_group_manifest",
    };
  });
}

async function fixtures() {
  const [seedRaw, splitRaw] = await Promise.all([
    readFile(seedPath, "utf8"),
    readFile(splitPath, "utf8"),
  ]);
  return {
    frozenRecords: parseRecords(seedRaw),
    frozenManifest: JSON.parse(splitRaw),
  };
}

async function selfTest() {
  const { frozenRecords, frozenManifest } = await fixtures();
  const inherited = assignSplitComponents(frozenRecords, frozenManifest, [{
    item_id: "self-inherit",
    authority_family: "SYNTHETIC-RD-PROCEDURE",
    document_family: "new-related-document",
  }]);
  if (inherited[0]?.split !== "train") throw new Error("inheritance self-test failed");

  const fresh = [{
    item_id: "self-new",
    authority_family: "NEW-AUTHORITY",
    document_family: "new-document",
  }];
  const first = assignSplitComponents(frozenRecords, frozenManifest, fresh);
  const second = assignSplitComponents(frozenRecords, frozenManifest, fresh);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("determinism self-test failed");
  }

  let conflictRejected = false;
  try {
    assignSplitComponents(frozenRecords, frozenManifest, [{
      item_id: "self-conflict-a",
      authority_family: "SYNTHETIC-RD-PROCEDURE",
      document_family: "bridge-document",
    }, {
      item_id: "self-conflict-b",
      authority_family: "SYNTHETIC-WCA",
      document_family: "bridge-document",
    }]);
  } catch {
    conflictRejected = true;
  }
  if (!conflictRejected) throw new Error("conflict self-test failed");
  return { status: "PASS", checks: 3 };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(await selfTest(), null, 2));
    return;
  }
  const inputIndex = process.argv.indexOf("--input");
  const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
  if (!input) throw new Error("usage: assign-splits.mjs --input CANDIDATES.jsonl");
  const [{ frozenRecords, frozenManifest }, candidateRaw] = await Promise.all([
    fixtures(),
    readFile(resolve(input), "utf8"),
  ]);
  const assignments = assignSplitComponents(
    frozenRecords,
    frozenManifest,
    parseRecords(candidateRaw),
  );
  console.log(JSON.stringify({ status: "PASS", assignments }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  });
}
