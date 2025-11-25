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

import * as fs from 'fs/promises';
import { existsSync, lstatSync } from 'fs';
import * as path from 'path';
import { UftoTestType } from '../dto/ft/UftoTestType';
import { context } from '@actions/github';
import * as git from 'isomorphic-git';
import { Logger } from './logger';
import AutomatedTest from '../dto/ft/AutomatedTest';
import { DOMParser, Document } from '@xmldom/xmldom';
import { TspParseError } from './TspParseError';
import * as CFB from 'cfb';
import ActionsEventType from '../dto/github/ActionsEventType';

// File to store the string (hidden file to avoid cluttering the repo)
const SYNCED_COMMIT_SHA = path.join(process.cwd(), '.synced-commit-sha');
const SYNCED_TIMESTAMP = path.join(process.cwd(), '.synced-timestamp');
const ACTIONS_XML = 'actions.xml';
const COMPONENT_INFO = "ComponentInfo";
const GUI_TEST_FILE = 'Test.tsp';
const API_ACTIONS_FILE = "actions.xml";//api test
const TEXT_XML = "text/xml";
const _TSP = '.tsp';
const _ST = '.st';
const UTF8 = 'utf8';
const logger: Logger = new Logger('utils');

async function getHeadCommitSha(dir: string): Promise<string> {
  return context.sha ?? git.resolveRef({ fs, dir, ref: 'HEAD' });
}

/**
 * Stores a string in the working directory
 * @param newCommit The string to store
 */
async function saveSyncedCommit(newCommit: string): Promise<void> {
  if (isBlank(newCommit))
    return;
  try {
    await fs.writeFile(SYNCED_COMMIT_SHA, newCommit.trim(), UTF8);
    logger.debug(`Newly synced commit ${newCommit} saved to [${SYNCED_COMMIT_SHA}]`);
    await saveSyncedTimestamp();
  } catch (error) {
    throw new Error(`Failed to save string: ${(error as Error).message}`);
  }
}

/**
 * Retrieves the stored string from the working directory
 * @returns The stored string, or undefined if the file doesn't exist
 */
async function getSyncedCommit(): Promise<string> {
  try {
    const data = await fs.readFile(SYNCED_COMMIT_SHA, UTF8);
    logger.debug(`Last synced commit: ${data} loaded from [${SYNCED_COMMIT_SHA}]`);
    return data.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(`File doesn't exist yet [${SYNCED_COMMIT_SHA}]`);
      return "";
    }
    throw new Error(`Failed to load string: ${(error as Error).message}`);
  }
}

async function saveSyncedTimestamp(): Promise<void> {
  try {
    const currentTime = new Date().toISOString();
    await fs.writeFile(SYNCED_TIMESTAMP, currentTime, UTF8);
    logger.debug(`Newly run timestamp ${currentTime} saved to [${SYNCED_TIMESTAMP}]`);
  } catch (error) {
    throw new Error(`Failed to save string: ${(error as Error).message}`);
  }
}

async function getSyncedTimestamp(): Promise<number> {
  try {
    const str = await fs.readFile(SYNCED_TIMESTAMP, UTF8);
    logger.debug(`Last synced timestamp: ${str} loaded from [${SYNCED_TIMESTAMP}]`);
    return new Date(str).getTime();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist yet, return 0
      return 0;
    }
    throw new Error(`Failed to load string: ${(error as Error).message}`);
  }
}

function isTestMainFile(file: string): boolean {
  const f = file.toLowerCase();
  return f.endsWith(_TSP) || f.endsWith(_ST) || f === ACTIONS_XML;
}

function getParentFolderFullPath(fullFilePath: string): string {
  const resolvedPath = path.resolve(fullFilePath);
  return path.dirname(resolvedPath);
}

function getTestType(filePath: string): UftoTestType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === _ST || filePath == ACTIONS_XML) {
    return UftoTestType.API;
  } else if (ext === _TSP) {
    return UftoTestType.GUI;
  }

  return UftoTestType.None;
}

/**
 * Checks if a string is blank, empty or contains only whitespace.
 * @param str The string to check.
 * @returns True if the string is null, undefined, empty, or contains only whitespace.
 */
function isBlank(str: string | null | undefined): boolean {
  return str === null || str === undefined || str.trim().length === 0;
}

const extractWorkflowFileName = (workflowPath: string): string => {
  return path.basename(workflowPath);
};

const isVersionGreater = (v1: string, v2: string): boolean => {
  if (!v1 || !v2) {
    return false;
  }

  const v1Arr = v1.split('.');
  const v2Arr = v2.split('.');

  for (let i = 0; i < v1Arr.length && i < v2Arr.length; i++) {
    const v1Part = parseInt(v1Arr[i]);
    const v2Part = parseInt(v2Arr[i]);

    if (v1Part !== v2Part) {
      return v1Part > v2Part;
    }
  }

  return v1Arr.length > v2Arr.length;
}

const sleep = async (milis: number): Promise<void> => {
  return new Promise<void>(resolve => {
    setTimeout(resolve, milis);
  });
};

const escapeQueryVal = (q: string): string => {
  return (
    q && q.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  );
}

const getTestPathPrefix = (test: AutomatedTest, orgPath: boolean): string => {
  const testPackage = orgPath ? test.oldPackageName : test.packageName;
  const testName = orgPath ? test.oldName : test.name;
  return `${testPackage ? `${testPackage}\\` : ''}${testName}`;
}

// a valid path is of the form <test package>\<test name>\<action name>:<action logical name | action name>. an invalid
// form can be caused if a user manually entered a scm path in-correctly
// this method extracts the test path from the repository path. if not valid returns null
const extractScmTestPath = (scmPath: string): string | null => {
  scmPath = extractScmPathFromActionPath(scmPath);
  const index = scmPath.lastIndexOf('\\');
  if (index === -1) {
    return null;
  } else {
    const scmTestPath = scmPath.substring(0, index);
    const actionNumber = scmPath.substring(index + 1, scmPath.length - 1);
    // the last part of the test path should contain the action name like "action10"
    if (actionNumber.toLowerCase().startsWith("action")) {
      return scmTestPath;
    } else {
      return null;
    }
  }
}

const extractScmPathFromActionPath = (repositoryPath: string): string => {
  const index = repositoryPath.indexOf(":");
  if (index === -1) {
    return repositoryPath;
  } else {
    return repositoryPath.substring(0, index).toLowerCase();
  }
}

// the action path is in the form of <test package>\<test name>\<action name>:<action logical name | action name>.
// this method extracts the <action logical name>
const extractActionLogicalNameFromActionPath = (repositoryPath: string) => {
  const parts = repositoryPath.split(":");
  return parts.length == 1 ? "" : parts[1];
}

// the action path is in the form of <test package>\<test name>\<action name>:<action logical name | action name>.
// this method extracts the <action name> as set by the UFTOne: Action1 Action2 etc.
const extractActionNameFromActionPath = (repositoryPath: string): string => {
  const parts = repositoryPath.split(":");
  const repoPathParts = parts[0].split("\\");
  return repoPathParts[repoPathParts.length - 1]; // the last part of the repository path without logical name is the action name
}

const calcByExpr = (param: string, regex: RegExp, groupNum: number): string => {
  logger.debug(`calcByExpr: param=${param}, regex=${regex}, groupNum=${groupNum} ...`);
  const match = param.match(regex);

  if (match) {
    return match[groupNum];
  }
  return param;
}

const getSafeDomParser = (): DOMParser => {
  const parser = new DOMParser({
    errorHandler: (level: string, msg: string) => {
      if (level === 'error') {
        logger.error(`XML Parse Error: ${msg}`);
      } else if (level === 'fatalError') {
        throw new TspParseError(`Fatal XML Parse Error: ${msg}`);
      }
      return null;
    }
  });
  return parser;
}

const extractXmlFromTspOrMtrFile = async (filePath: string): Promise<string> => {
  try {
    // Read the .TSP file into a Buffer
    const data = await fs.readFile(filePath);

    // Parse the CFB file
    const cfb: CFB.CFB$Container = CFB.read(data, { type: 'buffer' });

    // Find the ComponentInfo stream
    const stream = CFB.find(cfb, COMPONENT_INFO);
    if (!stream || !stream.content) {
      throw new Error('ComponentInfo stream not found in CFB container');
    }

    // Convert stream content to Buffer (cfb returns Buffer or Uint8Array)
    const content = Buffer.isBuffer(stream.content)
      ? stream.content
      : Buffer.from(stream.content);

    // Convert to UTF-16LE and extract XML
    const fromUnicodeLE = bufferToUnicodeLE(content);
    const xmlStart = fromUnicodeLE.indexOf('<');
    if (xmlStart >= 0) {
      return fromUnicodeLE.substring(xmlStart).replace(/\0/g, '');
    } else {
      throw new Error('No XML data found in ComponentInfo stream');
    }
  } catch (error) {
    const err = `${(error as Error).message}`;
    logger.error(`Failed to extract xml from Test.tsp file: ${err}`);
    throw new Error(err);
  }
}

const bufferToUnicodeLE = (buffer: Buffer): string => {
  let result = '';
  for (let i = 0; i < buffer.length; i += 2) {
    const charCode = buffer.readUInt16LE(i);
    if (charCode === 0) continue; // Skip null characters
    result += String.fromCharCode(charCode);
  }
  return result;
}

const getGuiTestDocument = async (dirPath: string): Promise<Document | null> => {
  try {
    const tspTestFile = await getFileIfExist(dirPath, GUI_TEST_FILE);
    if (!tspTestFile) {
      return null;
    }

    const xmlContent = await extractXmlFromTspOrMtrFile(tspTestFile);
    if (!xmlContent) {
      logger.warn("No valid XML content extracted from TSP file");
      return null;
    }

    const parser = getSafeDomParser();
    const doc = parser.parseFromString(xmlContent, TEXT_XML) as Document;

    if (!doc.documentElement) {
      throw new TspParseError("Invalid XML content: No document element found.");
    }

    return doc;
  } catch (error: any) {
    logger.error("Error parsing document:" + error?.message);
    throw error instanceof TspParseError ? error : new TspParseError(`Failed to parse document: ${error}`);
  }
}

const getApiTestDocument = async (dirPath: string): Promise<Document | null> => {
  try {
    const actionsFile = await getFileIfExist(dirPath, API_ACTIONS_FILE);
    if (actionsFile == null) {
      return null;
    }

    const xmlContent = await fs.readFile(actionsFile, 'utf8');
    const parser = getSafeDomParser();
    const cleanXmlContent = xmlContent.replace(/^\uFEFF/, ''); // Remove BOM if present
    const doc = parser.parseFromString(cleanXmlContent, TEXT_XML) as Document;
    if (!doc.documentElement) {
      throw new TspParseError("Invalid XML content: No document element found.");
    }
    return doc;
  } catch (error: any) {
    logger.error("Error parsing document: " + error?.message);
    throw error;
  }
}

const getFileIfExist = async (dirPath: string, fileName: string): Promise<string | null> => {
  const filePath = path.join(dirPath, fileName);
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    logger.warn(`File ${filePath} does not exist`);
    return null;
  }
}

const getTimestamp = (): string => { // ddMMyyyyHHmmssSSS
  const now = new Date();
  const pad = (n: number, width = 2) => n.toString().padStart(width, '0');

  const day = pad(now.getDate());
  const month = pad(now.getMonth() + 1); // Months are 0-based
  const year = now.getFullYear();
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  const milliseconds = pad(now.getMilliseconds(), 3);

  return `${day}${month}${year}${hours}${minutes}${seconds}${milliseconds}`;
}

const escapePropVal = (val: string): string => {
  return val.replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/=/g, '\\=');
}

const checkReadWriteAccess = async (dirPath: string): Promise<void> => {
  if (!dirPath) {
    const err = `Missing environment variable RUNNER_WORKSPACE`;
    logger.error(`checkReadWriteAccess: ${err}`);
    throw new Error(err);
  }
  // Check read/write access to RUNNER_WORKSPACE
  logger.debug(`checkReadWriteAccess: [${dirPath}]`);
  try {
    await fs.access(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error: any) {
    const err = `checkReadWriteAccess: [${dirPath}] => ${error.message}`;
    logger.error(err);
    throw new Error(err);
  }
}
const checkFileExists = async (fullPath: string): Promise <void> => {
  try {
    logger.debug(`ensureFileExists: [${fullPath}] ...`);
    await fs.access(fullPath, fs.constants.F_OK | fs.constants.R_OK);
    logger.debug(`Located [${fullPath}]`);
  } catch(error: any) {
    const err = `checkFileExists: Failed to locate [${fullPath}]: ${error.message}`;
    logger.error(err);
    throw new Error(err);
  }
}

const escapeXML = (str: string | null | undefined): string => {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

const parseTimeToFloat = (time: string): number => {
  if (time) {
    try {
      return parseFloat(time.replace(",", ""));
    } catch (e) {
      // hmm, don't know what this format is.
    }
  }
  return NaN;
}

const getLastFolderFromPath = (dirPath: string): string => {
  if (!dirPath) return "";
  // Remove trailing slashes and normalize path
  const cleanPath = path.normalize(dirPath.replace(/[\\/]+$/, ''));
  if (existsSync(cleanPath) && lstatSync(cleanPath).isDirectory()) {
    return path.basename(cleanPath);
  } else {
    return cleanPath;
  }
}

const getEventType = (event: string | null | undefined): ActionsEventType => {
  switch (event) {
    case 'workflow_dispatch':
      return ActionsEventType.WORKFLOW_DISPATCH;
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

export { getHeadCommitSha, isBlank, isTestMainFile, getTestType, getParentFolderFullPath, saveSyncedCommit, getSyncedCommit, getSyncedTimestamp, extractWorkflowFileName, isVersionGreater, sleep, escapeQueryVal, getTestPathPrefix, extractScmTestPath, extractScmPathFromActionPath, extractActionLogicalNameFromActionPath, extractActionNameFromActionPath, calcByExpr, getSafeDomParser, extractXmlFromTspOrMtrFile, getGuiTestDocument, getApiTestDocument, getFileIfExist, getTimestamp, escapePropVal, checkReadWriteAccess, checkFileExists, escapeXML, parseTimeToFloat, getLastFolderFromPath, getEventType };
