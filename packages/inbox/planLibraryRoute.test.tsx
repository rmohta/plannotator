/**
 * The Plans entry in the sidebar opens the Plan Library at `#plans=`.
 * hashOf once returned `plans=` without its `#`, so the click wrote the path
 * `/plans=`, which the window never reads: the Inbox list stayed on screen.
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PlanningStore } from '../shared/planning/store';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** What this computer prefers, as the stubbed `matchMedia` answers it. */
let osLight = false;
let reducedMotion = false;
/** While set, the window's settings read waits for it (a page whose first read has not answered yet). */
let settingsGate: Promise<void> | null = null;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-plans-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  port = (JSON.parse(line.trim()) as { port: number }).port;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  osLight = false;
  reducedMotion = false;
  settingsGate = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path === '/api/inbox/settings' && method === 'GET' && settingsGate) await settingsGate;
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query.includes('prefers-color-scheme: light') ? osLight : query.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}


test('the Plans entry puts the route in the hash and marks Plans as the current page', async () => {
  if (!hasDom) return;
  const view = await renderApp('');
  const plans = Array.from(view.querySelectorAll('button.ib-nav')).find((b) => b.textContent?.trim() === 'Plans') as HTMLButtonElement | undefined;
  expect(plans).toBeDefined();
  await act(async () => {
    plans!.click();
  });
  await settle();
  expect(window.location.hash).toBe('#plans=');
  expect(window.location.pathname).toBe('/');
  const current = Array.from(view.querySelectorAll('button.ib-nav')).find((b) => b.getAttribute('aria-current') === 'page');
  expect(current?.textContent?.trim()).toBe('Plans');
});

test('the Plans page has no creation forms: projects, repositories, deliverables and documents come from the agent', async () => {
  if (!hasDom) return;
  const view = await renderApp('#plans=');
  const words = view.textContent ?? '';
  for (const gone of ['New project', 'Repositories and checkouts', 'New deliverable', 'New document', 'Create document', 'Add deliverable']) expect(words).not.toContain(gone);
  expect(view.querySelector('section[aria-label="Plans"], section[aria-label="Plan Library"]')).not.toBeNull();
});

// The two screens must identify the same agreement, never offer two revisions to a run.
test('Plans defaults to the latest approved revision, archives old revisions and preselects one agreement', async () => {
  if (!hasDom) return;
  const store = new PlanningStore({ dataDir: join(dir!, 'data') });
  const repo = await store.execute({ type: 'createRepository', title: 'Billing' });
  await store.execute({ type: 'bindCheckout', repositoryId: repo.id, checkoutPath: join(dir!, 'projects', 'billing-0') });
  const project = await store.execute({ type: 'createProject', title: 'Approval workflow', purpose: 'Exact agreement', repositoryIds: [repo.id] });
  const deliverable = await store.execute({ type: 'createDeliverable', projectId: project.id, title: 'Cache outcome', acceptanceCriteria: ['Correct'], requiredTests: ['unit'] });
  const doc = await store.execute({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: 'Cache plan', kind: 'implementation-plan', content: '# Old agreement' });
  const first = await store.execute({ type: 'approveDocument', documentId: doc.id, expectedRevisionId: doc.latestRevisionId, person: 'Person' });
  const revised = await store.execute({ type: 'reviseDocument', documentId: doc.id, expectedRevisionId: first.revisionId, content: '# Current agreement' });
  const approval = await store.execute({ type: 'approveDocument', documentId: doc.id, expectedRevisionId: revised.latestRevisionId, person: 'Person' });
  await store.execute({ type: 'reviseDocument', documentId: doc.id, expectedRevisionId: approval.revisionId, content: '# Pending draft' });
  const view = await renderApp('#plans=');
  const click = async (label: string) => {
    const button = [...view.querySelectorAll('button')].find(b => b.textContent?.startsWith(label));
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    await settle();
  };
  await click('Cache plan');
  const content = view.querySelector('.pl-content')!;
  expect(content.textContent).toContain('Revision 2 · Approved · Latest approved');
  expect(content.querySelector('.pl-document')?.textContent).toContain('Current agreement');
  expect(content.querySelector('.pl-document')?.textContent).not.toContain('Pending draft');
  const history = [...content.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Revision history and IDs')!;
  expect(history.textContent).toContain('Revision 1 · Approved · Archived');
  expect(history.textContent).toContain(approval.revisionId);
  await click('Agent context');
  const inputs = [...view.querySelectorAll<HTMLInputElement>('input[name="approvals"]')];
  expect(inputs).toHaveLength(1);
  expect(inputs[0].value).toBe(approval.id);
  expect(inputs[0].checked).toBe(true);
  expect(inputs[0].closest('label')?.textContent).toContain('Revision 2 · Approved · Latest approved');
});
