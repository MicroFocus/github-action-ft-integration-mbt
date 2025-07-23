/*
 * Copyright 2022-2025 Open Text.
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

import fsExtra from 'fs-extra';
import OctaneClient from '../client/octaneClient';
import { Logger } from '../utils/logger';
import { JUnitParser } from '../reporting/JUnitParser';
import { TestResultManager } from '../reporting/TestResultManager';
import { BuildInfo } from '../reporting/interfaces';

const logger: Logger = new Logger('testResultsService');
  
const sendTestResults = async (serverId: string, jobId: string, buildId: number, resFullPath: string) => {
  logger.info(`sendTestResults: [${resFullPath}] ...`);
  const buildInfo: BuildInfo = {serverId, jobId, buildId};
  const parser = new JUnitParser(resFullPath); // TODO assets 
  const junitRes = await parser.parseResult();
  const mqmTestsXmlFilePath = await TestResultManager.buildOctaneXmlFile(buildInfo, junitRes);
  const octaneXml = await fsExtra.readFile(mqmTestsXmlFilePath, 'utf-8');

  try {
    await OctaneClient.sendTestResult(octaneXml/*, serverId, jobId, buildId*/);
  } catch (error) {
    logger.error(`Failed to send test results. Check if the 'testingFramework' parameter is configured in the integration workflow. Error: ${error}`);
  };

  logger.info('All test results have been sent successfully.');
};

const publishResultsToOctane = async (serverId: string, jobId: string, workflowRunId: number, resFullPath: string) => {
  logger.debug(`publishResultsToOctane: workflowRunId=${workflowRunId}, jobId=${jobId}, serverId=${serverId}, resFullPath=[${resFullPath}] ...`);
  //const resFileName = path.basename(resFullPath);
  await sendTestResults(serverId, jobId, workflowRunId, resFullPath);
  logger.info('JUnit test results processed and sent successfully.');
};

export { publishResultsToOctane };
