import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInventories,
  extractCandidateAssertions,
  extractClaimInventory,
  type CandidateAssertion,
  type InventoryAction,
} from "../src/claims.js";

function actionsForMaterialChange(before: string, after: string): InventoryAction[] {
  return compareInventories(
    extractClaimInventory(before),
    extractClaimInventory(after),
  ).plan.filter((item) => item.requiresRevalidation).map((item) => item.action);
}

function onlyCandidate(text: string): CandidateAssertion {
  const candidates = extractCandidateAssertions(text);
  assert.equal(candidates.length, 1);
  return candidates[0]!;
}

test("deterministically splits Markdown and classifies allowlisted material signals", () => {
  const text = [
    "# Grounds",
    "",
    "- 2024 BCSC 123 applied s. 23 on August 22, 2026.",
    "- Officer Scott wrote, \"No reply was sent.\"",
    "- The deadline is within 30 days.",
    "- I seek an order setting aside the decision.",
    "- Thank you for reading.",
  ].join("\n");

  const first = extractClaimInventory(text);
  const second = extractClaimInventory(text);
  assert.deepEqual(first, second);
  assert.equal(first.coverage.complete, false);
  assert.match(first.coverage.reasons.join(" "), /not an exhaustive semantic inventory/i);

  const signals = new Set(
    first.candidates.flatMap((candidate) =>
      candidate.materialSignals.map((signal) => signal.kind)
    ),
  );
  assert.ok(signals.has("citation"));
  assert.ok(signals.has("quotation"));
  assert.ok(signals.has("date"));
  assert.ok(signals.has("number"));
  assert.ok(signals.has("legal_section"));
  assert.ok(signals.has("deadline"));
  assert.ok(signals.has("remedy"));
  assert.ok(signals.has("actor_attribution"));
  assert.ok(first.candidates.some((candidate) => candidate.classification === "PROSE_ONLY"));
});

test("prose-only classification reports high uncertainty instead of claiming coverage", () => {
  const candidate = onlyCandidate("This introduction provides useful background.");
  assert.equal(candidate.material, false);
  assert.equal(candidate.classification, "PROSE_ONLY");
  assert.equal(candidate.uncertainty.level, "HIGH");
  assert.match(candidate.uncertainty.reasons.join(" "), /can still contain a material proposition/i);
});

test("claim fingerprints are independent of Markdown location", () => {
  const first = onlyCandidate("- Section 23 requires a response within 30 days.");
  const moved = extractCandidateAssertions([
    "Background only.",
    "",
    "Section 23 requires a response within 30 days.",
  ].join("\n")).find((candidate) => candidate.materialSignals.some(
    (signal) => signal.kind === "legal_section",
  ));
  assert.ok(moved);
  assert.notDeepEqual(first.locator, moved.locator);
  assert.equal(first.fingerprint, moved.fingerprint);
});

test("grammar and discourse-connector edits reuse claims despite a changed document hash", () => {
  const previous = extractClaimInventory([
    "Me made the request.",
    "Section 23 requires the employer to respond within 30 days.",
  ].join("\n\n"));
  const current = extractClaimInventory([
    "I made the request.",
    "However, Section 23 requires the employer to respond within 30 days.",
  ].join("\n\n"));
  const comparison = compareInventories(previous, current);

  assert.notEqual(previous.subjectSha256, current.subjectSha256);
  assert.equal(comparison.wholeDocumentChanged, true);
  assert.equal(comparison.plan.filter((item) => item.action === "REUSE").length, 2);
  assert.equal(comparison.plan.some((item) => item.action === "REVERIFY"), false);
  assert.equal(comparison.plan.some((item) => item.requiresRevalidation), false);
});

test("first-person normalization never erases all-caps actor acronyms", () => {
  const pairs: Array<[string, string]> = [
    ["ME made the request.", "I made the request."],
    ["US made the request.", "We made the request."],
  ];
  for (const [before, after] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
    assert.ok(comparison.plan.some((item) => item.requiresRevalidation));
  }
});

test("connector normalization requires punctuation and cannot erase an actor name", () => {
  const comparison = compareInventories(
    extractClaimInventory("Moreover Technologies made the request."),
    extractClaimInventory("Technologies made the request."),
  );
  assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
  assert.ok(comparison.plan.some((item) => item.requiresRevalidation));
});

test("article changes are not assumed harmless in a material legal proposition", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "An employer must disclose the record.",
      "The employer must disclose the record.",
    ),
    ["REVERIFY"],
  );
});

test("extracts protected Traditional Chinese legal signals", () => {
  const candidate = onlyCandidate(
    "公司必須在30日內依第23條回覆，並寫道：「要求已收到。」",
  );
  const kinds = new Set(candidate.materialSignals.map((signal) => signal.kind));
  assert.ok(kinds.has("legal_proposition"));
  assert.ok(kinds.has("deadline"));
  assert.ok(kinds.has("legal_section"));
  assert.ok(kinds.has("quotation"));
  assert.ok(kinds.has("actor_attribution"));
});

test("splits Traditional Chinese sentences without splitting quoted punctuation", () => {
  const candidates = extractCandidateAssertions(
    "公司寫道：「要求已收到。」公司必須在30日內回覆。背景資料稍後提供。",
  );
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0]?.text, "公司寫道：「要求已收到。」");
  assert.equal(candidates[1]?.text, "公司必須在30日內回覆。");
  assert.equal(candidates[2]?.text, "背景資料稍後提供。");
});

test("changing a Chinese legal section forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "公司必須依第23條披露紀錄。",
      "公司必須依第24條披露紀錄。",
    ),
    ["REVERIFY"],
  );
});

test("a prose-only edit does not invalidate an unrelated legal claim", () => {
  const previous = extractClaimInventory([
    "Section 23 requires disclosure within 30 days.",
    "This is a short introduction.",
  ].join("\n\n"));
  const current = extractClaimInventory([
    "Section 23 requires disclosure within 30 days.",
    "This is a substantially clearer introduction for the reader.",
  ].join("\n\n"));
  const comparison = compareInventories(previous, current);
  const legalItem = comparison.plan.find((item) =>
    item.before?.materialSignals.some((signal) => signal.kind === "legal_section")
  );

  assert.equal(legalItem?.action, "REUSE");
  assert.equal(legalItem?.requiresRevalidation, false);
  assert.equal(
    comparison.plan.filter((item) => item.reviewKind === "SOURCE_SUPPORT").length,
    0,
  );
  assert.ok(comparison.plan.some((item) => item.reviewKind === "MATERIALITY"));
});

test("a same-paragraph prose edit does not invalidate another sentence's legal claim", () => {
  const comparison = compareInventories(
    extractClaimInventory(
      "Section 23 requires disclosure within 30 days. This introduction is short.",
    ),
    extractClaimInventory(
      "Section 23 requires disclosure within 30 days. This introduction is much clearer for workers.",
    ),
  );
  const legalItem = comparison.plan.find((item) =>
    item.before?.text === "Section 23 requires disclosure within 30 days."
  );
  assert.equal(legalItem?.action, "REUSE");
  assert.equal(legalItem?.requiresRevalidation, false);
  assert.ok(comparison.plan.some((item) => item.reviewKind === "MATERIALITY"));
});

test("changing a legal section forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "Section 23 requires the employer to respond.",
      "Section 24 requires the employer to respond.",
    ),
    ["REVERIFY"],
  );
});

test("changing a date forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "The decision was issued on August 22, 2026.",
      "The decision was issued on August 23, 2026.",
    ),
    ["REVERIFY"],
  );
});

test("changing a number forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "The report identified 10 errors.",
      "The report identified 11 errors.",
    ),
    ["REVERIFY"],
  );
});

test("changing a quotation forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "Officer Scott wrote, \"The request was denied.\"",
      "Officer Scott wrote, \"The request was approved.\"",
    ),
    ["REVERIFY"],
  );
});

test("changing a remedy forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "The requested remedy is to set aside the decision.",
      "The requested remedy is to remit the decision.",
    ),
    ["REVERIFY"],
  );
});

test("changing a legal proposition forces selective revalidation", () => {
  assert.deepEqual(
    actionsForMaterialChange(
      "The employer must disclose the record.",
      "The employer may withhold the record.",
    ),
    ["REVERIFY"],
  );
});

test("material additions and removals are never silently reused", () => {
  const previous = extractClaimInventory("Section 23 requires disclosure.");
  const current = extractClaimInventory("The introduction is concise.");
  const comparison = compareInventories(previous, current);

  assert.ok(comparison.plan.some((item) =>
    item.action === "REMOVED" && item.requiresRevalidation
  ));
  assert.ok(comparison.plan.some((item) =>
    item.action === "ADDED"
      && item.requiresRevalidation
      && item.reviewKind === "MATERIALITY"
  ));
});

test("protected surface edits can never produce REUSE", () => {
  const pairs: Array<[string, string]> = [
    ["[BC Law s.23](https://example.test/s23)", "[BC Law s.23](https://example.test/s24)"],
    ["[Policy](https://example.test/me)", "[Policy](https://example.test/i)"],
    ["The award is -10 dollars.", "The award is 10 dollars."],
    ["The award is ≤ 10 dollars.", "The award is ≥ 10 dollars."],
    ["The employer must disclose?", "The employer must disclose."],
    ["A and (B or C)", "(A and B) or C"],
    ["The employer ~~must~~ disclose.", "The employer must disclose."],
    ["- [ ] File within 30 days", "- [x] File within 30 days"],
    ["- 10 days remain", "10 days remain"],
    ["The employer finally paid 10 dollars.", "The employer paid 10 dollars."],
    ['Officer Scott wrote, "No  reply."', 'Officer Scott wrote, "No reply."'],
    ["Officer Scott wrote, ‘No  reply.’", "Officer Scott wrote, ‘No reply.’"],
    ["Officer Scott recorded `No  reply`.", "Officer Scott recorded `No reply`."],
    ["Officer Scott wrote, 'No  reply'.", "Officer Scott wrote, 'No reply'."],
    ["Officer Scott wrote, «No  reply».", "Officer Scott wrote, «No reply»."],
    ["Officer Scott recorded ``No  reply``.", "Officer Scott recorded ``No reply``."],
    ["> No  reply was sent.", "> No reply was sent."],
    ["<q>No  reply was sent.</q>", "<q>No reply was sent.</q>"],
    ["## The employer must disclose.", "The employer must disclose."],
    ["    The employer must disclose.", "The employer must disclose."],
    ["The result is 2*3.", "The result is 23."],
    ["Record A_B must be disclosed.", "Record AB must be disclosed."],
  ];
  for (const [before, after] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    assert.equal(
      comparison.plan.some((item) => item.action === "REUSE"),
      false,
      `${before} must not reuse ${after}`,
    );
    assert.ok(comparison.plan.some((item) => item.requiresRevalidation));
  }
});

test("Setext heading roles and their section context are protected", () => {
  const headingToParagraph = compareInventories(
    extractClaimInventory("The employer must disclose.\n---"),
    extractClaimInventory("The employer must disclose."),
  );
  assert.equal(headingToParagraph.plan.some((item) => item.action === "REUSE"), false);

  const sectionChange = compareInventories(
    extractClaimInventory("Employer finding\n---\nShe denied the request."),
    extractClaimInventory("Worker allegation\n---\nShe denied the request."),
  );
  const dependent = sectionChange.plan.find((item) =>
    item.before?.text === "She denied the request."
  );
  assert.notEqual(dependent?.action, "REUSE");

  const levelChange = compareInventories(
    extractClaimInventory("Scope\n===\nThe employer must disclose."),
    extractClaimInventory("Scope\n---\nThe employer must disclose."),
  );
  assert.equal(levelChange.plan.some((item) => item.action === "REUSE"), false);
});

test("heading role and pronoun antecedent changes invalidate dependent claims", () => {
  const headingChange = compareInventories(
    extractClaimInventory([
      "## Employer's allegation",
      "The request was made on August 1, 2026.",
    ].join("\n")),
    extractClaimInventory([
      "## Tribunal's finding",
      "The request was made on August 1, 2026.",
    ].join("\n")),
  );
  const datedBody = headingChange.plan.find((item) =>
    item.before?.text.includes("August 1, 2026")
  );
  assert.notEqual(datedBody?.action, "REUSE");
  assert.equal(datedBody?.reviewKind, "SOURCE_SUPPORT");

  const antecedentChange = compareInventories(
    extractClaimInventory("Alice made the request. She denied the allegation."),
    extractClaimInventory("Bob made the request. She denied the allegation."),
  );
  const pronounClaim = antecedentChange.plan.find((item) =>
    item.before?.text === "She denied the allegation."
  );
  assert.notEqual(pronounClaim?.action, "REUSE");
});

test("rolling section context invalidates multi-hop English and Cantonese references", () => {
  const pairs: Array<[string, string, string]> = [
    [
      "Alice made the request. The file was opened. She denied the allegation.",
      "Bob made the request. The file was opened. She denied the allegation.",
      "She denied the allegation.",
    ],
    [
      "Alice made the request. She denied the allegation. This was recorded.",
      "Bob made the request. She denied the allegation. This was recorded.",
      "This was recorded.",
    ],
    [
      "陳小姐提出要求。檔案已開立。佢拒絕披露。",
      "李先生提出要求。檔案已開立。佢拒絕披露。",
      "佢拒絕披露。",
    ],
    [
      "陳小姐提出要求。檔案已開立。他拒絕披露。",
      "李先生提出要求。檔案已開立。他拒絕披露。",
      "他拒絕披露。",
    ],
  ];
  for (const [before, after, dependentText] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    const dependent = comparison.plan.find((item) => item.before?.text === dependentText);
    assert.notEqual(dependent?.action, "REUSE", dependentText);
  }
});

test("forward qualifiers and quote attributions bind the following assertion", () => {
  const pairs: Array<[string, string, string]> = [
    [
      "Subject to section 24.\n\nThe employer must disclose the record.",
      "Subject to section 25.\n\nThe employer must disclose the record.",
      "The employer must disclose the record.",
    ],
    [
      "Officer Scott wrote:\n\n> “No reply was sent.”",
      "The employer wrote:\n\n> “No reply was sent.”",
      "“No reply was sent.”",
    ],
    [
      "Alice made the request. Such conduct violates section 23.",
      "Bob made the request. Such conduct violates section 23.",
      "Such conduct violates section 23.",
    ],
    [
      "Alice made the request. The same conduct violates section 23.",
      "Bob made the request. The same conduct violates section 23.",
      "The same conduct violates section 23.",
    ],
    [
      "陳小姐提出要求。此舉違反第23條。",
      "李先生提出要求。此舉違反第23條。",
      "此舉違反第23條。",
    ],
  ];
  for (const [before, after, dependentText] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    const dependent = comparison.plan.find((item) => item.before?.text === dependentText);
    assert.notEqual(dependent?.action, "REUSE", dependentText);
  }
});

test("literal code order and malformed closing-fence content are protected", () => {
  const fencedOrder = compareInventories(
    extractClaimInventory("```js\ngrantAccess();\nrevokeAccess();\n```"),
    extractClaimInventory("```js\nrevokeAccess();\ngrantAccess();\n```"),
  );
  assert.equal(fencedOrder.plan.some((item) => item.action === "REUSE"), false);

  const indentedOrder = compareInventories(
    extractClaimInventory("    grantAccess();\n    revokeAccess();"),
    extractClaimInventory("    revokeAccess();\n    grantAccess();"),
  );
  assert.equal(indentedOrder.plan.some((item) => item.action === "REUSE"), false);

  const malformedClose = compareInventories(
    extractClaimInventory("```\n``` Section 23 requires disclosure."),
    extractClaimInventory("```\n``` Section 24 requires disclosure."),
  );
  assert.ok(malformedClose.plan.length > 0);
  assert.equal(malformedClose.plan.some((item) => item.action === "REUSE"), false);
  assert.ok(malformedClose.plan.some((item) => item.reviewKind === "SOURCE_SUPPORT"));
});

test("source-only HTML and extractor silence fail closed", () => {
  const pairs: Array<[string, string]> = [
    ['<a href="https://example.test/a"></a>', '<a href="https://example.test/b"></a>'],
    ['<img src="evidence-a.png">', '<img src="evidence-b.png">'],
    ["<mailto:old@example.test>", "<mailto:new@example.test>"],
  ];
  for (const [before, after] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    assert.ok(comparison.plan.length > 0);
    assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
    assert.ok(comparison.plan.some((item) => item.requiresRevalidation));
  }

  const silent = compareInventories(
    extractClaimInventory("```text"),
    extractClaimInventory("```javascript"),
  );
  assert.deepEqual(silent.plan.map((item) => item.action), ["UNCERTAIN"]);
  assert.equal(silent.plan[0]?.reviewKind, "MATERIALITY");
});

test("fenced content and bare URLs are inventoried instead of silently omitted", () => {
  const fenced = extractCandidateAssertions([
    "```text",
    "The employer must disclose the record.",
    "```",
  ].join("\n"));
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0]?.semanticRole, "fenced_code");

  const fencedChange = compareInventories(
    extractClaimInventory("```\nThe employer must disclose.\n```"),
    extractClaimInventory("```\nThe employer may withhold.\n```"),
  );
  assert.equal(fencedChange.plan.some((item) => item.action === "REUSE"), false);
  assert.ok(fencedChange.plan.some((item) => item.requiresRevalidation));

  const urlChange = compareInventories(
    extractClaimInventory("https://example.test/authority-a"),
    extractClaimInventory("https://example.test/authority-b"),
  );
  assert.ok(urlChange.plan.length > 0);
  assert.equal(urlChange.plan.some((item) => item.action === "REUSE"), false);
  assert.ok(urlChange.plan.some((item) => item.reviewKind === "SOURCE_SUPPORT"));
});

test("unrecognized changed prose is UNCERTAIN and routes to materiality review", () => {
  const pairs: Array<[string, string]> = [
    ["公司要交紀錄。", "公司唔使交紀錄。"],
    ["The report identifies ten errors.", "The report identifies eleven errors."],
    ["The response is due next Friday.", "The response is due next Monday."],
    ["Alice harassed Bob.", "Bob harassed Alice."],
  ];
  for (const [before, after] of pairs) {
    const comparison = compareInventories(
      extractClaimInventory(before),
      extractClaimInventory(after),
    );
    assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
    assert.ok(comparison.plan.some((item) =>
      item.requiresRevalidation && item.reviewKind !== "NONE"
    ));
  }
});

test("ambiguous changed matches are UNCERTAIN and cannot reuse an attestation", () => {
  const previous = extractClaimInventory("The employer must disclose 10 records.");
  const current = extractClaimInventory([
    "The employer must disclose 11 records.",
    "The employer must disclose 12 records.",
  ].join("\n\n"));
  const comparison = compareInventories(previous, current);
  const uncertain = comparison.plan.find((item) => item.action === "UNCERTAIN");

  assert.ok(uncertain);
  assert.equal(uncertain.requiresRevalidation, true);
  assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
});

test("fuzzy matching is resource-bounded and fails closed when its budget is exhausted", () => {
  const previous = extractClaimInventory([
    "The employer must disclose 10 records.",
    "The worker must file 20 records.",
  ].join("\n\n"));
  const current = extractClaimInventory([
    "The employer must disclose 11 records.",
    "The worker must file 21 records.",
  ].join("\n\n"));
  const comparison = compareInventories(previous, current, { maxFuzzyComparisons: 1 });

  assert.equal(comparison.fuzzyComparisons, 1);
  assert.equal(comparison.fuzzyComparisonLimitReached, true);
  assert.ok(comparison.plan.some((item) => item.action === "UNCERTAIN"));
  assert.equal(comparison.plan.some((item) => item.action === "REUSE"), false);
});
