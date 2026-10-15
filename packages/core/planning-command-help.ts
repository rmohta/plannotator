import type { PlanningCommand } from './planning-types';

type DeviationCommand = Extract<PlanningCommand, { type: 'requestDeviation' }>;
type ContinuationCommand = Extract<PlanningCommand, { type: 'consumeContinuation' }>;

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

export function deviationRequestExample(agentName = '<assigned-agent-name>'): DeviationCommand {
  return {
    type: 'requestDeviation', agentName,
    repositoryIds: ['<affected-repository-id>'],
    relevantText: '<exact approved text that must change>',
    proposedChange: '<specific change you request>',
    reason: '<why the approved plan cannot be followed>',
    impact: '<effect on scope, contracts, dependencies, tests, and baselines>',
  };
}

export function continuationExample(agentName = '<assigned-agent-name>'): ContinuationCommand {
  return { type: 'consumeContinuation', agentName, decisionId: '<planning-decision-id>' };
}

export const PLANNING_COMMAND_HELP = {
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
      idempotencyKey: 'A stable key for an identical submission retry. Never replay implementation actions after a retry.',
    },
    example: continuationExample(),
    result: 'result.continued must be true before you resume. False means permission was already consumed; an error grants no permission.',
    nextSteps: DEVIATION_DECISION_GATE,
  },
} as const;
