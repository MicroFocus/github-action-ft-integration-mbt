/*
 * Copyright 2016-2024 Open Text.
 *
 * The only warranties for products and services of Open Text and
 * its affiliates and licensors (“Open Text”) are as may be set forth
 * in the express warranty statements accompanying such products and services.
 * Nothing herein should be construed as constituting an additional warranty.
 * Open Text shall not be liable for technical or editorial errors or
 * omissions contained herein. The information contained herein is subject
 * to change without notice.
 *
 * Except as specifically indicated otherwise, this document contains
 * confidential information and a valid license is required for possession,
 * use or copying. If this work is provided to the U.S. Government,
 * consistent with FAR 12.211 and 12.212, Commercial Computer Software,
 * Computer Software Documentation, and Technical Data for Commercial Items are
 * licensed to the U.S. Government under vendor's standard commercial license.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *   http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import GitHubClient from '../client/githubClient';
import ActionsEvent from '../dto/github/ActionsEvent';
import ActionsEventType from '../dto/github/ActionsEventType';
import { ActionsJob } from '../dto/github/ActionsJob';
import WorkflowRun from '../dto/github/WorkflowRun';
import WorkflowRunStatus from '../dto/github/WorkflowRunStatus';
import CiEvent from '../dto/octane/events/CiEvent';
import CiEventCause from '../dto/octane/events/CiEventCause';
import CiParam from '../dto/octane/events/CiParam';
import {
  CiEventType,
  MultiBranchType,
  PhaseType,
  Result
} from '../dto/octane/events/CiTypes';
import { sleep } from '../utils/utils';

const pollForJobsOfTypeToFinish = async (
  owner: string,
  repoName: string,
  currentRun: WorkflowRun,
  workflowRunId: number,
  startTime: number,
  eventType: ActionsEventType
): Promise<void> => {
  let done = false;

  while (!done) {
    const notFinishedRuns = await getNotFinishedRuns(
      owner,
      repoName,
      startTime,
      currentRun
    );

    // Integration job name structure is: OctaneIntegration#${{github.event.action}}#${{github.event.workflow_run.id}}
    const runsMappedToTheirJobs: ActionsJob[][] = await Promise.all(
      notFinishedRuns.map(run =>
        GitHubClient.getWorkflowRunJobs(owner, repoName, run.id)
      )
    );

    const runsToWaitFor = runsMappedToTheirJobs.filter(jobsForRun => {
      const jobs = jobsForRun.filter(job => {
        const nameComponents = job.name.split('#');
        const runEventType = nameComponents[1];
        const triggeredByRunId = nameComponents[2];
        return (
          runEventType === eventType &&
          Number.parseInt(triggeredByRunId) === workflowRunId
        );
      });

      return jobs.length > 0;
    });

    done = runsToWaitFor.length === 0;
    await sleep(3000);
  }
};

const getNotFinishedRuns = async (
  owner: string,
  repoName: string,
  startTime: number,
  currentRun: WorkflowRun
): Promise<WorkflowRun[]> => {
  const runs: WorkflowRun[] = [];
  const params: [string, string, number, number] = [
    owner,
    repoName,
    startTime,
    currentRun.workflow_id
  ];
  runs.push(
    ...(await GitHubClient.getWorkflowRunsTriggeredBeforeByStatus(
      ...params,
      WorkflowRunStatus.IN_PROGRESS
    ))
  );
  runs.push(
    ...(await GitHubClient.getWorkflowRunsTriggeredBeforeByStatus(
      ...params,
      WorkflowRunStatus.QUEUED
    ))
  );
  runs.push(
    ...(await GitHubClient.getWorkflowRunsTriggeredBeforeByStatus(
      ...params,
      WorkflowRunStatus.REQUESTED
    ))
  );
  runs.push(
    ...(await GitHubClient.getWorkflowRunsTriggeredBeforeByStatus(
      ...params,
      WorkflowRunStatus.WAITING
    ))
  );
  return runs.filter(run => run.id !== currentRun.id);
};

const generateRootExecutorEvent = (
  event: ActionsEvent,
  executorName: string,
  executorCiId: string,
  buildCiId: string,
  runNumber: string,
  branchName: string,
  startTime: number,
  eventType: CiEventType,
  parameters: CiParam[],
  causes: CiEventCause[],
  multiBranchType: MultiBranchType,
  parentCiId: string,
  phaseType?: PhaseType
): CiEvent => {
  const executorEvent: CiEvent = {
    buildCiId,
    eventType,
    number: runNumber,
    parentCiId,
    project: executorCiId,
    projectDisplayName: executorName,
    multiBranchType,
    startTime,
    branch: branchName,
    parameters,
    causes,
    phaseType,
    skipValidation: true
  };

  if (CiEventType.FINISHED === eventType) {
    executorEvent.duration = getRunDuration(
      event.workflow_run?.run_started_at,
      event.workflow_run?.updated_at
    );
    executorEvent.result = getRunResult(event.workflow_run?.conclusion);
  }

  return executorEvent;
};

const getEventType = (event: string | null | undefined): ActionsEventType => {
  switch (event) {
    case 'workflow_dispatch':
      return ActionsEventType.WORKFLOW_RUN; 
    case 'push':
      return ActionsEventType.PUSH; 
    case 'requested':
      return ActionsEventType.WORKFLOW_QUEUED;
    case 'in_progress':
      return ActionsEventType.WORKFLOW_STARTED;
    case 'completed':
      return ActionsEventType.WORKFLOW_FINISHED;
    case 'opened':
      return ActionsEventType.PULL_REQUEST_OPENED;
    case 'closed':
      return ActionsEventType.PULL_REQUEST_CLOSED;
    case 'reopened':
      return ActionsEventType.PULL_REQUEST_REOPENED;
    case 'edited':
      return ActionsEventType.PULL_REQUEST_EDITED;
    default:
      return ActionsEventType.UNKNOWN_EVENT;
  }
};

const getRunDuration = (
  startedAt: string | null | undefined,
  completedAt: string | null | undefined
): number => {
  if (!startedAt || !completedAt) {
    throw new Error(
      'Event should contain startedAt and completedAt workflow_run fields!'
    );
  }

  return new Date(completedAt).getTime() - new Date(startedAt).getTime();
};

const getRunResult = (conclusion: string | undefined | null): Result => {
  if (!conclusion) {
    throw new Error(
      'Event must contain a conclusion on Workflow Completed event!'
    );
  }

  switch (conclusion) {
    case WorkflowRunStatus.SUCCESS:
      return Result.SUCCESS;
    case WorkflowRunStatus.FAILURE:
    case WorkflowRunStatus.TIMED_OUT:
      return Result.FAILURE;
    case WorkflowRunStatus.CANCELLED:
      return Result.ABORTED;
    case WorkflowRunStatus.NEUTRAL:
    case WorkflowRunStatus.ACTION_REQUIRED:
    case WorkflowRunStatus.STALE:
      return Result.UNSTABLE;
    case WorkflowRunStatus.SKIPPED:
    default:
      return Result.UNAVAILABLE;
  }
};

export {
  generateRootExecutorEvent,
  getEventType,
  pollForJobsOfTypeToFinish
};
