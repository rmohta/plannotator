import type { PlanningStore } from '@plannotator/shared/planning/store';
import type { InboxStore } from '@plannotator/shared/inbox/store';
import { join } from 'node:path';
import { recordDecisionsForReply } from './inbox-decisions';

const DEVIATION_OPTIONS = {
  'Approve this deviation': 'approved',
  'Request a revised proposal': 'revision-requested',
  'Decline this deviation': 'declined',
} as const;

/** Inbox questions and sent Decisions share the normal reply flow; replay repairs planning settlement after a crash. */
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
    const plan = state.documents.find(doc => doc.kind === 'implementation-plan' && run.approvalIds.some(id => state.approvals.some(a => a.id === id && a.documentId === doc.id)));
    const proposalLabel = request.proposedChange.replace(/\s+/g, ' ').replace(/:::/g, '');
    const input = {
      project_id: folder.id, author: { kind: 'agent' as const, session: run.sessionId, name: 'Planning agent', host: null },
      thread: `Deviation ${request.id}`, idempotency_key: `planning-deviation-question:${request.id}`,
      subject: `Deviation: ${plan?.title ?? deliverable.title}`,
      body: `# Deviation approval required\n\nAffected implementation is paused. Choose an option below, add any conditions or feedback, and press Send. Read the updated pinned context before continuing. Only an approved deviation permits its exact scope; other pending deviations keep affected work paused.\n\n:::question\nAllow this deviation: ${proposalLabel}? (${request.id}, revision ${request.proposalRevision})\nDecision: when answered\n\n- [ ] Approve this deviation\n- [ ] Request a revised proposal\n- [ ] Decline this deviation\n:::\n\nApproved text: ${request.relevantText}\n\nProposed change: ${request.proposedChange}\n\nReason: ${request.reason}\n\nImpact: ${request.impact}`,
    };
    const existing = inbox.listRows().filter(row => row.project.id === folder.id && row.thread_name === input.thread)
      .flatMap(row => inbox.thread(row.thread_id)?.messages ?? []);
    // Keep historical notices immutable. Pending legacy notices gain a normal
    // question in the same thread; settled ones retain their original record.
    const pending = ['pending', 'revision-requested'].includes(request.state);
    const message = existing.find(m => m.idempotency_key === input.idempotency_key)
      ?? (!pending ? existing.find(m => m.idempotency_key === `planning-deviation:${request.id}`) : undefined)
      ?? inbox.sendMessage(input).message;
    const question = inbox.questionsOf(message.id)[0];
    const record = question && inbox.questionRecord(`${message.id}/${question.key}`);
    const reply = record?.sent_reply_id ? inbox.message(record.sent_reply_id) : null;
    if (reply && record) {
      const decisions = recordDecisionsForReply(inbox, reply.id);
      if (decisions.refused.length) throw new Error(decisions.refused[0]!.message);
      // Only an exact, sent choice grants an outcome. Picks, prose, Other and
      // skipped questions keep affected work paused.
      const selected = record.answer?.selected ?? [];
      const action = selected.length === 1 && !record.answer?.other && !record.answer?.skipped
        ? DEVIATION_OPTIONS[selected[0] as keyof typeof DEVIATION_OPTIONS] : undefined;
      if (action && ['pending', 'revision-requested'].includes(request.state)) {
        const decisionId = inbox.questionRecord(record.id)?.decision_id;
        // Without a recorded Decision, the answer cannot authorize a deviation.
        if (!decisionId) continue;
        await planning.execute({
          type: 'decideDeviation', requestId: request.id,
          expectedProposalRevision: request.proposalRevision, action,
          person: record.picked_by?.name || 'Reviewer',
          conditions: reply.body, inboxDecisionId: decisionId,
          idempotencyKey: `inbox-deviation-answer:${reply.id}`,
        });
      }
    }
    // The normal Inbox reply already delivers the person's answer and feedback.
    if (reply) continue;
    const decision = state.decisions.find(record => record.id === request.decisionId);
    if (!decision) continue;
    if (inbox.thread(message.thread_id)?.messages.some(message => message.author.kind === 'person' && message.idempotency_key === `planning-decision:${decision.id}`)) continue;
    // A conversation archive has no authority over this decision. Reopen solely to deliver it.
    if (inbox.thread(message.thread_id)?.resolved_at) inbox.resolveThread(message.id, false);
    inbox.sendReply(message.id, {
      idempotency_key: `planning-decision:${decision.id}`,
      words: `Planning decision ${decision.id} for run ${run.id}: ${decision.action}.\nProposal ${request.id}, exact proposal revision ${decision.proposalRevision}.\nConditions: ${decision.conditions || 'None'}.\nRead the latest pinned context for this run before continuing. Only an approved decision grants its exact scope; other pending deviations keep affected work paused. Call consumeContinuation with runId ${run.id}, decisionId ${decision.id}, sessionId ${run.sessionId}; it grants continuation at most once and only while this run is active. A restarted session must read the durable agreement and reuse that session identity, rather than assume this notification grants permission.`,
    });
  }
}
