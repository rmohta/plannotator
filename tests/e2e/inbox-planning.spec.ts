/** Permanent planning flow against a real Inbox with scratch-only storage. */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { PlanningCommand, PlanningState, PlanningCodeTarget } from '../../packages/core/planning-types';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
let context: BrowserContext;
let page: Page;
let url: string;
let session: string;
let checkout: string;
let baseCommit: string;
let headCommit: string;
let patchHash: string;
function git(args: string[]): string { const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' }); expect(result.status, result.stderr).toBe(0); return result.stdout; }
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });
const errors: string[] = [];
async function snapshot(): Promise<PlanningState> { const response = await page.request.get(`${url}/api/inbox/planning`); expect(response.ok()).toBe(true); return (await response.json()).state; }
async function command<T = { id: string }>(input: PlanningCommand): Promise<T> {
  const response = await page.request.post(`${url}/api/inbox/planning/command`, { headers: { Origin: new URL(url).origin }, data: { serverSession: session, command: { ...input, idempotencyKey: crypto.randomUUID() } } });
  expect(response.ok(), await response.text()).toBe(true); return (await response.json()).result as T;
}
const workflow = (name: string) => page.getByRole('navigation', { name: 'Planning workflow' }).getByRole('button', { name, exact: true });
const form = (title: string) => page.locator('form').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary)).toBe(true);
  const root = inboxScratch('plannotator-planning-browser-');
  checkout = join(root, 'payments'); mkdirSync(checkout);
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Planning browser']); git(['config', 'user.email', 'planning@example.test']);
  writeFileSync(join(checkout, 'payment.ts'), 'export const retentionHours = 24;\n'); git(['add', '.']); git(['commit', '-m', 'Initial system']); baseCommit = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(checkout, 'payment.ts'), 'export const retentionHours = 48;\nexport const atomicInsert = true;\n'); git(['add', '.']); git(['commit', '-m', 'Duplicate protection']); headCommit = git(['rev-parse', 'HEAD']).trim();
  patchHash = createHash('sha256').update(git(['diff', '--no-ext-diff', baseCommit, headCommit])).digest('hex');
  const started = spawnSync(binary, ['inbox', '--background'], { env: { ...process.env, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: 'none', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_TAILSCALE: '0' }, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0); url = started.stdout.trim().replace(/\/$/, '');
  context = await browser.newContext(); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  const model = await (await page.request.get(`${url}/api/inbox/planning`)).json(); session = model.serverSession;
});
test.afterAll(async () => { try { await context?.close(); } finally { await removeInboxScratch(); } });

test('approval, pinned context, deviation decision, exact review, and baseline promotion persist across browser sessions', async () => {
  const repository = await command({ type: 'createRepository', title: 'Payments', remote: 'https://example.test/payments.git' });
  await command({ type: 'bindCheckout', repositoryId: repository.id, path: checkout });
  const project = await command({ type: 'createProject', title: 'Reliable order processing', purpose: 'One charge per checkout.', repositoryIds: [repository.id] });
  const deliverable = await command({ type: 'createDeliverable', projectId: project.id, title: 'Prevent duplicate charges', acceptanceCriteria: ['Concurrent retries create one charge.'], requiredTests: ['unit', 'integration', 'e2e'] });
  const document = await command({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: 'Duplicate protection plan', kind: 'implementation-plan', content: '# Duplicate protection\n\nRetain checkout keys for 24 hours.' });
  await page.goto(`${url}/#plans=${project.id}`);
  await expect(page.getByRole('heading', { name: 'Plan Library' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Epic or feature', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Deliverables and documents' }).getByRole('button', { name: 'Prevent duplicate charges', exact: true }).click();
  await page.getByRole('button', { name: /Duplicate protection plan/ }).click();
  await form('Exact approval').getByLabel('Your name').fill('Reviewer');
  await form('Exact approval').getByLabel('Approval notes and conditions').fill('Preserve response contracts.');
  await form('Exact approval').getByRole('button', { name: 'Approve this revision' }).click();
  await expect(page.getByText(/Approved by Reviewer/)).toBeVisible();
  mkdirSync(resolve('.local/proof'), { recursive: true });
  await page.screenshot({ path: resolve('.local/proof/plan-library-approved-document.png'), fullPage: true });
  let state = await snapshot(); const approval = state.approvals[0]; const approvedRevision = approval.revisionId;
  await command({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: approvedRevision, content: '# Draft\n\nUnapproved retention change.' });
  const run = await command({ type: 'startRun', deliverableId: deliverable.id, approvalIds: [approval.id], sessionId: 'browser-agent-session' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await workflow('Agent context').click(); await page.getByRole('button', { name: 'Read the agent’s pinned context' }).click();
  await expect(page.getByText(/Preserve response contracts/).last()).toBeVisible();
  state = await snapshot(); expect(state.runs[0].revisionIds).toContain(approvedRevision);
  const deviation = await command({ type: 'requestDeviation', runId: run.id, repositoryIds: [repository.id], relevantText: '24 hours', proposedChange: 'Retain keys for 48 hours.', reason: 'Upstream retries for 32 hours.', impact: 'Update storage and tests.' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await workflow('Implementation changes').click();
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  await form('Your decision').getByLabel('Your name').fill('Reviewer');
  await form('Your decision').locator('select[name=action]').selectOption('revision-requested');
  await form('Your decision').getByRole('button', { name: 'Record decision' }).click();
  expect((await snapshot()).runs[0].state).toBe('paused');
  await form('Your decision').getByLabel('Your name').fill('Reviewer');
  await form('Your decision').locator('select[name=action]').selectOption('approved');
  await form('Your decision').getByLabel('Conditions or requested revisions').fill('Keep response contract unchanged.');
  await form('Your decision').getByRole('button', { name: 'Record decision' }).click();
  state = await snapshot(); expect(state.deviations.find((d) => d.id === deviation.id)?.state).toBe('approved');
  await workflow('Review changes').click();
  const launch = form('Code review / Guided Review');
  await launch.getByLabel('Base commit (leave empty to review working changes)').fill(baseCommit);
  const opened = page.waitForEvent('popup');
  await launch.getByRole('button', { name: 'Open code review' }).click();
  const review = await opened; review.on('pageerror', (error) => errors.push(error.message));
  await expect(review.locator('summary').filter({ hasText: 'Plan alignment: Prevent duplicate charges' })).toBeVisible();
  if (await review.getByRole('heading', { name: 'Introducing Guided Reviews' }).isVisible()) await review.getByRole('button', { name: 'Got it', exact: true }).click();
  if (await review.getByRole('dialog', { name: 'Choose how plans look' }).isVisible()) await review.getByRole('button', { name: 'Continue', exact: true }).click();
  if (await review.getByRole('dialog', { name: 'Edit code to suggest' }).isVisible()) await review.getByRole('button', { name: 'Done', exact: true }).click();
  if (await review.getByRole('dialog', { name: 'Hover cards' }).isVisible()) await review.getByRole('button', { name: 'Done', exact: true }).click();
  if (await review.getByRole('heading', { name: 'Plannotator TUI and Herdr Annotate' }).isVisible()) await review.getByRole('button', { name: 'Got it', exact: true }).click();
  await review.locator('summary').filter({ hasText: 'Plan alignment: Prevent duplicate charges' }).click();
  await expect(review.getByText(/Preserve response contracts/)).toBeVisible();
  await expect(review.getByText(/Retain keys for 48 hours/)).toBeVisible();
  await review.close();
  const target: PlanningCodeTarget = { repositoryId: repository.id, baseCommit, headCommit, patchHash };
  await command({ type: 'recordAlignment', runId: run.id, target, criteria: [{ criterion: 'Concurrent retries create one charge.', result: 'covered', locations: ['payment.ts:18'], explanation: 'Atomic insert prevents duplicate charges.' }], tests: ['unit', 'integration', 'e2e'].map((level) => ({ level: level as 'unit' | 'integration' | 'e2e', command: `bun test ${level}`, target, result: 'passed', artifact: `artifacts/${level}.log` })) });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await workflow('Review changes').click();
  await form('Exact code signoff').getByLabel('Your name').fill('Reviewer');
  await form('Exact code signoff').getByRole('button', { name: 'Sign off this agreement and target' }).click();
  await expect(page.getByText('Signed off by Reviewer')).toBeVisible();
  state = await snapshot(); const alignment = state.alignments[0];
  const merge = await command({ type: 'recordMerge', alignmentId: alignment.id, repositoryId: repository.id, targetCommit: target.headCommit, source: 'refs/heads/main', mergedAt: new Date().toISOString() });
  const baseline = await command<{ id: string; latestRevisionId: string }>({ type: 'createDocument', projectId: project.id, title: 'Payments baseline', kind: 'service-baseline', serviceId: 'payments', content: '# Payments\n\nAtomic charge insertion; checkout keys retained for 48 hours.' });
  await command({ type: 'proposeBaseline', serviceId: 'payments', documentId: baseline.id, proposalRevisionId: baseline.latestRevisionId, alignmentId: alignment.id, mergeEvidenceId: merge.id });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await workflow('Current system').click();
  await form('Accept current system knowledge').getByLabel('Your name').fill('Reviewer');
  await form('Accept current system knowledge').getByRole('button', { name: 'Accept baseline', exact: true }).click();
  await expect(page.getByText('Accepted by Reviewer')).toBeVisible();
  expect((await snapshot()).baselines.payments).toBe(baseline.latestRevisionId);
  await page.screenshot({ path: resolve('.local/proof/plan-library-current-system.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('button', { name: /Payments baseline/ })).toBeVisible();
  expect((await snapshot()).runs[0].revisionIds).toContain(approvedRevision); expect(errors).toEqual([]);
});

 test('a new target makes earlier signoff stale and concurrent baseline advances refuse obsolete acceptance', async () => {
  let state = await snapshot(); const run = state.runs[0]; const prior = state.alignments[0];
  const document = state.documents.find((d) => d.kind === 'service-baseline')!;
  const previous = state.baselines.payments;
  await command({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: document.latestRevisionId!, content: '# Payments baseline two' });
  state = await snapshot(); const revisionTwo = state.documents.find((d) => d.id === document.id)!.latestRevisionId!;
  const updateOne = await command({ type: 'proposeBaseline', serviceId: 'payments', documentId: document.id, expectedRevisionId: previous, proposalRevisionId: revisionTwo, alignmentId: prior.id, mergeEvidenceId: state.merges[0].id });
  await command({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: revisionTwo, content: '# Payments baseline three' });
  state = await snapshot(); const revisionThree = state.documents.find((d) => d.id === document.id)!.latestRevisionId!;
  const updateTwo = await command({ type: 'proposeBaseline', serviceId: 'payments', documentId: document.id, expectedRevisionId: previous, proposalRevisionId: revisionThree, alignmentId: prior.id, mergeEvidenceId: state.merges[0].id });
  await command({ type: 'acceptBaseline', updateId: updateOne.id, expectedRevisionId: previous, person: 'Reviewer' });
  await workflow('Current system').click(); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const pending = form('Accept current system knowledge'); await pending.getByLabel('Your name').fill('Reviewer');
  await pending.getByRole('button', { name: 'Accept baseline', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  state = await snapshot(); expect(state.baselines.payments).toBe(revisionTwo); expect(state.baselineUpdates.find((u) => u.id === updateTwo.id)?.accepted).toBeUndefined();
  const newTarget = { ...prior.target, headCommit: 'd'.repeat(40), patchHash: 'e'.repeat(64) };
  await command({ type: 'recordAlignment', runId: run.id, target: newTarget, criteria: prior.criteria, tests: prior.tests.map((t) => ({ ...t, target: newTarget })) });
  await page.getByRole('button', { name: 'Prevent duplicate charges', exact: true }).click();
  await workflow('Review changes').click(); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Stale signoff: the code target or agreement changed.')).toBeVisible();
  state = await snapshot(); expect(state.alignments[0].stale).toBe(true);

});

test('approval captures complete direct edits from the shared markdown editor', async () => {
  const state = await snapshot();
  const document = await command({ type: 'createDocument', projectId: state.projects[0].id, deliverableId: state.deliverables[0].id, title: 'Effective text approval', kind: 'implementation-plan', content: '# Effective text\n\nOriginal draft.' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: /Effective text approval/ }).click();
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  const content = page.locator('.pl-document [contenteditable=true]').first();
  await content.click(); await content.press('ControlOrMeta+A');
  await page.keyboard.insertText('Complete effective approval content, including direct edits.');
  await form('Exact approval').getByLabel('Your name').fill('Reviewer');
  await form('Exact approval').getByRole('button', { name: 'Approve effective edited text' }).click();
  await expect(page.getByText(/Approved by Reviewer/)).toBeVisible();
  const after = await snapshot(); const approval = after.approvals.find((a) => a.documentId === document.id)!;
  expect(after.revisions.find((r) => r.id === approval.revisionId)?.content).toContain('Complete effective approval content, including direct edits.');
  expect(after.revisions.filter((r) => r.documentId === document.id)).toHaveLength(2);
});
