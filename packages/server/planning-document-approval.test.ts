import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { startPlannotatorServer } from './index';
import { startAnnotateServer } from './annotate';
import { startAnnotateServer as startPiAnnotateServer } from '../../apps/pi-extension/server/serverAnnotate';
import { startPlanReviewServer } from '../../apps/pi-extension/server/serverPlan';


async function planningArchive(dataDir: string) {
  const records: any[] = [];
  for await (const path of new Bun.Glob('feedback/**/index.jsonl').scan({cwd:dataDir,absolute:true})) {
    records.push(...(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  }
  return records;
}

for (const runtime of ['bun', 'pi'] as const) {
  test(`${runtime}: registered plan preserves full direct edits and deny grants no planning approval`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'planning-document-'));
    const priorEnv={...process.env}; process.env.PLANNOTATOR_DATA_DIR=dataDir; process.env.PLANNOTATOR_FEEDBACK_HISTORY='1'; process.env.PLANNOTATOR_ANNOTATE_HISTORY='1';
    const store = new PlanningStore({ dataDir });
    let server: { url: string; stop: () => void } | undefined;
    try {
      const project = await store.execute({ type: 'createProject', title: 'Project', purpose: 'Feature', repositoryIds: [] });
      const document = await store.execute({ type: 'createDocument', projectId: project.id, title: 'Plan', kind: 'implementation-plan', content: '# Original' });
      const identity = { documentId: document.id, expectedRevisionId: document.latestRevisionId, person: 'Reviewer', dataDir };
      const start = async () => runtime === 'bun'
        ? await startPlannotatorServer({ plan: '# Original', htmlContent: '', planningDocument: identity })
        : await startPlanReviewServer({ plan: '# Original', htmlContent: '', planningDocument: identity });
      server = await start();
      const wire = await (await fetch(server.url + '/api/plan')).json();
      expect(wire.planningDocument).toEqual({ documentId: document.id, expectedRevisionId: document.latestRevisionId });
      const session = wire.serverSession;
      const denied = await fetch(server.url + '/api/deny', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: session, feedback: 'Revise this plan' }) });
      expect(denied.status).toBe(200);
      expect((await store.read()).approvals).toHaveLength(0);
      const deniedRecord=(await planningArchive(dataDir)).find(record=>record.decision==='denied');
      expect(deniedRecord.target.planning).toEqual({documentId:document.id,submittedRevisionId:document.latestRevisionId});
      server.stop();
      server = await start();
      const closable = server as unknown as { closeKeepingDraft?: () => unknown; hostControl?: { closeKeepingDraft?: () => unknown } };
      if (closable.closeKeepingDraft) { closable.closeKeepingDraft(); expect((await store.read()).approvals).toHaveLength(0); server.stop(); server = await start(); }

      const nextSession = (await (await fetch(server.url + '/api/plan')).json()).serverSession;
      const approved = await fetch(server.url + '/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: nextSession, effectiveContent: '# Accepted direct edits', feedback: 'Approved with notes', planSave: { enabled: false } }) });
      if (approved.status !== 200) throw new Error(await approved.text());
      const state = await store.read();
      expect(state.approvals).toHaveLength(1);
      expect(state.revisions.find(revision => revision.id === state.approvals[0]!.revisionId)?.content).toBe('# Accepted direct edits');
      const archived=(await planningArchive(dataDir)).find(record=>record.decision==='approved-with-notes');
      expect(archived.target.planning).toEqual({documentId:document.id,submittedRevisionId:document.latestRevisionId,approvedRevisionId:state.approvals[0]!.revisionId,approvalId:state.approvals[0]!.id});
      expect(archived.target.planning.approvedRevisionId).not.toBe(archived.target.planning.submittedRevisionId);
    } finally { server?.stop(); for(const key of ['PLANNOTATOR_DATA_DIR','PLANNOTATOR_FEEDBACK_HISTORY','PLANNOTATOR_ANNOTATE_HISTORY']) { if(priorEnv[key]===undefined) delete process.env[key]; else process.env[key]=priorEnv[key]; } await rm(dataDir, { recursive: true, force: true }); }
  });
}

for (const runtime of ['bun', 'pi'] as const) {
  test(`${runtime}: annotate approval retains exact edited revision`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'planning-annotate-'));
    const priorEnv={...process.env}; process.env.PLANNOTATOR_DATA_DIR=dataDir; process.env.PLANNOTATOR_FEEDBACK_HISTORY='1'; process.env.PLANNOTATOR_ANNOTATE_HISTORY='1';
    const store = new PlanningStore({ dataDir });
    let server: { url: string; stop: () => void } | undefined;
    try {
      const project = await store.execute({ type: 'createProject', title: 'Project', purpose: 'Feature', repositoryIds: [] });
      const document = await store.execute({ type: 'createDocument', projectId: project.id, title: 'Design', kind: 'hld', content: '# Original' });
      const options = { markdown: '# Original', filePath: '/tmp/plan-library-design.md', htmlContent: '', planningDocument: { documentId: document.id, expectedRevisionId: document.latestRevisionId, person: 'Reviewer', dataDir } };
      server = runtime === 'bun' ? await startAnnotateServer(options) : await startPiAnnotateServer(options);
      const wire = await (await fetch(server.url + '/api/plan')).json();
      expect(wire.planningDocument).toEqual({ documentId: document.id, expectedRevisionId: document.latestRevisionId });
      const session = wire.serverSession;
      const result = await fetch(server.url + '/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: session, effectiveContent: '# Edited design' }) });
      expect(result.status).toBe(200);
      const state = await store.read();
      expect(state.revisions.find(revision => revision.id === state.approvals[0]?.revisionId)?.content).toBe('# Edited design');
      const archived=(await planningArchive(dataDir)).find(record=>record.decision==='approved');
      expect(archived.target.planning).toEqual({documentId:document.id,submittedRevisionId:document.latestRevisionId,approvedRevisionId:state.approvals[0]!.revisionId,approvalId:state.approvals[0]!.id});
    } finally { server?.stop(); for(const key of ['PLANNOTATOR_DATA_DIR','PLANNOTATOR_FEEDBACK_HISTORY','PLANNOTATOR_ANNOTATE_HISTORY']) { if(priorEnv[key]===undefined) delete process.env[key]; else process.env[key]=priorEnv[key]; } await rm(dataDir, { recursive: true, force: true }); }
  });
}
