#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const benchmarkRoot = fileURLToPath(new URL("../", import.meta.url));
const dataPath = new URL("../data/raw/synthetic-seed-v0.1.jsonl", import.meta.url);
const manifestPath = new URL("../data/raw/manifest-v0.1.json", import.meta.url);
const schemaPath = new URL("../schema/item.schema.json", import.meta.url);
const splitsPath = new URL("../splits/splits-v0.1.json", import.meta.url);
const taxonomyPath = new URL("../taxonomy/error-taxonomy-v0.1.json", import.meta.url);

const requiredPhenomena = new Set([
  "exact_quote",
  "paraphrase_support",
  "wrong_statute_section",
  "outdated_effective_date",
  "fake_citation",
  "exception_omitted",
  "remedy_overreach",
  "cantonese_english_code_switch",
  "innocuous_wording_edit",
]);

function countBy(values) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

function duplicates(values) {
  return Object.entries(countBy(values))
    .filter(([, count]) => count > 1)
    .map(([value]) => value);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value));
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

const [raw, manifestRaw, schemaRaw, splitsRaw, taxonomyRaw] = await Promise.all([
  readFile(dataPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(schemaPath, "utf8"),
  readFile(splitsPath, "utf8"),
  readFile(taxonomyPath, "utf8"),
]);
const records = raw.trim().split("\n").map((line) => JSON.parse(line));
const manifest = JSON.parse(manifestRaw);
const schema = JSON.parse(schemaRaw);
const splits = JSON.parse(splitsRaw);
const taxonomy = JSON.parse(taxonomyRaw);
const failures = [];

assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema must declare Draft 2020-12", failures);
assert(schema.type === "object", "item schema root must be an object", failures);
assert(records.length === 9, `expected 9 seed records, got ${records.length}`, failures);
assert(manifest.files.length === 1, "raw manifest must describe exactly one seed file", failures);
assert(manifest.files[0].record_count === records.length, "manifest record_count does not match JSONL", failures);
assert(manifest.files[0].sha256 === sha256(raw), "raw seed SHA-256 does not match immutable manifest", failures);
assert(manifest.contains_private_evidence === false, "manifest must reject private evidence", failures);
assert(manifest.legal_ground_truth === false, "synthetic seed cannot be legal ground truth", failures);

const itemIds = records.map((item) => item.item_id);
assert(duplicates(itemIds).length === 0, `duplicate item IDs: ${duplicates(itemIds).join(", ")}`, failures);

const phenomena = new Set(records.map((item) => item.metadata.phenomenon));
const missingPhenomena = [...requiredPhenomena].filter((phenomenon) => !phenomena.has(phenomenon));
const extraPhenomena = [...phenomena].filter((phenomenon) => !requiredPhenomena.has(phenomenon));
assert(missingPhenomena.length === 0, `missing phenomena: ${missingPhenomena.join(", ")}`, failures);
assert(extraPhenomena.length === 0, `unexpected phenomena: ${extraPhenomena.join(", ")}`, failures);

const privateMarkers = [/\/home\/[^/]+\//iu, /\/Evidence\//iu, /Claim\s*\d{6,}/iu];
assert(!privateMarkers.some((pattern) => pattern.test(raw)), "raw seed contains a forbidden private-evidence marker", failures);

records.forEach((item) => {
  const expectedGroup = `${item.authority_family}::${item.document_family}`;
  assert(item.group_id === expectedGroup, `${item.item_id}: group_id is not canonical`, failures);
  assert(splits.assignments[item.group_id] === item.split, `${item.item_id}: split differs from frozen manifest`, failures);
  assert(item.synthetic === true, `${item.item_id}: seed item must be synthetic`, failures);
  assert(item.ground_truth_status === "synthetic_fixture_not_legal_ground_truth", `${item.item_id}: invalid ground-truth label`, failures);
  assert(item.provenance.data_origin === "synthetic", `${item.item_id}: invalid data_origin`, failures);
  assert(item.provenance.is_legal_ground_truth === false, `${item.item_id}: synthetic item claims legal ground truth`, failures);
  assert(item.provenance.contains_private_evidence === false, `${item.item_id}: private evidence is forbidden`, failures);
  assert(item.evidence.source_uri === null && item.evidence.source_sha256 === null, `${item.item_id}: synthetic evidence must not impersonate a real source`, failures);
  assert(item.evidence.jurisdiction === item.jurisdiction, `${item.item_id}: evidence jurisdiction mismatch`, failures);
  assert(validDate(item.as_of), `${item.item_id}: invalid as_of date`, failures);
  assert(validDate(item.evidence.effective_from), `${item.item_id}: invalid effective_from date`, failures);
  assert(item.evidence.effective_to === null || validDate(item.evidence.effective_to), `${item.item_id}: invalid effective_to date`, failures);
  assert(item.evidence.effective_to === null || item.evidence.effective_from < item.evidence.effective_to, `${item.item_id}: invalid effective interval`, failures);
  assert(item.expected.must_abstain === (item.expected.decision === "ABSTAIN"), `${item.item_id}: decision and must_abstain disagree`, failures);
});

const authoritySplitPairs = new Set(records.map((item) => `${item.authority_family}\u0000${item.split}`));
const documentSplitPairs = new Set(records.map((item) => `${item.document_family}\u0000${item.split}`));
const groupSplitPairs = new Set(records.map((item) => `${item.group_id}\u0000${item.split}`));
const authorityFamilies = [...new Set(records.map((item) => item.authority_family))];
const documentFamilies = [...new Set(records.map((item) => item.document_family))];
const groups = [...new Set(records.map((item) => item.group_id))];
const leakedAuthorities = authorityFamilies.filter((family) => [...authoritySplitPairs].filter((pair) => pair.startsWith(`${family}\u0000`)).length > 1);
const leakedDocuments = documentFamilies.filter((family) => [...documentSplitPairs].filter((pair) => pair.startsWith(`${family}\u0000`)).length > 1);
const leakedGroups = groups.filter((group) => [...groupSplitPairs].filter((pair) => pair.startsWith(`${group}\u0000`)).length > 1);
assert(leakedAuthorities.length === 0, `authority-family leakage: ${leakedAuthorities.join(", ")}`, failures);
assert(leakedDocuments.length === 0, `document-family leakage: ${leakedDocuments.join(", ")}`, failures);
assert(leakedGroups.length === 0, `group leakage: ${leakedGroups.join(", ")}`, failures);

const taxonomyCodes = new Set(taxonomy.definitions.map((entry) => entry.code));
const schemaErrorTags = schema.properties.expected.properties.error_tags.items.enum;
const undefinedTags = schemaErrorTags.filter((code) => !taxonomyCodes.has(code));
assert(undefinedTags.length === 0, `schema tags absent from taxonomy: ${undefinedTags.join(", ")}`, failures);
assert(taxonomy.primary_safety_error === "FALSE_PASS", "FALSE_PASS must remain the primary safety error", failures);

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", benchmark_root: benchmarkRoot, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "PASS",
    records: records.length,
    raw_sha256: sha256(raw),
    split_counts: countBy(records.map((item) => item.split)),
    authority_families: authorityFamilies.length,
    document_families: documentFamilies.length,
    groups: groups.length,
    phenomena: [...phenomena].sort(),
    leakage: {
      authority_family: 0,
      document_family: 0,
      group_id: 0,
    },
    private_evidence_records: 0,
  }, null, 2));
}
