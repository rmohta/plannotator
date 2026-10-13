import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { handleInboxPlanningRoute } from './inbox-planning';

test('Plan Library survives restart, refuses origin-free person decisions and stale page writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planning-routes-'));
  try {
    const store = new PlanningStore({ dataDir: dir });
    const url = new URL('http://localhost/api/inbox/planning/command');
    const project = await handleInboxPlanningRoute(new Request(url, { method: 'POST', body: JSON.stringify({ serverSession: 'page', command: { type: 'createProject', title: 'Feature', purpose: 'Durable outcome', repositoryIds: [] } }) }), url, store, 'page');
    expect(project?.status).toBe(200);
    const state = await new PlanningStore({ dataDir: dir }).read();
    expect(state.projects).toHaveLength(1);
    const stale = await handleInboxPlanningRoute(new Request(url, { method: 'POST', body: JSON.stringify({ serverSession: 'old', command: { type: 'createProject' } }) }), url, store, 'page');
    expect(stale?.status).toBe(409);
    const approve = await handleInboxPlanningRoute(new Request(url, { method: 'POST', body: JSON.stringify({ serverSession: 'page', command: { type: 'approveDocument', person: 'Person' } }) }), url, store, 'page');
    expect(approve?.status).toBe(403);
    const snapshotUrl = new URL('http://localhost/api/inbox/planning');
    const snapshot = await handleInboxPlanningRoute(new Request(snapshotUrl), snapshotUrl, store, 'page');
    expect((await snapshot!.json()).state.projects[0].title).toBe('Feature');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
