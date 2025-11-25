/*
 * Copyright 2025 Open Text.
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

import { notice } from '@actions/core';
import OctaneClient from './client/octaneClient';
import { config } from './config/config';
import ActionsEvent from './dto/github/ActionsEvent';
import ActionsEventType from './dto/github/ActionsEventType';
import { Logger } from './utils/logger';
import { saveSyncedCommit, getSyncedCommit, getSyncedTimestamp, getEventType } from './utils/utils';
import { context } from '@actions/github';
import { getCreateOrUpdateTestRunner, sendExecutorFinishEvent, sendExecutorStartEvent } from './service/executorService';
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
import { publishResultsToOctane } from './service/testResultsService';
import * as fs from 'fs';
import FTL from './ft/FTL';
import { PLUGIN_VERSION, SEP } from './utils/constants';

const logger: Logger = new Logger('eventHandler');
const requiredKeys: WorkflowInputsKeys[] = ['executionId', 'suiteId', 'suiteRunId', 'testsToRun'];

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
          //TODO use exitCode ?
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
          const msg = `The minimum time interval of ${minSyncInterval} minutes has not yet elapsed since the last sync.`;
          logger.warn(msg);
          notice(msg, { title: 'Run Canceled' });
          await GitHubClient.cancelWorkflowRun();
          return;
        }
      }
      const discoveryRes = await discovery.startScanning(oldCommit);
      const tests = discoveryRes.getAllTests();

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
  // END of handleCurrentEvent function

  async function handleExecutorEvent(defaultParams: CiParam[], wfis: WorkflowInputs): Promise<ExitCode> {
    const workflowRunId = context.runId;
    const workflowRunNum = context.runNumber;
    const workDir = process.cwd();
    logger.debug(`handleExecutorEvent: ...`);
    const execParams = generateExecParams(defaultParams, wfis);
    const { ciServerInstanceId, executorName, ciId, parentCiId } = getCiPredefinedVals(branch!, ymlFileName);
    const ciServer = await OctaneClient.getCiServer(ciServerInstanceId);
    if (!ciServer) {
      logger.error(`handleExecutorEvent: Could not find CI server with instanceId: ${ciServerInstanceId}`);
      return ExitCode.Aborted;
    };
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

    const tmpFullPath = path.join(config.runnerWorkspacePath, FTL._TMP);
    if (fs.existsSync(tmpFullPath)) {
      await cleanupTempFolder(tmpFullPath);
    } else {
      logger.debug(`handleExecutorEvent: creating ${tmpFullPath} ...`);
      await fs.promises.mkdir(tmpFullPath, { recursive: true });
    }

    const { ok, mbtPropsFullPath }  = await MbtPreTestExecuter.preProcess(mbtTestInfos);
    if (ok) {
      const { exitCode, resFullPath, propsFullPath, mtbxFullPath } = await FtTestExecuter.process(mbtTestInfos);
      const res = (exitCode === ExitCode.Passed ? Result.SUCCESS : (exitCode === ExitCode.Unstable ? Result.UNSTABLE : Result.FAILURE));
      await publishResultsToOctane(ciServerInstanceId, ciId, workflowRunId, resFullPath);
      await sendFinishEvent(res, true);
      await GitHubClient.uploadArtifact(config.runnerWorkspacePath, [mbtPropsFullPath, propsFullPath, mtbxFullPath, resFullPath], `temp_files`);
      logger.info(`handleExecutorEvent: Finished with exitCode=${exitCode}.`);
      return exitCode;
    } else {
      await sendFinishEvent(Result.ABORTED, false);
      logger.error(`handleExecutorEvent: Failed to convert MBT tests. ExitCode=${ExitCode.Aborted}`);
      return ExitCode.Aborted;
    };
    async function sendFinishEvent(res: Result, testResExpected: boolean) {
      await sendExecutorFinishEvent(executorName, ciId, parentCiId, `${workflowRunId}`, `${workflowRunNum}`, branch!, startTime, ciServer?.url!, causes, execParams, ciServerInstanceId, testResExpected, res);
    }
  }
};

const cleanupTempFolder = async (tmpFullPath: string) => {
  logger.debug(`cleanupTempFolder: ${tmpFullPath}`);

  try {
    // Check if the path exists and is a directory
    const stats = await fs.promises.stat(tmpFullPath);
    if (!stats.isDirectory()) {
      logger.warn(`cleanupTempFolder: ${tmpFullPath} is not a directory`);
      return;
    }

    const items = await fs.promises.readdir(tmpFullPath, { withFileTypes: true });

    // Delete all items in parallel
    await Promise.all(
      items.map(async (item) => {
        const fullPath = path.join(tmpFullPath, item.name);
        try {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
        } catch (error) {
          logger.warn(`cleanupTempFolder: Failed to delete ${fullPath}: ${error}`);
        }
      })
    );
  } catch (error) {
    logger.warn(`cleanupTempFolder: ${error}`);
  }
};

const isMinSyncIntervalElapsed = async (minSyncInterval: number): Promise<boolean> => {
  const lastSyncedTimestamp = await getSyncedTimestamp();
  const dtNow = new Date();
  logger.debug(`Current Time: ${dtNow.toISOString() }`);
  const timeDiffMinutes = (dtNow.getTime() - lastSyncedTimestamp) / (60000);
  logger.debug(`Time since last sync: ${timeDiffMinutes.toFixed(2)} minutes.`);
  return Number(timeDiffMinutes) >= minSyncInterval;
}

const doTestSync = async (discoveryRes: DiscoveryResult, ymlFileName: string, branch: string) => {
  const { ciServerInstanceId, executorName, ciId } = getCiPredefinedVals(branch, ymlFileName);

  const ciServer = await OctaneClient.getOrCreateCiServer(ciServerInstanceId);
  const ciJob = await getOrCreateCiJob(executorName, ciId, ciServer, branch);
  logger.debug(`Ci Job id: ${ciJob.id}, name: ${ciJob.name}, ci_id: ${ciJob.ci_id}`);
  const tr = await getCreateOrUpdateTestRunner(executorName, ciServer.id, ciJob);
  logger.debug(`ci_server.id: ${tr.ci_server.id}, ci_job.id: ${tr.ci_job.id}, scm_repository.id: ${tr.scm_repository.id}`);
  await mbtPrepDiscoveryRes4Sync(tr.id, tr.scm_repository.id, discoveryRes);
  await dispatchDiscoveryResults(tr.id, tr.scm_repository.id, discoveryRes);
}

function getCiPredefinedVals(branch: string, ymlFileName: string) {
  const ymlFileNameWithoutExt = path.basename(ymlFileName, path.extname(ymlFileName));
  const ciServerInstanceId = `GHA-MBT~${config.owner}~${config.repo}`;
  const executorName = `GHA-MBT~${config.owner}.${config.repo}.${branch}.${ymlFileNameWithoutExt}`;
  const parentCiId = `${PLUGIN_VERSION}${SEP}${config.owner}${SEP}${config.repo}${SEP}${ymlFileName}${SEP}executor`;
  const ciId = `${parentCiId}${SEP}${branch}`;
  return { ciServerInstanceId, executorName, ciId, parentCiId };
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