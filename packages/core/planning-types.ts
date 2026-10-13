/** Permanent planning identities are independent from Inbox conversation identities. */
export type PlanningDocumentKind = 'project-design' | 'hld' | 'lld' | 'integration-design' | 'implementation-plan' | 'service-baseline';
export type PlanningTestLevel = 'unit' | 'integration' | 'e2e';
export interface PlanningRepository { id: string; title: string; remote?: string }
export interface CheckoutBinding { id: string; repositoryId: string; path: string }
export interface PlanningProject { id: string; title: string; purpose: string; domain?: string; repositoryIds: string[] }
export interface Deliverable { id: string; projectId: string; title: string; acceptanceCriteria: string[]; requiredTests: PlanningTestLevel[]; relatedDeliverableIds: string[] }
export interface PlanDocument { id: string; title: string; kind: PlanningDocumentKind; projectId: string; deliverableId?: string; serviceId?: string; linkedDocumentIds: string[]; latestRevisionId?: string }
export interface DocumentRevision { id: string; documentId: string; predecessorId?: string; content: string; contentHash: string; createdAt: string }
export interface Approval { id: string; documentId: string; revisionId: string; person: string; notes: string; createdAt: string }
export interface ImplementationRun { id: string; deliverableId: string; approvalIds: string[]; revisionIds: string[]; decisionIds: string[]; sessionId: string; state: 'active' | 'paused'; createdAt: string }
export interface DeviationRequest { id: string; runId: string; proposalRevision: number; approvedRevisionIds: string[]; repositoryIds: string[]; relevantText: string; proposedChange: string; reason: string; impact: string; state: 'pending' | 'revision-requested' | 'approved' | 'declined' | 'withdrawn' | 'replaced'; decisionId?: string }
export interface PlanningDecision { id: string; requestId: string; proposalRevision: number; action: 'approved' | 'revision-requested' | 'declined' | 'withdrawn'; person: string; conditions: string; createdAt: string }
export interface PlanningCodeTarget { repositoryId: string; baseCommit: string; headCommit: string; patchHash: string; branch?: string; prUrl?: string }
export interface CriterionResult { criterion: string; result: 'covered' | 'missing' | 'deviation' | 'unknown'; locations: string[]; explanation: string }
export interface PlanningTestEvidence { level: PlanningTestLevel; command: string; target: PlanningCodeTarget; result: 'passed' | 'failed' | 'unknown'; artifact: string }
export interface PlanAlignment { id: string; runId: string; revisionIds: string[]; decisionIds: string[]; target: PlanningCodeTarget; criteria: CriterionResult[]; tests: PlanningTestEvidence[]; createdAt: string; signoff?: { person: string; createdAt: string }; stale: boolean }
export interface PlanningMergeEvidence { id: string; alignmentId: string; repositoryId: string; targetCommit: string; source: string; mergedAt: string }
export interface BaselineUpdate { id: string; serviceId: string; documentId: string; expectedRevisionId?: string; proposalRevisionId: string; alignmentId: string; mergeEvidenceId: string; accepted?: { person: string; createdAt: string } }
export interface PlanningState { version: 1; repositories: PlanningRepository[]; checkouts: CheckoutBinding[]; projects: PlanningProject[]; deliverables: Deliverable[]; documents: PlanDocument[]; revisions: DocumentRevision[]; approvals: Approval[]; runs: ImplementationRun[]; deviations: DeviationRequest[]; decisions: PlanningDecision[]; alignments: PlanAlignment[]; merges: PlanningMergeEvidence[]; baselineUpdates: BaselineUpdate[]; baselines: Record<string, string>; continuations: string[]; idempotency: Record<string, { fingerprint: string; result: unknown }> }
export interface PlanningContext { run: ImplementationRun; deliverable: Deliverable; project: PlanningProject; approvals: Approval[]; decisions: PlanningDecision[]; acceptedDeviations: DeviationRequest[]; documents: { document: PlanDocument; revision: DocumentRevision; approved: boolean; truncated: boolean }[]; relatedDeliverables: Deliverable[]; nextOffset?: number }
type CommandBase = { idempotencyKey?: string };
export type PlanningCommand = CommandBase & (
 | { type: 'createRepository'; title: string; remote?: string }
 | { type: 'bindCheckout'; repositoryId: string; path: string; checkoutId?: string }
 | { type: 'createProject'; title: string; purpose: string; domain?: string; repositoryIds: string[] }
 | { type: 'createDeliverable'; projectId: string; title: string; acceptanceCriteria: string[]; requiredTests: PlanningTestLevel[]; relatedDeliverableIds?: string[] }
 | { type: 'createDocument'; title: string; kind: PlanningDocumentKind; projectId: string; deliverableId?: string; serviceId?: string; linkedDocumentIds?: string[]; content: string }
 | { type: 'reviseDocument'; documentId: string; expectedRevisionId: string; content: string; title?: string }
 | { type: 'approveDocument'; documentId: string; expectedRevisionId: string; person: string; notes?: string; effectiveContent?: string }
 | { type: 'startRun'; deliverableId: string; approvalIds: string[]; baselineRevisionIds?: string[]; sessionId: string }
 | { type: 'requestDeviation'; runId: string; repositoryIds: string[]; relevantText: string; proposedChange: string; reason: string; impact: string; replacesId?: string }
 | { type: 'decideDeviation'; requestId: string; expectedProposalRevision: number; action: PlanningDecision['action']; person: string; conditions?: string }
 | { type: 'consumeContinuation'; runId: string; decisionId: string; sessionId: string }
 | { type: 'recordAlignment'; runId: string; target: PlanningCodeTarget; criteria: CriterionResult[]; tests: PlanningTestEvidence[] }
 | { type: 'signoffAlignment'; alignmentId: string; expectedTarget: PlanningCodeTarget; person: string }
 | { type: 'recordMerge'; alignmentId: string; repositoryId: string; targetCommit: string; source: string; mergedAt: string }
 | { type: 'proposeBaseline'; serviceId: string; documentId: string; expectedRevisionId?: string; proposalRevisionId: string; alignmentId: string; mergeEvidenceId: string }
 | { type: 'acceptBaseline'; updateId: string; expectedRevisionId?: string; person: string }
);
