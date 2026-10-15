/**
 * The Plan Library page (components/PlanLibrary.tsx): one left panel only (the
 * Inbox sidebar, not drawn here), a breadcrumb header, the Deliverables and
 * Plans pills, and the Inbox's grouped flat rows. `inboxApi.planning` is read
 * through the recording fetch below.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanningState } from '@plannotator/core/planning-types';
import type { ProjectFolder } from './api';

const hasDom = typeof document !== 'undefined';
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { PlanLibrary } = (hasDom ? await import('./components/PlanLibrary') : {}) as typeof import('./components/PlanLibrary');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  document.body.innerHTML = '';
});

const FOLDER: ProjectFolder = { id: 'p1', key: 'payments-abc', name: 'payments', root: '/work/payments', created_at: '2026-10-01T00:00:00Z', threads: 0, unread: 0 };

function state(): PlanningState {
  const rev = (id: string, documentId: string, createdAt: string, predecessorId?: string) => ({ id, documentId, predecessorId, content: `# ${documentId}\n\nBody ${id}.`, contentHash: `h-${id}`, createdAt });
  return {
    version: 1,
    repositories: [{ id: 'r1', title: 'Payments' }],
    checkouts: [{ id: 'c1', repositoryId: 'r1', path: '/work/payments' }],
    projects: [{ id: 'proj', title: 'Reliable order processing', purpose: 'One charge per checkout.', repositoryIds: ['r1'] }],
    deliverables: [
      { id: 'dA', projectId: 'proj', title: 'Prevent duplicate charges', acceptanceCriteria: ['One charge.'], requiredTests: ['unit'], relatedDeliverableIds: [] },
      { id: 'dB', projectId: 'proj', title: 'Refund flow', acceptanceCriteria: ['Refunds settle.'], requiredTests: [], relatedDeliverableIds: [] },
    ],
    documents: [
      { id: 'a1', title: 'Duplicate protection plan', kind: 'implementation-plan', projectId: 'proj', deliverableId: 'dA', linkedDocumentIds: [], latestRevisionId: 'ra1' },
      { id: 'b1', title: 'Refund LLD', kind: 'lld', projectId: 'proj', deliverableId: 'dB', linkedDocumentIds: [], latestRevisionId: 'rb1' },
      { id: 'b2', title: 'Refund implementation', kind: 'implementation-plan', projectId: 'proj', deliverableId: 'dB', linkedDocumentIds: [], latestRevisionId: 'rb2' },
      { id: 'w1', title: 'Platform HLD', kind: 'hld', projectId: 'proj', linkedDocumentIds: [], latestRevisionId: 'rw1' },
      { id: 's1', title: 'Payments baseline', kind: 'service-baseline', projectId: 'proj', serviceId: 'payments', linkedDocumentIds: [], latestRevisionId: 'rs1' },
    ],
    revisions: [rev('ra1', 'a1', '2026-10-02T10:00:00Z'), rev('rb1', 'b1', '2026-10-03T10:00:00Z'), rev('rb2', 'b2', '2026-10-04T10:00:00Z'), rev('rw1', 'w1', '2026-10-05T10:00:00Z'), rev('rs1', 's1', '2026-10-05T11:00:00Z')],
    approvals: [{ id: 'ap1', documentId: 'a1', revisionId: 'ra1', person: 'Reviewer', notes: '', createdAt: '2026-10-02T11:00:00Z' }],
    runs: [], deviations: [], decisions: [], alignments: [], merges: [], baselineUpdates: [], baselines: {}, continuations: [], idempotency: {},
  };
}

async function mount(planning: PlanningState = state()) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ serverSession: 's', state: planning }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<SidebarProvider><PlanLibrary projects={[FOLDER]} folder={FOLDER} home={null} phone={false} onFolder={() => {}} /></SidebarProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const click = (el: Element | null | undefined) => { act(() => { (el as HTMLElement).click(); }); };
const q = (sel: string) => host!.querySelector(sel);
const qa = (sel: string) => [...host!.querySelectorAll(sel)];
const crumbs = () => q('h1.pl-crumbs')!.textContent;
const bands = () => qa('.ib-band').map((b) => b.textContent);
const pill = (name: string) => qa('[role=tab]').find((t) => t.textContent!.startsWith(name))!;

test('one panel only: no Projects or Deliverables-and-documents column, a breadcrumb header and a muted purpose line', async () => {
  if (!hasDom) return;
  await mount();
  expect(q('[aria-label="Planning projects"]')).toBeNull();
  expect(q('[aria-label="Deliverables and documents"]')).toBeNull();
  expect(q('nav.pl-navigation')).toBeNull();
  expect(q('.pl-layout')).toBeNull();
  expect(crumbs()).toBe('Reliable order processing›Deliverables');
  expect(q('.ib-dsub')!.textContent).toBe('One charge per checkout.');
  expect(qa('[role=tab]').map((t) => t.textContent)).toEqual(['Deliverables2', 'Plans4']);
  expect(pill('Deliverables').getAttribute('aria-selected')).toBe('true');
});

test('Deliverables pill: groups Needs approval then Approved, with status chips', async () => {
  if (!hasDom) return;
  await mount();
  expect(bands()).toEqual(['Needs approval1', 'Approved1']);
  const refund = q('[data-deliverable-id=dB]')!;
  expect(refund.textContent).toContain('Refund flow');
  expect(refund.textContent).toContain('2 plans');
  expect(refund.querySelector('.ib-chip-warn')!.textContent).toBe('Needs approval');
  const prevent = q('[data-deliverable-id=dA]')!;
  expect(prevent.querySelector('.ib-chip-on')!.textContent).toBe('Approved');
  expect(prevent.textContent).toContain('1 plan');
  expect(prevent.querySelector('.ib-t')!.textContent).not.toBe('');
});

test('Plans pill: grouped by deliverable with a final Project-wide band; baselines are not listed; keys move between pills', async () => {
  if (!hasDom) return;
  await mount();
  click(pill('Plans'));
  expect(crumbs()).toBe('Reliable order processing›Plans');
  expect(bands()).toEqual(['Prevent duplicate charges1', 'Refund flow2', 'Project-wide1']);
  expect(q('[data-plan-id=s1]')).toBeNull();
  const row = q('[data-plan-id=b1]')!;
  expect(row.querySelector('.ib-chip')!.textContent).toBe('LLD');
  expect(row.textContent).toContain('Revision 1 · Draft');
  expect(q('[data-plan-id=a1] .ib-chip-on')!.textContent).toBe('Approved');
  expect(qa('[data-plan-id=w1] .ib-chip').map((c) => c.textContent)).toEqual(['HLD', 'Draft']);
  act(() => { q('[role=tablist]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
  expect(pill('Deliverables').getAttribute('aria-selected')).toBe('true');
});

test('opening a plan shows Plan & approve with the deliverable selected and an extended breadcrumb', async () => {
  if (!hasDom) return;
  await mount();
  click(pill('Plans'));
  click(q('[data-plan-id=b2]'));
  expect(crumbs()).toBe('Reliable order processing›Plans›Refund implementation');
  expect(qa('[aria-label="Planning workflow"] button').find((b) => b.getAttribute('aria-pressed') === 'true')!.textContent).toBe('Plan & approve');
  expect(q('.pl-document-scope')!.textContent).toContain('Refund flow');
  expect(host!.textContent).toContain('Exact approval');
  click(qa('button.pl-crumb').find((b) => b.textContent === 'Plans'));
  expect(bands()).toEqual(['Prevent duplicate charges1', 'Refund flow2', 'Project-wide1']);
});

test('opening a deliverable extends the breadcrumb; its plans are listed on Plan & approve', async () => {
  if (!hasDom) return;
  await mount();
  click(q('[data-deliverable-id=dB]'));
  expect(crumbs()).toBe('Reliable order processing›Deliverables›Refund flow');
  expect(host!.textContent).toContain('Acceptance criteria');
  click(qa('[aria-label="Planning workflow"] button').find((b) => b.textContent === 'Plan & approve'));
  expect(bands()).toEqual(['Refund flow2', 'Project-wide1']);
  click(q('[data-plan-id=w1]'));
  expect(crumbs()).toBe('Reliable order processing›Deliverables›Refund flow›Platform HLD');
  click(qa('button.pl-crumb').find((b) => b.textContent === 'Refund flow'));
  expect(crumbs()).toBe('Reliable order processing›Deliverables›Refund flow');
  click(qa('button.pl-crumb').find((b) => b.textContent === 'Deliverables'));
  expect(bands()).toEqual(['Needs approval1', 'Approved1']);
});

test('the service baseline stays reachable from Current system', async () => {
  if (!hasDom) return;
  await mount();
  click(q('[data-deliverable-id=dA]'));
  click(qa('[aria-label="Planning workflow"] button').find((b) => b.textContent === 'Current system'));
  click(qa('.pl-actions button').find((b) => b.textContent === 'Payments baseline'));
  expect(crumbs()).toBe('Reliable order processing›Plans›Payments baseline');
});

test('no visible text or label says Document', async () => {
  if (!hasDom) return;
  await mount();
  const visible = () => [host!.textContent ?? '', ...qa('[aria-label]').map((e) => e.getAttribute('aria-label')!), ...qa('button').map((b) => b.getAttribute('title') ?? '')].join('\n').replaceAll('linkedDocumentIds', '');
  expect(visible()).not.toMatch(/document/i);
  click(pill('Plans'));
  click(q('[data-plan-id=b2]'));
  expect(visible()).not.toMatch(/document/i);
  for (const name of ['Build', 'Review changes', 'Current system']) {
    click(qa('[aria-label="Planning workflow"] button').find((b) => b.textContent === name));
    expect(visible()).not.toMatch(/document/i);
  }
});

test('a folder with two planning Projects switches between them from the Project crumb', async () => {
  if (!hasDom) return;
  const two = state();
  two.projects.push({ id: 'proj2', title: 'Ledger rewrite', purpose: 'A new ledger.', repositoryIds: ['r1'] });
  await mount(two);
  const trigger = q('h1.pl-crumbs [data-project-picker-trigger]')!;
  expect(trigger.textContent).toContain('Reliable order processing');
  click(trigger);
  click(q('[data-project-option=proj2]'));
  expect(crumbs()).toBe('Ledger rewrite›Deliverables');
  expect(q('.ib-dsub')!.textContent).toBe('A new ledger.');
  expect(q('.ib-dnone')!.textContent).toContain('No deliverables yet');
});

// Build belongs to a plan, and another plan's approval cannot unlock it.
test('Build is absent on deliverables and stops on a plan without approval', async () => {
  if (!hasDom) return;
  const planning = state();
  // A sibling plan's approval must not authorize the selected draft.
  planning.documents[0]!.deliverableId = 'dB';
  await mount(planning);
  click(q('[data-deliverable-id=dB]'));
  expect(qa('[aria-label="Planning workflow"] button').some(b => b.textContent === 'Build')).toBe(false);
  click(qa('[aria-label="Planning workflow"] button').find(b => b.textContent === 'Plan & approve'));
  click(q('[data-plan-id=b2]'));
  click(qa('[aria-label="Planning workflow"] button').find(b => b.textContent === 'Build'));
  expect(q('[aria-label="Build prompt"]')).toBeNull();
  expect(host!.textContent).toContain('no approved revision');
  expect(host!.textContent).not.toContain('startRun');
  expect(host!.querySelector('input[type="checkbox"]')).toBeNull();
});

test('Build prompt and deviations belong only to the opened plan', async () => {
  if (!hasDom) return;
  const planning = state();
  planning.documents.push({ ...planning.documents[0]!, id:'a2', title:'Another plan', latestRevisionId:'ra2' });
  planning.revisions.push({ ...planning.revisions[0]!, id:'ra2', documentId:'a2' });
  planning.approvals.push({ ...planning.approvals[0]!, id:'ap2', documentId:'a2', revisionId:'ra2' });
  planning.runs.push(...[0,1].map((i) => ({id:`run${i}`,deliverableId:'dA',approvalIds:[`ap${i+1}`],revisionIds:[`ra${i+1}`],decisionIds:[],sessionId:'session',state:'paused' as const,createdAt:'2026-10-15T00:00:00Z'})));
  planning.deviations.push(...['Keep the original API','Change the other plan'].map((proposedChange,i) => ({id:`dev${i}`,runId:`run${i}`,proposalRevision:1,approvedRevisionIds:[],repositoryIds:[],relevantText:'Original',proposedChange,reason:'Reason',impact:'Tests',state:'pending' as const})));
  await mount(planning);
  click(pill('Plans'));
  click(q('[data-plan-id=a1]'));
  click(qa('[aria-label="Planning workflow"] button').find(b => b.textContent === 'Build'));
  const prompt = q('[aria-label="Build prompt"]')!.textContent!;
  expect(prompt).toContain('ap1');
  expect(prompt).toContain('ra1');
  expect(prompt).not.toContain('ap2');
  expect(prompt).not.toContain('ra2');
  expect(q('[aria-label="Deviations"]')!.textContent).toContain('Keep the original API');
  expect(q('[aria-label="Deviations"]')!.textContent).not.toContain('Change the other plan');
  expect(host!.querySelector('input[name="sessionId"], input[name="approvals"]')).toBeNull();
});
