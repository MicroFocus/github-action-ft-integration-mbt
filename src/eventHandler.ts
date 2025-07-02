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

import OctaneClient from './client/octaneClient';
import { getConfig } from './config/config';
import ActionsEvent from './dto/github/ActionsEvent';
import ActionsEventType from './dto/github/ActionsEventType';
import { getEventType } from './service/ciEventsService';
import { Logger } from './utils/logger';
import { saveSyncedCommit, getSyncedCommit, getSyncedTimestamp } from './utils/utils';
import { context } from '@actions/github';
import { getOrCreateTestRunner, sendExecutorStartEvent } from './service/executorService';
import Discovery from './discovery/Discovery';
import { UftoParamDirection } from './dto/ft/UftoParamDirection';
import { OctaneStatus } from './dto/ft/OctaneStatus';
import DiscoveryResult from './discovery/DiscoveryResult';
import { mbtPrepDiscoveryRes4Sync } from './discovery/mbtDiscoveryResultPreparer';
import { getOrCreateCiJob } from './service/ciJobService';
import { dispatchDiscoveryResults } from './discovery/mbtDiscoveryResultDispatcher';
import * as path from 'path';
import GitHubClient from './client/githubClient';
import { WorkflowInputs } from './dto/github/Workflow';
import TestParamsParser from './mbt/TestParamsParser';
import { getParamsFromConfig } from './service/parametersService';
import CiParam from './dto/octane/events/CiParam';
import MbtDataPrepConverter from './mbt/MbtDataPrepConverter';
import { MbtTestInfo } from './mbt/MbtTestData';
import TestData from './mbt/TestData';
import MbtPreTestExecuter from './mbt/MbtPreTestExecuter';
import { ExitCode } from './ft/ExitCode';
import FtTestExecuter from './ft/FtTestExecuter';
import { CiCausesType } from './dto/octane/events/CiTypes';
import { convertRootCauseType } from './service/eventCauseBuilder';

const _config = getConfig();
const _logger: Logger = new Logger('eventHandler');

export const handleCurrentEvent = async (): Promise<void> => {
  _logger.info('BEGIN handleEvent ...');

  if (_config.logLevel === 2) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('GITHUB_') || key.startsWith('RUNNER_')) {
        _logger.debug(`${key}=${value}`);
      }
    }
  }

  const event: ActionsEvent = context.payload;
  const eventName = context.eventName;

  //event && _logger.debug(`event = ${JSON.stringify(event)}`);

  const eventType = getEventType(event?.action || eventName);
  if (eventType === ActionsEventType.UNKNOWN_EVENT) {
    _logger.info('Unknown event type');
    return;
  }
  _logger.info(`eventType = ${event?.action || eventName}`);

  let workflowPath: string | undefined;
  if (eventType === ActionsEventType.PUSH) {
    workflowPath = await GitHubClient.getWorkflowPath(event.after!);
  } else {
    workflowPath = (typeof event.workflow === 'string') ? event.workflow : event.workflow?.path;
  }

  //const workflowName = event.workflow?.name;
  const ref: string | undefined = event.ref;
  let branch: string | undefined;

  if (ref && ref.startsWith('refs/heads/')) {
    branch = ref.replace('refs/heads/', '');
  } else {
    branch = event.workflow_run?.head_branch; // Fallback for other event types
  }

  if (!branch) {
    throw new Error('Could not determine branch name!');
  }

  if (!workflowPath) {
    throw new Error('Event should contain workflow file path!');
  }
  const workflowFileName = path.basename(workflowPath);

  _logger.info(`Current repository URL: ${_config.repoUrl}`);

  const workDir = process.cwd(); //.env.GITHUB_WORKSPACE || '.';
  _logger.info(`Working directory: ${workDir}`);
  _logger.info(`Testing tool type: ${_config.testingTool.toUpperCase()}`);
  const discovery = new Discovery(workDir);
  switch (eventType) {
    case ActionsEventType.WORKFLOW_RUN:
      const defaultParams = await getParamsFromConfig(_config.owner, _config.repo, workflowFileName, branch);
      const inputs = context.payload.inputs;
      _logger.debug(`Input params: ${JSON.stringify(inputs, null, 0)}`);
      if (inputs && hasExecutorKeys(defaultParams)) {
        const defaults: Record<string, string> = Object.fromEntries(defaultParams.map(param => [param.name, param.defaultValue ?? ""]));
        const wfis: WorkflowInputs = { executionId: inputs.executionId ?? '', suiteId: inputs.suiteId ?? '', suiteRunId: inputs.suiteRunId ?? '', testsToRun: inputs.testsToRun ?? '' };
        if (hasNoEmptyNorDefaultValue(wfis, defaults)) {
          const exitCode = await handleExecutorEvent(event, defaultParams, wfis, branch, workflowFileName);

          break;
        } else {
          _logger.debug(`Continue with discovery / sync ...`);
        }
      }
    case ActionsEventType.PUSH:
      const oldCommit = await getSyncedCommit();
      if (oldCommit) {
        const minSyncInterval = _config.minSyncInterval;
        _logger.info(`minSyncInterval = ${minSyncInterval} minutes.`);
        const isIntervalElapsed = await isMinSyncIntervalElapsed(minSyncInterval);
        if (!isIntervalElapsed) {
          _logger.warn(`The minimum time interval of ${minSyncInterval} minutes has not yet elapsed since the last sync.`);
          return;
        }
      }
      const discoveryRes = await discovery.startScanning(oldCommit);
      const tests = discoveryRes.getAllTests();
      const scmResxFiles = discoveryRes.getScmResxFiles();

      if (_logger.isDebugEnabled()) {
        console.log(`Tests: ${tests.length}`);
        for (const t of tests) {
          console.log(`${t.name}, type = ${t.uftOneTestType}`);
          console.log(`  packageName: ${t.packageName}`);
          console.log(`  executable: ${t.executable}`);
          console.log(`  isMoved: ${t.isMoved ?? false}`);
          console.log(`  octaneStatus: ${OctaneStatus.getName(t.octaneStatus)}`);
          t.changeSetSrc && console.log(`  changeSetSrc: ${t.changeSetSrc}`);
          t.changeSetDst && console.log(`  changeSetDst: ${t.changeSetDst}`);
          if (t.actions && t.actions.length > 0) {
            console.log(`  Actions:`);
            for (const a of t.actions) {
              console.log(`    ${a.name}`);
              if (a.parameters && a.parameters.length > 0) {
                console.log(`      Parameters:`);
                for (const p of a.parameters) {
                  console.log(`        ${p.name} - ${UftoParamDirection.getName(p.direction)}`);
                }
              }
            }
          }
        }
        scmResxFiles?.length && console.log(`Resource files: ${scmResxFiles.length}`, scmResxFiles);
        for (const f of scmResxFiles) {
          console.log(`Resource file: ${f.name}`);
          console.log(`  oldName: ${f.oldName ?? ""}`);
          console.log(`  relativePath: ${f.relativePath}`);
          f.oldRelativePath ?? console.log(`  oldPath: ${f.oldRelativePath}`);
          console.log(`  changeType: ${OctaneStatus.getName(f.octaneStatus)}`);
          console.log(`  isMoved: ${f.isMoved ?? false}`);
          f.changeSetSrc && console.log(`  changeSetSrc: ${f.changeSetSrc}`);
          f.changeSetDst && console.log(`  changeSetDst: ${f.changeSetDst}`);
        }
      }

      await doTestSync(discoveryRes, workflowFileName, branch!);
      const newCommit = discoveryRes.getNewCommit();
      if (newCommit !== oldCommit) {
        await saveSyncedCommit(newCommit);
      }
      break;
    default:
      _logger.info(`default -> eventType = ${eventType}`);
      break;
  }

  _logger.info('END handleEvent ...');

};

const handleExecutorEvent = async (event: ActionsEvent, defaultParams: CiParam[], wfis: WorkflowInputs, branch: string, workflowFileName: string): Promise<ExitCode> => {
  const startTime = new Date().getTime();
  const workflowRunId = event.workflow_run?.id ?? 0;
  const workflowRunNum = event.workflow_run?.run_number ?? 0;
  const workDir = process.cwd();
  _logger.debug(`handleExecutorEvent: ...`);
  const execParams = generateExecParams(defaultParams, wfis);
  const { ciServerInstanceId, ciServerName, executorName, ciId, parentCiId } = getCiPredefinedVals(branch, workflowFileName);
  const ciServer = await OctaneClient.getCiServer(ciServerInstanceId, ciServerName);
  if (!ciServer) {
    _logger.error(`Could not find CI server with instanceId: ${ciServerInstanceId}`);
    return ExitCode.Aborted;
  };
  // TODO updatePluginVersionIfNeeded ?
  const login = event.workflow_run?.triggering_actor.login;
  const startEventCauses = [
    {
      buildCiId: `${workflowRunId}`,
      project: ciId,
      type: CiCausesType.UPSTREAM,
      userId: login,
      userName: login,
      causes: [
        {
          buildCiId: `${workflowRunId}`,
          project: parentCiId,
          type: convertRootCauseType(event.workflow_run?.event),
          userId: login,
          userName: login
        }
      ]
    }
  ];

  await sendExecutorStartEvent(event, executorName, ciId, parentCiId, `${workflowRunId}`, `${workflowRunNum}`, branch, startTime,
    _config.repoUrl, execParams, startEventCauses, ciServer);

  const testDataMap = TestParamsParser.parseTestData(wfis.testsToRun);
  _logger.debug("TestData: ", testDataMap);

  const mbtTestSuiteData = await OctaneClient.getMbtTestSuiteData(parseInt(wfis.suiteRunId));
  const mbtTestInfos: MbtTestInfo[] = [];
  const repoFolderPath = workDir;

  for (const [runId, mbtTestData] of mbtTestSuiteData.entries()) {
    const mbtTestInfo = MbtDataPrepConverter.buildMbtTestInfo(repoFolderPath, runId, mbtTestData, testDataMap);
    mbtTestInfos.push(mbtTestInfo);
    _logger.debug(JSON.stringify(mbtTestInfo, null, 2));
  };
  let exitCode = await MbtPreTestExecuter.preProcess(mbtTestInfos);
  if (exitCode === ExitCode.Passed) {
    exitCode = await FtTestExecuter.preProcess(mbtTestInfos);
  }
  return exitCode;

  //TODO
}

const isMinSyncIntervalElapsed = async (minSyncInterval: number) => {
  const lastSyncedTimestamp = await getSyncedTimestamp();
  const currentTimestamp = new Date().getTime();
  const timeDiffMinutes = (currentTimestamp - lastSyncedTimestamp) / (60000);
  return timeDiffMinutes >= minSyncInterval;
}

const doTestSync = async (discoveryRes: DiscoveryResult, workflowFileName: string, branch: string) => {
  const { ciServerInstanceId, ciServerName, executorName, ciId } = getCiPredefinedVals(branch, workflowFileName);

  const ciServer = await OctaneClient.getOrCreateCiServer(ciServerInstanceId, ciServerName);
  const ciJob = await getOrCreateCiJob(executorName, ciId, ciServer, branch);
  _logger.debug(`Ci Job id: ${ciJob.id}, name: ${ciJob.name}, ci_id: ${ciJob.ci_id}`);
  const tr = await getOrCreateTestRunner(executorName, ciServer.id, ciJob);
  _logger.debug(`ci_server.id: ${tr.ci_server.id}, ci_job.id: ${tr.ci_job.id}, scm_repository.id: ${tr.scm_repository.id}`);
  await mbtPrepDiscoveryRes4Sync(tr.id, tr.scm_repository.id, discoveryRes);
  await dispatchDiscoveryResults(tr.id, tr.scm_repository.id, discoveryRes);
}

function getCiPredefinedVals(branch: string, workflowFileName: string) {
  const ciServerInstanceId = `GHA-MBT-${_config.owner}`;
  const ciServerName = `GHA-MBT-${_config.owner}`;
  const executorName = `GHA-MBT-${_config.owner}.${_config.repo}.${branch}.${workflowFileName}`;
  const ciId = `${_config.owner}/${_config.repo}/${workflowFileName}/executor/${branch}`;
  const parentCiId = `${_config.owner}/${_config.repo}/${workflowFileName}/executor`;

  return { ciServerInstanceId, ciServerName, executorName, ciId, parentCiId };
}

// Helper function to check if all required keys are present in ciParams
function hasExecutorKeys(params: CiParam[]): boolean {
  if (!params?.length) {
    return false;
  }
  const requiredKeys: (keyof WorkflowInputs)[] = Object.keys({} as WorkflowInputs).map(key => key as keyof WorkflowInputs);
  return requiredKeys.every(key => params.some(param => param.name === key));
}

// Helper function to check if all values in wfi are non-empty and different from their corresponding defaults
function hasNoEmptyNorDefaultValue(wfi: WorkflowInputs, defaults: Record<string, string>): boolean {
  const keys: (keyof WorkflowInputs)[] = Object.keys({} as WorkflowInputs).map(key => key as keyof WorkflowInputs);
  return keys.every(key => wfi[key] && wfi[key] !== defaults[key]);
}

// Function to generate execParams based on defaultParams and wfi
function generateExecParams(defaultParams: CiParam[], wfi: WorkflowInputs): CiParam[] {
  return defaultParams.map(param => {
    if (param.name in wfi) {
      return {
        ...param,
        value: wfi[param.name as keyof WorkflowInputs]
      };
    }
    return param;
  });
}