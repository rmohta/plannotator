import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { InboxStore } from '@plannotator/shared/inbox/store';
import { syncPlanningDelivery } from './inbox-planning-delivery';

test('deviation outbox repairs restart, delivers to the durable assignment once, and keeps independent deviations paused', async () => {
 const dataDir = await mkdtemp(join(tmpdir(), 'planning-delivery-'));
 try {
  const planning = new PlanningStore({dataDir});
  let inbox = InboxStore.open(dataDir);
  const project = await planning.execute({type:'createProject',title:'Project',purpose:'Feature',repositoryIds:[]});
  const deliverable = await planning.execute({type:'createDeliverable',projectId:project.id,title:'Outcome',acceptanceCriteria:['Works'],requiredTests:['unit']});
  const document = await planning.execute({type:'createDocument',projectId:project.id,deliverableId:deliverable.id,title:'Plan',kind:'implementation-plan',content:'# Plan'});
  const approval = await planning.execute({type:'approveDocument',documentId:document.id,expectedRevisionId:document.latestRevisionId,person:'Reviewer'});
  const run = await planning.execute({type:'startRun',deliverableId:deliverable.id,approvalIds:[approval.id],agentName:'agent-session'});
  const ask = () => planning.execute({type:'requestDeviation',agentName: run.agentName,repositoryIds:[],relevantText:'24 hours',proposedChange:'48 hours',reason:'Retry window',impact:'Retention'});
  const first = await ask();
  // A notice from an older release must gain an answerable question in the
  // same thread, without rewriting the original message.
  const folder = inbox.ensureProject({root:join(inbox.dir,'planning',project.id),name:project.title});
  const legacy = inbox.sendMessage({project_id:folder.id,author:{kind:'agent',session:`planning:${run.id}`,name:'Planning agent',host:null},thread:`Deviation ${first.id}`,idempotency_key:`planning-deviation:${first.id}`,body:'Open Plans to decide this deviation.'});
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.listRows()).toHaveLength(1);
  const messages = inbox.thread(legacy.message.thread_id)!.messages;
  expect(messages).toHaveLength(2);
  expect(inbox.questionsOf(messages[1]!.id)).toHaveLength(1);
  const second = await ask();
  const decision = await planning.execute({type:'decideDeviation',requestId:first.id,expectedProposalRevision:first.proposalRevision,action:'approved',person:'Reviewer'});
  // Crash between authority commit and attention delivery: restart derives the unsent outbox.
  inbox = InboxStore.open(dataDir);
  await syncPlanningDelivery(new PlanningStore({dataDir}),inbox);
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.pendingReplies(`planning:${run.id}`)).toHaveLength(1);
  expect((await planning.context(run.id)).run.state).toBe('paused');
  await expect(planning.execute({type:'consumeContinuation',agentName: run.agentName,decisionId:decision.id})).rejects.toThrow();
  const reply = inbox.pendingReplies(`planning:${run.id}`)[0]!;
  inbox.recordDelivery(reply.id,{host:'codex',session:`planning:${run.id}`});
  inbox = InboxStore.open(dataDir);
  await syncPlanningDelivery(planning,inbox);
  expect(inbox.pendingReplies(`planning:${run.id}`)).toHaveLength(0);
  await planning.execute({type:'decideDeviation',requestId:second.id,expectedProposalRevision:second.proposalRevision,action:'declined',person:'Reviewer'});
  await syncPlanningDelivery(planning,inbox);
  const continuation = await planning.execute({type:'consumeContinuation',agentName: run.agentName,decisionId:decision.id});
  expect(continuation.continued).toBe(true);
  const duplicate = await planning.execute({type:'consumeContinuation',agentName: run.agentName,decisionId:decision.id});
  expect(duplicate.continued).toBe(false);
 } finally {await rm(dataDir,{recursive:true,force:true});}
});

test('a sent Inbox choice records the existing Decision and controls the exact deviation; picks alone do not', async () => {
 const dataDir = await mkdtemp(join(tmpdir(), 'planning-inbox-answer-'));
 try {
  const planning = new PlanningStore({dataDir});
  let inbox = InboxStore.open(dataDir);
  const project = await planning.execute({type:'createProject',title:'Project',purpose:'Feature',repositoryIds:[]});
  const deliverable = await planning.execute({type:'createDeliverable',projectId:project.id,title:'Outcome',acceptanceCriteria:['Works'],requiredTests:[]});
  const document = await planning.execute({type:'createDocument',projectId:project.id,deliverableId:deliverable.id,title:'Plan',kind:'implementation-plan',content:'# Plan'});
  const approval = await planning.execute({type:'approveDocument',documentId:document.id,expectedRevisionId:document.latestRevisionId,person:'Reviewer'});
  const run = await planning.execute({type:'startRun',deliverableId:deliverable.id,approvalIds:[approval.id],agentName:'agent-session'});
  for (const [choice, outcome] of [['Request a revised proposal','revision-requested'], ['Decline this deviation','declined'], ['Approve this deviation','approved']] as const) {
   const request = await planning.execute({type:'requestDeviation',agentName: run.agentName,repositoryIds:[],relevantText:'24 hours',proposedChange:'48 hours',reason:'Retry window',impact:'Retention'});
   await syncPlanningDelivery(planning,inbox);
   const message = inbox.listRows().map(row => inbox.thread(row.thread_id)!.messages[0]!).find(m => m.idempotency_key === `planning-deviation-question:${request.id}`)!;
   const q = inbox.questionsOf(message.id)[0]!;
   expect(q.decision_on_answer).toBe(true);
   expect(q.choices.map(c => c.label)).toContain(choice);
   inbox.savePicks(message.id,[{key:q.key,revision:q.revision,answer:{v:1,key:q.key,kind:q.kind,prompt:q.prompt,selected:[choice],note:'Preserve the API contract.'}}]);
   await syncPlanningDelivery(planning,inbox);
   expect((await planning.context(run.id)).run.state).toBe('paused');
   expect([...inbox.allDecisions()]).toHaveLength(outcome === 'revision-requested' ? 0 : outcome === 'declined' ? 1 : 2);
   const reply = inbox.sendReply(message.id,{idempotency_key:`answer:${request.id}`,questions:[{key:q.key,revision:q.revision+1}],words:'Add a regression test.'});
   // A restart between Send and planning settlement repairs from the sent answer.
   inbox = InboxStore.open(dataDir);
   await syncPlanningDelivery(planning,inbox);
   await syncPlanningDelivery(planning,inbox);
   const state = await planning.read();
   const decision = state.decisions.find(d => d.requestId === request.id)!;
   expect(decision.action).toBe(outcome);
   expect(decision.conditions).toContain('Preserve the API contract.');
   expect(decision.conditions).toContain('Add a regression test.');
   expect(inbox.decision(decision.inboxDecisionId!)?.source.question_id).toBe(`${message.id}/${q.key}`);
   expect(inbox.questionRecord(`${message.id}/${q.key}`)?.decision_id).toBe(decision.inboxDecisionId);
   expect(inbox.pendingReplies(`planning:${run.id}`).filter(m => m.id === reply.reply.id)).toHaveLength(1);
  }
  expect([...inbox.allDecisions()]).toHaveLength(3);
  // The first proposal still needs revision, so a separate approval cannot resume it.
  expect((await planning.context(run.id)).run.state).toBe('paused');
 } finally {await rm(dataDir,{recursive:true,force:true});}
});

test('a completed run delivers one sign-off notice to the person, idempotently', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-complete-'));
  try {
    const planning = new PlanningStore({dataDir});
    const inbox = InboxStore.open(dataDir);
    const repo = await planning.execute({type:'createRepository',title:'Service'});
    const project = await planning.execute({type:'createProject',title:'Project',purpose:'Feature',repositoryIds:[repo.id]});
    const deliverable = await planning.execute({type:'createDeliverable',projectId:project.id,title:'Outcome',acceptanceCriteria:['Works'],requiredTests:[]});
    const document = await planning.execute({type:'createDocument',projectId:project.id,deliverableId:deliverable.id,title:'Plan',kind:'implementation-plan',content:'# Plan'});
    const approval = await planning.execute({type:'approveDocument',documentId:document.id,expectedRevisionId:document.latestRevisionId,person:'Reviewer'});
    const run = await planning.execute({type:'startRun',deliverableId:deliverable.id,approvalIds:[approval.id],agentName:'Bobby'});
    await planning.execute({type:'recordAlignment',agentName:'Bobby',target:{repositoryId:repo.id,baseCommit:'b',headCommit:'h',patchHash:'p'},criteria:[{criterion:'Works',result:'covered',locations:['a:1'],explanation:'Works'}],tests:[]});
    await planning.execute({type:'completeRun',agentName:'Bobby'});
    await syncPlanningDelivery(planning,inbox);
    await syncPlanningDelivery(new PlanningStore({dataDir}),InboxStore.open(dataDir));
    const notice = inbox.listRows().flatMap(row => inbox.thread(row.thread_id)!.messages).filter(m => m.idempotency_key === `planning-run-completed:${run.id}`);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.body).toContain('sign-off is awaited');
    expect(notice[0]!.body).toContain('Bobby');
    // An active run stays silent.
    expect(inbox.listRows().flatMap(row => inbox.thread(row.thread_id)!.messages).some(m => m.idempotency_key?.startsWith('planning-run-completed:') && m.idempotency_key !== `planning-run-completed:${run.id}`)).toBe(false);
  } finally {await rm(dataDir,{recursive:true,force:true});}
});
