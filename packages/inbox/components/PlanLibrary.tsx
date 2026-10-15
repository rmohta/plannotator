/** The permanent Plan Library. Conversation routing never owns these records. */
import { latestApprovals, revisionNumber } from '@plannotator/core/planning-discovery';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PlanDocument, PlanningCommand, PlanningState, PlanningCodeTarget, CriterionResult, PlanningTestEvidence } from '@plannotator/core/planning-types';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { MarkdownDiff } from '@plannotator/ui/components/MarkdownDiff';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getIdentity, setCustomIdentity } from '@plannotator/ui/utils/identity';
import { inboxApi, setPageSession, type ProjectFolder } from '../api';
import { SidebarTrigger } from '../shell/sidebar';
import { DecisionsProjectPicker } from './DecisionsProjectPicker';
import { CodeBox } from './ConnectPicker';
import { DeliverableList, PlanList } from './PlanLibraryLists';
import './planLibrary.css';

const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const lines = (value: string) => value.split('\n').map((v) => v.trim()).filter(Boolean);
function Field({ label, name, value, required = true, multiline = false }: { label: string; name: string; value?: string; required?: boolean; multiline?: boolean }) {
  return <label>{label}{multiline ? <textarea name={name} defaultValue={value} required={required} rows={3} /> : <input name={name} defaultValue={value} required={required} />}</label>;
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
  const [reviewerName, setReviewerName] = useState('');
  const [deliverableId, setDeliverableId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [pill, setPill] = useState<'deliverables' | 'plans'>('deliverables');
  const [edit, setEdit] = useState(false);
  const [linkedDocumentId, setLinkedDocumentId] = useState<string | null>(null);
  const editor = useRef<MarkdownEditorHandle | null>(null);
  const refresh = useCallback(async () => {
    try {
      const model = await inboxApi.planning(folder.root);
      setPageSession(model.serverSession); setState(model.state); setError(null);
      const identity = getIdentity();
      // A generated annotation nickname must not take precedence over a Git name.
      setReviewerName(model.reviewer?.displayName?.trim() || (!identity.endsWith('-tater') ? identity : '') || model.reviewer?.gitUser?.trim() || identity);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [folder.root]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setProjectId(null); setDeliverableId(null); setDocumentId(null); setRevisionId(null); setTab('overview'); setEdit(false); }, [folder.id]);
  async function execute(command: PlanningCommand): Promise<unknown> {
    setBusy(true); setError(null); setNotice('');
    try {
      const response = await inboxApi.planningCommand({ ...command, idempotencyKey: crypto.randomUUID() });
      setState(response.state);
      if ('person' in command && command.person.trim()) {
        setReviewerName(command.person.trim());
        setCustomIdentity(command.person);
      }
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
  const currentApprovals = latestApprovals(state);
  const approval = currentApprovals.find((a) => a.documentId === document?.id);
  const revision = state.revisions.find((r) => r.id === (revisionId ?? approval?.revisionId ?? document?.latestRevisionId));
  const previous = state.revisions.find((r) => r.id === revision?.predecessorId);
  const revisionLabel = (id: string) => `Revision ${revisionNumber(state, id)} · ${state.approvals.some(a => a.revisionId === id) ? 'Approved' : 'Draft'}`;
  const buildPlan = document?.kind === 'implementation-plan' ? document : undefined;
  const buildApproval = currentApprovals.find(a => a.documentId === buildPlan?.id);
  const belongsToBuildPlan = (runId: string) => state.runs.some(r => r.id === runId && r.deliverableId === deliverable?.id
    && (!buildPlan || r.approvalIds.some(id => state.approvals.some(a => a.id === id && a.documentId === buildPlan.id))));
  const documentRevisions = state.revisions.filter(r => r.documentId === document?.id);
  const displayedApproval = [...state.approvals].reverse().find(a => a.revisionId === revision?.id);
  const run = [...state.runs].reverse().find((r) => belongsToBuildPlan(r.id));
  const deviations = state.deviations.filter((d) => belongsToBuildPlan(d.runId));
  const alignments = state.alignments.filter((a) => a.runId === run?.id);
  const latestAlignment = alignments.at(-1);
  const projectDeliverables = state.deliverables.filter((d) => d.projectId === project?.id);
  const documentDeliverable = projectDeliverables.find((d) => d.id === document?.deliverableId);
  const documentScope = (id?: string) => id ? `Deliverable: ${projectDeliverables.find((d) => d.id === id)?.title ?? id}` : 'Project-wide · No deliverable';
  const targetFrom = (data: FormData): PlanningCodeTarget => ({ repositoryId: text(data, 'repositoryId'), baseCommit: text(data, 'baseCommit'), headCommit: text(data, 'headCommit'), patchHash: text(data, 'patchHash'), prUrl: text(data, 'prUrl') || undefined });
  const person = <Field key={reviewerName} label="Your name" name="person" value={reviewerName} />;
  const targetFields = <><label>Repository<select name="repositoryId" required>{state.repositories.filter((r) => project?.repositoryIds.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label><Field label="Base commit" name="baseCommit" /><Field label="Head commit" name="headCommit" /><Field label="Patch hash" name="patchHash" /><Field label="Pull request URL" name="prUrl" required={false} /></>;
  const reset = () => { setDeliverableId(null); setDocumentId(null); setRevisionId(null); setEdit(false); setTab('overview'); };
  const openList = (which: 'deliverables' | 'plans') => { reset(); setPill(which); };
  const openDeliverable = (id: string) => { reset(); setPill('deliverables'); setDeliverableId(id); };
  const openPlan = (d: PlanDocument, via: 'deliverables' | 'plans') => { setPill(via); setDeliverableId(via === 'deliverables' ? deliverableId : d.deliverableId ?? null); setDocumentId(d.id); setRevisionId(null); setEdit(false); setTab('document'); };
  const pickerProjects: ProjectFolder[] = folderProjects.map((p) => ({ id: p.id, key: p.id, name: p.title, root: p.purpose, created_at: '', threads: 0, unread: 0 }));
  const pickerCurrent = pickerProjects.find((p) => p.id === project?.id);
  const inList = !deliverable && !document;
  /** The breadcrumb after the Project: every crumb with a handler is a button back to that list. */
  const crumbs: { label: string; go?: () => void }[] = [{ label: pill === 'deliverables' ? 'Deliverables' : 'Plans', go: inList ? undefined : () => openList(pill) }];
  if (pill === 'deliverables' && deliverable) crumbs.push({ label: deliverable.title, go: document ? () => openDeliverable(deliverable.id) : undefined });
  if (document) crumbs.push({ label: document.title });
  const pillKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); const next = pill === 'deliverables' ? 'plans' : 'deliverables'; setPill(next);
    (event.currentTarget.querySelector(`[data-pill=${next}]`) as HTMLElement | null)?.focus();
  };
  const planCount = state.documents.filter((d) => d.projectId === project?.id && d.kind !== 'service-baseline').length;
  const pills = [{ id: 'deliverables' as const, label: 'Deliverables', count: projectDeliverables.length }, { id: 'plans' as const, label: 'Plans', count: planCount }];
  return <section className="pl-library" aria-label="Plan Library">
    <header className="pl-heading"><div className="ib-dh"><SidebarTrigger /><h1 className="pl-crumbs">{project ? <>{folderProjects.length > 1 && pickerCurrent ? <DecisionsProjectPicker projects={pickerProjects} current={pickerCurrent} counts={null} home={null} phone={phone} onPick={(id) => { setProjectId(id); reset(); }} /> : <span className="pl-crumb-now">{project.title}</span>}{crumbs.map((c, i) => <span key={i} className="pl-crumb-item"><span className="pl-sep" aria-hidden="true">›</span>{c.go ? <button type="button" className="pl-crumb" onClick={c.go}>{c.label}</button> : <span className="pl-crumb-now" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}</span>)}</> : 'Plans'}</h1><DecisionsProjectPicker projects={projects} current={folder} counts={null} home={home} phone={phone} onPick={onFolder} /><button className="pl-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>{project && <p className="ib-dsub">{project.purpose}</p>}</header>
    {error && <p role="alert" className="pl-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {project && inList && <><div className="ib-ctabs" role="tablist" aria-label="Plan Library" onKeyDown={pillKeys}>{pills.map((p) => <button key={p.id} type="button" role="tab" id={`pl-pill-${p.id}`} data-pill={p.id} className="ib-ctab" aria-selected={pill === p.id} aria-controls="pl-pill-panel" tabIndex={pill === p.id ? 0 : -1} onClick={() => setPill(p.id)}>{p.label}<span className="ib-n">{p.count}</span></button>)}</div>
      <div id="pl-pill-panel" role="tabpanel" aria-labelledby={`pl-pill-${pill}`}>{pill === 'deliverables' ? <DeliverableList state={state} deliverables={projectDeliverables} onOpen={openDeliverable} /> : <PlanList state={state} projectId={project.id} revisionLabel={revisionLabel} onOpen={(d) => openPlan(d, 'plans')} />}</div></>}
    {!inList && <div className="pl-content">
      {project && <><div className="pl-tabs" role="navigation" aria-label="Planning workflow">{['overview', 'document', ...(buildPlan ? ['build'] : []), 'review', 'baseline'].map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{({ overview: 'Project', document: 'Plan & approve', build: 'Build', review: 'Review changes', baseline: 'Current system' } as Record<string, string>)[item]}</button>)}</div>
      {tab === 'overview' && <><h2>{deliverable?.title ?? project.title}</h2><p>{project.purpose}</p>{deliverable ? <><h3>Acceptance criteria</h3><ul>{deliverable.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul><p>Required tests: {deliverable.requiredTests.join(', ') || 'None specified'}</p><h3>Related deliverables</h3>{deliverable.relatedDeliverableIds.map((id) => <button key={id} onClick={() => openDeliverable(id)}>{state.deliverables.find((d) => d.id === id)?.title ?? id}</button>)}</> : <>
      <p>This plan applies to the whole project, not to one deliverable.</p></>}
      </>}
      {tab === 'document' && (document && revision ? <><h2>{document.title}</h2><div className="pl-document-scope">{documentDeliverable ? <><span>Deliverable:</span><button onClick={() => { setDeliverableId(documentDeliverable.id); setTab('overview'); }}>{documentDeliverable.title}</button></> : <span>{documentScope(document.deliverableId)}</span>}</div><p><strong>{revisionLabel(revision.id)}</strong>{revision.id === approval?.revisionId && ' · Latest approved'}</p>
        {displayedApproval && <p>Approved by {displayedApproval.person} · {displayedApproval.createdAt}. Notes: {displayedApproval.notes || 'None'}.</p>}
        {document.latestRevisionId !== revision.id && <button onClick={() => { setRevisionId(document.latestRevisionId ?? null); setEdit(false); }}>View latest {state.approvals.some(a => a.revisionId === document.latestRevisionId) ? 'revision' : 'draft'}</button>}
        {approval && approval.revisionId !== revision.id && <button onClick={() => { setRevisionId(approval.revisionId); setEdit(false); }}>View latest approved revision</button>}
        <details><summary>Revision history and IDs</summary><p>Plan ID: <code>{document.id}</code></p><label>Revision<select value={revision.id} onChange={(event) => { setRevisionId(event.target.value); setEdit(false); }}>{documentRevisions.map(r => <option key={r.id} value={r.id}>{revisionLabel(r.id)}{r.id === approval?.revisionId ? ' · Latest approved' : r.id !== document.latestRevisionId ? ' · Archived' : ''} · {r.createdAt}</option>)}</select></label><p>Revision ID: <code>{revision.id}</code></p><p>Content hash: <code>{revision.contentHash}</code></p></details>
        <div className="pl-actions"><button onClick={() => { if (!edit) setRevisionId(document.latestRevisionId ?? revision.id); setEdit(!edit); }}>{edit ? 'Read plan' : 'Edit draft'}</button>{document.linkedDocumentIds.map((id) => <button key={id} onClick={() => setLinkedDocumentId(id)}>{state.documents.find((d) => d.id === id)?.title ?? id}</button>)}</div>
        <div className="pl-document">{edit ? <MarkdownEditor key={revision.id} markdown={revision.content} documentId={revision.id} editorHandleRef={editor} maxWidth={null} /> : <DocumentView content={revision.content} />}</div>
        {edit && <button disabled={busy || revision.id !== document.latestRevisionId} onClick={() => { const content = editor.current?.getMarkdown(); if (content !== undefined) void execute({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: revision.id, content }).then((result) => { if (result) { setEdit(false); setRevisionId(null); } }); }}>Save new draft revision</button>}
        {previous && <details><summary>Compare with previous revision</summary><MarkdownDiff originalMarkdown={previous.content} modifiedMarkdown={revision.content} documentId={revision.id} /></details>}
        {approval && approval.revisionId !== revision.id && <details><summary>Compare with approved agreement</summary><MarkdownDiff originalMarkdown={state.revisions.find((r) => r.id === approval.revisionId)?.content ?? ''} modifiedMarkdown={revision.content} documentId={`approved-${revision.id}`} /></details>}
        {revision.id === document.latestRevisionId && (!displayedApproval || edit) && form('Exact approval', edit ? 'Approve effective edited text' : 'Approve this revision', (data) => ({ type: 'approveDocument', documentId: document.id, expectedRevisionId: revision.id, person: text(data, 'person'), notes: text(data, 'notes'), ...(edit ? { effectiveContent: editor.current?.getMarkdown() ?? revision.content } : {}) }), <>{person}<Field label="Approval notes and conditions" name="notes" multiline required={false} /><p>Approval preserves this exact content. A later draft cannot change an active run.</p></>)}
      </> : deliverable ? <><h2>Plans for this deliverable</h2><PlanList state={state} projectId={project.id} only={deliverable.id} revisionLabel={revisionLabel} onOpen={(d) => openPlan(d, 'deliverables')} /></> : <p>Select a plan from the Plans list.</p>)}
      {tab === 'build' && buildPlan && deliverable && <><h2>Build</h2>
        {buildApproval ? <section className="pl-card" aria-label="Build prompt">
          <h3>Implement {buildPlan.title}</h3>
          <p>Plan ID: <code>{buildPlan.id}</code></p>
          <p>{revisionLabel(buildApproval.revisionId)}</p>
          <p>Copy this prompt into your coding agent’s chat in the target repository. The agent needs the local Plannotator CLI and access to this Plan Library store.</p>
          <CodeBox text={[
            `Implement only the approved plan ${JSON.stringify(buildPlan.title)} (${buildPlan.id}).`,
            `Project: ${JSON.stringify(project.title)} (${project.id}). Deliverable: ${JSON.stringify(deliverable.title)} (${deliverable.id}).`,
            'Use the local plannotator planning CLI for this workflow. Run commands from the target repository or worktree.',
            'Read plannotator planning --help for command usage. Do not use MCP for this workflow.',
            `Read the current approval with: plannotator planning list --kind approvals --json`,
            'If nextOffset is present, read the next page with --offset <nextOffset>. Repeat until all pages are read.',
            `Make sure that approval ${buildApproval.id} names plan ${buildPlan.id} and exact revision ${buildApproval.revisionId}.`,
            'If the named approval is missing or superseded, stop. Do not create, revise, or implement a plan.',
            `Approval conditions: ${buildApproval.notes || 'None'}.`,
            '',
            'Export the approved plan to a new Markdown file:',
            `plannotator planning export revision ${buildApproval.revisionId} --out <new-file.md> --json`,
            'This writes the complete, verbatim revision text. The JSON response contains the file path and metadata, not the plan text.',
            'Read the exported Markdown file in full. If your file reader limits output, read the remaining ranges.',
            'Use new output paths under an existing parent directory. Exports refuse existing files or directories.',
            'If the CLI cannot access the store or export the approved revision, stop and report the error.',
            '',
            'Read existing runs and deviations with plannotator planning list --kind runs --json and --kind deviations --json.',
            'Read every discovery page. Do not start a new run to bypass a pending deviation.',
            'Send planning commands through plannotator planning request <command.json> --json.',
            'Save one bare command object in the JSON file, without a command wrapper.',
            'To start the run, replace <your-session-id> with your actual session ID in this command:',
            JSON.stringify({ type: 'startRun', deliverableId: deliverable.id, approvalIds: [buildApproval.id], sessionId: '<your-session-id>' }),
            'Use the returned run ID to export the complete pinned agreement:',
            'plannotator planning export run <run-id> --out <new-directory> --json',
            'Read manifest.json and every Markdown file under documents/ in full before implementation.',
            'The run export includes supporting revisions, approvals, decisions, and deviations without pagination or text limits.',
            'If the export fails or you cannot read every file in full, stop and report the error.',
            'Follow the approved scope, conditions, acceptance criteria, and required tests.',
            'If a deviation is pending, keep affected work paused.',
            '',
            'If you need to depart from the approved plan, send requestDeviation through the CLI for this run.',
            'Include the approved text, proposed change, reason, and impact. The request goes to Inbox with approval options.',
            'Wait for my sent answer and feedback. Export the run again to read the decision.',
            'After approval, send consumeContinuation through the CLI with the planning decision ID, run ID, and recorded session ID.',
            'Export the run to a new directory again. Read the updated manifest and every revision before you resume affected work.',
            'Implement the approved work and report the changes and test results.',
          ].join('\n')} />
        </section> : <p>This plan has no approved revision. Stop and approve it in Plan &amp; approve before building.</p>}
        <section aria-label="Deviations"><h3>Deviations</h3>
        <p>Requests to depart from the approved plan go to Inbox. Choose an option, add feedback, and press Send. Your answer records a Decision and returns to the agent.</p>
        {deviations.some(d => d.state === 'pending' || d.state === 'revision-requested') && <p>Affected implementation is <strong>paused</strong> until pending deviations are settled.</p>}
        {deviations.length === 0 && <p>No deviations requested.</p>}
        {deviations.map((d) => <article className="pl-card" key={d.id}><h3>{d.proposedChange}</h3><p><strong>{d.state}</strong> · Proposal revision {d.proposalRevision}</p><h4>Approved text</h4><p>{d.relevantText}</p><h4>Reason and impact</h4><p>{d.reason}</p><p>{d.impact}</p>{state.decisions.filter((decision) => decision.requestId === d.id).map((decision) => <p key={decision.id}>{decision.action} by {decision.person}: {decision.conditions}</p>)}
          {(d.state === 'pending' || d.state === 'revision-requested') && <p>Answer this deviation request in Inbox. Choose an option, add feedback or conditions, and press Send. Your answer records a Decision and returns to the agent.</p>}
        </article>)}
        </section>
      </>}
      {tab === 'review' && <><h2>Review changes against the agreement</h2>{run && deliverable ? <><p>Approved revisions: {run.revisionIds.join(', ')}</p><p>Accepted decisions: {run.decisionIds.join(', ') || 'None'}</p><form className="pl-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const opened = window.open('about:blank', '_blank'); if (opened) opened.opener = null; setBusy(true); void inboxApi.planningReview(run.id, text(data, 'repositoryId'), text(data, 'baseCommit') || undefined).then(({ url }) => { if (opened) opened.location.replace(url); else window.location.assign(url); setNotice('Code review opened with this approved agreement.'); }).catch((cause) => { opened?.close(); setError(String(cause)); }).finally(() => setBusy(false)); }}><h3>Code review / Guided Review</h3><fieldset disabled={busy}><label>Repository<select name="repositoryId" required>{state.repositories.filter((r) => project.repositoryIds.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label><Field label="Base commit (leave empty to review working changes)" name="baseCommit" required={false} /><button type="submit">Open code review</button></fieldset></form><p>Record criterion results and retained test evidence for the exact code target below.</p>
        {form('Alignment evidence', 'Record alignment', (data) => { const target = targetFrom(data); const criteria: CriterionResult[] = deliverable.acceptanceCriteria.map((criterion, i) => ({ criterion, result: text(data, `result-${i}`) as CriterionResult['result'], explanation: text(data, `explanation-${i}`), locations: lines(text(data, `locations-${i}`)) })); const tests: PlanningTestEvidence[] = deliverable.requiredTests.map((level) => ({ level, command: text(data, `command-${level}`), target, result: text(data, `test-${level}`) as PlanningTestEvidence['result'], artifact: text(data, `artifact-${level}`) })); return { type: 'recordAlignment', runId: run.id, target, criteria, tests }; }, <>{targetFields}{deliverable.acceptanceCriteria.map((criterion, i) => <div className="pl-card" key={i}><h4>{criterion}</h4><label>Result<select name={`result-${i}`}><option value="unknown">Unknown</option><option value="covered">Covered</option><option value="missing">Missing</option><option value="deviation">Deviation</option></select></label><Field label="Code locations (one per line)" name={`locations-${i}`} multiline required={false} /><Field label="Explanation" name={`explanation-${i}`} multiline /></div>)}{deliverable.requiredTests.map((level) => <div className="pl-card" key={level}><h4>{level} test evidence</h4><Field label="Command" name={`command-${level}`} /><label>Test result<select name={`test-${level}`}><option value="unknown">Unknown</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label><Field label="Retained artifact" name={`artifact-${level}`} /></div>)}</>)}
        {alignments.map((a) => <article key={a.id} className="pl-card"><h3>{a.target.headCommit}</h3><p>{a.stale ? 'Stale signoff: the code target or agreement changed.' : a.signoff ? `Signed off by ${a.signoff.person}` : 'Awaiting signoff'}</p><p>Patch hash: {a.target.patchHash}</p>{a.criteria.map((c, i) => <p key={i}><strong>{c.result}</strong>: {c.criterion} — {c.explanation} ({c.locations.join(', ')})</p>)}{a.tests.map((t, i) => <p key={i}>{t.level}: {t.result} · {t.command} · {t.artifact}</p>)}{!a.signoff && !a.stale && form('Exact code signoff', 'Sign off this agreement and target', (data) => ({ type: 'signoffAlignment', alignmentId: a.id, expectedTarget: a.target, person: text(data, 'person') }), person)}</article>)}
      </> : <p>Select a deliverable with an approved run.</p>}</>}
      {tab === 'baseline' && <><h2>Current system</h2>{state.documents.some((d) => d.projectId === project.id && d.kind === 'service-baseline') && <><h3>Service baseline plans</h3><div className="pl-actions">{state.documents.filter((d) => d.projectId === project.id && d.kind === 'service-baseline').map((d) => <button key={d.id} onClick={() => openPlan(d, 'plans')}>{d.title}</button>)}</div></>}{Object.entries(state.baselines).map(([service, id]) => <details key={service}><summary>{service} · {id}</summary><DocumentView content={state.revisions.find((r) => r.id === id)?.content ?? ''} /></details>)}
        {latestAlignment && form('Actual merge evidence', 'Record merge evidence', (data) => ({ type: 'recordMerge', alignmentId: latestAlignment.id, repositoryId: latestAlignment.target.repositoryId, targetCommit: text(data, 'targetCommit'), source: text(data, 'source'), mergedAt: text(data, 'mergedAt') }), <><Field label="Merged target commit" name="targetCommit" /><Field label="Merged branch reference (for example refs/heads/main)" name="source" /><Field label="Merge time (ISO timestamp)" name="mergedAt" /></>, !latestAlignment.signoff || latestAlignment.stale)}
        {latestAlignment && form('Proposed baseline update', 'Propose baseline update', (data) => { const serviceId = text(data, 'serviceId'); const proposalRevisionId = text(data, 'proposalRevisionId'); const r = state.revisions.find((v) => v.id === proposalRevisionId); return { type: 'proposeBaseline', serviceId, documentId: r?.documentId ?? '', expectedRevisionId: state.baselines[serviceId], proposalRevisionId, alignmentId: latestAlignment.id, mergeEvidenceId: text(data, 'mergeEvidenceId') }; }, <><Field label="Service identity" name="serviceId" /><label>Proposed baseline revision<select name="proposalRevisionId" required>{state.revisions.filter((r) => state.documents.some((d) => d.id === r.documentId && d.kind === 'service-baseline' && d.projectId === project.id)).map((r) => <option key={r.id} value={r.id}>{state.documents.find((d) => d.id === r.documentId)?.title} · {r.id}</option>)}</select></label><label>Actual merge evidence<select name="mergeEvidenceId" required>{state.merges.filter((m) => m.alignmentId === latestAlignment.id).map((m) => <option key={m.id} value={m.id}>{m.targetCommit} · {m.source}</option>)}</select></label></>)}
        {state.baselineUpdates.filter((update) => state.documents.some((d) => d.id === update.documentId && d.projectId === project.id)).map((update) => <article key={update.id} className="pl-card"><h3>{update.serviceId}</h3><p>{update.accepted ? `Accepted by ${update.accepted.person}` : 'Awaiting explicit baseline acceptance'}</p><MarkdownDiff originalMarkdown={state.revisions.find((r) => r.id === update.expectedRevisionId)?.content ?? ''} modifiedMarkdown={state.revisions.find((r) => r.id === update.proposalRevisionId)?.content ?? ''} documentId={update.id} />{!update.accepted && form('Accept current system knowledge', 'Accept baseline', (data) => ({ type: 'acceptBaseline', updateId: update.id, expectedRevisionId: update.expectedRevisionId, person: text(data, 'person') }), <>{person}<p>Acceptance requires actual merge evidence. Concurrent baseline advances require another review.</p></>)}</article>)}
      </>}
      </>}
    </div>}
    {!project && <p>No plans for this project yet. Ask your agent to create a Project here; it will appear in this list.</p>}
    {linkedDocumentId && (() => { const linked = state.documents.find((d) => d.id === linkedDocumentId); const linkedRevision = state.revisions.find((r) => r.id === linked?.latestRevisionId); return <div className="pl-modal-backdrop"><section className="pl-modal" role="dialog" aria-modal="true" aria-label={linked?.title ?? 'Related plan'}><button autoFocus onClick={() => setLinkedDocumentId(null)}>Close related plan</button><h2>{linked?.title}</h2><p>{linked?.kind} · {linkedRevision?.id}</p>{linkedRevision && <DocumentView content={linkedRevision.content} />}</section></div>; })()}
  </section>;
}
