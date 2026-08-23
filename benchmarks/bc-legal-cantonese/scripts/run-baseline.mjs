#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const dataPath = new URL("../data/raw/synthetic-seed-v0.1.jsonl", import.meta.url);
const raw = await readFile(dataPath, "utf8");
const items = raw.trim().split("\n").map((line) => JSON.parse(line));

function normalizeText(value) {
  return value
    .normalize("NFKC")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceIsEffective(item) {
  const fromOk = item.evidence.effective_from <= item.as_of;
  const toOk = item.evidence.effective_to === null || item.as_of < item.evidence.effective_to;
  return fromOk && toOk;
}

function predict(item) {
  const citationClosed = item.claim.citation.source_id === item.evidence.source_id
    && item.claim.citation.chunk_id === item.evidence.chunk_id;
  if (!citationClosed) return { decision: "ABSTAIN", reason: "citation_not_in_evidence" };
  if (!sourceIsEffective(item)) return { decision: "ABSTAIN", reason: "source_not_effective" };
  if (item.claim.quoted_text === null) return { decision: "ABSTAIN", reason: "semantic_support_unchecked" };
  if (normalizeText(item.claim.text) !== normalizeText(item.claim.quoted_text)) {
    return { decision: "ABSTAIN", reason: "claim_contains_unverified_text_outside_quote" };
  }
  const quoteFound = normalizeText(item.evidence.text).includes(normalizeText(item.claim.quoted_text));
  return quoteFound
    ? { decision: "PASS", reason: "normalized_quote_found" }
    : { decision: "ABSTAIN", reason: "quote_not_found" };
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (total === 0) return null;
  const proportion = successes / total;
  const denominator = 1 + ((z * z) / total);
  const centre = (proportion + ((z * z) / (2 * total))) / denominator;
  const margin = (
    z * Math.sqrt(((proportion * (1 - proportion)) + ((z * z) / (4 * total))) / total)
  ) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)].map((value) => Number(value.toFixed(6)));
}

function rateRecord(numerator, denominator) {
  return {
    numerator,
    denominator,
    estimate: denominator === 0 ? null : Number((numerator / denominator).toFixed(6)),
    ci95_wilson: wilsonInterval(numerator, denominator),
  };
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((1664525 * state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function clusterBootstrapInterval(rows, group, score, iterations, seed) {
  const rng = makeRng(seed);
  const groupIds = [...new Set(rows.map(group))];
  if (groupIds.length === 0) return null;
  const grouped = new Map(groupIds.map((groupId) => [
    groupId,
    rows.filter((row) => group(row) === groupId),
  ]));
  const estimates = Array.from({ length: iterations }, () => {
    const sample = Array.from({ length: groupIds.length }, () => {
      const sampledId = groupIds[Math.floor(rng() * groupIds.length)];
      return grouped.get(sampledId) ?? [];
    }).flat();
    return sample.filter(score).length / sample.length;
  }).sort((left, right) => left - right);
  return [quantile(estimates, 0.025), quantile(estimates, 0.975)]
    .map((value) => Number(value.toFixed(6)));
}

function summarizeRows(rows) {
  const unsafe = rows.filter(({ item }) => item.expected.must_abstain);
  const passes = rows.filter(({ prediction }) => prediction.decision === "PASS");
  const falsePasses = unsafe.filter(({ prediction }) => prediction.decision === "PASS");
  const correct = rows.filter(({ item, prediction }) =>
    item.expected.decision === prediction.decision
  );
  return {
    sample_size: rows.length,
    false_pass_rate: rateRecord(falsePasses.length, unsafe.length),
    coverage: rateRecord(passes.length, rows.length),
    decision_accuracy: rateRecord(correct.length, rows.length),
  };
}

const predictions = items.map((item) => ({
  item_id: item.item_id,
  split: item.split,
  phenomenon: item.metadata.phenomenon,
  expected: item.expected.decision,
  ...predict(item),
}));
const joined = items.map((item, index) => ({ item, prediction: predictions[index] }));
const mustAbstain = joined.filter(({ item }) => item.expected.must_abstain);
const shouldPass = joined.filter(({ item }) => !item.expected.must_abstain);
const predictedPasses = joined.filter(({ prediction }) => prediction.decision === "PASS");
const correct = joined.filter(({ item, prediction }) => item.expected.decision === prediction.decision).length;
const falsePasses = mustAbstain.filter(({ prediction }) => prediction.decision === "PASS").length;
const safePasses = predictedPasses.filter(({ item }) => !item.expected.must_abstain).length;
const falseAbstains = shouldPass.filter(({ prediction }) => prediction.decision === "ABSTAIN").length;
const languageProfiles = [...new Set(items.map((item) => item.language_profile))].sort();
const errorTags = [...new Set(items.flatMap((item) => item.expected.error_tags))].sort();
const reasonToSpecificErrors = {
  citation_not_in_evidence: ["CITATION_NOT_FOUND"],
  source_not_effective: ["SOURCE_NOT_EFFECTIVE"],
  quote_not_found: ["QUOTE_MISMATCH"],
};

const launderingProbe = structuredClone(items.find((item) =>
  item.metadata.phenomenon === "exception_omitted"
));
if (launderingProbe !== undefined) {
  launderingProbe.claim.quoted_text = "except where it arose primarily from an employer decision";
  if (predict(launderingProbe).decision === "PASS") {
    throw new Error("quote-laundering self-test failed");
  }
}

const report = {
  benchmark: "bc-legal-cantonese-verification",
  dataset: "synthetic-seed-v0.1",
  warning: "Synthetic software fixtures only; these metrics are not legal-ground-truth or product-performance results.",
  baseline: {
    name: "citation-date-quote-only-v0.2",
    behavior: "PASS only when the complete claim is the quoted span, the citation is in evidence, the source is effective, and the normalized quote occurs; otherwise ABSTAIN.",
  },
  sample_size: items.length,
  primary_safety_metric: "false_pass_rate",
  metrics: {
    false_pass_rate: rateRecord(falsePasses, mustAbstain.length),
    coverage: rateRecord(predictedPasses.length, joined.length),
    safe_pass_precision: rateRecord(safePasses, predictedPasses.length),
    decision_accuracy: rateRecord(correct, joined.length),
    false_abstain_rate_on_pass_worthy: rateRecord(falseAbstains, shouldPass.length),
    pass_worthy_coverage: rateRecord(shouldPass.length - falseAbstains, shouldPass.length),
    abstention_rate: rateRecord(joined.length - predictedPasses.length, joined.length),
  },
  small_sample_sensitivity: {
    method: "deterministic authority-family cluster bootstrap; Wilson intervals remain authoritative for zero-event safety rates",
    iterations: 1000,
    seed: 20260822,
    decision_accuracy_ci95_cluster_bootstrap: clusterBootstrapInterval(
      joined,
      ({ item }) => item.authority_family,
      ({ item, prediction }) => item.expected.decision === prediction.decision,
      1000,
      20260822,
    ),
    coverage_ci95_cluster_bootstrap: clusterBootstrapInterval(
      joined,
      ({ item }) => item.authority_family,
      ({ prediction }) => prediction.decision === "PASS",
      1000,
      20260823,
    ),
  },
  language_slices: Object.fromEntries(languageProfiles.map((profile) => [
    profile,
    summarizeRows(joined.filter(({ item }) => item.language_profile === profile)),
  ])),
  false_pass_rate_by_error_tag: Object.fromEntries(errorTags.map((tag) => {
    const rows = joined.filter(({ item }) => item.expected.error_tags.includes(tag));
    const falsePassesForTag = rows.filter(({ prediction }) => prediction.decision === "PASS").length;
    return [tag, rateRecord(falsePassesForTag, rows.length)];
  })),
  error_specific_detection_slices: Object.fromEntries(errorTags.map((tag) => {
    const rows = joined.filter(({ item }) => item.expected.error_tags.includes(tag));
    const detected = rows.filter(({ prediction }) =>
      (reasonToSpecificErrors[prediction.reason] ?? []).includes(tag)
    ).length;
    return [tag, rateRecord(detected, rows.length)];
  })),
  gate_abstention_by_error_tag: Object.fromEntries(errorTags.map((tag) => {
    const rows = joined.filter(({ item }) => item.expected.error_tags.includes(tag));
    const abstained = rows.filter(({ prediction }) => prediction.decision === "ABSTAIN").length;
    return [tag, rateRecord(abstained, rows.length)];
  })),
  split_counts: Object.fromEntries(["train", "dev", "test"].map((split) => [
    split,
    joined.filter(({ item }) => item.split === split).length,
  ])),
  predictions,
};

console.log(JSON.stringify(report, null, 2));
