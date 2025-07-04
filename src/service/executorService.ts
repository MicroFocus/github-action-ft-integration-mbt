/*
 * Copyright 2016-2025 Open Text.
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

import OctaneClient from '../client/octaneClient';
import CiEvent from '../dto/octane/events/CiEvent';
import CiEventCause from '../dto/octane/events/CiEventCause';
import CiParam from '../dto/octane/events/CiParam';
import {
  CiEventType,
  PhaseType,
  Result
} from '../dto/octane/events/CiTypes';
import CiExecutor from '../dto/octane/general/CiExecutor';
import CiJob from '../dto/octane/general/CiJob';
import { Logger } from '../utils/logger';

const logger: Logger = new Logger('executorService');

const getOrCreateTestRunner = async (name: string, ciServerId: number, ciJob: CiJob): Promise<CiExecutor> => {
  const subType = "uft_test_runner";
  const entry = await OctaneClient.getExecutor(ciServerId, name, subType);

  if (entry) {
    return entry;
  }
  return await OctaneClient.createMbtTestRunner(name, ciServerId, ciJob);
};

const sendExecutorStartEvent = async (
  executorName: string,
  executorCiId: string,
  parentCiId: string,
  buildCiId: string,
  runNumber: string,
  branch: string,
  startTime: number,
  baseUrl: string,
  causes: CiEventCause[],
  parameters: CiParam[],
  ciServerInstanceId: string
): Promise<void> => {
  const evt: CiEvent = {
    buildCiId,
    eventType: CiEventType.STARTED,
    number: runNumber,
    parentCiId,
    project: executorCiId,
    projectDisplayName: executorName,
    startTime,
    branch,
    phaseType: PhaseType.INTERNAL,
    causes,
    parameters,
    skipValidation: true
  };

  await OctaneClient.sendEvents([evt], ciServerInstanceId, baseUrl);
};

const sendExecutorFinishEvent = async (
  executorName: string,
  executorCiId: string,
  parentCiId: string,
  buildCiId: string,
  runNumber: string,
  branch: string,
  startTime: number,
  baseUrl: string,
  causes: CiEventCause[],
  params: CiParam[],
  ciServerInstanceId: string,
  testResultExpected: boolean,
  result: Result
): Promise<void> => {
  const evt: CiEvent = {
    buildCiId: buildCiId,
    eventType: CiEventType.FINISHED,
    number: runNumber,
    parentCiId,
    project: executorCiId,
    projectDisplayName: executorName,
    startTime,
    branch,
    phaseType: PhaseType.INTERNAL,
    causes,
    parameters: params,
    duration: (new Date().getTime() - startTime),
    skipValidation: true,
    testResultExpected,
    result
  };
  logger.debug(`sendExecutorFinishEvent: `, evt);
  await OctaneClient.sendEvents([evt], ciServerInstanceId, baseUrl);
};

const buildExecutorName = (
  executorNamePattern: string,
  repositoryOwner: string,
  repositoryName: string,
  workflowName: string,
  workflowFileName: string
): string => {
  return executorNamePattern
    .replace('${repository_owner}', repositoryOwner)
    .replace('${repository_name}', repositoryName)
    .replace('${workflow_name}', workflowName)
    .replace('${workflow_file_name}', workflowFileName);
};

const getFrameworkId = (framework: string): string => {
  let frameworkId;

  switch (framework) {
    case 'mbt':
      frameworkId = 'list_node.je.framework.mbt';
      break;
    default:
      frameworkId = 'list_node.je.framework.uft';
  }
  return frameworkId;
};

export {
  getOrCreateTestRunner,
  buildExecutorName,
  sendExecutorStartEvent,
  sendExecutorFinishEvent
};
