/** The permanent Plan Library. Conversation routing never owns these records. */
import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { PlanningCommand, PlanningContext, PlanningState, PlanningCodeTarget, CriterionResult, PlanningTestEvidence } from '@plannotator/core/planning-types';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { MarkdownDiff } from '@plannotator/ui/components/MarkdownDiff';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { inboxApi, setPageSession, type ProjectFolder } from '../api';
import { SidebarTrigger } from '../shell/sidebar';
import { DecisionsProjectPicker } from './DecisionsProjectPicker';
import './planLibrary.css';

const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const lines = (value: string) => value.split('\n').map((v) => v.trim()).filter(Boolean);
function Field({ label, name, value, required = true, multiline = false }: { label: string; name: string; value?: string; required?: boolean; multiline?: boolean }) {
  return <label>{label}{multiline ? <textarea name={name} defaultValue={value} required={required} rows={3} /> : <input name={name} defaultValue={value} required={required} />}</label>;
}
/** A checkbox list for choosing several records; its children are the `<option value>` elements to choose from. */
function Choices({ label, name, defaultValue, children }: { label: string; name: string; defaultValue?: string[]; children?: ReactNode }) {
  const options = Children.toArray(children) as ReactElement<{ value: string; children?: ReactNode }>[];
  return <fieldset className="pl-choices"><legend>{label}</legend>{options.length === 0 ? <small>None yet</small> : options.map((option) => <label key={option.key ?? option.props.value} className="pl-choice"><input type="checkbox" name={name} value={option.props.value} defaultChecked={defaultValue?.includes(option.props.value)} /><span>{option.props.children}</span></label>)}</fieldset>;
}
function DocumentView({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdownToBlocks(content), [content]);
  return <Viewer blocks={blocks} markdown={content} annotations={[]} onAddAnnotation={() => {}} onSelectAnnotation={() => {}} selectedAnnotationId={null} mode="selection" taterMode={false} readOnly disableCodePathValidation allowImages={false} maxWidth={null} stickyActions={false} />;
}

/** The Plans page of one sidebar project: the planning Projects whose repositories are checked out in its folder. */
export function PlanLibrary({ projects, folder, home, phone, onFolder }: { projects: readonly ProjectFolder[]; folder: ProjectFolder; home: string | null; phone: boolean; onFolder: (id: string) => void }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [state, setState] = useState<PlanningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [deliverableId, setDeliverableId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [edit, setEdit] = useState(false);
  const [context, setContext] = useState<PlanningContext | null>(null);
  const [linkedDocumentId, setLinkedDocumentId] = useState<string | null>(null);
  const editor = useRef<MarkdownEditorHandle | null>(null);
  const refresh = useCallback(async () => {
    try { const model = await inboxApi.planning(); setPageSession(model.serverSession); setState(model.state); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setProjectId(null); setDeliverableId(null); setDocumentId(null); setRevisionId(null); setContext(null); setTab('overview'); }, [folder.id]);
  async function execute(command: PlanningCommand): Promise<unknown> {
    setBusy(true); setError(null); setNotice('');
    try {
      const response = await inboxApi.planningCommand({ ...command, idempotencyKey: crypto.randomUUID() });
      setState(response.state);
      if (command.type === 'approveDocument') { setRevisionId(null); setEdit(false); }
      setNotice('Saved to the Plan Library.'); return response.result;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; }
    finally { setBusy(false); }
  }
  function form(title: string, label: string, build: (data: FormData) => PlanningCommand, children: ReactNode, disabled = false) {
    return <form className="pl-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void execute(build(data)); }}><h3>{title}</h3><fieldset disabled={busy || disabled}>{children}<button type="submit">{label}</button></fieldset></form>;
  }
  if (!state) return <section className="pl-library"><h1>Plans</h1>{error ? <><p role="alert">{error}</p><button onClick={() => void refresh()}>Retry</button></> : <p>Loading plans…</p>}</section>;
  const folderProjects = state.projects.filter((p) => p.repositoryIds.some((id) => state.checkouts.some((c) => c.repositoryId === id && c.path === folder.root)));
  const project = folderProjects.find((p) => p.id === projectId) ?? folderProjects[0];
  const deliverable = state.deliverables.find((d) => d.id === deliverableId && d.projectId === project?.id);
  const documents = state.documents.filter((d) => d.projectId === project?.id && (!deliverable || d.deliverableId === deliverable.id || !d.deliverableId));
  const document = documents.find((d) => d.id === documentId);
  const revision = state.revisions.find((r) => r.id === (revisionId ?? document?.latestRevisionId));
  const previous = state.revisions.find((r) => r.id === revision?.predecessorId);
  const approval = [...state.approvals].reverse().find((a) => a.documentId === document?.id);
  const run = [...state.runs].reverse().find((r) => r.deliverableId === deliverable?.id);
  const deviations = state.deviations.filter((d) => d.runId === run?.id);
  const alignments = state.alignments.filter((a) => a.runId === run?.id);
  const latestAlignment = alignments.at(-1);
  const projectDeliverables = state.deliverables.filter((d) => d.projectId === project?.id);
  const targetFrom = (data: FormData): PlanningCodeTarget => ({ repositoryId: text(data, 'repositoryId'), baseCommit: text(data, 'baseCommit'), headCommit: text(data, 'headCommit'), patchHash: text(data, 'patchHash'), prUrl: text(data, 'prUrl') || undefined });
  const person = <Field label="Your name" name="person" />;
  const targetFields = <><label>Repository<select name="repositoryId" required>{state.repositories.filter((r) => project?.repositoryIds.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label><Field label="Base commit" name="baseCommit" /><Field label="Head commit" name="headCommit" /><Field label="Patch hash" name="patchHash" /><Field label="Pull request URL" name="prUrl" required={false} /></>;
  return <section className="pl-library" aria-label="Plan Library">
    <header className="pl-heading"><div className="ib-dh"><SidebarTrigger /><h1>Plans</h1><DecisionsProjectPicker projects={projects} current={folder} counts={null} home={home} phone={phone} onPick={onFolder} /></div><button onClick={() => void refresh()} disabled={busy}>Refresh</button></header>
    {error && <p role="alert" className="pl-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className={`pl-layout${folderProjects.length > 1 ? '' : ' pl-single'}`}>{folderProjects.length > 1 && <nav className="pl-navigation" aria-label="Planning projects">
      <h2>Projects</h2>{folderProjects.map((p) => <button key={p.id} aria-current={project?.id === p.id ? 'page' : undefined} onClick={() => setProjectId(p.id)}>{p.title}<small>{p.domain ?? p.purpose}</small></button>)}
    </nav>}<nav className="pl-navigation" aria-label="Deliverables and documents">
      <h2>{project?.title ?? 'No plans yet'}</h2><button onClick={() => { setDeliverableId(null); setDocumentId(null); setTab('overview'); }}>Project overview</button>
      <h3>Deliverables</h3>{projectDeliverables.map((d) => <button key={d.id} aria-pressed={d.id === deliverable?.id} onClick={() => { setDeliverableId(d.id); setDocumentId(null); setRevisionId(null); setContext(null); setTab('overview'); }}>{d.title}</button>)}
      <h3>Documents</h3>{documents.map((d) => <button key={d.id} aria-pressed={document?.id === d.id} onClick={() => { setDocumentId(d.id); setRevisionId(null); setEdit(false); setTab('document'); }}>{d.title}<small>{d.kind} · {state.approvals.some((a) => a.revisionId === d.latestRevisionId) ? 'approved' : 'draft'}</small></button>)}
    </nav><div className="pl-content">
      {project && <><div className="pl-tabs" role="navigation" aria-label="Planning workflow">{['overview', 'document', 'context', 'deviations', 'review', 'baseline'].map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{({ overview: 'Project', document: 'Plan & approve', context: 'Agent context', deviations: 'Implementation changes', review: 'Review changes', baseline: 'Current system' } as Record<string, string>)[item]}</button>)}</div>
      {tab === 'overview' && <><h2>{deliverable?.title ?? project.title}</h2><p>{project.purpose}</p>{deliverable ? <><h3>Acceptance criteria</h3><ul>{deliverable.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul><p>Required tests: {deliverable.requiredTests.join(', ') || 'None specified'}</p><h3>Related deliverables</h3>{deliverable.relatedDeliverableIds.map((id) => <button key={id} onClick={() => { setDeliverableId(id); setDocumentId(null); }}>{state.deliverables.find((d) => d.id === id)?.title ?? id}</button>)}</> : <>
      <p>Select a deliverable or document from the list to see it. Your agent creates and updates them.</p></>}
      </>}
      {tab === 'document' && (document && revision ? <><h2>{document.title}</h2><label>Revision<select value={revision.id} onChange={(event) => { setRevisionId(event.target.value); setEdit(false); }}>{state.revisions.filter((r) => r.documentId === document.id).map((r, i) => <option key={r.id} value={r.id}>Revision {i + 1} · {state.approvals.some((a) => a.revisionId === r.id) ? 'Approved' : 'Draft'} · {r.createdAt}</option>)}</select></label><p>Content hash: <code>{revision.contentHash}</code></p>
        {approval && <p>Approved by {approval.person} · {approval.createdAt}. Notes: {approval.notes || 'None'}. {approval.revisionId !== revision.id && 'This displayed draft does not replace the approved agreement.'}</p>}
        <div className="pl-actions"><button onClick={() => setEdit(!edit)}>{edit ? 'Read document' : 'Edit draft'}</button>{document.linkedDocumentIds.map((id) => <button key={id} onClick={() => setLinkedDocumentId(id)}>{state.documents.find((d) => d.id === id)?.title ?? id}</button>)}</div>
        <div className="pl-document">{edit ? <MarkdownEditor key={revision.id} markdown={revision.content} documentId={revision.id} editorHandleRef={editor} maxWidth={null} /> : <DocumentView content={revision.content} />}</div>
        {edit && <button disabled={busy || revision.id !== document.latestRevisionId} onClick={() => { const content = editor.current?.getMarkdown(); if (content !== undefined) void execute({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: revision.id, content }).then((result) => { if (result) { setEdit(false); setRevisionId(null); } }); }}>Save new draft revision</button>}
        {previous && <details><summary>Compare with previous revision</summary><MarkdownDiff originalMarkdown={previous.content} modifiedMarkdown={revision.content} documentId={revision.id} /></details>}
        {approval && approval.revisionId !== revision.id && <details><summary>Compare with approved agreement</summary><MarkdownDiff originalMarkdown={state.revisions.find((r) => r.id === approval.revisionId)?.content ?? ''} modifiedMarkdown={revision.content} documentId={`approved-${revision.id}`} /></details>}
        {form('Exact approval', edit ? 'Approve effective edited text' : 'Approve this revision', (data) => ({ type: 'approveDocument', documentId: document.id, expectedRevisionId: revision.id, person: text(data, 'person'), notes: text(data, 'notes'), ...(edit ? { effectiveContent: editor.current?.getMarkdown() ?? revision.content } : {}) }), <>{person}<Field label="Approval notes and conditions" name="notes" multiline required={false} /><p>Approval preserves this exact content. A later draft cannot change an active run.</p></>, revision.id !== document.latestRevisionId)}
      </> : <p>Select a document in the library, or create one on the Project page.</p>)}
      {tab === 'context' && <><h2>Agent context</h2>{deliverable ? <>
        {form('Start an implementation run', 'Pin approved agreement', (data) => ({ type: 'startRun', deliverableId: deliverable.id, approvalIds: data.getAll('approvals').map(String), baselineRevisionIds: data.getAll('baselines').map(String), sessionId: text(data, 'sessionId') }), <><Field label="Requesting agent session" name="sessionId" /><Choices label="Approved documents" name="approvals">{state.approvals.filter((a) => state.documents.some((d) => d.id === a.documentId && d.projectId === project.id)).map((a) => <option key={a.id} value={a.id}>{state.documents.find((d) => d.id === a.documentId)?.title} · {a.revisionId} · {a.notes}</option>)}</Choices><Choices label="Pinned service baselines" name="baselines">{Object.entries(state.baselines).map(([service, id]) => <option key={service} value={id}>{service} · {id}</option>)}</Choices></>)}
        {run && <><p>Run: {run.id} · {run.state} · Session: {run.sessionId}</p><button onClick={() => void inboxApi.planningContext(run.id).then(setContext).catch((cause) => setError(String(cause)))}>Read the agent’s pinned context</button></>}
        {context && <><h3>Exact agreement</h3>{context.approvals.map((a) => <p key={a.id}>Approved by {a.person} · {a.revisionId} · {a.notes}</p>)}{context.documents.map(({ document: d, revision: r, approved, truncated }) => <details key={r.id}><summary>{d.title} · {approved ? 'Approved' : 'Draft'} · {r.id}{truncated ? ' · Content truncated' : ''}</summary><DocumentView content={r.content} /></details>)}<h3>Related deliverables</h3>{context.relatedDeliverables.map((d) => <p key={d.id}>{d.title}</p>)}<h3>Accepted deviations</h3>{context.decisions.map((d) => <p key={d.id}>{d.action}: {d.conditions} · {d.person}</p>)}</>}
      </> : <p>Select a deliverable to prepare its approved context.</p>}</>}
      {tab === 'deviations' && <><h2>Implementation changes</h2>{run ? <><p>Run state: <strong>{run.state}</strong>. A pending change pauses affected implementation. Investigation and independent work can continue.</p>
        {form('Request a deviation', 'Request approval and pause', (data) => ({ type: 'requestDeviation', runId: run.id, repositoryIds: project.repositoryIds, relevantText: text(data, 'relevantText'), proposedChange: text(data, 'proposedChange'), reason: text(data, 'reason'), impact: text(data, 'impact'), replacesId: text(data, 'replacesId') || undefined }), <><Field label="Relevant approved text" name="relevantText" multiline /><Field label="Proposed change" name="proposedChange" multiline /><Field label="Reason" name="reason" multiline /><Field label="Impact on contracts, dependencies, tests, and baselines" name="impact" multiline /><label>Replace a previous request<select name="replacesId"><option value="">New request</option>{deviations.map((d) => <option key={d.id} value={d.id}>{d.proposedChange} · {d.state}</option>)}</select></label></>)}
        {deviations.map((d) => <article className="pl-card" key={d.id}><h3>{d.proposedChange}</h3><p><strong>{d.state}</strong> · Proposal revision {d.proposalRevision}</p><h4>Approved text</h4><p>{d.relevantText}</p><h4>Reason and impact</h4><p>{d.reason}</p><p>{d.impact}</p>{state.decisions.filter((decision) => decision.requestId === d.id).map((decision) => <p key={decision.id}>{decision.action} by {decision.person}: {decision.conditions}</p>)}
          {(d.state === 'pending' || d.state === 'revision-requested') && form('Your decision', 'Record decision', (data) => ({ type: 'decideDeviation', requestId: d.id, expectedProposalRevision: d.proposalRevision, action: text(data, 'action') as 'approved' | 'revision-requested' | 'declined', person: text(data, 'person'), conditions: text(data, 'conditions') }), <>{person}<label>Decision<select name="action"><option value="revision-requested">Request revision (keep paused)</option><option value="approved">Approve exact proposal</option><option value="declined">Decline</option></select></label><Field label="Conditions or requested revisions" name="conditions" multiline required={false} /></>)}
        </article>)}
      </> : <p>Start an approved implementation run first.</p>}</>}
      {tab === 'review' && <><h2>Review changes against the agreement</h2>{run && deliverable ? <><p>Approved revisions: {run.revisionIds.join(', ')}</p><p>Accepted decisions: {run.decisionIds.join(', ') || 'None'}</p><form className="pl-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const opened = window.open('about:blank', '_blank'); if (opened) opened.opener = null; setBusy(true); void inboxApi.planningReview(run.id, text(data, 'repositoryId'), text(data, 'baseCommit') || undefined).then(({ url }) => { if (opened) opened.location.replace(url); else window.location.assign(url); setNotice('Code review opened with this approved agreement.'); }).catch((cause) => { opened?.close(); setError(String(cause)); }).finally(() => setBusy(false)); }}><h3>Code review / Guided Review</h3><fieldset disabled={busy}><label>Repository<select name="repositoryId" required>{state.repositories.filter((r) => project.repositoryIds.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label><Field label="Base commit (leave empty to review working changes)" name="baseCommit" required={false} /><button type="submit">Open code review</button></fieldset></form><p>Record criterion results and retained test evidence for the exact code target below.</p>
        {form('Alignment evidence', 'Record alignment', (data) => { const target = targetFrom(data); const criteria: CriterionResult[] = deliverable.acceptanceCriteria.map((criterion, i) => ({ criterion, result: text(data, `result-${i}`) as CriterionResult['result'], explanation: text(data, `explanation-${i}`), locations: lines(text(data, `locations-${i}`)) })); const tests: PlanningTestEvidence[] = deliverable.requiredTests.map((level) => ({ level, command: text(data, `command-${level}`), target, result: text(data, `test-${level}`) as PlanningTestEvidence['result'], artifact: text(data, `artifact-${level}`) })); return { type: 'recordAlignment', runId: run.id, target, criteria, tests }; }, <>{targetFields}{deliverable.acceptanceCriteria.map((criterion, i) => <div className="pl-card" key={i}><h4>{criterion}</h4><label>Result<select name={`result-${i}`}><option value="unknown">Unknown</option><option value="covered">Covered</option><option value="missing">Missing</option><option value="deviation">Deviation</option></select></label><Field label="Code locations (one per line)" name={`locations-${i}`} multiline required={false} /><Field label="Explanation" name={`explanation-${i}`} multiline /></div>)}{deliverable.requiredTests.map((level) => <div className="pl-card" key={level}><h4>{level} test evidence</h4><Field label="Command" name={`command-${level}`} /><label>Test result<select name={`test-${level}`}><option value="unknown">Unknown</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label><Field label="Retained artifact" name={`artifact-${level}`} /></div>)}</>)}
        {alignments.map((a) => <article key={a.id} className="pl-card"><h3>{a.target.headCommit}</h3><p>{a.stale ? 'Stale signoff: the code target or agreement changed.' : a.signoff ? `Signed off by ${a.signoff.person}` : 'Awaiting signoff'}</p><p>Patch hash: {a.target.patchHash}</p>{a.criteria.map((c, i) => <p key={i}><strong>{c.result}</strong>: {c.criterion} — {c.explanation} ({c.locations.join(', ')})</p>)}{a.tests.map((t, i) => <p key={i}>{t.level}: {t.result} · {t.command} · {t.artifact}</p>)}{!a.signoff && !a.stale && form('Exact code signoff', 'Sign off this agreement and target', (data) => ({ type: 'signoffAlignment', alignmentId: a.id, expectedTarget: a.target, person: text(data, 'person') }), person)}</article>)}
      </> : <p>Select a deliverable with an approved run.</p>}</>}
      {tab === 'baseline' && <><h2>Current system</h2>{Object.entries(state.baselines).map(([service, id]) => <details key={service}><summary>{service} · {id}</summary><DocumentView content={state.revisions.find((r) => r.id === id)?.content ?? ''} /></details>)}
        {latestAlignment && form('Actual merge evidence', 'Record merge evidence', (data) => ({ type: 'recordMerge', alignmentId: latestAlignment.id, repositoryId: latestAlignment.target.repositoryId, targetCommit: text(data, 'targetCommit'), source: text(data, 'source'), mergedAt: text(data, 'mergedAt') }), <><Field label="Merged target commit" name="targetCommit" /><Field label="Merged branch reference (for example refs/heads/main)" name="source" /><Field label="Merge time (ISO timestamp)" name="mergedAt" /></>, !latestAlignment.signoff || latestAlignment.stale)}
        {latestAlignment && form('Proposed baseline update', 'Propose baseline update', (data) => { const serviceId = text(data, 'serviceId'); const proposalRevisionId = text(data, 'proposalRevisionId'); const r = state.revisions.find((v) => v.id === proposalRevisionId); return { type: 'proposeBaseline', serviceId, documentId: r?.documentId ?? '', expectedRevisionId: state.baselines[serviceId], proposalRevisionId, alignmentId: latestAlignment.id, mergeEvidenceId: text(data, 'mergeEvidenceId') }; }, <><Field label="Service identity" name="serviceId" /><label>Proposed baseline revision<select name="proposalRevisionId" required>{state.revisions.filter((r) => state.documents.some((d) => d.id === r.documentId && d.kind === 'service-baseline' && d.projectId === project.id)).map((r) => <option key={r.id} value={r.id}>{state.documents.find((d) => d.id === r.documentId)?.title} · {r.id}</option>)}</select></label><label>Actual merge evidence<select name="mergeEvidenceId" required>{state.merges.filter((m) => m.alignmentId === latestAlignment.id).map((m) => <option key={m.id} value={m.id}>{m.targetCommit} · {m.source}</option>)}</select></label></>)}
        {state.baselineUpdates.filter((update) => state.documents.some((d) => d.id === update.documentId && d.projectId === project.id)).map((update) => <article key={update.id} className="pl-card"><h3>{update.serviceId}</h3><p>{update.accepted ? `Accepted by ${update.accepted.person}` : 'Awaiting explicit baseline acceptance'}</p><MarkdownDiff originalMarkdown={state.revisions.find((r) => r.id === update.expectedRevisionId)?.content ?? ''} modifiedMarkdown={state.revisions.find((r) => r.id === update.proposalRevisionId)?.content ?? ''} documentId={update.id} />{!update.accepted && form('Accept current system knowledge', 'Accept baseline', (data) => ({ type: 'acceptBaseline', updateId: update.id, expectedRevisionId: update.expectedRevisionId, person: text(data, 'person') }), <>{person}<p>Acceptance requires actual merge evidence. Concurrent baseline advances require another review.</p></>)}</article>)}
      </>}
      </>}
      {!project && <p>No plans for this project yet. Ask your agent to create a Project here; it will appear in this list.</p>}
    </div></div>
    {linkedDocumentId && (() => { const linked = state.documents.find((d) => d.id === linkedDocumentId); const linkedRevision = state.revisions.find((r) => r.id === linked?.latestRevisionId); return <div className="pl-modal-backdrop"><section className="pl-modal" role="dialog" aria-modal="true" aria-label={linked?.title ?? 'Related document'}><button autoFocus onClick={() => setLinkedDocumentId(null)}>Close related document</button><h2>{linked?.title}</h2><p>{linked?.kind} · {linkedRevision?.id}</p>{linkedRevision && <DocumentView content={linkedRevision.content} />}</section></div>; })()}
  </section>;
}
