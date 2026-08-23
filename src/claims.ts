import { sha256Text } from "./canonical.js";

export const CLAIM_EXTRACTOR_VERSION = "0.2.0-baseline.5";

export type ClaimClassification = "MATERIAL_CANDIDATE" | "PROSE_ONLY";

export type MaterialSignalKind =
  | "citation"
  | "quotation"
  | "date"
  | "number"
  | "legal_section"
  | "deadline"
  | "remedy"
  | "actor_attribution"
  | "legal_proposition";

export interface MaterialSignal {
  kind: MaterialSignalKind;
  value: string;
}

export interface ClaimLocator {
  blockIndex: number;
  sentenceIndex: number;
  lineStart: number;
  lineEnd: number;
  startOffset: number;
  endOffset: number;
}

export interface ExtractionUncertainty {
  level: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
}

export interface CandidateAssertion {
  text: string;
  normalizedText: string;
  fingerprint: string;
  comparisonFingerprint: string;
  comparisonTokens: string[];
  classification: ClaimClassification;
  material: boolean;
  materialSignals: MaterialSignal[];
  semanticRole: TextSemanticRole;
  reasons: string[];
  uncertainty: ExtractionUncertainty;
  context: {
    headingPath: string[];
    headingLevels: number[];
    dependsOnPrevious: boolean;
    priorContextHash?: string;
  };
  locator: ClaimLocator;
}

export interface AutomaticCoverageStatement {
  complete: false;
  method: "deterministic_candidate_extraction";
  reasons: string[];
}

export interface ClaimInventory {
  extractorVersion: typeof CLAIM_EXTRACTOR_VERSION;
  subjectSha256: string;
  candidates: CandidateAssertion[];
  coverage: AutomaticCoverageStatement;
}

export type InventoryAction = "REUSE" | "REVERIFY" | "ADDED" | "REMOVED" | "UNCERTAIN";

export interface InventoryPlanItem {
  action: InventoryAction;
  requiresRevalidation: boolean;
  reviewKind: "NONE" | "MATERIALITY" | "SOURCE_SUPPORT";
  reason: string;
  before?: CandidateAssertion;
  after?: CandidateAssertion;
}

export interface InventoryComparison {
  previousSubjectSha256: string;
  currentSubjectSha256: string;
  wholeDocumentChanged: boolean;
  coverageComplete: false;
  fuzzyComparisons: number;
  fuzzyComparisonLimitReached: boolean;
  plan: InventoryPlanItem[];
  reasons: string[];
}

export interface InventoryComparisonOptions {
  maxFuzzyComparisons?: number;
}

// The bounded fuzzy-matching budget is part of the comparison contract: a
// persisted revision plan records the resolved value so a replay reproduces the
// same UNCERTAIN fallbacks instead of guessing the default.
export const DEFAULT_MAX_FUZZY_COMPARISONS = 250_000;

export type TextSemanticRole = "assertion" | "heading" | "fenced_code" | "indented_code";

interface TextBlock {
  text: string;
  rawText: string;
  headingPath: string[];
  blockIndex: number;
  lineStart: number;
  lineEnd: number;
  startOffset: number;
  endOffset: number;
  markdownQuote: boolean;
  semanticRole: TextSemanticRole;
  headingLevel?: number;
  headingLevels: number[];
  literalGroup?: number;
  literalSequence?: number;
  literalFenceInfo?: string;
}

const DISCOURSE_CONNECTORS = new Set([
  "additionally",
  "furthermore",
  "however",
  "moreover",
  "nevertheless",
  "nonetheless",
]);

// Connector removal is deliberately narrower than token normalization. A leading
// capitalized name can be an actor (for example, "Moreover, LLC"), so only
// syntactically recognizable clause starters are eligible for this convenience.
const SAFE_CONNECTOR_FOLLOWER = "(?:a|an|the|i|me|we|us|he|him|she|her|they|them|it|this|that|these|those|section|sections|article|articles|paragraph|paragraphs|para\\.?|s\\.?|ss\\.?|under|pursuant|according|if|when|where|because|although|there|[0-9])";
const SAFE_DISCOURSE_CONNECTOR_PREFIX = new RegExp(
  `^(?:${[...DISCOURSE_CONNECTORS].join("|")})\\s*[,;:]\\s+(?=${SAFE_CONNECTOR_FOLLOWER}\\b)`,
  "iu",
);

const FIRST_PERSON = new Set(["i", "me"]);
const FIRST_PERSON_PLURAL = new Set(["we", "us"]);

const ABBREVIATIONS = new Set([
  "art",
  "arts",
  "dr",
  "e.g",
  "i.e",
  "mr",
  "mrs",
  "ms",
  "no",
  "nos",
  "para",
  "paras",
  "s",
  "ss",
  "v",
  "vol",
]);

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

const CITATION_PATTERNS = [
  /\b\d{4}\s+[A-Z]{2,}(?:\s+[A-Z]{2,})?\s+\d+\b/g,
  /\b[A-Z][\p{L}\p{N}.'’-]+(?:\s+[A-Z][\p{L}\p{N}.'’-]+){0,3}\s+v\.?\s+[A-Z][\p{L}\p{N}.'’-]+(?:\s+[A-Z][\p{L}\p{N}.'’-]+){0,3}\b/gu,
  /https?:\/\/[^\s<>()\[\]{}"'“”‘’「」『』]+/giu,
  /(?:\b(?:href|src|srcset|cite|poster|action|formaction|data|longdesc|usemap|manifest):|mailto:)[^\s<>"']+/giu,
];

const LEGAL_SECTION_PATTERN = /\b(?:s\.?|ss\.?|section|sections|article|articles|para\.?|paragraph|paragraphs)\s*\d+[\w.-]*(?:\s*\([\w-]+\))*/giu;
const CHINESE_LEGAL_SECTION_PATTERN = /第\s*[〇零一二三四五六七八九十百千\d]+(?:\.\d+)?\s*(?:條|条|款|項|项|段)/gu;

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}[,]?\\s+\\d{4}\\b`, "gi"),
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu,
];

const DEADLINE_PATTERN = /\b(?:deadline|due date|limitation period|time limit|expires?|no later than|on or before|within\s+\d+(?:\.\d+)?\s+(?:business\s+|calendar\s+)?(?:hours?|days?|weeks?|months?|years?)|by\s+(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?))\b/giu;

const REMEDY_PATTERN = /\b(?:set(?:ting)? aside|quash(?:ed|ing)?|remit(?:ted|ting)?|reconsider(?:ation)?|compensation|damages|injunction|declaration|reinstat(?:e|ed|ement|ing)|refund|specific performance|costs|award|dismiss(?:ed|al|ing)?|allow(?:ed|ing)? the appeal|grant(?:ed|ing)?(?: the)? (?:application|appeal|order)|order(?:ed|ing)?)\b/giu;

const ATTRIBUTION_VERBS = [
  "admitted",
  "agreed",
  "approved",
  "confirmed",
  "decided",
  "denied",
  "disagreed",
  "failed",
  "found",
  "held",
  "issued",
  "made",
  "ordered",
  "received",
  "refused",
  "reported",
  "requested",
  "said",
  "sent",
  "stated",
  "wrote",
] as const;

const ATTRIBUTION_PATTERN = new RegExp(
  `\\b((?:I|Me|We|Us|He|Him|She|Her|They|Them)|(?:the\\s+[\\p{L}][\\p{L}'’.-]*(?:\\s+[\\p{L}][\\p{L}'’.-]*){0,4})|(?:[A-Z][\\p{L}'’.-]*(?:\\s+[A-Z][\\p{L}'’.-]*){0,4}))\\s+(${ATTRIBUTION_VERBS.join("|")})\\b`,
  "giu",
);

const SAFE_FIRST_PERSON_PATTERN = new RegExp(
  `(^|[.!?。！？]\\s+)(?:I|i|Me|me)(?=\\s+(?:${ATTRIBUTION_VERBS.join("|")})\\b)`,
  "gu",
);
const SAFE_FIRST_PERSON_PLURAL_PATTERN = new RegExp(
  `(^|[.!?。！？]\\s+)(?:We|we|Us|us)(?=\\s+(?:${ATTRIBUTION_VERBS.join("|")})\\b)`,
  "gu",
);

const PROPOSITION_WORDS = [
  "applies",
  "breached",
  "contradicts",
  "disclose",
  "entitled",
  "invalid",
  "liable",
  "may",
  "must",
  "prohibited",
  "requires",
  "shall",
  "supports",
  "valid",
  "violated",
  "violates",
  "withhold",
] as const;

const PROPOSITION_PATTERN = new RegExp(`\\b(?:${PROPOSITION_WORDS.join("|")})\\b`, "giu");

const CHINESE_DEADLINE_PATTERN = /(?:期限|截止|不遲於|不迟于|最遲於|最迟于|聽日|明天|下星期|下週|下周|月底前|月尾前|年尾前|在\s*[〇零一二三四五六七八九十百千兩两\d]+\s*(?:個)?(?:工作日|曆日|日|星期|週|周|月|年)\s*(?:內|内))/gu;
const CHINESE_REMEDY_PATTERN = /(?:撤銷|撤销|發還|发还|重新考慮|重新考虑|復職|复职|賠償|赔偿|損害賠償|损害赔偿|退款|禁制令|宣告|命令|訟費|讼费)/gu;
const CHINESE_PROPOSITION_PATTERN = /(?:必須|必须|不得|不可以|可以|有權|有权|無權|无权|違反|违反|適用|适用|應當|应当|應該|应该|唔應該|毋須|毋须|唔使|唔准|需要|須要|须要|要交|要覆|要披露|要提交)/gu;
const CHINESE_ATTRIBUTION_PATTERN = /[\p{L}\p{N}.’'·\- ]{1,60}?(?:表示|確認|确认|拒絕|拒绝|決定|决定|裁定|承認|承认|要求|發出|发出|收到|寫道|写道|話|讲|講|覆|交咗|冇交)/gu;
const CHINESE_COUNT_PATTERN = /[〇零一二三四五六七八九十百千兩两]+\s*(?:項|项|份|次|人|個|个|日|星期|週|周|月|年)/gu;

const COMPARISON_PREDICATES = new Set([
  ...ATTRIBUTION_VERBS,
  ...PROPOSITION_WORDS,
  "apply",
  "breach",
  "deny",
  "disclosed",
  "disclosing",
  "pay",
  "paid",
  "refuse",
  "refused",
  "require",
  "required",
  "support",
  "supported",
  "violate",
  "violating",
  "withheld",
  "withholding",
]);

function collapseWhitespace(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

const PROTECTED_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "“": "”",
  "„": "“",
  "「": "」",
  "『": "』",
  "‘": "’",
  "’": "’",
  "«": "»",
  "‹": "›",
  "〝": "〞",
};

const PROTECTED_ENTITY_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["&quot;", "&quot;"],
  ["&apos;", "&apos;"],
  ["&ldquo;", "&rdquo;"],
  ["&lsquo;", "&rsquo;"],
  ["&laquo;", "&raquo;"],
  ["&lsaquo;", "&rsaquo;"],
];

interface ProtectedSpan {
  close: string;
  asciiSingle: boolean;
  caseInsensitive?: boolean;
  closePattern?: RegExp;
}

function wordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function openingProtectedSpan(value: string, index: number): { open: string; span: ProtectedSpan } | undefined {
  const numericEntity = /^&#(?:0*34|x0*22);/iu.exec(value.slice(index))?.[0];
  if (numericEntity) {
    return {
      open: numericEntity,
      span: {
        close: numericEntity,
        asciiSingle: false,
        closePattern: /^&#(?:0*34|x0*22);/iu,
      },
    };
  }
  for (const [open, close] of PROTECTED_ENTITY_QUOTE_PAIRS) {
    const actualOpen = value.slice(index, index + open.length);
    if (actualOpen.toLocaleLowerCase("en-CA") === open) {
      return {
        open: actualOpen,
        span: { close, asciiSingle: false, caseInsensitive: true },
      };
    }
  }
  const char = value[index];
  if (char === "`") {
    const open = /^`+/u.exec(value.slice(index))?.[0] ?? "`";
    return { open, span: { close: open, asciiSingle: false } };
  }
  if (
    char === "'"
    && !wordCharacter(value[index - 1])
    && value.slice(index + 1).match(/'(?=$|[^\p{L}\p{N}])/u) !== null
  ) {
    return { open: "'", span: { close: "'", asciiSingle: true } };
  }
  if (
    char === "’"
    && !wordCharacter(value[index - 1])
    && value.slice(index + 1).match(/’(?=$|[^\p{L}\p{N}])/u) !== null
  ) {
    return { open: "’", span: { close: "’", asciiSingle: true } };
  }
  if (char === "’") return undefined;
  if (char === undefined) return undefined;
  const close = PROTECTED_QUOTE_PAIRS[char];
  return close === undefined ? undefined : { open: char, span: { close, asciiSingle: false } };
}

function transformOutsideProtectedSpans(
  value: string,
  transform: (unprotected: string) => string,
): string {
  const output: string[] = [];
  let unprotected = "";
  let span: ProtectedSpan | undefined;
  const flush = (): void => {
    if (unprotected.length === 0) return;
    output.push(transform(unprotected));
    unprotected = "";
  };

  for (let index = 0; index < value.length;) {
    if (!span) {
      const opening = openingProtectedSpan(value, index);
      if (opening) {
        flush();
        output.push(opening.open);
        span = opening.span;
        index += opening.open.length;
        continue;
      }
      unprotected += value[index] ?? "";
      index += 1;
      continue;
    }

    const closeLength = protectedSpanCloseLength(value, index, span);
    if (closeLength !== undefined) {
      output.push(value.slice(index, index + closeLength));
      index += closeLength;
      span = undefined;
      continue;
    }
    output.push(value[index] ?? "");
    index += 1;
  }
  flush();
  return output.join("");
}

function protectedSpanCloseLength(
  value: string,
  index: number,
  span: ProtectedSpan,
): number | undefined {
  const patternMatch = span.closePattern?.exec(value.slice(index))?.[0];
  const closeLength = patternMatch?.length ?? span.close.length;
  const matches = patternMatch !== undefined
    || (span.caseInsensitive
      ? value.slice(index, index + closeLength).toLocaleLowerCase("en-CA")
        === span.close.toLocaleLowerCase("en-CA")
      : value.startsWith(span.close, index));
  return matches && (!span.asciiSingle || !wordCharacter(value[index + closeLength]))
    ? closeLength
    : undefined;
}

function collapseUnquotedWhitespace(value: string): string {
  // Compatibility folding (NFKC) can turn 2² into 22. Preserve those code
  // points for legal/material identity and reserve NFKC for fuzzy anchors only.
  const surface = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  return transformOutsideProtectedSpans(surface, (unprotected) =>
    unprotected.replace(/\s+/gu, " ")
  );
}

function normalizeSafeSurface(value: string): string {
  let surface = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  surface = surface.replace(/^\s*[-+*]\s+(?!\[[ xX]\]\s*|[+\-]?\d)/u, "");
  const connector = SAFE_DISCOURSE_CONNECTOR_PREFIX.exec(surface);
  if (connector) {
    surface = surface.slice(connector[0].length);
    surface = surface.replace(/^([a-z])/u, (letter) => letter.toLocaleUpperCase("en-CA"));
  }
  return transformOutsideProtectedSpans(surface, (unprotected) =>
    unprotected
      .replace(SAFE_FIRST_PERSON_PATTERN, "$1<first_person>")
      .replace(SAFE_FIRST_PERSON_PLURAL_PATTERN, "$1<first_person_plural>")
      .replace(/[\t \f\v]+/gu, " ")
  );
}

function dependsOnPreviousContext(text: string): boolean {
  return /\b(?:he|him|his|she|her|hers|they|them|their|theirs|it|its|this|that|these|those|former|latter|such|same|above|aforementioned|therefore|thereby|thus|hence|consequently|accordingly)\b/iu
    .test(text)
    || /(?:他們|她們|它們|他们|她们|它们|(?<!其)[他她它佢](?!們|们)|上述|前述|該|该|其|這|这|那|呢個|嗰個|此舉|此举|同一|該等|该等|因此|所以|據此|据此|故此)/u.test(text);
}

function establishesForwardContext(text: string): boolean {
  return /[:：]\s*$/u.test(text)
    || /^\s*(?:notwithstanding|despite|subject\s+to|provided\s+that|except(?:\s+that)?|unless|if|whether|when|where|while|although|because|once|only\s+if|as\s+long\s+as|in\s+the\s+event(?:\s+that)?|according\s+to|under|pursuant\s+to|as\s+(?:stated|written|reported)\s+by)\b/iu.test(text)
    || /\b(?:wrote|said|stated|reported|confirmed|found|held|decided|ordered)\s*[.?!。！？]?\s*$/iu.test(text)
    || /^\s*(?:受.+規限|受.+规限|除非|但書|但书|根據|根据|依據|依据|按照)/u.test(text);
}

function htmlSourceTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(/\b(href|src|srcset|cite|poster|action|formaction|data|longdesc|usemap|manifest)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
    const attribute = (match[1] ?? "").toLocaleLowerCase("en-CA");
    const target = match[2] ?? match[3] ?? match[4] ?? "";
    if (attribute && target) tokens.push(attribute + ":" + target);
  }
  for (const match of value.matchAll(/<(mailto:[^>]+)>/giu)) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

function stripMarkdown(value: string): string {
  const sourceTokens = htmlSourceTokens(value);
  const stripped = collapseUnquotedWhitespace(
    value
      .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 ($2)")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-+*](?!\s+[+\-]?\d)|\d+[.)])\s+/, "")
      .replace(/^\s*\|?|\|?\s*$/g, "")
      .replace(/\s*\|\s*/g, ". "),
  );
  return collapseUnquotedWhitespace([stripped, ...sourceTokens].filter(Boolean).join(" "));
}

function protectedBlockGuard(block: TextBlock): string | undefined {
  if (block.semanticRole === "fenced_code" || block.semanticRole === "indented_code") {
    return block.rawText.normalize("NFC").replace(/\r\n?/gu, "\n");
  }
  if (block.markdownQuote || /<[^>]+>/u.test(block.rawText)) {
    return block.rawText.normalize("NFC").replace(/\r\n?/gu, "\n");
  }
  if (/^\s*\||\|\s*$/u.test(block.rawText)) {
    return normalizeSafeSurface(block.rawText);
  }
  return undefined;
}

function collectMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => collapseWhitespace(match[0] ?? ""));
}

function quotedValues(text: string): string[] {
  const values: string[] = [];
  const patterns = [
    /["“]([^"”]+)["”]/g,
    /「([^」]+)」/g,
    /『([^』]+)』/g,
    /‘([^’]+)’/g,
    /’([^’]+)’/g,
    /«([^»]+)»/g,
    /‹([^›]+)›/g,
    /„([^“]+)“/g,
    /〝([^〞]+)〞/g,
    /(?:^|[^\p{L}\p{N}])'(.+?)'(?![\p{L}\p{N}])/gu,
    /&quot;([\s\S]+?)&quot;/giu,
    /&apos;([\s\S]+?)&apos;/giu,
    /&ldquo;([\s\S]+?)&rdquo;/giu,
    /&lsquo;([\s\S]+?)&rsquo;/giu,
    /&laquo;([\s\S]+?)&raquo;/giu,
    /&lsaquo;([\s\S]+?)&rsaquo;/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const quote = match[1];
      if (quote && collapseWhitespace(quote).length > 0) values.push(collapseWhitespace(quote));
    }
  }
  for (const match of text.matchAll(/(`+)([\s\S]*?)\1/gu)) {
    const quote = match[2];
    if (quote && collapseWhitespace(quote).length > 0) values.push(collapseWhitespace(quote));
  }
  return values;
}

function canonicalTokens(value: string): string[] {
  const raw = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .match(/[\p{L}\p{N}§$%]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [];

  const tokens: string[] = [];
  for (const token of raw) {
    if (DISCOURSE_CONNECTORS.has(token)) continue;
    if (FIRST_PERSON.has(token)) {
      tokens.push("<first_person>");
    } else if (FIRST_PERSON_PLURAL.has(token)) {
      tokens.push("<first_person_plural>");
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

function signalKey(signal: MaterialSignal): string {
  const value = signal.kind === "quotation"
    ? signal.value.normalize("NFC")
    : signal.kind === "actor_attribution"
      ? canonicalTokens(signal.value).join(" ")
      : collapseWhitespace(signal.value).toLocaleLowerCase("en-CA");
  return `${signal.kind}:${value}`;
}

function comparisonTokens(
  normalizedText: string,
  signals: MaterialSignal[],
): string[] {
  let generalized = normalizedText;
  const replaceKinds: MaterialSignalKind[] = [
    "quotation",
    "citation",
    "legal_section",
    "date",
    "deadline",
    "remedy",
    "number",
  ];

  for (const kind of replaceKinds) {
    const values = signals
      .filter((signal) => signal.kind === kind)
      .map((signal) => signal.value)
      .sort((left, right) => right.length - left.length);
    for (const value of values) {
      if (value.length === 0) continue;
      generalized = generalized.split(value).join(` <${kind}> `);
    }
  }

  return canonicalTokens(generalized).map((token) =>
    COMPARISON_PREDICATES.has(token) ? "<predicate>" : token
  );
}

function detectSignals(text: string, markdownQuote: boolean): MaterialSignal[] {
  const signals: MaterialSignal[] = [];
  const add = (kind: MaterialSignalKind, values: string[]): void => {
    for (const value of values) {
      if (value.length > 0) signals.push({ kind, value });
    }
  };

  for (const pattern of CITATION_PATTERNS) add("citation", collectMatches(text, pattern));
  const directQuotes = quotedValues(text);
  add("quotation", directQuotes);
  if (markdownQuote && directQuotes.length === 0) add("quotation", [collapseWhitespace(text)]);
  add("date", DATE_PATTERNS.flatMap((pattern) => collectMatches(text, pattern)));
  add("legal_section", [
    ...collectMatches(text, LEGAL_SECTION_PATTERN),
    ...collectMatches(text, CHINESE_LEGAL_SECTION_PATTERN),
  ]);
  add("deadline", collectMatches(text, DEADLINE_PATTERN));
  add("deadline", collectMatches(text, CHINESE_DEADLINE_PATTERN));
  add("remedy", collectMatches(text, REMEDY_PATTERN));
  add("remedy", collectMatches(text, CHINESE_REMEDY_PATTERN));
  add("actor_attribution", collectMatches(text, ATTRIBUTION_PATTERN));
  add("actor_attribution", collectMatches(text, CHINESE_ATTRIBUTION_PATTERN));
  add("legal_proposition", collectMatches(text, PROPOSITION_PATTERN));
  add("legal_proposition", collectMatches(text, CHINESE_PROPOSITION_PATTERN));
  add("number", collectMatches(text, /(?:[$£€]\s*)?\b\d+(?:,\d{3})*(?:\.\d+)?%?\b/g));
  add("number", collectMatches(text, CHINESE_COUNT_PATTERN));

  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = signalKey(signal);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockLines(markdown: string): TextBlock[] {
  const text = markdown.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  const headingLevelStack: number[] = [];
  let pending: { lines: string[]; lineStart: number; lineEnd: number; startOffset: number; endOffset: number } | undefined;
  let fence: {
    marker: "`" | "~";
    length: number;
    group: number;
    nextSequence: number;
    info: string;
  } | undefined;
  let nextLiteralGroup = 0;
  let indentedGroup: { group: number; nextSequence: number; previousLine: number } | undefined;

  const pushBlock = (
    raw: string,
    lineStart: number,
    lineEnd: number,
    startOffset: number,
    endOffset: number,
    forcedRole?: TextSemanticRole,
    forcedHeadingLevel?: number,
    literal?: { group: number; sequence: number; fenceInfo?: string },
  ): void => {
    const heading = /^\s{0,3}(#{1,6})\s+/u.exec(raw);
    const semanticRole = forcedRole
      ?? (heading ? "heading" : /^(?: {4}|\t)/u.test(raw) ? "indented_code" : "assertion");
    const markdownQuote = /^\s*>/.test(raw);
    const literalRole = semanticRole === "fenced_code" || semanticRole === "indented_code";
    const stripped = literalRole ? "" : stripMarkdown(raw);
    const cleaned = literalRole
      ? raw.normalize("NFC").replace(/\r\n?/gu, "\n")
      : stripped || (/<[^>]+>/u.test(raw) ? raw.normalize("NFC") : "");
    if (!literalRole && (!cleaned || /^:?-{3,}:?(?:\s*\.\s*:?-{3,}:?)*$/.test(cleaned))) return;
    const headingLevel = forcedHeadingLevel ?? heading?.[1]?.length;
    blocks.push({
      text: cleaned,
      rawText: raw,
      headingPath: [...headingStack],
      headingLevels: [...headingLevelStack],
      blockIndex: blocks.length,
      lineStart,
      lineEnd,
      startOffset,
      endOffset,
      markdownQuote,
      semanticRole,
      ...(headingLevel === undefined ? {} : { headingLevel }),
      ...(literal === undefined ? {} : {
        literalGroup: literal.group,
        literalSequence: literal.sequence,
        ...(literal.fenceInfo === undefined ? {} : { literalFenceInfo: literal.fenceInfo }),
      }),
    });
    if (semanticRole === "heading" && headingLevel !== undefined) {
      const level = headingLevel;
      while ((headingLevelStack.at(-1) ?? 0) >= level) {
        headingStack.pop();
        headingLevelStack.pop();
      }
      headingStack.push(cleaned);
      headingLevelStack.push(level);
    }
  };

  const flush = (): void => {
    if (!pending) return;
    pushBlock(
      pending.lines.join(" "),
      pending.lineStart,
      pending.lineEnd,
      pending.startOffset,
      pending.endOffset,
    );
    pending = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineOffset = offsets[index] ?? 0;
    if (fence) {
      const closingFence = /^\s{0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
      const closingToken = closingFence?.[1] ?? "";
      const closingMarker = closingToken[0] as "`" | "~" | undefined;
      if (
        closingMarker === fence.marker
        && closingToken.length >= fence.length
      ) {
        fence = undefined;
        continue;
      }
      const sequence = fence.nextSequence;
      fence.nextSequence += 1;
      pushBlock(
        line,
        index + 1,
        index + 1,
        lineOffset,
        lineOffset + line.length,
        "fenced_code",
        undefined,
        { group: fence.group, sequence, fenceInfo: fence.info },
      );
      continue;
    }

    const openingFence = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (openingFence) {
      const token = openingFence[1] ?? "";
      const marker = token[0] as "`" | "~" | undefined;
      flush();
      indentedGroup = undefined;
      if (marker) {
        fence = {
          marker,
          length: token.length,
          group: nextLiteralGroup,
          nextSequence: 0,
          info: (openingFence[2] ?? "").trim(),
        };
        nextLiteralGroup += 1;
      }
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      indentedGroup = undefined;
      continue;
    }
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) {
      flush();
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    const setextUnderline = /^\s{0,3}(=+|-+)\s*$/u.exec(nextLine);
    if (setextUnderline && line.trim().length > 0) {
      flush();
      pushBlock(
        line,
        index + 1,
        index + 2,
        lineOffset,
        (offsets[index + 1] ?? lineOffset) + nextLine.length,
        "heading",
        (setextUnderline[1] ?? "=").startsWith("=") ? 1 : 2,
      );
      index += 1;
      continue;
    }

    if (/^(?: {4}|\t)/u.test(line)) {
      flush();
      if (!indentedGroup || indentedGroup.previousLine !== index) {
        indentedGroup = {
          group: nextLiteralGroup,
          nextSequence: 0,
          previousLine: index,
        };
        nextLiteralGroup += 1;
      }
      const literal = {
        group: indentedGroup.group,
        sequence: indentedGroup.nextSequence,
      };
      indentedGroup.nextSequence += 1;
      indentedGroup.previousLine = index + 1;
      pushBlock(
        line,
        index + 1,
        index + 1,
        lineOffset,
        lineOffset + line.length,
        "indented_code",
        undefined,
        literal,
      );
      continue;
    }
    indentedGroup = undefined;

    const standalone = /^\s*(?:#{1,6}\s+|>|[-+*]\s+|\d+[.)]\s+|\|)/.test(line);
    if (standalone) {
      flush();
      pushBlock(line, index + 1, index + 1, lineOffset, lineOffset + line.length);
      continue;
    }

    if (!pending) {
      pending = {
        lines: [line],
        lineStart: index + 1,
        lineEnd: index + 1,
        startOffset: lineOffset,
        endOffset: lineOffset + line.length,
      };
    } else {
      pending.lines.push(line);
      pending.lineEnd = index + 1;
      pending.endOffset = lineOffset + line.length;
    }
  }
  flush();
  return blocks;
}

function isSentencePeriod(text: string, index: number): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/https?:\/\/\S*$/iu.test(text.slice(0, index + 1))) return false;
  if (/\d/.test(previous) && /\d/.test(next)) return false;
  const prefix = text.slice(0, index);
  const token = prefix.match(/([\p{L}.]+)$/u)?.[1]?.toLocaleLowerCase("en-CA").replace(/\.$/, "");
  if (token && ABBREVIATIONS.has(token)) return false;
  if (next === ".") return false;
  return true;
}

function splitSentences(block: TextBlock): string[] {
  const output: string[] = [];
  let start = 0;
  let protectedSpan: ProtectedSpan | undefined;

  const push = (end: number): void => {
    const candidate = collapseUnquotedWhitespace(block.text.slice(start, end));
    if (candidate.length > 0) output.push(candidate);
    start = end;
  };

  for (let index = 0; index < block.text.length;) {
    const char = block.text[index];
    if (!protectedSpan) {
      const opening = openingProtectedSpan(block.text, index);
      if (opening) {
        protectedSpan = opening.span;
        index += opening.open.length;
        continue;
      }
    } else {
      const closeLength = protectedSpanCloseLength(block.text, index, protectedSpan);
      if (closeLength !== undefined) {
      const previous = block.text[index - 1] ?? "";
      protectedSpan = undefined;
      const remainder = block.text.slice(index + closeLength).trimStart();
      const continuesSentence = /^(?:[,.，、;；:：)）]|and\b|or\b|but\b|並|及|以及|而|但)/iu
        .test(remainder);
      if (/[.?!。！？]/u.test(previous) && !continuesSentence) push(index + closeLength);
      index += closeLength;
      continue;
      }
    }
    if (protectedSpan) {
      index += 1;
      continue;
    }
    if ([";", "?", "!", "；", "？", "！", "。"].includes(char ?? "")) {
      push(index + 1);
    } else if (char === "." && isSentencePeriod(block.text, index)) {
      push(index + 1);
    }
    index += 1;
  }
  push(block.text.length);
  return output;
}

function buildCandidate(
  block: TextBlock,
  sentence: string,
  sentenceIndex: number,
  priorContextHash: string,
  forceContextDependent: boolean,
): CandidateAssertion {
  const normalizedText = collapseWhitespace(sentence);
  // Compatibility folding improves detection (for example, full-width digits)
  // but never enters exact identity, which remains NFC/raw in the fingerprint.
  const materialSignals = detectSignals(normalizedText.normalize("NFKC"), block.markdownQuote);
  const material = materialSignals.length > 0;
  const normalized = canonicalTokens(normalizedText);
  const contextDependent = forceContextDependent || dependsOnPreviousContext(normalizedText);
  const boundPriorContextHash = contextDependent ? priorContextHash : undefined;
  const stableSignalKeys = materialSignals.map(signalKey).sort();
  const blockGuard = protectedBlockGuard(block);
  const fingerprint = sha256Text(JSON.stringify({
    extractor: CLAIM_EXTRACTOR_VERSION,
    sentenceSurface: normalizeSafeSurface(sentence),
    blockGuard: blockGuard ?? null,
    semanticRole: block.semanticRole,
    literalGroup: block.literalGroup ?? null,
    literalSequence: block.literalSequence ?? null,
    literalFenceInfo: block.literalFenceInfo ?? null,
    headingLevel: block.headingLevel ?? null,
    signals: stableSignalKeys,
    headingPath: block.headingPath.map(normalizeSafeSurface),
    headingLevels: block.headingLevels,
    priorContextHash: boundPriorContextHash ?? null,
  }));
  const matchTokens = comparisonTokens(normalizedText, materialSignals);
  const comparisonFingerprint = sha256Text(JSON.stringify({
    extractor: CLAIM_EXTRACTOR_VERSION,
    semanticRole: block.semanticRole,
    literalGroup: block.literalGroup ?? null,
    tokens: matchTokens,
    signalKinds: [...new Set(materialSignals.map((signal) => signal.kind))].sort(),
  }));

  const strongKinds = new Set<MaterialSignalKind>([
    "citation",
    "quotation",
    "date",
    "legal_section",
    "deadline",
    "remedy",
    "actor_attribution",
    "legal_proposition",
  ]);
  const hasStrongSignal = materialSignals.some((signal) => strongKinds.has(signal.kind));
  const reasons = material
    ? materialSignals.map((signal) => `Detected ${signal.kind}: ${signal.value}`)
    : ["No deterministic material signal was detected."];
  const uncertaintyReasons = [
    "This deterministic baseline identifies candidates; it does not prove semantic atomicity or complete coverage.",
  ];
  if (!material) {
    uncertaintyReasons.push("Prose-only text can still contain a material proposition outside the allowlisted patterns.");
  } else if (!hasStrongSignal) {
    uncertaintyReasons.push("A number alone may be incidental rather than a material assertion.");
  }

  return {
    text: normalizedText,
    normalizedText: normalized.join(" "),
    fingerprint,
    comparisonFingerprint,
    comparisonTokens: matchTokens,
    classification: material ? "MATERIAL_CANDIDATE" : "PROSE_ONLY",
    material,
    materialSignals,
    semanticRole: block.semanticRole,
    reasons,
    uncertainty: {
      level: !material ? "HIGH" : hasStrongSignal ? "MEDIUM" : "HIGH",
      reasons: uncertaintyReasons,
    },
    context: {
      headingPath: block.headingPath,
      headingLevels: block.headingLevels,
      dependsOnPrevious: contextDependent,
      ...(boundPriorContextHash === undefined ? {} : { priorContextHash: boundPriorContextHash }),
    },
    locator: {
      blockIndex: block.blockIndex,
      sentenceIndex,
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
    },
  };
}

export function extractCandidateAssertions(markdownOrProse: string): CandidateAssertion[] {
  const candidates: CandidateAssertion[] = [];
  const rollingContextBySection = new Map<string, string>();
  const forwardContextBySection = new Map<string, boolean>();
  for (const block of blockLines(markdownOrProse)) {
    const sectionKey = JSON.stringify({
      headingPath: block.headingPath.map(normalizeSafeSurface),
      headingLevels: block.headingLevels,
    });
    let rollingContextHash = rollingContextBySection.get(sectionKey)
      ?? sha256Text(JSON.stringify({
        extractor: CLAIM_EXTRACTOR_VERSION,
        section: block.headingPath.map(normalizeSafeSurface),
        headingLevels: block.headingLevels,
      }));
    let forwardContext = forwardContextBySection.get(sectionKey) ?? false;
    const sentences = splitSentences(block);
    const literalRole = block.semanticRole === "fenced_code" || block.semanticRole === "indented_code";
    if (
      sentences.length === 0
      && literalRole
    ) {
      // Blank and separator-looking literal lines are content too. Retaining an
      // empty candidate prevents a trailing literal edit from disappearing.
      sentences.push("");
    }
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex];
      if (sentence !== undefined && (sentence.length > 0 || literalRole)) {
        const candidate = buildCandidate(
          block,
          sentence,
          sentenceIndex,
          rollingContextHash,
          forwardContext || block.markdownQuote,
        );
        candidates.push(candidate);
        rollingContextHash = sha256Text(JSON.stringify({
          extractor: CLAIM_EXTRACTOR_VERSION,
          priorContextHash: rollingContextHash,
          candidateFingerprint: candidate.fingerprint,
        }));
        forwardContext = establishesForwardContext(sentence);
      }
    }
    rollingContextBySection.set(sectionKey, rollingContextHash);
    forwardContextBySection.set(sectionKey, forwardContext);
  }
  return candidates;
}

export function normalizedAtomicClaimFingerprint(text: string): string | undefined {
  const candidates = extractCandidateAssertions(text);
  const candidate = candidates[0];
  return candidates.length === 1 && candidate?.context.dependsOnPrevious === false
    ? candidate.fingerprint
    : undefined;
}

export function extractClaimInventory(markdownOrProse: string): ClaimInventory {
  return {
    extractorVersion: CLAIM_EXTRACTOR_VERSION,
    // This hash is audit identity only. compareInventories never uses it to invalidate every claim.
    subjectSha256: sha256Text(markdownOrProse),
    candidates: extractCandidateAssertions(markdownOrProse),
    coverage: {
      complete: false,
      method: "deterministic_candidate_extraction",
      reasons: [
        "Automatic extraction is a conservative candidate inventory, not an exhaustive semantic inventory.",
        "Unrecognized wording, compound assertions, tables, formatting, and implicit propositions may be missed or split incorrectly.",
        "High-risk use still requires manual or independently validated coverage attestation.",
      ],
    },
  };
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

function signalKindOverlap(left: CandidateAssertion, right: CandidateAssertion): boolean {
  const kinds = new Set(left.materialSignals.map((signal) => signal.kind));
  return right.materialSignals.some((signal) => kinds.has(signal.kind));
}

function planItem(
  action: InventoryAction,
  reason: string,
  before?: CandidateAssertion,
  after?: CandidateAssertion,
): InventoryPlanItem {
  const material = Boolean(before?.material || after?.material);
  const reviewKind = action === "REUSE"
    ? "NONE"
    : material
      ? "SOURCE_SUPPORT"
      : "MATERIALITY";
  const item: InventoryPlanItem = {
    action,
    requiresRevalidation: action !== "REUSE",
    reviewKind,
    reason,
  };
  if (before) item.before = before;
  if (after) item.after = after;
  return item;
}

export function compareInventories(
  previous: ClaimInventory,
  current: ClaimInventory,
  options: InventoryComparisonOptions = {},
): InventoryComparison {
  const maxFuzzyComparisons = options.maxFuzzyComparisons ?? DEFAULT_MAX_FUZZY_COMPARISONS;
  if (!Number.isSafeInteger(maxFuzzyComparisons) || maxFuzzyComparisons < 0) {
    throw new RangeError("maxFuzzyComparisons must be a non-negative integer");
  }
  const oldMatched = new Set<number>();
  const newMatched = new Set<number>();
  const pairByOld = new Map<number, InventoryPlanItem>();
  let fuzzyComparisons = 0;
  let fuzzyComparisonLimitReached = false;

  // Exact claim fingerprints are matched as a multiset. Location is deliberately absent.
  const oldByFingerprint = new Map<string, number[]>();
  for (let index = 0; index < previous.candidates.length; index += 1) {
    const candidate = previous.candidates[index];
    if (!candidate) continue;
    const queue = oldByFingerprint.get(candidate.fingerprint) ?? [];
    queue.push(index);
    oldByFingerprint.set(candidate.fingerprint, queue);
  }
  for (let index = 0; index < current.candidates.length; index += 1) {
    const candidate = current.candidates[index];
    if (!candidate) continue;
    const queue = oldByFingerprint.get(candidate.fingerprint);
    const oldIndex = queue?.shift();
    if (oldIndex === undefined) continue;
    const before = previous.candidates[oldIndex];
    if (!before) continue;
    oldMatched.add(oldIndex);
    newMatched.add(index);
    pairByOld.set(oldIndex, planItem(
      "REUSE",
      "The location-independent claim fingerprint is unchanged.",
      before,
      candidate,
    ));
  }

  // Changed values or predicates normally retain a generalized comparison anchor.
  fuzzyMatching: for (let oldIndex = 0; oldIndex < previous.candidates.length; oldIndex += 1) {
    if (oldMatched.has(oldIndex)) continue;
    const before = previous.candidates[oldIndex];
    if (!before) continue;

    let bestIndex: number | undefined;
    let bestScore = -1;
    const tiedBestIndices: number[] = [];
    for (let newIndex = 0; newIndex < current.candidates.length; newIndex += 1) {
      if (newMatched.has(newIndex)) continue;
      if (fuzzyComparisons >= maxFuzzyComparisons) {
        fuzzyComparisonLimitReached = true;
        break fuzzyMatching;
      }
      fuzzyComparisons += 1;
      const after = current.candidates[newIndex];
      if (!after || before.classification !== after.classification) continue;
      if (before.material && !signalKindOverlap(before, after)) continue;
      const sameAnchor = before.comparisonFingerprint === after.comparisonFingerprint;
      const score = sameAnchor ? 1 : jaccard(before.comparisonTokens, after.comparisonTokens);
      const threshold = before.material ? 0.4 : 0.75;
      if (score >= threshold && score > bestScore) {
        bestIndex = newIndex;
        bestScore = score;
        tiedBestIndices.length = 0;
        tiedBestIndices.push(newIndex);
      } else if (score >= threshold && Math.abs(score - bestScore) < Number.EPSILON) {
        tiedBestIndices.push(newIndex);
      }
    }
    if (bestIndex === undefined) continue;
    if (tiedBestIndices.length > 1) {
      oldMatched.add(oldIndex);
      pairByOld.set(oldIndex, planItem(
        "UNCERTAIN",
        "More than one candidate is an equally plausible changed match; no prior attestation may be reused.",
        before,
      ));
      continue;
    }
    const after = current.candidates[bestIndex];
    if (!after) continue;
    oldMatched.add(oldIndex);
    newMatched.add(bestIndex);
    pairByOld.set(oldIndex, planItem(
      before.material || after.material ? "REVERIFY" : "UNCERTAIN",
      before.material || after.material
        ? "The likely corresponding assertion changed its protected surface, context, material value, quotation, remedy, attribution, or proposition fingerprint."
        : "The wording changed, but the baseline cannot prove that this prose-only candidate is immaterial.",
      before,
      after,
    ));
  }

  if (fuzzyComparisonLimitReached) {
    for (let oldIndex = 0; oldIndex < previous.candidates.length; oldIndex += 1) {
      if (oldMatched.has(oldIndex)) continue;
      const before = previous.candidates[oldIndex];
      if (!before) continue;
      oldMatched.add(oldIndex);
      pairByOld.set(oldIndex, planItem(
        "UNCERTAIN",
        "The bounded fuzzy-matching budget was exhausted; no prior attestation may be reused for this candidate.",
        before,
      ));
    }
  }

  const plan: InventoryPlanItem[] = [];
  for (let oldIndex = 0; oldIndex < previous.candidates.length; oldIndex += 1) {
    const paired = pairByOld.get(oldIndex);
    if (paired) {
      plan.push(paired);
      continue;
    }
    const before = previous.candidates[oldIndex];
    if (before) plan.push(planItem(
      "REMOVED",
      before.material
        ? "A previously material candidate is absent and its prior verification must not be carried forward."
        : "A prose-only candidate is absent; its materiality must be reviewed because automatic extraction is incomplete.",
      before,
    ));
  }
  for (let newIndex = 0; newIndex < current.candidates.length; newIndex += 1) {
    if (newMatched.has(newIndex)) continue;
    const after = current.candidates[newIndex];
    if (after) plan.push(planItem(
      "ADDED",
      after.material
        ? "A new material candidate has no reusable prior fingerprint."
        : fuzzyComparisonLimitReached
          ? "A new or unmatched prose candidate requires materiality review after the bounded matcher stopped."
          : "A new prose-only candidate requires materiality review because automatic extraction is incomplete.",
      undefined,
      after,
    ));
  }
  if (plan.length === 0 && previous.subjectSha256 !== current.subjectSha256) {
    plan.push(planItem(
      "UNCERTAIN",
      "The document changed but neither incomplete automatic inventory produced a comparable candidate; materiality must be reviewed rather than inferred from silence.",
    ));
  }

  return {
    previousSubjectSha256: previous.subjectSha256,
    currentSubjectSha256: current.subjectSha256,
    wholeDocumentChanged: previous.subjectSha256 !== current.subjectSha256,
    coverageComplete: false,
    fuzzyComparisons,
    fuzzyComparisonLimitReached,
    plan,
    reasons: [
      "Whole-document hashes are retained as audit identities and do not cause blanket revalidation.",
      "Only exact protected claim fingerprints are reusable; fuzzy or generalized matches route to REVERIFY or UNCERTAIN and never inherit an attestation.",
      fuzzyComparisonLimitReached
        ? `Fuzzy matching stopped at the configured ${maxFuzzyComparisons}-comparison limit; remaining candidates are uncertain.`
        : `Fuzzy matching completed within the configured ${maxFuzzyComparisons}-comparison limit.`,
      "Automatic comparison does not establish complete semantic claim coverage.",
    ],
  };
}
