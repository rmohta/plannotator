import { expect, test } from 'bun:test';
import { planningDocumentFeedbackTarget, planningReviewFeedbackTarget } from '../feedback-archive';
import type { PlanningContext } from '@plannotator/core/planning-types';

test('legacy target helpers add no fields and review evidence copies the launch agreement', () => {
 expect(planningDocumentFeedbackTarget(undefined)).toEqual({});
 expect(planningReviewFeedbackTarget(undefined)).toEqual({});
 const agreement={run:{id:'run',revisionIds:['pinned-plan'],decisionIds:['approved-deviation']}} as PlanningContext;
 const codeTarget={repositoryId:'logical-repo',baseCommit:'base',headCommit:'reviewed-head',patchHash:'reviewed-patch'};
 const snapshot=planningReviewFeedbackTarget(agreement,codeTarget);
 agreement.run.revisionIds.push('later-plan'); codeTarget.headCommit='later-head';
 expect(snapshot).toEqual({planning:{runId:'run',revisionIds:['pinned-plan'],decisionIds:['approved-deviation'],codeTarget:{repositoryId:'logical-repo',baseCommit:'base',headCommit:'reviewed-head',patchHash:'reviewed-patch'}}});
});
