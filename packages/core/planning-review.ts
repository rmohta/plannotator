import type { PlanningContext, PlanningCodeTarget } from './planning-types';

/** Review prompts use the run's immutable agreement, never a document's latest draft. */
export function planningReviewPrompt(context: PlanningContext, target?: PlanningCodeTarget): string {
  return [
    '## Approved planning agreement',
    `Agent: ${context.run.agentName ?? "Unassigned (legacy)"}; deliverable: ${context.deliverable.title}`,
    `Pinned revision IDs: ${JSON.stringify(context.run.revisionIds)}`,
    ...(context.nextOffset !== undefined ? [`Context is paginated; unread revisions start at offset ${context.nextOffset}. Request the remaining pages before establishing coverage.`] : []),
    ...(target ? [`Code target: ${JSON.stringify(target)}`] : ['Code target evidence is unavailable.']),
    'Compare this exact patch with the approved revisions and accepted deviations below.',
    'For each acceptance criterion report Covered, Missing, Deviation, or Unknown with code locations and an explanation.',
    'A test file is not a successful test result. Missing execution evidence remains Unknown or Missing.',
    'Pending deviations grant no implementation permission. Guide checkboxes are reading progress, not alignment signoff.',
    `Acceptance criteria: ${JSON.stringify(context.deliverable.acceptanceCriteria)}`,
    `Required test levels: ${JSON.stringify(context.deliverable.requiredTests)}`,
    `Approvals and separate notes: ${JSON.stringify(context.approvals)}`,
    `Accepted deviation decisions and conditions: ${JSON.stringify(context.decisions)}`,
    `Exact accepted proposals: ${JSON.stringify(context.acceptedDeviations)}`,
    ...context.documents.map(({ document, revision, approved, truncated }) => [
      `### ${document.title} (${document.kind})`,
      `Document ${document.id}; revision ${revision.id}; hash ${revision.contentHash}; ${approved ? 'approved' : 'pinned baseline'}${truncated ? '; content truncated' : ''}`,
      revision.content,
    ].join('\n')),
  ].join('\n\n');
}
