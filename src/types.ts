export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AuthorityTier =
  | "primary"
  | "official_guidance"
  | "secondary"
  | "user_provided"
  | "unknown";

export interface SourceRecord {
  sourceId: string;
  title: string;
  sourceType: string;
  authorityTier: AuthorityTier;
  sha256?: string;
  uri?: string;
  issuer?: string;
  version?: string;
  retrievedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  jurisdictions?: string[];
  domains?: string[];
}

export interface EvidenceChunk {
  chunkId: string;
  sourceId: string;
  text: string;
  sha256?: string;
  locator?: string;
  structuredFacts?: Record<string, JsonValue>;
}

export interface EvidenceSnapshot {
  schemaVersion: "0.1.0";
  snapshotId: string;
  createdAt: string;
  domain: string;
  sources: SourceRecord[];
  chunks: EvidenceChunk[];
}

export interface CitationRef {
  sourceId: string;
  chunkId: string;
}

export interface ExactQuoteProof {
  kind: "exact_quote";
  quote: string;
  normalization?: "exact" | "unicode" | "whitespace";
}

export interface StructuredFactProof {
  kind: "structured_fact";
  field: string;
  expected: JsonValue;
}

export interface DerivedOperandBinding {
  operandIndex: number;
  sourceId: string;
  chunkId: string;
  field: string;
}

export interface DerivedProof {
  kind: "derived";
  operation: "add" | "subtract" | "multiply" | "divide" | "date_add_days";
  operands: JsonValue[];
  expected: JsonValue;
  bindings: DerivedOperandBinding[];
}

export interface SemanticProof {
  kind: "semantic";
}

export type ClaimProof = ExactQuoteProof | StructuredFactProof | DerivedProof | SemanticProof;

export interface AtomicClaim {
  claimId: string;
  text: string;
  material: boolean;
  risk: "low" | "medium" | "high";
  selfContained?: boolean;
  citations: CitationRef[];
  proof: ClaimProof;
  jurisdiction?: string;
  asOf?: string;
  requiredAuthority?: AuthorityTier[];
  draftLocator?: string;
}

export interface CoverageAttestation {
  complete: boolean;
  method: "manual_inventory" | "extractor" | "hybrid";
  subjectSha256: string;
  reviewer?: string;
  notes?: string;
}

export interface VerificationSubject {
  subjectId: string;
  mediaType: string;
  sha256: string;
  path?: string;
}

export interface ActionBinding {
  argPath: string;
  sourceId: string;
  chunkId: string;
  field: string;
}

export interface ActionProposal {
  actionId: string;
  type: string;
  args: Record<string, JsonValue>;
  bindings: ActionBinding[];
  idempotencyKey?: string;
}

export interface AllowedActionPolicy {
  requiredArgs: string[];
  allowedArgs?: string[];
  requireBindings?: string[];
  requireIdempotencyKey?: boolean;
  requireConfirmation?: boolean;
}

export interface VerificationPolicy {
  policyId: string;
  riskTier: "low" | "medium" | "high";
  requireCompleteCoverage: boolean;
  requireRetrievedCitationClosure: boolean;
  maxSourceAgeDays?: number;
  trustedSemanticCheckers?: string[];
  allowClaimScopedAttestations?: boolean;
  allowNormalizedClaimReuse?: boolean;
  allowedActions?: Record<string, AllowedActionPolicy>;
}

export interface SemanticAttestation {
  claimId: string;
  checkerName: string;
  checkerVersion: string;
  checkerKind: "human" | "model" | "hybrid";
  bindingScope?: "subject" | "claim";
  verdict: Exclude<ClaimVerdict, "UNCHECKED">;
  score: number;
  reasons: string[];
  checkedAt: string;
  subjectSha256: string;
  snapshotId: string;
  claimTextHash: string;
  claimFingerprint?: string;
  claimBindingHash: string;
  evidenceHash: string;
}

export interface VerifyRequest {
  schemaVersion: "0.1.0";
  requestId: string;
  requestedAt: string;
  domain: string;
  question?: string;
  subject: VerificationSubject;
  coverage: CoverageAttestation;
  evidence: EvidenceSnapshot;
  retrievedChunkIds: string[];
  claims: AtomicClaim[];
  semanticAttestations?: SemanticAttestation[];
  actions?: ActionProposal[];
  policy: VerificationPolicy;
}

export type ClaimVerdict = "SUPPORTED" | "PARTIAL" | "CONTRADICTED" | "NOT_FOUND" | "UNCHECKED";
export type AssuranceClass = "EXACT" | "STRUCTURED" | "DERIVED" | "SEMANTIC" | "NONE";
export type Decision = "PASS" | "REWRITE" | "ASK" | "ABSTAIN" | "HUMAN_REVIEW";
export type ActionDecision = "ALLOW" | "DENY" | "CONFIRM" | "REVIEW";

export interface Finding {
  code: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR" | "INFO";
  message: string;
  claimId?: string;
  actionId?: string;
  sourceId?: string;
  chunkId?: string;
}

export interface ClaimResult {
  claimId: string;
  claimText: string;
  assurance: AssuranceClass;
  verdict: ClaimVerdict;
  validCitations: CitationRef[];
  checkerScores: Record<string, number>;
  findings: Finding[];
}

export interface ActionResult {
  actionId: string;
  type: string;
  decision: ActionDecision;
  findings: Finding[];
}

export interface VerificationResult {
  schemaVersion: "0.1.0";
  engineVersion: string;
  requestId: string;
  inputHash: string;
  decision: Decision;
  coverage: "COMPLETE" | "INCOMPLETE" | "MISMATCH";
  claims: ClaimResult[];
  actions: ActionResult[];
  findings: Finding[];
}

export interface SemanticCheckInput {
  claim: AtomicClaim;
  chunks: EvidenceChunk[];
  sources: SourceRecord[];
  domain: string;
}

export interface SemanticCheckOutput {
  verdict: Exclude<ClaimVerdict, "UNCHECKED">;
  score: number;
  reasons: string[];
}

export interface SemanticChecker {
  name: string;
  version: string;
  verify(input: SemanticCheckInput): Promise<SemanticCheckOutput>;
}

export interface AuditTrace {
  schemaVersion: "0.1.0";
  traceId: string;
  createdAt: string;
  engineVersion: string;
  inputHash: string;
  resultHash: string;
  request: VerifyRequest;
  result: VerificationResult;
}
