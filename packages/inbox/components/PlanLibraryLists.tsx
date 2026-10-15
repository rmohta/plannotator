/** The Plan Library's two lists, drawn as the Inbox list is: a band with a count, then flat rows. */
import { latestApprovals } from '@plannotator/core/planning-discovery';
import type { PlanDocument, PlanningDocumentKind, PlanningState, Deliverable } from '@plannotator/core/planning-types';
import { shortTime } from '../format';

export type PlanStatus = 'Approved' | 'Needs approval' | 'Draft';

const KIND_WORDS: Record<PlanningDocumentKind, string> = { 'implementation-plan': 'Implementation plan', hld: 'HLD', lld: 'LLD', 'integration-design': 'Integration design', 'project-design': 'Project design', 'service-baseline': 'Service baseline' };

/** A plan's status: Approved when its latest approval is of its latest revision; Needs approval when an earlier revision was approved but the latest is not; Draft when it was never approved. */
export function planStatus(state: PlanningState, plan: PlanDocument): PlanStatus {
  const approval = latestApprovals(state).find((a) => a.documentId === plan.id);
  return !approval ? 'Draft' : approval.revisionId === plan.latestRevisionId ? 'Approved' : 'Needs approval';
}

/** A Deliverable's plans, without service baselines (those are current-system knowledge, not plans for the Deliverable). */
export const deliverablePlans = (state: PlanningState, deliverableId: string) => state.documents.filter((d) => d.deliverableId === deliverableId && d.kind !== 'service-baseline');

const revisionDate = (state: PlanningState, plan: PlanDocument) => state.revisions.find((r) => r.id === plan.latestRevisionId)?.createdAt ?? '';

/**
 * A Deliverable "Needs approval" when it has no approved plan, or when its latest-revised plan
 * (the plan whose latest revision has the newest createdAt) is not Approved; otherwise "Approved".
 * The date is that plan's latest revision createdAt (empty without plans).
 */
export function deliverableStatus(state: PlanningState, deliverable: Deliverable): { approved: boolean; date: string; plans: number } {
  const plans = deliverablePlans(state, deliverable.id);
  const latest = plans.reduce<PlanDocument | undefined>((best, p) => (!best || revisionDate(state, p) > revisionDate(state, best) ? p : best), undefined);
  const anyApproved = plans.some((p) => planStatus(state, p) !== 'Draft');
  return { approved: !!latest && anyApproved && planStatus(state, latest) === 'Approved', date: latest ? revisionDate(state, latest) : '', plans: plans.length };
}

const chipClass = (status: PlanStatus) => (status === 'Approved' ? 'ib-chip ib-chip-on' : status === 'Needs approval' ? 'ib-chip ib-chip-warn' : 'ib-chip');
const Empty = ({ children }: { children: string }) => <p className="ib-dnone">{children}</p>;
const Band = ({ title, count }: { title: string; count: number }) => <div className="ib-band"><span>{title}</span><span className="ib-n">{count}</span></div>;
const When = ({ iso }: { iso: string }) => <span className="ib-t">{iso ? shortTime(iso) : ''}</span>;

/** Deliverables in one flat list, grouped by status: Needs approval, then Approved. Empty groups are not drawn. */
export function DeliverableList({ state, deliverables, onOpen }: { state: PlanningState; deliverables: Deliverable[]; onOpen: (id: string) => void }) {
  if (deliverables.length === 0) return <Empty>No deliverables yet. Ask your agent to create one; it will appear in this list.</Empty>;
  const rows = deliverables.map((d) => ({ d, ...deliverableStatus(state, d) }));
  return <>{[{ title: 'Needs approval', items: rows.filter((r) => !r.approved) }, { title: 'Approved', items: rows.filter((r) => r.approved) }].filter((g) => g.items.length > 0).map((g) => <div className="ib-group" role="group" aria-label={g.title} key={g.title} data-deliverable-group={g.title}>
    <Band title={g.title} count={g.items.length} />
    {g.items.map(({ d, approved, date, plans }) => <button type="button" key={d.id} className={`ib-row pl-row pl-drow${approved ? '' : ' ib-u'}`} data-deliverable-id={d.id} onClick={() => onOpen(d.id)}>
      <span className="pl-title">{d.title}</span><span className="pl-meta"><span className="ib-p">{plans === 1 ? '1 plan' : `${plans} plans`}</span><span><span className={approved ? 'ib-chip ib-chip-on' : 'ib-chip ib-chip-warn'}>{approved ? 'Approved' : 'Needs approval'}</span></span></span><When iso={date} />
    </button>)}
  </div>)}</>;
}

/** Plans grouped by Deliverable (in Deliverable order), then a final Project-wide band. `only` limits it to one Deliverable and the Project-wide plans. */
export function PlanList({ state, projectId, only, revisionLabel, onOpen }: { state: PlanningState; projectId: string; only?: string; revisionLabel: (revisionId: string) => string; onOpen: (plan: PlanDocument) => void }) {
  const plans = state.documents.filter((d) => d.projectId === projectId && d.kind !== 'service-baseline');
  const groups = [...state.deliverables.filter((d) => d.projectId === projectId && (!only || d.id === only)).map((d) => ({ key: d.id, title: d.title, items: plans.filter((p) => p.deliverableId === d.id) })), { key: 'project-wide', title: 'Project-wide', items: plans.filter((p) => !p.deliverableId || !state.deliverables.some((d) => d.id === p.deliverableId)) }].filter((g) => g.items.length > 0);
  if (groups.length === 0) return <Empty>No plans yet. Ask your agent to create one; it will appear in this list.</Empty>;
  return <>{groups.map((g) => <div className="ib-group" role="group" aria-label={g.title} key={g.key} data-plan-group={g.key}>
    <Band title={g.title} count={g.items.length} />
    {g.items.map((p) => { const status = planStatus(state, p); return <button type="button" key={p.id} className={`ib-row pl-row pl-prow${status === 'Approved' ? '' : ' ib-u'}`} data-plan-id={p.id} onClick={() => onOpen(p)}>
      <span className="pl-title">{p.title}</span><span className="pl-meta"><span><span className="ib-chip">{KIND_WORDS[p.kind]}</span></span><span className="ib-p">{p.latestRevisionId ? revisionLabel(p.latestRevisionId) : ''}</span><span><span className={chipClass(status)}>{status}</span></span></span><When iso={revisionDate(state, p)} />
    </button>; })}
  </div>)}</>;
}
