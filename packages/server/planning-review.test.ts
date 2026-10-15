import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { startReviewServer as bunReview } from './review';
import { startReviewServer as piReview } from '../../apps/pi-extension/server';
import { buildAgentReviewUserMessage } from './agent-review-message';
const dirs: string[] = [];
const saved = { data: process.env.PLANNOTATOR_DATA_DIR, port: process.env.PLANNOTATOR_PORT, feedback: process.env.PLANNOTATOR_FEEDBACK_HISTORY };
afterEach(() => {
  if (saved.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR; else process.env.PLANNOTATOR_DATA_DIR = saved.data;
  if (saved.port === undefined) delete process.env.PLANNOTATOR_PORT; else process.env.PLANNOTATOR_PORT = saved.port;
  if (saved.feedback === undefined) delete process.env.PLANNOTATOR_FEEDBACK_HISTORY; else process.env.PLANNOTATOR_FEEDBACK_HISTORY=saved.feedback;
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'planning-review-')); dirs.push(dataDir);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_PORT = '0';
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = '1';
  const store = new PlanningStore({ dataDir });
  const repo = await store.execute({ type: 'createRepository', title: 'Service' });
  const project = await store.execute({ type: 'createProject', title: 'Orders', purpose: 'No duplicate charges', repositoryIds: [repo.id] });
  const deliverable = await store.execute({ type: 'createDeliverable', projectId: project.id, title: 'Deduplicate', acceptanceCriteria: ['One charge'], requiredTests: ['e2e'] });
  const document = await store.execute({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: 'Plan', kind: 'implementation-plan', content: 'Keep keys for 24 hours.' });
  const approval = await store.execute({ type: 'approveDocument', documentId: document.id, expectedRevisionId: document.latestRevisionId, person: 'Reviewer', notes: 'Exercise concurrent requests' });
  const run = await store.execute({ type: 'startRun', deliverableId: deliverable.id, approvalIds: [approval.id], agentName: 'session-1' });
  const context = await store.context(run.id);
  const patch = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const target = { repositoryId: repo.id, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), patchHash: createHash('sha256').update(patch).digest('hex') };
  return { context, target, patch, dataDir };
}
for (const [name, start] of [['Bun', bunReview], ['Pi', piReview]] as const) {
  test(`${name} review pins agreement and rejects mismatched patch evidence`, async () => {
    const { context, target, patch, dataDir } = await fixture();
    await expect(start({ rawPatch: patch, gitRef: 'snapshot', diffType: 'static-patch', htmlContent: '<html/>', planningAgreement: context, planningTarget: { ...target, patchHash: 'wrong' } })).rejects.toThrow('opening patch');
    const server = await start({ rawPatch: patch, gitRef: 'snapshot', diffType: 'static-patch', htmlContent: '<html/>', planningAgreement: context, planningTarget: target });
    try {
      context.documents[0]!.revision.content = 'New draft must not replace the agreement';
      const snapshot = await (await fetch(`${server.url}/api/planning`)).json();
      expect(snapshot.agreement.documents[0].revision.content).toBe('Keep keys for 24 hours.');
      expect(snapshot.agreement.approvals[0].notes).toBe('Exercise concurrent requests');
      expect(snapshot.stale).toBe(false);
      expect(snapshot.patchHash).toBe(target.patchHash);
      const pinnedRevisionIds=[...context.run.revisionIds];
      context.run.revisionIds.push('unapproved-later-revision');
      const submitted=await fetch(server.url+'/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({feedback:'Matches the approved agreement',annotations:[]})});
      expect(submitted.status).toBe(200);
      const records:any[]=[];
      for await(const path of new Bun.Glob('feedback/**/index.jsonl').scan({cwd:dataDir,absolute:true})) records.push(...readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line)));
      expect(records[0].target.planning).toEqual({runId:context.run.id,revisionIds:pinnedRevisionIds,decisionIds:[],codeTarget:target});
      const diff = await (await fetch(`${server.url}/api/diff`)).json();
      if (diff.aiEnabled) {
        expect(diff.aiReviewContext).toContain('Keep keys for 24 hours.');
        expect(diff.aiReviewContext).toContain('Exercise concurrent requests');
      }
    } finally { server.stop(); }
  });
}
test('review prompts preserve required evidence and approved content', async () => {
  const { context, target, patch } = await fixture();
  const prompt = buildAgentReviewUserMessage(patch, 'static-patch', { planningAgreement: context, planningTarget: target });
  expect(prompt).toContain('Keep keys for 24 hours.');
  expect(prompt).toContain('Exercise concurrent requests');
  expect(prompt).toContain('e2e');
  expect(prompt).toContain('A test file is not a successful test result');
});
