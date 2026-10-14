import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { startReviewServer } from "./review";
import { getVcsContext } from "./vcs";
const git = promisify(execFile);
/** The permanent Plan Library shares one store across the window and agent transports. */
import type { PlanningCommand } from '@plannotator/core/planning-types';
import { checkoutFor, type PlanningStore } from '@plannotator/shared/planning/store';

export const PLANNING_PERSON_COMMANDS = new Set(['approveDocument', 'decideDeviation', 'signoffAlignment', 'acceptBaseline', 'recordMerge']);
export const PLANNING_AGENT_COMMANDS = new Set(['createRepository', 'bindCheckout', 'createProject', 'createDeliverable', 'createDocument', 'reviseDocument', 'startRun', 'requestDeviation', 'consumeContinuation', 'recordAlignment', 'proposeBaseline']);
const commands = new Set([...PLANNING_AGENT_COMMANDS, ...PLANNING_PERSON_COMMANDS, 'recordMerge']);
export function planningCommand(value: unknown): PlanningCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !commands.has((value as { type: string }).type)) {
    throw Object.assign(new Error('Unknown planning command.'), { code: 'validation_error' });
  }
  return value as PlanningCommand;
}
export function planningError(error: unknown): Response {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'validation_error';
  const explicitStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const status = explicitStatus ?? (/not_found/.test(code) ? 404 : /conflict|stale|pending|approval|merge|signoff|paused|required/.test(code) ? 409 : 400);
  return Response.json({ code, error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function handleInboxPlanningRoute(req: Request, url: URL, store: PlanningStore, serverSession: string, reviewHtmlContent?: string, syncDelivery?: () => Promise<void>): Promise<Response | null> {
  const prefix = '/api/inbox/planning';
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return null;
  try {
    if (req.method === 'POST' && !isSameOriginOrNoOrigin(req.headers.get('origin'), req.headers.get('host') ?? url.host, req.headers.get('sec-fetch-site'))) return Response.json({ code: 'cross_origin' }, { status: 403 });
    if (req.method === 'GET') {
      if (url.pathname === prefix) return Response.json({ serverSession, state: await planningSnapshot(store) });
      const context = url.pathname.match(/^\/api\/inbox\/planning\/context\/([^/]+)$/);
      if (context) return Response.json(await store.context(decodeURIComponent(context[1]!), {
        offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 20),
        maxContentChars: Number(url.searchParams.get('maxContentChars') ?? 50000),
      }));
      const revision = url.pathname.match(/^\/api\/inbox\/planning\/revisions\/([^/]+)$/);
      const document = url.pathname.match(/^\/api\/inbox\/planning\/documents\/([^/]+)$/);
      if (revision || document) {
        const state = await store.read();
        const id = decodeURIComponent((revision ?? document)![1]!);
        const result = revision ? state.revisions.find(record => record.id === id) : state.documents.find(record => record.id === id);
        if (!result) return Response.json({ code: 'not_found', error: 'Planning record not found.' }, { status: 404 });
        return Response.json(revision ? result : { document: result, revisions: state.revisions.filter(record => record.documentId === id) });
      }
    }
    if (req.method === 'POST' && url.pathname === prefix + '/review') {
      const body = await req.json() as { serverSession?: string; runId: string; repositoryId: string; baseCommit?: string };
      if (body.serverSession !== serverSession) return Response.json({ code: 'server_session_mismatch' }, { status: 409 });
      if (!reviewHtmlContent) return Response.json({ code: 'review_unavailable', error: 'This Inbox build has no review application.' }, { status: 409 });
      const state = await store.read();
      const agreement = await store.context(body.runId, { maxContentChars: 100000 });
      if (!agreement.project.repositoryIds.includes(body.repositoryId)) throw new Error('Repository does not belong to this Project.');
      const checkout = checkoutFor(state, agreement.run, body.repositoryId);
      if (!checkout) throw new Error('Bind a local checkout before opening code review.');
      const runGit = async (args: string[]) => (await git('git', args, { cwd: checkout.path, maxBuffer: 25 * 1024 * 1024 })).stdout.trimEnd();
      const baseCommit = await runGit(['rev-parse', '--verify', body.baseCommit ? `${body.baseCommit}^{commit}` : 'HEAD^{commit}']);
      const headCommit = await runGit(['rev-parse', 'HEAD']);
      const rawPatch = (await git('git', ['diff', '--no-ext-diff', baseCommit], { cwd: checkout.path, maxBuffer: 25 * 1024 * 1024 })).stdout;
      const target = { repositoryId: body.repositoryId, baseCommit, headCommit, patchHash: createHash('sha256').update(rawPatch).digest('hex') };
      const review = await startReviewServer({ rawPatch, gitRef: baseCommit, htmlContent: reviewHtmlContent, planningAgreement: agreement, planningTarget: target,
        gitContext: await getVcsContext(checkout.path), diffType: 'static-patch', initialBase: baseCommit, openStatePinned: true });
      return Response.json({ url: review.url, target });
    }
    if (req.method === 'POST' && url.pathname === prefix + '/command') {
      const body = await req.json() as { serverSession?: string; command?: unknown };
      if (body.serverSession !== serverSession) return Response.json({ code: 'server_session_mismatch', error: 'Refresh the Plans page before writing.' }, { status: 409 });
      const command = planningCommand(body.command);
      // An agent's origin-free HTTP call cannot masquerade as a person decision.
      if (PLANNING_PERSON_COMMANDS.has(command.type) && req.headers.get('origin') === null && req.headers.get('sec-fetch-site') !== 'same-origin') {
        return Response.json({ code: 'person_decision_required', error: 'Approve this request in the Plans window.' }, { status: 403 });
      }
      if (command.type === 'recordMerge') {
        const state = await store.read();
        const alignment = state.alignments.find(record => record.id === command.alignmentId);
        const checkout = checkoutFor(state, state.runs.find(record => record.id === alignment?.runId), command.repositoryId);
        if (!alignment || !checkout) throw new Error('Merge evidence requires a bound repository and reviewed alignment.');
        // Local evidence must name a target branch ref, not an arbitrary source label.
        if (!/^refs\/(heads|remotes)\/[A-Za-z0-9_./-]+$/.test(command.source)) throw new Error('Merge source must be the actual target branch ref.');
        const runGit = async (args: string[]) => (await git('git', args, { cwd: checkout.path })).stdout.trim();
        const targetCommit = await runGit(['rev-parse', '--verify', `${command.source}^{commit}`]);
        if (targetCommit !== command.targetCommit) throw new Error('The target branch does not contain the claimed resulting commit at its tip.');
        const patch = (await git('git', ['diff', '--no-ext-diff', alignment.target.baseCommit, alignment.target.headCommit], { cwd: checkout.path, maxBuffer: 25 * 1024 * 1024 })).stdout;
        if (createHash('sha256').update(patch).digest('hex') !== alignment.target.patchHash) throw new Error('The reviewed patch is not committed; review the final committed target before recording merge evidence.');
        try { await runGit(['merge-base', '--is-ancestor', alignment.target.headCommit, targetCommit]); }
        catch {
          // Squash/rebase can change commit identity; exact resulting patch proves equivalence.
          const deliveredPatch = (await git('git', ['diff', '--no-ext-diff', alignment.target.baseCommit, targetCommit], { cwd: checkout.path, maxBuffer: 25 * 1024 * 1024 })).stdout;
          if (createHash('sha256').update(deliveredPatch).digest('hex') !== alignment.target.patchHash) throw new Error('Squash/rebase merge evidence is unavailable: the actual target patch differs from the reviewed patch.');
        }
      }
      const result = await store.execute(command);
      await syncDelivery?.();
      return Response.json({ result, state: await planningSnapshot(store) });
    }
    return Response.json({ code: 'not_found', error: 'Planning route not found.' }, { status: 404 });
  } catch (error) { return planningError(error); }
}

async function planningSnapshot(store: PlanningStore) {
  const { idempotency, continuations, ...state } = await store.read();
  return state;
}
