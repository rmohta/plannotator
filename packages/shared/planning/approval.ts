import type { Approval } from '@plannotator/core/planning-types';
import { PlanningStore } from './store';
import { getPlannotatorDataDir } from '../data-dir';
export interface PlanningDocumentApproval { documentId: string; expectedRevisionId: string; person: string; dataDir?: string }
/** Keep direct edits as complete immutable content; never reconstruct text from annotation feedback. */
export async function recordPlanningDocumentApproval(identity: PlanningDocumentApproval | undefined, body: Record<string, unknown>, currentContent: string, serverSession: string): Promise<Approval | undefined> {
  if (!identity) return;
  if (body.serverSession !== serverSession) throw new Error('Planning approval requires the current page session.');
  if (body.effectiveContent !== undefined && typeof body.effectiveContent !== 'string') throw new Error('effectiveContent must contain the complete document text.');
  return await new PlanningStore({ dataDir: identity.dataDir ?? getPlannotatorDataDir() }).execute({
    type: 'approveDocument', documentId: identity.documentId, expectedRevisionId: identity.expectedRevisionId,
    person: identity.person, notes: typeof body.feedback === 'string' ? body.feedback : '',
    effectiveContent: typeof body.effectiveContent === 'string' ? body.effectiveContent : currentContent,
    idempotencyKey: `document-review:${serverSession}`,
  });
}
