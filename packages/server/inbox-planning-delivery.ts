import type { PlanningStore } from '@plannotator/shared/planning/store';
import type { InboxStore } from '@plannotator/shared/inbox/store';
import { join } from 'node:path';

/** Repairable outbox: planning authority commits first, then the Inbox log delivers its exact decision. */
export async function syncPlanningDelivery(planning: PlanningStore, inbox: InboxStore): Promise<void> {
  const state = await planning.read();
  for (const request of state.deviations) {
    const run = state.runs.find(record => record.id === request.runId);
    const deliverable = state.deliverables.find(record => record.id === run?.deliverableId);
    const project = state.projects.find(record => record.id === deliverable?.projectId);
    if (!run || !deliverable || !project) continue;
    const home = state.checkouts.find(record => record.id === run.checkoutId && request.repositoryIds.includes(record.repositoryId));
    const checkout = home ?? state.checkouts.find(record => request.repositoryIds.includes(record.repositoryId));
    const folder = inbox.ensureProject({ root: checkout?.path ?? join(inbox.dir, 'planning', project.id), name: project.title });
    const sent = inbox.sendMessage({
      project_id: folder.id, author: { kind: 'agent', session: run.sessionId, name: 'Planning agent', host: null },
      thread: `Deviation ${request.id}`, idempotency_key: `planning-deviation:${request.id}`,
      subject: `Approval required: ${deliverable.title}`,
      body: `# Deviation approval required\n\nAffected implementation is paused. Open Plans to decide proposal ${request.id} (revision ${request.proposalRevision}). An Inbox answer or resolved conversation grants no planning permission.\n\nApproved text: ${request.relevantText}\n\nProposed change: ${request.proposedChange}\n\nReason: ${request.reason}\n\nImpact: ${request.impact}`,
    });
    const decision = state.decisions.find(record => record.id === request.decisionId);
    if (!decision) continue;
    if (inbox.thread(sent.message.thread_id)?.messages.some(message => message.author.kind === 'person' && message.idempotency_key === `planning-decision:${decision.id}`)) continue;
    // A conversation archive has no authority over this decision. Reopen solely to deliver it.
    if (inbox.thread(sent.message.thread_id)?.resolved_at) inbox.resolveThread(sent.message.id, false);
    inbox.sendReply(sent.message.id, {
      idempotency_key: `planning-decision:${decision.id}`,
      words: `Planning decision ${decision.id} for run ${run.id}: ${decision.action}.\nProposal ${request.id}, exact proposal revision ${decision.proposalRevision}.\nConditions: ${decision.conditions || 'None'}.\nRead the latest pinned context for this run before continuing. Only an approved decision grants its exact scope; other pending deviations keep affected work paused. Call consumeContinuation with runId ${run.id}, decisionId ${decision.id}, sessionId ${run.sessionId}; it grants continuation at most once and only while this run is active. A restarted session must read the durable agreement and reuse that session identity, rather than assume this notification grants permission.`,
    });
  }
}
