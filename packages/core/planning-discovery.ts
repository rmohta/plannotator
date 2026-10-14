/** Read-only revision identity shared by the Plans UI, CLI and MCP. */
import type { PlanningState } from './planning-types';

export function revisionNumber(state: PlanningState, revisionId: string): number {
  const revision = state.revisions.find(r => r.id === revisionId);
  return revision ? state.revisions.filter(r => r.documentId === revision.documentId).findIndex(r => r.id === revisionId) + 1 : 0;
}

/** Superseded approvals remain stored for history and existing pinned runs. */
export function latestApprovals(state: PlanningState) {
  const latest = new Map<string, PlanningState['approvals'][number]>();
  for (const approval of state.approvals) latest.set(approval.documentId, approval);
  return [...latest.values()];
}

export function planningDocuments(state: PlanningState) {
  const approvals = latestApprovals(state);
  return state.documents.map(document => ({
    ...document,
    latestRevisionNumber: document.latestRevisionId ? revisionNumber(state, document.latestRevisionId) : undefined,
    approvalState: state.approvals.some(a => a.revisionId === document.latestRevisionId) ? 'approved' : 'draft',
    latestApproval: (() => {
      const approval = approvals.find(a => a.documentId === document.id);
      return approval ? { ...approval, revisionNumber: revisionNumber(state, approval.revisionId) } : undefined;
    })(),
  }));
}

export const PLANNING_PAGED_KINDS = ['repositories', 'checkouts', 'projects', 'deliverables', 'documents', 'approvals', 'runs', 'deviations', 'decisions'] as const;

export function planningDiscovery(state: PlanningState, offset = 0, limit = 20) {
  const collections = { ...state, documents: planningDocuments(state), approvals: latestApprovals(state).map(a => ({ ...a, revisionNumber: revisionNumber(state, a.revisionId) })) };
  return {
    ...Object.fromEntries(PLANNING_PAGED_KINDS.map(kind => [kind, collections[kind].slice(offset, offset + limit)])),
    baselines: state.baselines,
    nextOffset: offset + limit < Math.max(...PLANNING_PAGED_KINDS.map(kind => collections[kind].length)) ? offset + limit : undefined,
  } as Record<typeof PLANNING_PAGED_KINDS[number], unknown[]> & { baselines: Record<string, string>; nextOffset?: number };
}
