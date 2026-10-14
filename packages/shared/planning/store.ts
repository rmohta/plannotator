import { latestApprovals } from '@plannotator/core/planning-discovery';
import { mkdir, readFile, writeFile, rename, rm, open, link, unlink, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PlanningState, PlanningCommand, PlanningContext, DocumentRevision, PlanningCodeTarget, ImplementationRun, CheckoutBinding } from '@plannotator/core/planning-types';
export class PlanningError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
const fail = (message: string, code = 'invalid_request', status = 400): never => { throw new PlanningError(code, message, status); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const targetEqual = (a: PlanningCodeTarget, b: PlanningCodeTarget) => a.repositoryId === b.repositoryId && a.baseCommit === b.baseCommit && a.headCommit === b.headCommit && a.patchHash === b.patchHash;
const own = (record: Record<string, any>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const safeKey = (key: string) => { required(key, 'key'); if (['__proto__','constructor','prototype'].includes(key)) fail('Reserved record key'); return key; };
const bounded = (value: unknown, name: string): void => { if (!Array.isArray(value) || value.length > 1000) fail(`${name} must be an array of at most 1000 entries`); };
const empty = (): PlanningState => ({ version: 1, repositories: [], checkouts: [], projects: [], deliverables: [], documents: [], revisions: [], approvals: [], runs: [], deviations: [], decisions: [], alignments: [], merges: [], baselineUpdates: [], baselines: {}, continuations: [], idempotency: {} });
const required = (value: unknown, name: string): string => typeof value === 'string' && value.trim() && value.length <= 1000000 ? value : fail(`${name} must be a nonempty string`);
// Folders compare by real path, so a symlinked binding still matches the worktree root git reports.
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** The checkout a run works in: the one it started in, else the repository's first binding (bound before runs recorded theirs). */
export const checkoutFor = (state: PlanningState, run: ImplementationRun | undefined, repositoryId: string): CheckoutBinding | undefined =>
  state.checkouts.find(x => x.id === run?.checkoutId && x.repositoryId === repositoryId) ?? state.checkouts.find(x => x.repositoryId === repositoryId);
const find = <T extends {id: string}>(items: T[], id: string): T => items.find(item => item.id === id) ?? fail(`Unknown record: ${id}`, 'not_found', 404);
export class PlanningStore {
 private root: string;
 constructor(options: {dataDir: string}) { this.root = join(options.dataDir, 'planning'); }
 async read(): Promise<PlanningState> { try { return JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; } }
 async execute(command: PlanningCommand): Promise<any> {
  if (!command || typeof command !== 'object') fail('A command is required');
  await mkdir(this.root, { recursive: true, mode: 0o700 });
  const lock = join(this.root, 'write.lock');
  const deadline = Date.now() + 10000;
  const ownerFile=join(this.root, `${randomUUID()}.owner`);
  await writeFile(ownerFile, JSON.stringify({pid:process.pid}), {mode:0o600});
  // The owner content exists before the exclusive hard-link claim, including after a crash.
  const reap = async (path: string, depth = 0): Promise<void> => {
   if(depth > 8) return;
   let info: Awaited<ReturnType<typeof stat>>, owner: {pid:number};
   try { info=await stat(path); owner=JSON.parse(await readFile(path,'utf8')); } catch { return; }
   if(!Number.isInteger(owner.pid)||owner.pid<=0) return;
   try { process.kill(owner.pid,0); return; } catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH') return; }
   // Each dead inode has one recovery owner. A replacement lock has a different claim path.
   const recovery=`${path}.${info.ino}.recovery`;
   try { await link(ownerFile,recovery); } catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') await reap(recovery,depth+1); return; }
   try { const current=await stat(path); if(current.ino===info.ino) await unlink(path); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
   finally { await rm(recovery,{force:true}); }
  };
  try {
   for (;;) {
    try { await link(ownerFile,lock); break; }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; await reap(lock); }
    if(Date.now()>deadline) fail('Planning storage is busy','busy',409);
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  } finally { await rm(ownerFile,{force:true}); }

  try {
   const state = await this.read();
   const fingerprint = hash(JSON.stringify(command));
   const key = command.idempotencyKey;
   if (key) { required(key, 'idempotencyKey'); safeKey(key); const prior = own(state.idempotency,key); if (prior) { if (prior.fingerprint !== fingerprint) fail('Idempotency key reused with another command', 'conflict', 409); return prior.result; } }
   const result = this.apply(state, command);
   if (key) state.idempotency[key] = {fingerprint, result};
   const temp = join(this.root, `${randomUUID()}.tmp`);
   const handle = await open(temp, 'wx', 0o600);
   try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
   await rename(temp, join(this.root, 'state.json'));
   const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
   return result;
  } finally { await rm(lock, {recursive: true, force: true}); }
 }
 private apply(s: PlanningState, c: PlanningCommand): any {
  for(const [name,value] of Object.entries(c)) if(Array.isArray(value)) bounded(value,name);
  const id = randomUUID(), createdAt = new Date().toISOString();
  const revision = (documentId: string, content: string, predecessorId?: string): DocumentRevision => { required(content, 'content'); const r = {id: randomUUID(), documentId, content, predecessorId, contentHash: hash(content), createdAt}; s.revisions.push(r); return r; };
  const person = () => required('person' in c ? c.person : undefined, 'person');
  const conflict = (message: string): never => fail(message, 'conflict', 409);
  switch (c.type) {
   case 'createRepository': { const r = {id, title: required(c.title,'title'), remote: c.remote}; s.repositories.push(r); return r; }
   case 'bindCheckout': { find(s.repositories,c.repositoryId); const path = resolve(required(c.path ?? c.checkoutPath,'path')); const collision = s.checkouts.find(x => x.path === path && x.id !== c.checkoutId); if (collision) conflict('Checkout path already bound'); if(c.checkoutId) { const r = find(s.checkouts,c.checkoutId); if(r.repositoryId !== c.repositoryId) conflict('Checkout logical identity cannot change'); r.path = path; return r; } const r = {id,repositoryId:c.repositoryId,path}; s.checkouts.push(r); return r; }
   case 'createProject': { bounded(c.repositoryIds,'repositoryIds'); c.repositoryIds.forEach(x=>find(s.repositories,x)); const r = {id,title:required(c.title,'title'),purpose:required(c.purpose,'purpose'),domain:c.domain,repositoryIds:c.repositoryIds}; s.projects.push(r); return r; }
   case 'createDeliverable': { find(s.projects,c.projectId); if(!Array.isArray(c.acceptanceCriteria) || !Array.isArray(c.requiredTests)) fail('Acceptance criteria and tests are required'); c.acceptanceCriteria.forEach(x=>required(x,'criterion')); c.requiredTests.forEach(x=> { if(!['unit','integration','e2e'].includes(x)) fail('Unknown test level'); }); (c.relatedDeliverableIds??[]).forEach(x=>find(s.deliverables,x)); const r = {id,projectId:c.projectId,title:required(c.title,'title'),acceptanceCriteria:c.acceptanceCriteria,requiredTests:c.requiredTests,relatedDeliverableIds:c.relatedDeliverableIds??[]}; s.deliverables.push(r); return r; }
   case 'createDocument': { find(s.projects,c.projectId); if(!['project-design','hld','lld','integration-design','implementation-plan','service-baseline'].includes(c.kind)) fail('Unknown document kind'); if(c.deliverableId && find(s.deliverables,c.deliverableId).projectId!==c.projectId) fail('Document owner is outside Project'); (c.linkedDocumentIds??[]).forEach(x=>find(s.documents,x)); if(c.kind==='service-baseline') { safeKey(required(c.serviceId,'serviceId')); if(s.documents.some(doc=>doc.kind==='service-baseline'&&doc.serviceId===c.serviceId)) conflict('A service already has a baseline document; link the existing document'); } const r = {id,title:required(c.title,'title'),kind:c.kind,projectId:c.projectId,deliverableId:c.deliverableId,serviceId:c.serviceId,linkedDocumentIds:c.linkedDocumentIds??[],latestRevisionId:revision(id,c.content).id}; s.documents.push(r); return r; }
   case 'reviseDocument': { const d=find(s.documents,c.documentId); if(d.latestRevisionId!==c.expectedRevisionId) conflict('Document revision changed'); d.latestRevisionId=revision(d.id,c.content,d.latestRevisionId).id; if(c.title) d.title=required(c.title,'title'); return d; }
   case 'approveDocument': { person(); const d=find(s.documents,c.documentId); if(d.latestRevisionId!==c.expectedRevisionId) conflict('Approval revision is obsolete'); if(c.effectiveContent!==undefined && c.effectiveContent!==find(s.revisions,c.expectedRevisionId).content) d.latestRevisionId=revision(d.id,c.effectiveContent,d.latestRevisionId).id; const r={id,documentId:d.id,revisionId:d.latestRevisionId!,person:c.person,notes:c.notes??'',createdAt}; s.approvals.push(r); if(d.kind==='service-baseline' && !s.baselines[d.serviceId!]) s.baselines[d.serviceId!]=r.revisionId; return r; }
   case 'startRun': { const d=find(s.deliverables,c.deliverableId); if(!Array.isArray(c.approvalIds)||!c.approvalIds.length) fail('An approved implementation plan is required'); const approvals=c.approvalIds.map(x=>find(s.approvals,x)); const current=latestApprovals(s); for(const a of approvals) if(!current.some(latest=>latest.id===a.id)) conflict('Approval is superseded; select the latest approved revision'); if(new Set(approvals.map(a=>a.documentId)).size!==approvals.length) fail('Choose one approval per document'); if(!approvals.some(a=>{const doc=find(s.documents,a.documentId); return doc.deliverableId===d.id && doc.kind==='implementation-plan';})) fail('No approved implementation plan for this Deliverable'); for(const a of approvals) if(find(s.documents,a.documentId).projectId!==d.projectId) fail('Approval is outside Project'); const parentIds=s.documents.filter(doc=>doc.projectId===d.projectId && !doc.deliverableId && doc.kind!=='service-baseline').map(doc=>doc.id);
   const linkedIds=s.documents.filter(doc=>approvals.some(a=>a.documentId===doc.id)).flatMap(doc=>doc.linkedDocumentIds);
   for(const documentId of new Set([...parentIds,...linkedIds])) { const approved=[...s.approvals].reverse().find(a=>a.documentId===documentId); if(approved && !approvals.some(a=>a.id===approved.id)) approvals.push(approved); }
   const baselines=(c.baselineRevisionIds??s.documents.filter(doc=>doc.projectId===d.projectId && doc.kind==='service-baseline' && doc.serviceId && s.baselines[doc.serviceId]).map(doc=>s.baselines[doc.serviceId!])); baselines.forEach(x=>{ const r=find(s.revisions,x), doc=find(s.documents,r.documentId); if(doc.kind!=='service-baseline' || !s.approvals.some(a=>a.revisionId===x)&&!s.baselineUpdates.some(u=>u.accepted&&u.proposalRevisionId===x)) fail('Baseline revision is not accepted'); }); const project=find(s.projects,d.projectId), here=c.checkoutPath?s.checkouts.find(x=>project.repositoryIds.includes(x.repositoryId)&&real(x.path)===real(c.checkoutPath!)):undefined; const r={id,deliverableId:d.id,checkoutId:here?.id,approvalIds:approvals.map(a=>a.id),revisionIds:[...new Set([...approvals.map(x=>x.revisionId),...baselines])],decisionIds:[],sessionId:required(c.sessionId,'sessionId'),state:'active' as const,createdAt}; s.runs.push(r); return r; }
   case 'requestDeviation': { const run=find(s.runs,c.runId); bounded(c.repositoryIds,'repositoryIds'); s.alignments.filter(a=>a.runId===run.id).forEach(a=>{a.stale=true;}); c.repositoryIds.forEach(x=>find(s.repositories,x)); let proposalRevision=1; if(c.replacesId) { const old=find(s.deviations,c.replacesId); if(old.runId!==run.id || ['approved','declined','withdrawn','replaced'].includes(old.state)) conflict('Cannot replace this proposal'); old.state='replaced'; proposalRevision=old.proposalRevision+1; } const r={id,runId:run.id,proposalRevision,approvedRevisionIds:[...run.revisionIds],repositoryIds:c.repositoryIds,relevantText:required(c.relevantText,'relevantText'),proposedChange:required(c.proposedChange,'proposedChange'),reason:required(c.reason,'reason'),impact:required(c.impact,'impact'),state:'pending' as const}; s.deviations.push(r); run.state='paused'; return r; }
   case 'decideDeviation': { person(); const d=find(s.deviations,c.requestId); if(d.proposalRevision!==c.expectedProposalRevision || !['pending','revision-requested'].includes(d.state)) conflict('Proposal decision is obsolete'); if(!['approved','revision-requested','declined','withdrawn'].includes(c.action)) fail('Unknown deviation decision'); const r={id,requestId:d.id,proposalRevision:d.proposalRevision,action:c.action,person:c.person,conditions:c.conditions??'',createdAt}; s.decisions.push(r); d.state=c.action; d.decisionId=id; const run=find(s.runs,d.runId); if(c.action==='approved') run.decisionIds.push(id); run.state=s.deviations.some(x=>x.runId===run.id&&['pending','revision-requested'].includes(x.state))?'paused':'active'; return r; }
   case 'consumeContinuation': { const run=find(s.runs,c.runId), decision=find(s.decisions,c.decisionId), request=find(s.deviations,decision.requestId); if(run.sessionId!==c.sessionId || request.runId!==run.id || decision.action!=='approved' || run.state!=='active') conflict('Continuation is not authorized'); const token=`${run.id}:${decision.id}`; if(s.continuations.includes(token)) return {continued:false}; s.continuations.push(token); return {continued:true,run}; }
   case 'recordAlignment': { const run=find(s.runs,c.runId); find(s.repositories,c.target.repositoryId); for(const k of ['baseCommit','headCommit','patchHash'] as const) required(c.target[k],k); if(!Array.isArray(c.criteria)||!Array.isArray(c.tests)) fail('Criteria and test evidence must be arrays'); c.criteria.forEach(x=>{ if(!['covered','missing','deviation','unknown'].includes(x.result)) fail('Invalid criterion result'); required(x.criterion,'criterion'); required(x.explanation,'explanation'); if(!Array.isArray(x.locations)) fail('Code locations must be an array'); }); c.tests.forEach(x=>{if(!['unit','integration','e2e'].includes(x.level)||!['passed','failed','unknown'].includes(x.result)) fail('Invalid test evidence'); required(x.command,'command'); required(x.artifact,'artifact'); if(!targetEqual(x.target,c.target)) fail('Test evidence target does not match review');}); s.alignments.filter(x=>x.runId===run.id).forEach(x=>{x.stale=true;}); const r={id,runId:run.id,revisionIds:[...run.revisionIds],decisionIds:[...run.decisionIds],target:c.target,criteria:c.criteria,tests:c.tests,createdAt,stale:false}; s.alignments.push(r); return r; }
   case 'signoffAlignment': { person(); const a=find(s.alignments,c.alignmentId),run=find(s.runs,a.runId),d=find(s.deliverables,run.deliverableId); if(a.stale||!targetEqual(a.target,c.expectedTarget)||run.state==='paused'||!equal(a.decisionIds,run.decisionIds)) conflict('Review agreement or code target changed'); if(!d.acceptanceCriteria.every(criterion=>a.criteria.some(x=>x.criterion===criterion&&x.result==='covered'))||a.criteria.some(x=>x.result!=='covered')) conflict('Acceptance criteria remain unresolved'); if(!d.requiredTests.every(level=>a.tests.some(x=>x.level===level&&x.result==='passed'&&targetEqual(x.target,a.target)))) conflict('Required test evidence is missing'); a.signoff={person:c.person,createdAt}; return a; }
   case 'recordMerge': { const a=find(s.alignments,c.alignmentId); if(!a.signoff||a.stale) conflict('Current review signoff is required'); if(c.repositoryId!==a.target.repositoryId) fail('Merge repository mismatch'); const r={id,alignmentId:a.id,repositoryId:c.repositoryId,targetCommit:required(c.targetCommit,'targetCommit'),source:required(c.source,'source'),mergedAt:required(c.mergedAt,'mergedAt')}; if(!Number.isFinite(Date.parse(c.mergedAt))) fail('Invalid merge timestamp'); s.merges.push(r); return r; }
   case 'proposeBaseline': { const d=find(s.documents,c.documentId),r=find(s.revisions,c.proposalRevisionId),a=find(s.alignments,c.alignmentId),m=find(s.merges,c.mergeEvidenceId); if(d.kind!=='service-baseline'||d.serviceId!==c.serviceId||r.documentId!==d.id) fail('Baseline service/document mismatch'); if(m.alignmentId!==a.id||!a.signoff||a.stale) conflict('Merge evidence and current signoff are required'); if(s.baselines[c.serviceId]!==c.expectedRevisionId) conflict('Baseline pointer changed'); const update={id,serviceId:c.serviceId,documentId:d.id,expectedRevisionId:c.expectedRevisionId,proposalRevisionId:r.id,alignmentId:a.id,mergeEvidenceId:m.id}; s.baselineUpdates.push(update); return update; }
   case 'acceptBaseline': { person(); const u=find(s.baselineUpdates,c.updateId),a=find(s.alignments,u.alignmentId); find(s.merges,u.mergeEvidenceId); if(u.accepted||u.expectedRevisionId!==c.expectedRevisionId||s.baselines[u.serviceId]!==c.expectedRevisionId) conflict('Baseline proposal is obsolete'); if(!a.signoff||a.stale) conflict('Current review signoff is required'); u.accepted={person:c.person,createdAt}; s.baselines[u.serviceId]=u.proposalRevisionId; return u; }
   default: return fail('Unknown planning command');
  }
 }
 async context(runId: string, options: {offset?: number;limit?: number;maxContentChars?: number} = {}): Promise<PlanningContext> {
  const s=await this.read(), run=find(s.runs,runId),deliverable=find(s.deliverables,run.deliverableId),project=find(s.projects,deliverable.projectId);
  for(const value of Object.values(options)) if(value!==undefined && !Number.isFinite(value)) fail('Context limits must be finite numbers');
  const offset=Math.max(0,Math.floor(options.offset??0)),limit=Math.max(1,Math.min(100,Math.floor(options.limit??20))),max=Math.max(0,Math.min(1000000,Math.floor(options.maxContentChars??100000)));
  let remaining=max;
  const ids=run.revisionIds.slice(offset,offset+limit);
  const documents=ids.map(id=>{const r=find(s.revisions,id),document=find(s.documents,r.documentId),content=r.content.slice(0,remaining); remaining-=content.length; return {document,revision:{...r,content},approved:true,truncated:content.length!==r.content.length};});
  return {run,deliverable,project,approvals:run.approvalIds.map(id=>find(s.approvals,id)),decisions:run.decisionIds.map(id=>find(s.decisions,id)),acceptedDeviations:s.deviations.filter(d=>d.runId===run.id&&d.state==='approved'),documents,relatedDeliverables:deliverable.relatedDeliverableIds.slice(0,limit).map(id=>find(s.deliverables,id)),nextOffset:offset+limit<run.revisionIds.length?offset+limit:undefined};
 }
 getRunContext(runId: string, options?: {offset?:number;limit?:number;maxContentChars?:number}) { return this.context(runId,options); }
}
