import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveConfig } from '@plannotator/shared/config';
import { PlanningStore } from '@plannotator/shared/planning/store';
import { handleInboxPlanningRoute } from './inbox-planning';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startInboxServer, type InboxServer } from './inbox';

test('reviewer suggestions use the selected bound checkout and the saved display name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planning-reviewer-'));
  const priorDataDir = process.env.PLANNOTATOR_DATA_DIR;
  try {
    process.env.PLANNOTATOR_DATA_DIR = dir;
    const store = new PlanningStore({ dataDir: dir });
    const repo = await store.execute({ type: 'createRepository', title: 'Service' });
    for (const name of ['First Reviewer', 'Second Reviewer']) {
      const path = join(dir, name);
      execFileSync('git', ['init', '-q', path]);
      execFileSync('git', ['-C', path, 'config', 'user.name', name]);
      await store.execute({ type: 'bindCheckout', repositoryId: repo.id, path });
    }
    const read = async (folder: string) => {
      const url = new URL('http://localhost/api/inbox/planning');
      url.searchParams.set('folder', folder);
      const response = await handleInboxPlanningRoute(new Request(url), url, store, 'page');
      expect(response!.status).toBe(200);
      return (await response!.json()).reviewer;
    };
    expect((await read(join(dir, 'Second Reviewer'))).gitUser).toBe('Second Reviewer');
    expect((await read(join(dir, 'First Reviewer'))).gitUser).toBe('First Reviewer');
    // A browser-supplied folder cannot make the server read an unbound repository.
    expect((await read(dir)).gitUser).toBeNull();
    saveConfig({ displayName: 'Saved Reviewer' });
    expect((await read(join(dir, 'First Reviewer'))).displayName).toBe('Saved Reviewer');
  } finally {
    if (priorDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = priorDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});

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
    const response = await client.callTool({ name: 'read_planning', arguments: { limit: 1 } });
    const block = (response.content as { type: string; text?: string }[]).find(c => c.type === 'text');
    expect(JSON.parse(block!.text!).repositories).toEqual([first]);
    expect(JSON.parse(block!.text!).checkouts).toEqual([checkout]);
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

test('normal Inbox Send settles a deviation and links the recorded Decision to its planning agreement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planning-inbox-send-'));
  let server: InboxServer | undefined;
  try {
    const planning = new PlanningStore({dataDir:dir});
    const project = await planning.execute({type:'createProject',title:'Project',purpose:'Feature',repositoryIds:[]});
    const deliverable = await planning.execute({type:'createDeliverable',projectId:project.id,title:'Outcome',acceptanceCriteria:['Works'],requiredTests:[]});
    const document = await planning.execute({type:'createDocument',projectId:project.id,deliverableId:deliverable.id,title:'Plan',kind:'implementation-plan',content:'# Plan'});
    const approval = await planning.execute({type:'approveDocument',documentId:document.id,expectedRevisionId:document.latestRevisionId,person:'Reviewer'});
    const run = await planning.execute({type:'startRun',deliverableId:deliverable.id,approvalIds:[approval.id],sessionId:'agent-session'});
    await planning.execute({type:'requestDeviation',runId:run.id,repositoryIds:[],relevantText:'24 hours',proposedChange:'48 hours',reason:'Retry window',impact:'Retention test'});
    server = await startInboxServer({dataDir:dir});
    const base = `http://127.0.0.1:${server.port}`;
    const { InboxStore } = await import('@plannotator/shared/inbox/store');
    const inbox = InboxStore.open(dir);
    const message = inbox.thread(inbox.listRows()[0]!.thread_id)!.messages[0]!;
    const q = inbox.questionsOf(message.id)[0]!;
    const post = async (path: string, body: object) => {
      const response = await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({...body,serverSession:server!.serverSession})});
      expect(response.status).toBe(200);
      return response.json();
    };
    await post(`/api/inbox/messages/${message.id}/picks`,{questions:[{key:q.key,revision:q.revision,answer:{v:1,key:q.key,kind:q.kind,prompt:q.prompt,selected:['Approve this deviation'],note:'Preserve contracts.'}}]});
    expect((await planning.context(run.id)).run.state).toBe('paused');
    const sent = await post(`/api/inbox/messages/${message.id}/reply`,{idempotency_key:'approve-deviation',questions:[{key:q.key,revision:q.revision+1}],words:'Add a regression test.'});
    expect(sent.decisions).toHaveLength(1);
    const context = await planning.context(run.id);
    expect(context.run.state).toBe('active');
    expect(context.decisions[0]!.inboxDecisionId).toBe(sent.decisions[0].id);
    expect(context.decisions[0]!.conditions).toContain('Preserve contracts.');
    expect(context.decisions[0]!.conditions).toContain('Add a regression test.');
    const replay = await post(`/api/inbox/messages/${message.id}/reply`,{idempotency_key:'approve-deviation',questions:[{key:q.key,revision:q.revision+1}]});
    expect(replay.replayed).toBe(true);
    expect((await planning.context(run.id)).decisions).toHaveLength(1);
  } finally {server?.stop(); await rm(dir,{recursive:true,force:true});}
});
