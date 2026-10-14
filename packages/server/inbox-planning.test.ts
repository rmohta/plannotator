import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { handleInboxPlanningRoute } from './inbox-planning';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startInboxServer, type InboxServer } from './inbox';

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

// Catch discovery omitting existing IDs or ending before the longest new collection.
test('MCP planning discovery pages repositories and checkouts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planning-discovery-'));
  let server: InboxServer | undefined;
  const client = new Client({ name: 'planning-discovery-test', version: '1.0.0' });
  try {
    const store = new PlanningStore({ dataDir: dir });
    const first = await store.execute({ type: 'createRepository', title: 'First' });
    const second = await store.execute({ type: 'createRepository', title: 'Second' });
    const checkout = await store.execute({ type: 'bindCheckout', repositoryId: first.id, checkoutPath: join(dir, 'first') });
    const otherCheckout = await store.execute({ type: 'bindCheckout', repositoryId: second.id, checkoutPath: join(dir, 'second') });
    const thirdCheckout = await store.execute({ type: 'bindCheckout', repositoryId: second.id, checkoutPath: join(dir, 'third') });
    server = await startInboxServer({ dataDir: dir });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }));
    const read = async (offset: number) => (await client.callTool({
      name: 'read_planning', arguments: { offset, limit: 1 },
    })).structuredContent as Record<string, unknown>;
    const firstPage = await read(0);
    expect(firstPage.repositories).toEqual([first]);
    expect(firstPage.checkouts).toEqual([checkout]);
    expect(firstPage.nextOffset).toBe(1);
    const secondPage = await read(1);
    expect(secondPage.repositories).toEqual([second]);
    expect(secondPage.checkouts).toEqual([otherCheckout]);
    expect(secondPage.nextOffset).toBe(2);
    const lastPage = await read(2);
    expect(lastPage.repositories).toEqual([]);
    expect(lastPage.checkouts).toEqual([thirdCheckout]);
    expect(lastPage.nextOffset).toBeUndefined();
  } finally {
    await client.close();
    server?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
