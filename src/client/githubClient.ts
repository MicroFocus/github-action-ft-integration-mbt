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
import * as path from 'path';
import * as fs from 'fs';
import artifact from '@actions/artifact';
import { getOctokit, context } from '@actions/github';
import Commit from '../dto/github/Commit';
import WorkflowRun from '../dto/github/WorkflowRun';
import { Logger } from '../utils/logger';
import FileContent from '../dto/github/FileContent';
import * as core from '@actions/core';
import { config } from '../config/config';

const _owner_repo = { owner: config.owner, repo: config.repo };
export default class GitHubClient {
  private static logger: Logger = new Logger('githubClient');

  private static octokit = getOctokit(config.githubToken);

  public static getWorkflowPath = async (headSHA: string): Promise<string> => {
    const token = core.getInput('githubToken', { required: true });
    const octokit = getOctokit(token);

    try {
      const { data: workflowRuns } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: config.owner,
        repo: config.repo,
        event: 'push',
        head_sha: headSHA,
        status: 'in_progress'
      });

      if (!workflowRuns.workflow_runs.length) {
        throw new Error(`No in-progress workflow runs found for SHA ${headSHA}`);
      }

      const currentRunId = context.runId;
      const currentRun = workflowRuns.workflow_runs.find(run => run.id === currentRunId);
      if (!currentRun) {
        throw new Error(`Current workflow run (ID: ${currentRunId}) not found for SHA ${headSHA}`);
      }
      return currentRun.path; // e.g., .github/workflows/gha-ft-integration.yml
    } catch (error) {
      this.logger.error('Error fetching workflow path:', error as Error);
      throw error; // Re-throw to allow caller to handle
    }
  }

  public static getWorkflowRun = async (workflowRunId: number): Promise<WorkflowRun> => {
    this.logger.debug(`getWorkflowRun: run_id='${workflowRunId}' ...`);
    return (await this.octokit.rest.actions.getWorkflowRun({ ..._owner_repo, run_id: workflowRunId })).data;
  };

  public static uploadArtifact = async (parentPath: string, paths: string[], artifactName: string, skipInvalidPaths: boolean = true): Promise<number> => {
    try {
      let filesToUpload: string[] = [];
      this.logger.debug(`uploadArtifact: parentPath='${parentPath}', paths.length=${paths.length}, artifactName='${artifactName}' ...`);

      for (const fileOrDirFullPath of paths) {
        if (!fs.existsSync(fileOrDirFullPath)) {
          this.logger.error(`Path does not exist: ${fileOrDirFullPath}`);
          if (!skipInvalidPaths) {
            throw new Error(`Path does not exist: ${fileOrDirFullPath}`);
          }
          continue;
        }
        // Determine if the path is a file or directory
        const stats = fs.statSync(fileOrDirFullPath);
        if (stats.isFile()) {
          filesToUpload.push(fileOrDirFullPath);
        } else if (stats.isDirectory()) { // Recursively collect all files in the directory
          filesToUpload = filesToUpload.concat(this.walkDir(fileOrDirFullPath));
        } else {
          this.logger.error(`Path is neither a file nor a directory: ${fileOrDirFullPath}`);
          if (!skipInvalidPaths) {
            throw new Error(`Path is neither a file nor a directory: ${fileOrDirFullPath}`);
          }
          continue;
        }
      }

      this.logger.debug(`Uploading artifact ${artifactName} with ${filesToUpload.length} file(s)`);
      const res = await artifact.uploadArtifact(artifactName, filesToUpload, parentPath);

      this.logger.info(`Artifact ${res.id} uploaded successfully.`);
      return res.id ?? 0;
    } catch (error) {
      this.logger.error(`uploadArtifact: ${error instanceof Error ? error.message : String(error)}`);
      return -1;
    }
  };

  private static walkDir(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        results = results.concat(this.walkDir(filePath));
      } else {
        results.push(filePath);
      }
    }
    return results;
  }

  public static downloadArtifact = async (artifactId: number): Promise<ArrayBuffer> => {
    this.logger.info(`downloadArtifact: artifactId='${artifactId}' ...`);

    return <ArrayBuffer>(await this.octokit.rest.actions.downloadArtifact({
      ..._owner_repo, artifact_id: artifactId, archive_format: 'zip'
    })
    ).data;
  };

  public static getCommit = async (commitSha: string): Promise<Commit> => {
    this.logger.trace(`getCommit: ref='${commitSha}' ...`);

    return (await this.octokit.rest.repos.getCommit({ ..._owner_repo, ref: commitSha })).data;
  };

  public static getWorkflowFile = async (workflowFileName: string, branch?: string): Promise<FileContent> => {
    this.logger.info(`getWorkflowFile: '${workflowFileName}' ...`);

    const response = await this.octokit.request('GET /repos/{owner}/{repo}/contents/{path}',
      { ..._owner_repo, path: `.github/workflows/${workflowFileName}`, ...(branch && { ref: branch }) }
    );

    return <FileContent>response.data;
  };

  public static cancelWorkflowRun = async (): Promise<void> => {
    this.logger.info(`cancelWorkflowRun: run_id='${context.runId}' ...`);
    try {
      await this.octokit.rest.actions.cancelWorkflowRun({
        owner: config.owner,
        repo: config.repo,
        run_id: context.runId
      });
    } catch (e: any) {
      this.logger.error(`Cancel request failed: ${e.message}`);
    }
  }
}
