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

import AdmZip from 'adm-zip';
import {
  convertJUnitXMLToOctaneXML
} from '@microfocus/alm-octane-test-result-convertion';
import fsExtra from 'fs-extra';
import GitHubClient from '../client/githubClient';
import OctaneClient from '../client/octaneClient';
import { Logger } from '../utils/logger';
import OctaneBuildConfig from '@microfocus/alm-octane-test-result-convertion/dist/service/OctaneBuildConfig';
import { stringToFrameworkType } from '@microfocus/alm-octane-test-result-convertion/dist/model/common/FrameworkType';
import { globby } from 'globby';

const logger: Logger = new Logger('testResultsService');
const ARTIFACTS_DIR = 'artifacts';

const processArtifacts = async (workflowRunId: number, buildContext: OctaneBuildConfig,
  convertFunction: (
    content: string,
    options: any,
    ...extraParams: any[]
  ) => string,
  extraConvertParams: any[] = []
) => {
  logger.info(`processArtifacts: workflowRunId=${workflowRunId}`);

  const runArtifacts = await GitHubClient.getWorkflowRunArtifacts(workflowRunId);

  logger.info(`Found ${runArtifacts.length} artifacts for processing.`);
  fsExtra.ensureDirSync(ARTIFACTS_DIR);

  for (const artifact of runArtifacts) {
    const artifactId = artifact.id;
    const fileName = `${ARTIFACTS_DIR}/${artifact.name}.zip`;
    logger.debug(`processArtifacts: Downloading artifact: ${artifact.name} (ID: ${artifactId})`);

    const artifactZipBytes = await GitHubClient.downloadArtifact(artifactId);
    fsExtra.writeFileSync(fileName, new Uint8Array(artifactZipBytes));

    logger.debug(`processArtifacts: Extracting artifact: ${artifact.name}`);
    const zip = new AdmZip(fileName);
    zip.extractAllTo(ARTIFACTS_DIR);

    logger.debug(`processArtifacts: Cleaning up temporary zip file: ${fileName}`);
    fsExtra.rmSync(fileName);

    const reportFiles = await findReportFiles();

    await sendTestResults(
      reportFiles,
      convertFunction,
      {
        ...buildContext,
        artifact_id: artifactId.toString()
      },
      extraConvertParams
    );

    logger.debug(`processArtifacts: Cleaning up processed artifact directory: '${ARTIFACTS_DIR}'`);
    fsExtra.emptyDirSync(ARTIFACTS_DIR);
  }

  logger.info('processArtifacts: All artifacts have been processed successfully.');
};

const findReportFiles = async (): Promise<string[]> => {
  logger.info(`findReportFiles: ...`);

  const globSearchDestination = `${process.cwd()}/${ARTIFACTS_DIR}`;
  const pattern = "**/test-results/**/*.xml"; // TODO Adjust this pattern as needed
  const reportFiles = await globby(pattern, { cwd: globSearchDestination });

  logger.info(`Search completed. Found ${reportFiles.length} test result files matching the pattern.`);

  return reportFiles;
};

const sendTestResults = async (
  reportFiles: string[],
  convertFunction: (content: string, options: any, ...extraParams: any[]) => string,
  buildContext: OctaneBuildConfig,
  extraConvertParams: any[] = []
) => {
  logger.info(`sendTestResults: reportFiles.length=${reportFiles.length} ...`);

  for (const reportFile of reportFiles) {
    logger.debug(`Reading test results file: '${reportFile}'`);
    const fileContent = fsExtra.readFileSync(
      `${ARTIFACTS_DIR}/${reportFile}`,
      'utf-8'
    );

    logger.debug(`Converting test results file: '${reportFile}'`);
    const convertedXML = convertFunction(fileContent, buildContext, ...extraConvertParams);

    logger.debug(`Sending converted test results for file '${reportFile}', artifactId '${buildContext.artifact_id}', and serverId '${buildContext.server_id}'`);
    logger.debug(`Converted XML: ${convertedXML}`);

    try {
      await OctaneClient.sendTestResult(convertedXML, buildContext.server_id, buildContext.job_id, buildContext.build_id)
    } catch (error) {
      logger.error(`Failed to send test results. Check if the 'testingFramework' parameter is configured in the integration workflow. Error: ${error}`);
    };
  }

  logger.info('All test results have been sent successfully.');
};

const sendJUnitTestResults = async (workflowRunId: number, buildId: string, jobId: string, serverId: string, framework?: string, isExecutor?: boolean) => {
  logger.info('sendJUnitTestResults: ...');

  const buildContext: OctaneBuildConfig = { server_id: serverId, build_id: buildId, job_id: jobId, external_run_id: isExecutor ? undefined : `${workflowRunId}` };

  await processArtifacts(workflowRunId, buildContext, convertJUnitXMLToOctaneXML, framework ? [stringToFrameworkType(framework)] : undefined);
  logger.info('JUnit test results processed and sent successfully.');
};

export { sendJUnitTestResults };
