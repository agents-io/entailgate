import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInventories,
  extractClaimInventory,
  normalizedAtomicClaimFingerprint,
} from "../src/claims.js";

function assertAtomicFingerprintCannotReuse(before: string, after: string): void {
  const beforeFingerprint = normalizedAtomicClaimFingerprint(before);
  const afterFingerprint = normalizedAtomicClaimFingerprint(after);

  assert.ok(
    beforeFingerprint === undefined
      || afterFingerprint === undefined
      || beforeFingerprint !== afterFingerprint,
    "the changed input must not retain the same normalized atomic claim fingerprint",
  );
}

function assertChangedInputRequiresReview(before: string, after: string): void {
  const comparison = compareInventories(
    extractClaimInventory(before),
    extractClaimInventory(after),
  );

  assert.equal(comparison.wholeDocumentChanged, true);
  assert.ok(comparison.plan.length > 0, "a changed document must not produce an empty plan");
  assert.equal(
    comparison.plan.every((item) => item.action === "REUSE"),
    false,
    "a protected change must not produce an all-REUSE plan",
  );
  assert.ok(
    comparison.plan.some((item) => item.requiresRevalidation),
    "a protected change must require review",
  );
  assertAtomicFingerprintCannotReuse(before, after);
}

function assertDependentClaimRequiresReview(
  before: string,
  after: string,
  dependentText: string,
): void {
  const comparison = compareInventories(
    extractClaimInventory(before),
    extractClaimInventory(after),
  );
  const dependent = comparison.plan.find((item) => item.before?.text === dependentText);

  assert.equal(comparison.wholeDocumentChanged, true);
  assert.ok(dependent, `missing dependent candidate: ${dependentText}`);
  assert.notEqual(dependent.action, "REUSE", `${dependentText} must not be reused`);
  assert.equal(dependent.requiresRevalidation, true);
  assertAtomicFingerprintCannotReuse(before, after);
}

const unicodeCompatibilityCases: Array<[string, string, string]> = [
  [
    "superscript number",
    "The amount is 2².",
    "The amount is 22.",
  ],
  [
    "superscript legal section",
    "Section 2⁴ requires disclosure.",
    "Section 24 requires disclosure.",
  ],
  [
    "superscript inside an exact quotation",
    'Officer wrote, "The amount was 2²."',
    'Officer wrote, "The amount was 22."',
  ],
];

for (const [name, before, after] of unicodeCompatibilityCases) {
  test(`Unicode compatibility change cannot reuse: ${name}`, () => {
    assertChangedInputRequiresReview(before, after);
  });
}

test("connector normalization cannot erase a punctuated corporate actor", () => {
  assertChangedInputRequiresReview(
    "Moreover, LLC made the request.",
    "LLC made the request.",
  );
});

const quotationCases: Array<[string, string, string]> = [
  [
    "single guillemets",
    "Officer wrote, ‹No  reply›.",
    "Officer wrote, ‹No reply›.",
  ],
  [
    "German quotation marks",
    "Officer wrote, „No  reply“.",
    "Officer wrote, „No reply“.",
  ],
  [
    "symmetric right single quotation marks",
    "Officer wrote, ’No  reply’.",
    "Officer wrote, ’No reply’.",
  ],
  [
    "straight single quotation with interior edge spaces",
    "Officer wrote, ' No  reply '.",
    "Officer wrote, ' No reply '.",
  ],
  [
    "HTML quotation entities",
    "&quot;No  reply&quot;",
    "&quot;No reply&quot;",
  ],
  [
    "uppercase HTML quotation entities",
    "&QUOT;No  reply&QUOT;",
    "&QUOT;No reply&QUOT;",
  ],
  [
    "numeric HTML quotation entities",
    "&#34;No  reply&#34;",
    "&#x22;No reply&#x22;",
  ],
];

for (const [name, before, after] of quotationCases) {
  test(`quotation whitespace change cannot reuse: ${name}`, () => {
    assertChangedInputRequiresReview(before, after);
  });
}

test("a possessive curly apostrophe does not open a quotation span", () => {
  const comparison = compareInventories(
    extractClaimInventory("The worker’s report has  no reply."),
    extractClaimInventory("The worker’s report has no reply."),
  );
  assert.ok(comparison.plan.length > 0);
  assert.equal(comparison.plan.every((item) => item.action === "REUSE"), true);
});

test("a safe lowercase clause after a discourse connector can reuse", () => {
  const comparison = compareInventories(
    extractClaimInventory("Moreover, the employer must disclose."),
    extractClaimInventory("The employer must disclose."),
  );
  assert.equal(comparison.plan.map((item) => item.action).join(","), "REUSE");
});

const trailingLiteralCases: Array<[string, string, string]> = [
  [
    "trailing fenced HTML-like literal",
    ["```text", "Section 23 applies.", "<redacted>", "```"].join("\n"),
    ["```text", "Section 23 applies.", "<approved>", "```"].join("\n"),
  ],
  [
    "trailing fenced separator-like literal",
    ["```yaml", "section: 23", "---", "```"].join("\n"),
    ["```yaml", "section: 23", "----", "```"].join("\n"),
  ],
  [
    "trailing fenced blank line",
    ["```text", "Section 23 applies.", "```"].join("\n"),
    ["```text", "Section 23 applies.", "", "```"].join("\n"),
  ],
];

for (const [name, before, after] of trailingLiteralCases) {
  test(`trailing literal change cannot reuse: ${name}`, () => {
    assertChangedInputRequiresReview(before, after);
  });
}

const sourceAttributeCases: Array<[string, string, string]> = [
  [
    "blockquote cite",
    ["Section 23 applies.", "", '<blockquote cite="https://a"></blockquote>'].join("\n"),
    ["Section 23 applies.", "", '<blockquote cite="https://b"></blockquote>'].join("\n"),
  ],
  [
    "source srcset",
    ["Section 23 applies.", "", '<source srcset="a.png 1x">'].join("\n"),
    ["Section 23 applies.", "", '<source srcset="b.png 1x">'].join("\n"),
  ],
  [
    "video poster",
    ["Section 23 applies.", "", '<video poster="a.png"></video>'].join("\n"),
    ["Section 23 applies.", "", '<video poster="b.png"></video>'].join("\n"),
  ],
];

for (const [name, before, after] of sourceAttributeCases) {
  test(`source-only change cannot be masked by REUSE: ${name}`, () => {
    assertChangedInputRequiresReview(before, after);
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    assert.ok(comparison.plan.some((item) => item.reviewKind === "SOURCE_SUPPORT"));
  });
}

test("compatibility digits are detected without entering exact identity", () => {
  const inventory = extractClaimInventory("Section ２４ requires disclosure of ２ records.");
  const kinds = new Set(inventory.candidates[0]?.materialSignals.map((signal) => signal.kind));
  assert.ok(kinds.has("legal_section"));
  assert.ok(kinds.has("number"));
  assertChangedInputRequiresReview(
    "Section ２４ requires disclosure of ２ records.",
    "Section 24 requires disclosure of 2 records.",
  );
});

const dependentContextCases: Array<[string, string, string, string]> = [
  [
    "notwithstanding qualifier",
    ["Notwithstanding section 24.", "", "The employer must disclose."].join("\n"),
    ["Notwithstanding section 25.", "", "The employer must disclose."].join("\n"),
    "The employer must disclose.",
  ],
  [
    "if qualifier",
    ["If the worker consents.", "", "The employer may disclose."].join("\n"),
    ["If the worker objects.", "", "The employer may disclose."].join("\n"),
    "The employer may disclose.",
  ],
  [
    "period-ended quotation attribution",
    ["Officer Scott wrote.", "", "“No reply.”"].join("\n"),
    ["The employer wrote.", "", "“No reply.”"].join("\n"),
    "“No reply.”",
  ],
  [
    "therefore inference",
    ["Alice made the request.", "", "Therefore, section 23 applies."].join("\n"),
    ["Bob made the request.", "", "Therefore, section 23 applies."].join("\n"),
    "Therefore, section 23 applies.",
  ],
];

for (const [name, before, after, dependentText] of dependentContextCases) {
  test(`dependent context change invalidates its assertion: ${name}`, () => {
    assertDependentClaimRequiresReview(before, after, dependentText);
  });
}
