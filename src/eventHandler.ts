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
import { config } from './config/config';
import ActionsEvent from './dto/github/ActionsEvent';
import ActionsEventType from './dto/github/ActionsEventType';
import { getEventType } from './service/ciEventsService';
import { Logger } from './utils/logger';
import { saveSyncedCommit, getSyncedCommit, getSyncedTimestamp } from './utils/utils';
import { context } from '@actions/github';
import { getOrCreateTestRunner, sendExecutorFinishEvent, sendExecutorStartEvent } from './service/executorService';
import Discovery from './discovery/Discovery';
import { UftoParamDirection } from './dto/ft/UftoParamDirection';
import { OctaneStatus } from './dto/ft/OctaneStatus';
import DiscoveryResult from './discovery/DiscoveryResult';
import { mbtPrepDiscoveryRes4Sync } from './discovery/mbtDiscoveryResultPreparer';
import { getOrCreateCiJob } from './service/ciJobService';
import { dispatchDiscoveryResults } from './discovery/mbtDiscoveryResultDispatcher';
import * as path from 'path';
import GitHubClient from './client/githubClient';
import { WorkflowInputs, WorkflowInputsKeys } from './dto/github/Workflow';
import TestParamsParser from './mbt/TestParamsParser';
import { getParamsFromConfig } from './service/parametersService';
import CiParam from './dto/octane/events/CiParam';
import MbtDataPrepConverter from './mbt/MbtDataPrepConverter';
import { MbtTestInfo } from './mbt/MbtTestData';
import MbtPreTestExecuter from './mbt/MbtPreTestExecuter';
import { ExitCode } from './ft/ExitCode';
import FtTestExecuter from './ft/FtTestExecuter';
import { CiCausesType, Result } from './dto/octane/events/CiTypes';
import { convertJUnitXMLToOctaneXML } from '@microfocus/alm-octane-test-result-convertion';
import { sendJUnitTestResults } from './service/testResultsService';

const logger: Logger = new Logger('eventHandler');
const requiredKeys: WorkflowInputsKeys[] = ['executionId', 'suiteId', 'suiteRunId'];

export const handleCurrentEvent = async (): Promise<void> => {
  logger.info('BEGIN handleEvent ...');
  const startTime = new Date().getTime();

  if (config.logLevel === 2) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('GITHUB_') || key.startsWith('RUNNER_')) {
        logger.debug(`${key}=${value}`);
      }
    }
  }

  const event: ActionsEvent = context.payload;
  const eventName = context.eventName ?? event.name;

  logger.debug("context:", context);

  const eventType = getEventType(eventName);
  if (eventType === ActionsEventType.UNKNOWN_EVENT) {
    logger.error('Unknown event type');
    return;
  }
  logger.info(`eventType = ${eventName}`);

  let ymlFullPath: string | undefined;
  if (eventType === ActionsEventType.PUSH) {
    ymlFullPath = await GitHubClient.getWorkflowPath(event.after!);
  } else {
    ymlFullPath = (typeof event.workflow === 'string') ? event.workflow : event.workflow?.path;
  }

  //const workflowName = event.workflow?.name;
  const ref: string | undefined = event.ref;
  let branch: string | undefined;
  if (ref && ref.startsWith('refs/heads/')) {
    branch = ref.slice(11);  // 'refs/heads/' has 11 characters
  } else {
    branch = event.repository?.default_branch ?? event.repository?.master_branch;
  }
  if (!branch) {
    throw new Error('Could not determine branch name!');
  }

  if (!ymlFullPath) {
    throw new Error('Event should contain workflow file path!');
  }
  const ymlFileName = path.basename(ymlFullPath);

  logger.info(`Current repository URL: ${config.repoUrl}`);

  const workDir = process.cwd(); //.env.GITHUB_WORKSPACE || '.';
  logger.info(`Working directory: ${workDir}`);
  logger.info(`Testing tool type: ${config.testingTool.toUpperCase()}`);
  const discovery = new Discovery(workDir);
  switch (eventType) {
    case ActionsEventType.WORKFLOW_DISPATCH:
      const defaultParams = await getParamsFromConfig(ymlFileName, branch);
      const inputs = context.payload.inputs;
      logger.debug(`Input params: ${JSON.stringify(inputs, null, 0)}`);
      if (inputs && hasExecutorKeys(defaultParams)) {
        const defaults: Record<string, string> = Object.fromEntries(defaultParams.map(param => [param.name, param.defaultValue ?? ""]));
        const wfis: WorkflowInputs = { executionId: inputs.executionId ?? '', suiteId: inputs.suiteId ?? '', suiteRunId: inputs.suiteRunId ?? '', testsToRun: inputs.testsToRun ?? '' };
        if (hasNoEmptyOrDefaultValue(wfis, defaults)) {
          const testsToRun = wfis.testsToRun.trim();
          if (!testsToRun || testsToRun === defaults["testsToRun"]) {
            throw new Error(`Invalid or missing tests to run specified in the workflow`);
          }
          const exitCode = await handleExecutorEvent(defaultParams, wfis);
          //TODO use exitCode
          break;
        } else {
          logger.debug(`Continue with discovery / sync ...`);
        }
      }
    case ActionsEventType.PUSH:
      const oldCommit = await getSyncedCommit();
      if (oldCommit) {
        const minSyncInterval = config.minSyncInterval;
        logger.info(`minSyncInterval = ${minSyncInterval} minutes.`);
        const isIntervalElapsed = await isMinSyncIntervalElapsed(minSyncInterval);
        if (!isIntervalElapsed) {
          logger.warn(`The minimum time interval of ${minSyncInterval} minutes has not yet elapsed since the last sync.`);
          return;
        }
      }
      const discoveryRes = await discovery.startScanning(oldCommit);
      const tests = discoveryRes.getAllTests();
      const scmResxFiles = discoveryRes.getScmResxFiles();

      if (logger.isDebugEnabled()) {
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

      await doTestSync(discoveryRes, ymlFileName, branch!);
      const newCommit = discoveryRes.getNewCommit();
      if (newCommit !== oldCommit) {
        await saveSyncedCommit(newCommit);
      }
      break;
    default:
      logger.info(`default -> eventType = ${eventType}`);
      break;
  }

  logger.info('END handleEvent ...');
  // EOD of handleCurrentEvent function

  async function handleExecutorEvent(defaultParams: CiParam[], wfis: WorkflowInputs): Promise<ExitCode> {
    const workflowRunId = context.runId;
    const workflowRunNum = context.runNumber;
    const workDir = process.cwd();
    logger.debug(`handleExecutorEvent: ...`);
    const execParams = generateExecParams(defaultParams, wfis);
    const { ciServerInstanceId, ciServerName, executorName, ciId, parentCiId } = getCiPredefinedVals(branch!, ymlFileName);
    const ciServer = await OctaneClient.getCiServer(ciServerInstanceId, ciServerName);
    if (!ciServer) {
      logger.error(`handleExecutorEvent: Could not find CI server with instanceId: ${ciServerInstanceId}`);
      return ExitCode.Aborted;
    };
    // TODO updatePluginVersionIfNeeded ?
    const causes = [
      {
        buildCiId: `${workflowRunId}`,
        project: ciId,
        type: CiCausesType.USER,
        userId: context.actor, // or process.env.GITHUB_ACTOR
        userName: context.actor
      }
    ];

    await sendExecutorStartEvent(executorName, ciId, parentCiId, `${workflowRunId}`, `${workflowRunNum}`, branch!, startTime, ciServer.url, causes, execParams, ciServerInstanceId);

    const testDataMap = TestParamsParser.parseTestData(wfis.testsToRun);
    const mbtTestSuiteData = await OctaneClient.getMbtTestSuiteData(parseInt(wfis.suiteRunId));
    const mbtTestInfos: MbtTestInfo[] = [];
    const repoFolderPath = workDir;

    for (const [runId, mbtTestData] of mbtTestSuiteData.entries()) {
      const mbtTestInfo = MbtDataPrepConverter.buildMbtTestInfo(repoFolderPath, runId, mbtTestData, testDataMap);
      mbtTestInfos.push(mbtTestInfo);
      logger.debug(JSON.stringify(mbtTestInfo, null, 2));
    };
    const ok = await MbtPreTestExecuter.preProcess(mbtTestInfos);
    if (ok) {
      const { exitCode, resFullPath } = await FtTestExecuter.process(mbtTestInfos);
      const res = (exitCode === ExitCode.Passed ? Result.SUCCESS : (exitCode === ExitCode.Unstable ? Result.UNSTABLE : Result.FAILURE));
      await sendFinishEvent(res);
      await sendJUnitTestResults(workflowRunId, ciId, ciServerInstanceId, resFullPath);
      // TODO check TestResultServiceImpl.publishResultsToOctane
      logger.info(`handleExecutorEvent: Finished with exitCode=${exitCode}.`);
      return exitCode;
    } else {
      await sendFinishEvent(Result.ABORTED);
      logger.error(`handleExecutorEvent: Failed to convert MBT tests. ExitCode=${ExitCode.Aborted}`);
      return ExitCode.Aborted;
    };
    async function sendFinishEvent(res: Result) {
      await sendExecutorFinishEvent(executorName, ciId, parentCiId, `${workflowRunId}`, `${workflowRunNum}`, branch!, startTime, ciServer?.url!, causes, execParams, ciServerInstanceId, res);
    }
  }
};

const isMinSyncIntervalElapsed = async (minSyncInterval: number) => {
  const lastSyncedTimestamp = await getSyncedTimestamp();
  const currentTimestamp = new Date().getTime();
  const timeDiffMinutes = (currentTimestamp - lastSyncedTimestamp) / (60000);
  return timeDiffMinutes >= minSyncInterval;
}

const doTestSync = async (discoveryRes: DiscoveryResult, ymlFileName: string, branch: string) => {
  const { ciServerInstanceId, ciServerName, executorName, ciId } = getCiPredefinedVals(branch, ymlFileName);

  const ciServer = await OctaneClient.getOrCreateCiServer(ciServerInstanceId, ciServerName);
  const ciJob = await getOrCreateCiJob(executorName, ciId, ciServer, branch);
  logger.debug(`Ci Job id: ${ciJob.id}, name: ${ciJob.name}, ci_id: ${ciJob.ci_id}`);
  const tr = await getOrCreateTestRunner(executorName, ciServer.id, ciJob);
  logger.debug(`ci_server.id: ${tr.ci_server.id}, ci_job.id: ${tr.ci_job.id}, scm_repository.id: ${tr.scm_repository.id}`);
  await mbtPrepDiscoveryRes4Sync(tr.id, tr.scm_repository.id, discoveryRes);
  await dispatchDiscoveryResults(tr.id, tr.scm_repository.id, discoveryRes);
}

function getCiPredefinedVals(branch: string, ymlFileName: string) {
  const ymlFileNameWithoutExt = path.basename(ymlFileName, path.extname(ymlFileName));
  const ciServerInstanceId = `GHA-MBT-${config.owner}`;
  const ciServerName = `GHA-MBT-${config.owner}`;
  const executorName = `GHA-MBT-${config.owner}.${config.repo}.${branch}.${ymlFileNameWithoutExt}`;
  const parentCiId = `${config.owner}/${config.repo}/${ymlFileName}/executor`;
  const ciId = `${parentCiId}/${branch}`;
  return { ciServerInstanceId, ciServerName, executorName, ciId, parentCiId };
}

// Helper function to check if all required keys are present in ciParams
function hasExecutorKeys(params: CiParam[]): boolean {
  if (!params?.length) {
    return false;
  }
  return requiredKeys.every(key => params.some(param => param.name === key));
}

// Helper function to check if all values in wfi are non-empty and different from their corresponding defaults
function hasNoEmptyOrDefaultValue(wfis: WorkflowInputs, defaults: Record<string, string>): boolean {
  return requiredKeys.every(key => wfis[key] && wfis[key] !== defaults[key]);
}

// Function to generate execParams based on defaultParams and wfi
function generateExecParams(defaultParams: CiParam[], wfi: WorkflowInputs): CiParam[] {
  return defaultParams
    .filter(param => requiredKeys.includes(param.name as keyof WorkflowInputs))
    .map(param => ({
      name: param.name,
      value: wfi[param.name as keyof WorkflowInputs]
    }));
}