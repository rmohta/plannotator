import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { InboxStore } from '@plannotator/shared/inbox/store';
import { syncPlanningDelivery } from './inbox-planning-delivery';

test('deviation outbox repairs restart, wakes exact session once, and keeps independent deviations paused', async () => {
 const dataDir = await mkdtemp(join(tmpdir(), 'planning-delivery-'));
 try {
  const planning = new PlanningStore({dataDir});
  let inbox = InboxStore.open(dataDir);
  const project = await planning.execute({type:'createProject',title:'Project',purpose:'Feature',repositoryIds:[]});
  const deliverable = await planning.execute({type:'createDeliverable',projectId:project.id,title:'Outcome',acceptanceCriteria:['Works'],requiredTests:['unit']});
  const document = await planning.execute({type:'createDocument',projectId:project.id,deliverableId:deliverable.id,title:'Plan',kind:'implementation-plan',content:'# Plan'});
  const approval = await planning.execute({type:'approveDocument',documentId:document.id,expectedRevisionId:document.latestRevisionId,person:'Reviewer'});
  const run = await planning.execute({type:'startRun',deliverableId:deliverable.id,approvalIds:[approval.id],sessionId:'agent-session'});
  const ask = () => planning.execute({type:'requestDeviation',runId:run.id,repositoryIds:[],relevantText:'24 hours',proposedChange:'48 hours',reason:'Retry window',impact:'Retention'});
  const first = await ask();
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.listRows()).toHaveLength(1);
  const second = await ask();
  const decision = await planning.execute({type:'decideDeviation',requestId:first.id,expectedProposalRevision:first.proposalRevision,action:'approved',person:'Reviewer'});
  // Crash between authority commit and attention delivery: restart derives the unsent outbox.
  inbox = InboxStore.open(dataDir);
  await syncPlanningDelivery(new PlanningStore({dataDir}),inbox);
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.pendingReplies('agent-session')).toHaveLength(1);
  expect((await planning.context(run.id)).run.state).toBe('paused');
  await expect(planning.execute({type:'consumeContinuation',runId:run.id,decisionId:decision.id,sessionId:'agent-session'})).rejects.toThrow();
  const reply = inbox.pendingReplies('agent-session')[0]!;
  inbox.recordDelivery(reply.id,{host:'codex',session:'agent-session'});
  inbox = InboxStore.open(dataDir);
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.pendingReplies('agent-session')).toHaveLength(0);
  await planning.execute({type:'decideDeviation',requestId:second.id,expectedProposalRevision:second.proposalRevision,action:'declined',person:'Reviewer'});
  const continuation = await planning.execute({type:'consumeContinuation',runId:run.id,decisionId:decision.id,sessionId:'agent-session'});
  expect(continuation.continued).toBe(true);
  const duplicate = await planning.execute({type:'consumeContinuation',runId:run.id,decisionId:decision.id,sessionId:'agent-session'});
  expect(duplicate.continued).toBe(false);
 } finally {await rm(dataDir,{recursive:true,force:true});}
});
