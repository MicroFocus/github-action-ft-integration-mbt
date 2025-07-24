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
import { ActionsJob } from '../dto/github/ActionsJob';
import Commit from '../dto/github/Commit';
import WorkflowRun from '../dto/github/WorkflowRun';
import WorkflowRunStatus from '../dto/github/WorkflowRunStatus';
import { Logger } from '../utils/logger';
import FileContent from '../dto/github/FileContent';
import * as core from '@actions/core';
import { config } from '../config/config';
import { checkFileExists } from '../utils/utils';


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

  public static getWorkflowRunJobs = async (workflowRunId: number): Promise<ActionsJob[]> => {
    this.logger.debug(`getWorkflowRunJobs: run_id='${workflowRunId}' ...`);

    return await this.octokit.paginate(this.octokit.rest.actions.listJobsForWorkflowRun,
      { ..._owner_repo, run_id: workflowRunId, per_page: 100 },
      response => response.data
    );
  };

  public static getJob = async (jobId: number): Promise<ActionsJob> => {
    this.logger.debug(`getJob: job_id='${jobId}' ...`);
    return (await this.octokit.rest.actions.getJobForWorkflowRun({ ..._owner_repo, job_id: jobId })).data;
  };

  public static getWorkflowRunsTriggeredBeforeByStatus = async (beforeTime: number, workflowId: number, status: WorkflowRunStatus): Promise<WorkflowRun[]> => {
    this.logger.debug(`getWorkflowRunsTriggeredBeforeByStatus: beforeTime='${beforeTime}', workflow_id='${workflowId}', status='${status}' ...`);

    return (await this.octokit.paginate(this.octokit.rest.actions.listWorkflowRuns,
      { ..._owner_repo, workflow_id: workflowId, event: 'workflow_run', status, per_page: 100 },
      response => response.data)
    ).filter(run => new Date(run.run_started_at!).getTime() < beforeTime);
  };

  public static getWorkflowRun = async (workflowRunId: number): Promise<WorkflowRun> => {
    this.logger.debug(`getWorkflowRun: run_id='${workflowRunId}' ...`);
    return (await this.octokit.rest.actions.getWorkflowRun({ ..._owner_repo, run_id: workflowRunId })).data;
  };

/*  public static getWorkflowRunArtifacts = async (workflowRunId: number): Promise<Artifact[]> => {
    this.logger.debug(`getWorkflowRunArtifacts: run_id='${workflowRunId}' ...`);

    return await this.octokit.paginate(this.octokit.rest.actions.listWorkflowRunArtifacts,
      { ..._owner_repo, run_id: workflowRunId, per_page: 100 },
      response => response.data
    );
  };*/

  public static uploadArtifact = async (runResXmlfileFullPath: string, artifactName: string = "run_results"): Promise<number> => {
    try {
      this.logger.debug(`uploadArtifact: '${runResXmlfileFullPath}' ...`);

      await checkFileExists(runResXmlfileFullPath);

      //const uniqueArtifactName = `${artifactName}${Date.now()}`; // Ensure unique name
      this.logger.debug(`Uploading artifact ${artifactName} ...`);
      const res = await artifact.uploadArtifact(artifactName, [runResXmlfileFullPath], path.dirname(runResXmlfileFullPath));

      this.logger.info(`Artifact ${res.id} uploaded successfully.`);
      return res.id ?? 0;
    } catch (error) {
      this.logger.error(`uploadArtifact: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };

  public static uploadArtifacts = async (parentPath: string, paths: string[], skipInvalidPaths: boolean = true): Promise<number> => {
    try {
      let filesToUpload: string[] = [];

      for (const fileOrDirFullPath of paths) {
        this.logger.debug(`uploadArtifact: reportDirPath='${fileOrDirFullPath}' ...`);
        // Check if the path exists
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
        } else if (stats.isDirectory()) {
          // Recursively collect all files in the directory
          filesToUpload = filesToUpload.concat(this.walkDir(fileOrDirFullPath));
        } else {
          this.logger.error(`Path is neither a file nor a directory: ${fileOrDirFullPath}`);
          if (!skipInvalidPaths) {
            throw new Error(`Path is neither a file nor a directory: ${fileOrDirFullPath}`);
          }
          continue;
        }
      }

      const uniqueArtifactName = `reports-${Date.now()}`; // Ensure unique name
      this.logger.debug(`Uploading artifact ${uniqueArtifactName} with ${filesToUpload.length} file(s)`);
      const res = await artifact.uploadArtifact(uniqueArtifactName, filesToUpload, parentPath);

      this.logger.info(`Artifact ${res.id} uploaded successfully.`);
      return res.id ?? 0;
    } catch (error) {
      this.logger.error(`uploadArtifact: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
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

  public static getCommitIds = async (branch: string, since: Date): Promise<string[]> => {
    const isoFormattedSince = since.toISOString();
    this.logger.debug(`getCommitIds: since '${isoFormattedSince}' for branch '${branch}' ...`);

    return <string[]>(await this.octokit.paginate(this.octokit.rest.repos.listCommits,
      { ..._owner_repo, sha: branch, since: isoFormattedSince, per_page: 100 },
      response => response.data
    )
    ).map(commit => commit.sha);
  };

  public static getCommit = async (commitSha: string): Promise<Commit> => {
    this.logger.trace(`getCommit: ref='${commitSha}' ...`);

    return (await this.octokit.rest.repos.getCommit({ ..._owner_repo, ref: commitSha })).data;
  };

  public static getPullRequestCommitIds = async (pullRequestNumber: number): Promise<string[]> => {
    this.logger.debug(`getPullRequestCommitIds: pull_number='${pullRequestNumber}' ...`);

    return <string[]>(await this.octokit.paginate(this.octokit.rest.pulls.listCommits,
      { ..._owner_repo, pull_number: pullRequestNumber }, response => response.data)).map(commit => commit.sha);
  };

  public static getDownloadLogsUrl = async (workflowRunId: number): Promise<string | undefined> => {
    this.logger.info(`getDownloadLogsUrl: run_id='${workflowRunId}' ...`);

    const response = await this.octokit.rest.actions.downloadWorkflowRunLogs({
      ..._owner_repo, run_id: workflowRunId, archive_format: 'zip'
    });

    if (!response.url) {
      this.logger.warn(`Couldn't get the location of the logs files for workflow with {run_id='${workflowRunId}'}...`);
    }

    return response.url;
  };

  public static getWorkflowFile = async (workflowFileName: string, branch?: string): Promise<FileContent> => {
    this.logger.info(`getWorkflowFile: '${workflowFileName}' ...`);

    const response = await this.octokit.request('GET /repos/{owner}/{repo}/contents/{path}',
      { ..._owner_repo, path: `.github/workflows/${workflowFileName}`, ...(branch && { ref: branch }) }
    );

    return <FileContent>response.data;
  };
}
