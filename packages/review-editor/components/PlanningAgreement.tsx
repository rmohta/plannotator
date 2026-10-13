import { useEffect, useState } from 'react';
import type { PlanningContext, PlanningCodeTarget } from '@plannotator/core/planning-types';
import { renderMarkdownProse } from '@plannotator/guide-viewer/renderMarkdownProse';

interface Snapshot { agreement: PlanningContext; target?: PlanningCodeTarget; patchHash: string; stale: boolean }
/** The agreement remains separate from Guided Review's reading progress. */
export function PlanningAgreement({ patch }: { patch: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    void fetch('/api/planning', { signal: controller.signal }).then(async response => {
      if (response.ok) setSnapshot(await response.json());
    }).catch(() => {});
    return () => controller.abort();
  }, [patch]);
  if (!snapshot) return null;
  const { agreement, target, stale } = snapshot;
  return <details className="border-b border-border bg-card px-4 py-2 text-sm">
    <summary className="cursor-pointer font-medium">Plan alignment: {agreement.deliverable.title}{stale ? ' — code target changed or unavailable' : ''}</summary>
    <div className="max-h-96 overflow-auto py-3 space-y-3">
      <p>Run {agreement.run.id}. Patch {snapshot.patchHash}. {target && <>Base {target.baseCommit}; head {target.headCommit}.</>}</p>
      <p>Required tests: {agreement.deliverable.requiredTests.join(', ')}. Execution evidence and criterion results are recorded in the Plan Library.</p>
      <ul>{agreement.deliverable.acceptanceCriteria.map(criterion => <li key={criterion}>{criterion} — Unknown until evidence is recorded.</li>)}</ul>
      {agreement.approvals.map(approval => <p key={approval.id}>Approval {approval.id}: {approval.revisionId}. {approval.person}: {approval.notes}</p>)}
      {agreement.acceptedDeviations.map(request => <p key={request.id}>Accepted change: {request.proposedChange}. Reason: {request.reason}. Impact: {request.impact}.</p>)}
      {agreement.decisions.map(decision => <p key={decision.id}>Accepted deviation {decision.id}: {decision.conditions}</p>)}
      {agreement.documents.map(({ document, revision }) => <details key={revision.id}>
        <summary className="cursor-pointer">{document.title} — {revision.id}</summary>
        <div>{renderMarkdownProse(revision.content)}</div>
      </details>)}
    </div>
  </details>;
}
