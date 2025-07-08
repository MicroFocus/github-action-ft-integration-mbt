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

import CiParam from '../dto/octane/events/CiParam';
import GitHubClient from '../client/githubClient';
import { Logger } from '../utils/logger';
import yaml from 'yaml';

const logger: Logger = new Logger('parametersService');

const getParamsFromConfig = async (workflowFileName: string, branchName?: string): Promise<CiParam[]> => {
  let configParameters: CiParam[] = [];

  const content = await getWorkflowFileContent(workflowFileName, branchName);
  if (!content) {
    return configParameters;
  }

  configParameters = parseYamlToCiParameters(content);

  return configParameters;
};

const getWorkflowFileContent = async (
  workflowFileName: string,
  branchName?: string
): Promise<string | undefined> => {
  const fileContent = await GitHubClient.getWorkflowFile(
    workflowFileName,
    branchName
  );
  if (fileContent.encoding !== 'base64') {
    logger.error(
      `The content of the workflow's configuration file has an unknown encoding: ${fileContent.encoding}`
    );
    return undefined;
  }

  logger.debug(`Decoding the content of the workflow's configuration file...`);
  let singleLineContent = fileContent.content.replace(/\n/g, '');
  let decodedContent = Buffer.from(singleLineContent, 'base64').toString(
    'utf-8'
  );

  return decodedContent;
};

const parseYamlToCiParameters = (yamlContent: string): CiParam[] => {
  const ciParameters: CiParam[] = [];
  const parsedObject = yaml.parse(yamlContent);
  if (!parsedObject) {
    return ciParameters;
  }

  const onSection = parsedObject.on;
  if (!onSection) {
    return ciParameters;
  }

  const workflowDispatchSection = onSection.workflow_dispatch;
  if (!workflowDispatchSection) {
    return ciParameters;
  }

  const inputs = workflowDispatchSection.inputs;
  if (!inputs) {
    return ciParameters;
  }

  for (const [name, details] of Object.entries(inputs)) {
    const inputDetails = details as {
      //description: string;
      default: string;
      //options: string[];
      //type: string;
    };
    const ciParameter: CiParam = {
      name: name,
      //description: inputDetails.description,
      defaultValue: inputDetails.default,
      //choices: inputDetails.options,
      //type: 'string'
    };
    ciParameters.push(ciParameter);
    logger.debug(
      `Found parameter in configuration file with ${JSON.stringify(ciParameter)}.`
    );
  }

  return ciParameters;
};

export { getParamsFromConfig };
