import type { PlanningCommand } from './planning-types';

type DeviationCommand = Extract<PlanningCommand, { type: 'requestDeviation' }>;
type ContinuationCommand = Extract<PlanningCommand, { type: 'consumeContinuation' }>;
type RepositoryCommand = Extract<PlanningCommand, { type: 'createRepository' }>;
type CheckoutCommand = Extract<PlanningCommand, { type: 'bindCheckout' }>;
type ProjectCommand = Extract<PlanningCommand, { type: 'createProject' }>;
type DeliverableCommand = Extract<PlanningCommand, { type: 'createDeliverable' }>;
type CreateDocumentCommand = Extract<PlanningCommand, { type: 'createDocument' }>;
type ReviseDocumentCommand = Extract<PlanningCommand, { type: 'reviseDocument' }>;
type StartRunCommand = Extract<PlanningCommand, { type: 'startRun' }>;
type AlignmentCommand = Extract<PlanningCommand, { type: 'recordAlignment' }>;
type CompleteRunCommand = Extract<PlanningCommand, { type: 'completeRun' }>;
type BaselineCommand = Extract<PlanningCommand, { type: 'proposeBaseline' }>;

/** Only the person may send these, from the Plans window; the CLI and the agent tool refuse them. */
export const PLANNING_PERSON_ONLY = [
  { type: 'approveDocument', description: 'Approve one exact revision of a document. The person does this in the Plans window.' },
  { type: 'decideDeviation', description: 'Approve, decline, or request revision of a deviation. The person answers in Inbox.' },
  { type: 'signoffAlignment', description: 'Sign off review evidence for one code target. The person does this in the Plans window.' },
  { type: 'recordMerge', description: 'Record merge evidence after signoff. The person does this in the Plans window.' },
  { type: 'acceptBaseline', description: 'Accept a proposed service baseline. The person does this in the Plans window.' },
] as const;

/** Shared by CLI help, request responses, and the copied Build prompt. */
export const DEVIATION_DECISION_GATE = [
  'Pause affected work before you submit a deviation request.',
  'Wait for the person to send a decision and feedback through Plannotator.',
  'Do not implement the proposed change while you wait.',
  'Silence, timeouts, saved picks, and approval outside Plannotator do not grant permission.',
  'Export your named assignment again to read the sent decision and its conditions.',
  'Match the decision to your request ID and exact proposal revision.',
  'If no matching approved decision exists, keep the proposed change paused.',
  'A declined or revision-requested decision does not permit the proposed change.',
  'After approval, submit consumeContinuation with your agentName and the planning decision ID.',
  'Resume the approved change only after consumeContinuation returns continued: true.',
  'If continuation fails or another deviation remains pending, keep affected work paused.',
  'If continued is false, the continuation was already consumed. Do not repeat its actions.',
  'Read the updated agreement and conditions before you resume the approved work.',
] as const;

export function deviationRequestExample(agentName = '<assigned-agent-name>', runId?: string): DeviationCommand {
  return {
    type: 'requestDeviation', agentName, ...(runId ? { runId } : {}),
    repositoryIds: ['<affected-repository-id>'],
    relevantText: '<exact approved text that must change>',
    proposedChange: '<specific change you request>',
    reason: '<why the approved plan cannot be followed>',
    impact: '<effect on scope, contracts, dependencies, tests, and baselines>',
  };
}

export function continuationExample(agentName = '<assigned-agent-name>', runId?: string): ContinuationCommand {
  return { type: 'consumeContinuation', agentName, ...(runId ? { runId } : {}), decisionId: '<planning-decision-id>' };
}

/** Shared next steps after a document draft or revision exists. */
const DOCUMENT_APPROVAL_STEPS = [
  'Tell the person the document ID and ask for approval in the Plans window (plannotator inbox, then Plans).',
  'A draft grants no permission to implement. Implement only from the pinned context of a run.',
] as const;

export const PLANNING_COMMAND_HELP = {
  createRepository: {
    description: 'Create the logical identity of one repository, before any checkout is bound to it.',
    requiredFields: ['type', 'title'] satisfies (keyof RepositoryCommand)[],
    fields: {
      type: 'The literal createRepository.',
      title: 'The repository name, such as orders-service.',
    },
    optionalFields: {
      remote: 'The remote URL, when one exists.',
    },
    example: { type: 'createRepository', title: 'orders-service', remote: 'git@github.com:org/orders-service.git' },
    result: 'result.id is the repository ID. Use it in bindCheckout and createProject.',
    nextSteps: [] as const,
  },
  bindCheckout: {
    description: 'Bind your working folder (its git worktree root) to a repository. Run it from the worktree where you will implement.',
    requiredFields: ['type', 'repositoryId'] satisfies (keyof CheckoutCommand)[],
    fields: {
      type: 'The literal bindCheckout.',
      repositoryId: 'The repository to bind this folder to.',
    },
    optionalFields: {
      path: 'An absolute path, only to bind a folder other than your working folder.',
      checkoutId: 'The existing checkout ID, to move a binding to a new path.',
    },
    example: { type: 'bindCheckout', repositoryId: '<repository-id>' },
    result: 'result.id is the checkout ID. Each git worktree is its own checkout.',
    nextSteps: [] as const,
  },
  createProject: {
    description: 'Create the parent Project: the business or technical ask that owns deliverables.',
    requiredFields: ['type', 'title', 'purpose', 'repositoryIds'] satisfies (keyof ProjectCommand)[],
    fields: {
      type: 'The literal createProject.',
      title: 'The Project name.',
      purpose: 'Why this work exists.',
      repositoryIds: 'An array of repository IDs that hold the code. Every entry must exist.',
    },
    optionalFields: {
      domain: 'A domain label, such as payments.',
    },
    example: { type: 'createProject', title: 'Reliable order processing', purpose: 'Why this work exists.', repositoryIds: ['<repository-id>'] },
    result: 'result.id is the Project ID. Use it in createDeliverable and createDocument.',
    nextSteps: [] as const,
  },
  createDeliverable: {
    description: 'Create one sub-feature with its own acceptance criteria and required tests. Sign-off checks every criterion and level.',
    requiredFields: ['type', 'projectId', 'title', 'acceptanceCriteria', 'requiredTests'] satisfies (keyof DeliverableCommand)[],
    fields: {
      type: 'The literal createDeliverable.',
      projectId: 'The parent Project.',
      title: 'The deliverable name.',
      acceptanceCriteria: 'An array of criterion strings. Sign-off requires each to be covered.',
      requiredTests: 'An array of test levels: unit, integration, e2e.',
    },
    optionalFields: {
      relatedDeliverableIds: 'Deliverables whose approved text this work must respect.',
    },
    example: { type: 'createDeliverable', projectId: '<project-id>', title: 'Prevent duplicate charges', acceptanceCriteria: ['A retried request charges once'], requiredTests: ['unit', 'integration'] },
    result: 'result.id is the Deliverable ID. Use it in createDocument and startRun.',
    nextSteps: [] as const,
  },
  createDocument: {
    description: 'Save a design or implementation plan as a document with its first revision. content is the full markdown.',
    requiredFields: ['type', 'projectId', 'kind', 'title', 'content'] satisfies (keyof CreateDocumentCommand)[],
    fields: {
      type: 'The literal createDocument.',
      projectId: 'The Project that owns the document.',
      kind: 'One of: project-design, hld, lld, integration-design, implementation-plan, service-baseline.',
      title: 'The document title.',
      content: 'The complete markdown of the first revision.',
    },
    optionalFields: {
      deliverableId: 'The Deliverable this document belongs to. Omit for Project-level designs.',
      serviceId: 'The service identity, for service-baseline documents only.',
      linkedDocumentIds: 'Documents this one names as context.',
      idempotencyKey: 'A stable key for an identical submission retry.',
    },
    example: { type: 'createDocument', projectId: '<project-id>', deliverableId: '<deliverable-id>', kind: 'implementation-plan', title: 'Idempotency keys for charges', content: '# Plan\n…' },
    result: 'result.id is the document ID. result.latestRevisionId is its first revision.',
    nextSteps: DOCUMENT_APPROVAL_STEPS,
  },
  reviseDocument: {
    description: 'Send the complete new text of a document as its next revision. The person then approves that exact revision.',
    requiredFields: ['type', 'documentId', 'expectedRevisionId', 'content'] satisfies (keyof ReviseDocumentCommand)[],
    fields: {
      type: 'The literal reviseDocument.',
      documentId: 'The document to revise. A revision export header carries this ID.',
      expectedRevisionId: 'The current latestRevisionId. A revision export header carries it too.',
      content: 'The complete new markdown, not a diff.',
    },
    optionalFields: {
      title: 'A new document title.',
      idempotencyKey: 'A stable key for an identical submission retry.',
    },
    example: { type: 'reviseDocument', documentId: '<document-id>', expectedRevisionId: '<latest-revision-id>', content: '# Plan v2\n…' },
    result: 'result.latestRevisionId is the new revision. A conflict means the document changed: read it again and retry with the new revision ID.',
    nextSteps: DOCUMENT_APPROVAL_STEPS,
  },
  startRun: {
    description: 'Start, or recover, one implementation assignment from an approved plan. Send it from the worktree where you will implement.',
    requiredFields: ['type', 'deliverableId', 'approvalIds', 'agentName'] satisfies (keyof StartRunCommand)[],
    fields: {
      type: 'The literal startRun.',
      deliverableId: 'The Deliverable the plan belongs to.',
      approvalIds: 'An array with the plan approval ID from the Build tab. Supporting documents are pinned automatically.',
      agentName: 'The name assigned to your terminal, such as Bobby. One name may hold several assignments.',
    },
    optionalFields: {
      baselineRevisionIds: 'Baseline revisions to pin, instead of every accepted baseline of the Project.',
      idempotencyKey: 'A stable key for an identical submission retry.',
    },
    example: { type: 'startRun', deliverableId: '<deliverable-id>', approvalIds: ['<approval-id>'], agentName: '<assigned-agent-name>' },
    result: 'Returns the run. Repeating the same name and agreement returns the existing assignment, including pending deviations.',
    nextSteps: ['Export the assignment: plannotator planning export agent <agent-name> --out <new-directory> --json', 'With several assignments, export each by run ID: plannotator planning export run <run-id> --out <new-directory> --json', 'Read manifest.json and every revision file before implementing.'] as const,
  },
  requestDeviation: {
    description: 'Ask the person to approve a change to the exact approved plan. Affected work pauses until a sent Plannotator decision.',
    requiredFields: ['type', 'agentName', 'repositoryIds', 'relevantText', 'proposedChange', 'reason', 'impact'] satisfies (keyof DeviationCommand)[],
    fields: {
      type: 'The literal requestDeviation.',
      agentName: 'The name assigned to your plan and terminal, such as Bobby. Keep this name unchanged.',
      repositoryIds: 'An array of affected repository IDs. Find them in the exported manifest.repositories; use [] if none apply.',
      relevantText: 'The exact approved text that the proposed change affects.',
      proposedChange: 'The specific change for which you request a decision.',
      reason: 'Why the approved text cannot be followed.',
      impact: 'Effects on scope, contracts, dependencies, required tests, and baselines.',
    },
    optionalFields: {
      runId: 'The run this request belongs to, when your agent name holds several assignments. Find it with plannotator planning list --kind runs.',
      deliverableId: 'A run selector by Deliverable, when it names exactly one of your assignments.',
      replacesId: 'The ID of a pending or revision-requested proposal to replace. The replacement needs its own sent decision.',
      idempotencyKey: 'A stable key for an identical submission retry. Use a new key when the command changes.',
    },
    example: deviationRequestExample(),
    result: 'result.id is the deviation request ID. Save it to match the exact sent decision in manifest.deviations and manifest.decisions.',
    nextSteps: DEVIATION_DECISION_GATE,
  },
  consumeContinuation: {
    description: 'Consume permission for one exact, approved deviation after you read its sent Plannotator decision.',
    requiredFields: ['type', 'agentName', 'decisionId'] satisfies (keyof ContinuationCommand)[],
    fields: {
      type: 'The literal consumeContinuation.',
      agentName: 'The same agent name used for the deviation request.',
      decisionId: 'The planning decision ID from the updated assignment export. Do not use the Inbox decision ID.',
    },
    optionalFields: {
      runId: 'The run this continuation belongs to, when your agent name holds several assignments.',
      deliverableId: 'A run selector by Deliverable, when it names exactly one of your assignments.',
      idempotencyKey: 'A stable key for an identical submission retry. Never replay implementation actions after a retry.',
    },
    example: continuationExample(),
    result: 'result.continued must be true before you resume. False means permission was already consumed; an error grants no permission.',
    nextSteps: DEVIATION_DECISION_GATE,
  },
  recordAlignment: {
    description: 'Record criterion and test evidence for one exact code target. Commit first; the person signs off in the Plans window.',
    requiredFields: ['type', 'agentName', 'target', 'criteria', 'tests'] satisfies (keyof AlignmentCommand)[],
    fields: {
      type: 'The literal recordAlignment.',
      agentName: 'The name assigned to the run.',
      target: 'The exact code target: repositoryId, baseCommit, headCommit, and patchHash. patchHash is the SHA-256 of git diff --no-ext-diff <baseCommit> <headCommit>.',
      criteria: 'One entry per acceptance criterion, with its exact text, a result (covered, missing, deviation, unknown), code locations, and an explanation.',
      tests: 'One entry per required level, with the command, the same target, the result, and a retained artifact.',
    },
    optionalFields: {
      runId: 'The run this evidence belongs to, when your agent name holds several assignments.',
      deliverableId: 'A run selector by Deliverable, when it names exactly one of your assignments.',
      idempotencyKey: 'A stable key for an identical submission retry.',
    },
    example: { type: 'recordAlignment', agentName: '<assigned-agent-name>', target: { repositoryId: '<repository-id>', baseCommit: '<sha>', headCommit: '<sha>', patchHash: '<sha256>' }, criteria: [{ criterion: '<exact acceptance criterion>', result: 'covered', locations: ['src/charge.ts:42'], explanation: '<why it is covered>' }], tests: [{ level: 'unit', command: '<test command>', target: { repositoryId: '<repository-id>', baseCommit: '<sha>', headCommit: '<sha>', patchHash: '<sha256>' }, result: 'passed', artifact: '<path or URL of the test output>' }] },
    result: 'result.id is the alignment ID. Any new deviation or alignment makes earlier evidence stale.',
    nextSteps: ['The person signs off in the Plans window (Review changes).', 'Signoff requires every criterion covered and every required test level passed.'] as const,
  },
  completeRun: {
    description: 'Mark one implementation assignment completed, after its alignment evidence is recorded. The person still signs off and records the merge.',
    requiredFields: ['type', 'agentName'] satisfies (keyof CompleteRunCommand)[],
    fields: {
      type: 'The literal completeRun.',
      agentName: 'The name assigned to the run.',
    },
    optionalFields: {
      runId: 'The run to complete, when your agent name holds several assignments.',
      deliverableId: 'A run selector by Deliverable, when it names exactly one of your assignments.',
      idempotencyKey: 'A stable key for an identical submission retry.',
    },
    example: { type: 'completeRun', agentName: '<assigned-agent-name>', runId: '<run-id>' },
    result: 'Returns the run with state "completed". Repeating the command returns the same run. The Inbox tells the person sign-off is awaited.',
    nextSteps: ['Find remaining assignments with plannotator planning list --kind runs --json: runs still active or paused.', 'A completed run accepts no new deviations or evidence. More work needs a newly approved plan revision and a new run.'] as const,
  },
  proposeBaseline: {
    description: 'Propose an accepted service baseline update after merge evidence exists. The person accepts it.',
    requiredFields: ['type', 'serviceId', 'documentId', 'proposalRevisionId', 'alignmentId', 'mergeEvidenceId'] satisfies (keyof BaselineCommand)[],
    fields: {
      type: 'The literal proposeBaseline.',
      serviceId: 'The service identity of the baseline document.',
      documentId: 'The service-baseline document.',
      proposalRevisionId: 'The revision that records the new system knowledge.',
      alignmentId: 'The signed-off alignment.',
      mergeEvidenceId: 'The recorded merge evidence.',
    },
    optionalFields: {
      expectedRevisionId: 'The current baseline revision, to refuse an obsolete proposal.',
    },
    example: { type: 'proposeBaseline', serviceId: 'orders', documentId: '<baseline-document-id>', expectedRevisionId: '<current-baseline-revision-id>', proposalRevisionId: '<new-revision-id>', alignmentId: '<alignment-id>', mergeEvidenceId: '<merge-id>' },
    result: 'result.id is the baseline update ID. The person accepts it in the Plans window.',
    nextSteps: [] as const,
  },
} as const;

/** The agent surface, derived from the help catalog so commands and documentation cannot drift apart. */
export const PLANNING_AGENT_COMMAND_TYPES = Object.keys(PLANNING_COMMAND_HELP);
export const PLANNING_PERSON_COMMAND_TYPES = PLANNING_PERSON_ONLY.map(command => command.type);
