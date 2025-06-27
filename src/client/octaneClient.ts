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

import { Octane } from '@microfocus/alm-octane-js-rest-sdk';
import Query from '@microfocus/alm-octane-js-rest-sdk/dist/lib/query';
import { getConfig } from '../config/config';
import CiEvent from '../dto/octane/events/CiEvent';
import CiEventsList from '../dto/octane/events/CiEventsList';
import { Logger } from '../utils/logger';
import CiExecutor from '../dto/octane/general/CiExecutor';
import CiExecutorBody from '../dto/octane/general/bodies/CiExecutorBody';
import CiServer from '../dto/octane/general/CiServer';
import CiServerInfo from '../dto/octane/general/CiServerInfo';
import { escapeQueryVal } from '../utils/utils';
import { EntityConstants } from '../dto/octane/general/EntityConstants';
import FolderBody from '../dto/octane/general/bodies/FolderBody';
import Folder, { BaseFolder } from '../dto/octane/general/Folder';
import UnitBody, { UnitParamBody } from '../dto/octane/general/bodies/UnitBody';
import Unit, { UnitParam } from '../dto/octane/general/Unit';
import CiJob from '../dto/octane/general/CiJob';
import CiJobBody from '../dto/octane/general/bodies/CiJobBody';
import CiServerBody from '../dto/octane/general/bodies/CiServerBody';
import Test from '../dto/octane/general/Test';
import MbtTestData from '../mbt/MbtTestData';
const { ID, COLLECTION_NAME: MODEL_ITEMS, NAME, LOGICAL_NAME, ENTITY_NAME: MODEL_ITEM, ENTITY_SUBTYPE: MODEL_FOLDER, SUBTYPE, PARENT } = EntityConstants.ModelFolder;
const { COLLECTION_NAME: AUTOMATED_TESTS, TEST_RUNNER } = EntityConstants.AutomatedTest;
const { REPOSITORY_PATH } = EntityConstants.MbtUnit;
const SERVER_TYPE = 'server_type';
const CI_SERVERS = 'ci_servers';
const CI_SERVER = 'ci_server';
const SCM_REPOSITORY = 'scm_repository';
const TESTING_TOOL_TYPE = 'testing_tool_type';
const INSTANCE_ID = 'instance_id';
const _headers = { HPECLIENTTYPE: 'HPE_CI_CLIENT' };

export default class OctaneClient {
  private static _logger: Logger = new Logger('octaneClient');
  private static GITHUB_ACTIONS = 'github_actions';
  private static PLUGIN_VERSION = '25.2.3';
  private static _config = getConfig();
  private static _octane: Octane = new Octane({
    server: this._config.octaneUrl,
    sharedSpace: this._config.octaneSharedSpace,
    workspace: this._config.octaneWorkspace,
    user: this._config.octaneClientId,
    password: this._config.octaneClientSecret,
    headers: _headers
  });

  private static ANALYTICS_WORKSPACE_CI_INTERNAL_API_URL = `/internal-api/shared_spaces/${this._config.octaneSharedSpace}/workspaces/${this._config.octaneWorkspace}/analytics/ci`;
  private static ANALYTICS_CI_INTERNAL_API_URL = `/internal-api/shared_spaces/${this._config.octaneSharedSpace}/analytics/ci`;
  private static CI_INTERNAL_API_URL = `/internal-api/shared_spaces/${this._config.octaneSharedSpace}/workspaces/${this._config.octaneWorkspace}`;
  private static CI_API_URL = `/api/shared_spaces/${this._config.octaneSharedSpace}/workspaces/${this._config.octaneWorkspace}`;

  public static sendEvents = async (events: CiEvent[], instanceId: string, url: string): Promise<void> => {
    this._logger.debug(`Sending events to server-side app (instanceId: ${instanceId}): ${JSON.stringify(events)}`);

    const ciServerInfo: CiServerInfo = {
      instanceId,
      type: this.GITHUB_ACTIONS,
      url,
      version: this.PLUGIN_VERSION,
      sendingTime: new Date().getTime()
    };

    const eventsToSend: CiEventsList = {
      server: ciServerInfo,
      events
    };

    await this._octane.executeCustomRequest(
      `${this.ANALYTICS_CI_INTERNAL_API_URL}/events`,
      Octane.operationTypes.update,
      eventsToSend
    );
  };

  private static createCIServer = async (name: string, instanceId: string, url: string): Promise<CiServer> => {
    const body: CiServerBody = {
      name: name,
      instance_id: instanceId,
      server_type: this.GITHUB_ACTIONS,
      url: url
    };
    this._logger.debug(`createCIServer: ${JSON.stringify(body)} ...`);
    const fldNames = ['id', 'name', 'instance_id', 'plugin_version', 'url', 'is_connected', 'server_type'];
    const res = await this._octane.create(CI_SERVERS, body).fields(...fldNames).execute();
    return res.data[0];
  };

  public static getOrCreateCiServer = async (instanceId: string, name: string): Promise<CiServer> => {
    this._logger.debug(`getOrCreateCiServer: instanceId=[${instanceId}], name=[${name}], url=[${this._config.repoUrl}] ...`);

    const ciServerQuery = Query.field(INSTANCE_ID).equal(escapeQueryVal(instanceId))
      .and(Query.field(SERVER_TYPE).equal(this.GITHUB_ACTIONS))
      .and(Query.field('url').equal(escapeQueryVal(this._config.repoUrl)))
      .build();
    const fldNames = ['instance_id', 'plugin_version', 'url', 'is_connected'];
    let res = await this._octane.get(CI_SERVERS).fields(...fldNames).query(ciServerQuery).limit(1).execute();
    let ciServer;
    if (res?.total_count && res.data?.length) {
      ciServer = res.data[0];
    } else {
      const repoUrl = this._config.repoUrl.replace(/\.git$/, '');
      this._logger.debug(`getOrCreateCiServer: retry with url=[${repoUrl}] ...`);
      res = await this._octane.get(CI_SERVERS).fields(...fldNames).query(ciServerQuery).limit(1).execute();
      if (res?.total_count && res.data?.length) {
        ciServer = res.data[0];
      } else {
        ciServer = await this.createCIServer(name, instanceId, repoUrl);
        this.updatePluginVersion(instanceId);
        ciServer.plugin_version = this.PLUGIN_VERSION;
      }
    }
    this._logger.debug("CI Server:", ciServer);
    return ciServer;
  };

  public static getCiServersByType = async (serverType: string): Promise<CiServer[]> => {
    this._logger.debug(`getCiServersByType: serverType=${serverType} ...`);

    const ciServerQuery = Query.field(SERVER_TYPE).equal(serverType).build();
    const fldNames = ['id', 'instance_id', 'plugin_version'];
    const res = await this._octane.get(CI_SERVERS).fields(...fldNames).query(ciServerQuery).execute();
    if (!res || !res.total_count || !res.data.length) {
      return [];
    }
    const entries = res.data;
    entries.forEach((e: CiServer) => {
      this._logger.debug("CI Server:", e);
    });

    return entries;
  };

  public static getExecutor = async (ciServerId: number, name: string, subType: string): Promise<CiExecutor | null> => {
    this._logger.debug(`getExecutor: ciServerId=${ciServerId}, name=${name} ...`);
    const q = Query.field(CI_SERVER).equal(Query.field(ID).equal(ciServerId))
      .and(Query.field(NAME).equal(escapeQueryVal(name)))
      .and(Query.field(SUBTYPE).equal(subType))
      .build();

    //name,framework,test_runner_parameters,last_successful_sync,subtype,id,last_sync,next_sync,message,sync_status,ci_server{id},scm_repository{repository}
    const fldNames = ['id', 'name', 'subtype', 'framework', 'scm_repository', 'ci_job', 'ci_server'];
    const res = await this._octane.get('executors').fields(...fldNames).query(q).limit(1).execute();
    const entries = res?.data ?? [];
    if (!entries.length) {
      return null;
    }
    const entry = entries[0];
    this._logger.debug("Test Runner:", entry);
    return entry;
  };

  public static createMbtTestRunner = async (name: string, ciServerId: number, ciJob: CiJob): Promise<CiExecutor> => {
    const body: CiExecutorBody = {
      name: name,
      subtype: "uft_test_runner",
      framework: {
        id: "list_node.je.framework.mbt",
        type: "list_node"
      },
      ci_server: {
        id: ciServerId,
        type: "ci_server"
      },
      ci_job: {
        id: ciJob.id,
        type: 'ci_job'
      },
      jobCiId: ciJob.ci_id,
      scm_type: 2, // GIT
      scm_url: this._config.repoUrl,
    };
    this._logger.debug(`createMbtTestRunner: ${JSON.stringify(body)} ...`);

    const entry = await this._octane.executeCustomRequest(`${this.CI_INTERNAL_API_URL}/je/test_runners/uft`, Octane.operationTypes.create, body);

    if (!entry || entry.total_count === 0) {
      throw Error('Could not create the test runner entity.');
    }
    this._logger.debug("Test Runner:", entry);
    return entry;
  };

  public static getCiServerByInstanceId = async (instanceId: string): Promise<CiServer | null> => {
    this._logger.debug(`getCiServerByInstanceId: instanceId=${instanceId} ...`);
    const ciServerQuery = Query.field(INSTANCE_ID).equal(escapeQueryVal(`${instanceId}`)).build();

    const res = await this._octane.get(CI_SERVERS).fields(INSTANCE_ID).query(ciServerQuery).limit(1).execute();
    return res?.data?.length ? res.data[0] : null;
  };

  public static getSharedSpaceName = async (sharedSpaceId: number): Promise<string> => {
    this._logger.debug(`getSharedSpaceName: id=${sharedSpaceId} ...`);
    const res = await this._octane.executeCustomRequest(`/api/shared_spaces?fields=name&query="id EQ ${sharedSpaceId}"`, Octane.operationTypes.get);
    return res.data[0].name;
  };

  public static getOctaneVersion = async (): Promise<string> => {
    const response = await this._octane.executeCustomRequest(
      this.ANALYTICS_CI_INTERNAL_API_URL + '/servers/connectivity/status',
      Octane.operationTypes.get
    );

    return response.octaneVersion;
  };

  /**
   * Gets a map containing the experiments related to GitHub Actions and their
   * activation status.
   * @returns Object containing the names of the experiments as keys and the
   * activation status (true if on, false if off) as value.
   */
  public static getFeatureToggles = async (): Promise<{ [key: string]: boolean }> => {
    this._logger.info(`Getting features' statuses (on/off)...`);

    const response = await this._octane.executeCustomRequest(
      `${this.ANALYTICS_WORKSPACE_CI_INTERNAL_API_URL}/github_feature_toggles`,
      Octane.operationTypes.get
    );

    return response;
  };

  public static fetchAutomatedTestsAgainstScmRepository = async (testNames: string[] = [], linkedToScmRepo: boolean = false): Promise<Map<string, Test>> => {
    this._logger.debug(`fetchAutomatedTestsAgainstScmRepository: testNames.length=${testNames.length}, linkedToScmRepo=${linkedToScmRepo} ...`);
    let qry = Query.field(TESTING_TOOL_TYPE).equal(Query.field(ID).equal("list_node.testing_tool_type.uft"));

    if (testNames?.length) {
      const arr = testNames.map(name => escapeQueryVal(name));
      const namesQry = Query.field(NAME).inComparison(arr).build();
      namesQry.length <= 3000 && qry.and(namesQry);
    }

    const scmRepoId = await this.getScmRepositoryId(this._config.repoUrl);
    const qry1 = Query.field(SCM_REPOSITORY).equal(Query.field(ID).equal(scmRepoId));
    if (linkedToScmRepo) {
      qry = qry.and(qry1);
    } else {
      qry = qry.and(qry1.not());
    }
    const fields = ['id', 'name', 'package', 'executable', 'description', 'test_runner'];
    const entries = await this.fetchEntities<Test>(AUTOMATED_TESTS, qry, fields);
    const mappedTests = this.mapEntitiesByPackageAndName(entries);
    mappedTests.size && this._logger.debug("Tests:");
    mappedTests.forEach((e: Test, k: string) => {
      this._logger.debug(k, e);
    });

    return mappedTests;
  };

  public static fetchUnits = async (query: Query): Promise<Unit[]> => {
    this._logger.debug(`fetchUnits: ...`);
    const units = await this.fetchEntities<Unit>(MODEL_ITEMS, query, ['id', 'name', 'description', 'repository_path', 'parent', 'test_runner']);
    units.forEach(u => {
      this._logger.debug("Unit:", u);
    });
    return units;
  }

  public static fetchUnitsFromFolders(scmRepositoryId: number, folderNames: ReadonlyArray<string>): Promise<Unit[]> {
    if (!folderNames?.length) {
      return Promise.resolve([]);
    };
    this._logger.debug(`fetchUnitsFromFolders: scmRepositoryId=${scmRepositoryId} ...`);
    const qry1 = Query.field(SCM_REPOSITORY).equal(Query.field(ID).equal(scmRepositoryId));
    const queries = folderNames.map(folderName => Query.field(PARENT).equal(Query.field(NAME).equal(folderName)));
    const qry2 = queries.reduce((acc, curr) => acc.or(curr));
    return this.fetchUnits(qry1.and(qry2));
  }

  public static getRunnerDedicatedFolder = async (executorId: number): Promise<BaseFolder | null> => {
    this._logger.debug(`getRunnerDedicatedFolder: executorId=${executorId} ...`);
    const qry = Query.field(TEST_RUNNER).equal(Query.field(ID).equal(executorId))
      .and(Query.field(SUBTYPE).equal(MODEL_FOLDER))
      .build();

    const res = await this._octane.get(MODEL_ITEMS).query(qry).fields(...["id", "name"]).limit(1).execute();
    return res?.data?.length ? res.data[0] : null;
  }

  public static getGitMirrorFolder = async (): Promise<BaseFolder | null> => {
    this._logger.debug(`getGitMirrorFolder: ...`);
    const qry = Query.field(LOGICAL_NAME).equal("mbt.discovery.unit.default_folder_name").build();
    const res = await this._octane.get(MODEL_ITEMS).query(qry).limit(1).execute();
    return res?.data?.length ? res.data[0] : null;
  }

  public static fetchChildFolders = async (parentFolder: BaseFolder, nameFilters: string[] = []): Promise<Folder[]> => {
    this._logger.debug(`fetchChildFolders: parentFolder=${parentFolder.name}, nameFilters.length=${nameFilters.length} ...`);
    let qry = Query.field(PARENT).equal(Query.field(ID).equal(parentFolder.id))
      .and(Query.field(SUBTYPE).equal(MODEL_FOLDER));

    if (nameFilters.length) {
      qry = qry.and(Query.field(NAME).inComparison(nameFilters));
    }
    const fldNames = ["id", "name", "subtype"];
    return await this.fetchEntities<Folder>(MODEL_ITEMS, qry, fldNames);
  }

  public static createFolders = async (names: Set<string>, parentFolder: BaseFolder): Promise<Map<string, Folder>> => {
    if (names.size === 0) return new Map<string, Folder>();
    this._logger.debug(`createFolders: size=${names.size}, parent=${parentFolder.name} ...`);

    const folderBodies: FolderBody[] = Array.from(names, folderName => ({
      type: MODEL_ITEM,
      subtype: MODEL_FOLDER,
      name: folderName,
      parent: {
        id: parentFolder.id,
        type: MODEL_ITEM,
        name: parentFolder.name
      }
    }));
    const fldNames = ['id', 'name'];
    const folders = await this.postEntities<FolderBody, Folder>(MODEL_ITEMS, folderBodies, fldNames);
    return new Map<string, Folder>(folders.map(folder => [folder.name, folder]));
  };

  public static updateFolders = async (folders: FolderBody[]): Promise<Folder[]> => {
    if (folders?.length) {
      this._logger.debug(`updateFolders: length=${folders.length} ...`);
      const updatedFolders = await this.putEntities<FolderBody, Folder>(MODEL_ITEMS, folders);
      this._logger.debug(`Updated folders: ${updatedFolders.length}`);
      return updatedFolders;
    }
    return [];
  }

  public static createUnits = async (unitsToAdd: UnitBody[], paramsToAdd: UnitParamBody[]) => {
    this._logger.debug(`createUnits: length=${unitsToAdd.length} ...`);
    const newUnits = await this.postEntities<UnitBody, Unit>(MODEL_ITEMS, unitsToAdd, [REPOSITORY_PATH]);
    const unitsMap: Map<string, Unit> = new Map();
    for (const u of newUnits) {
      if (!u) {
        this._logger.warn('Null or undefined unit found');
        continue;
      }
      if (u.repository_path) {
        if (unitsMap.has(u.repository_path)) {
          this._logger.warn(`Duplicate repository_path found: ${u.repository_path}`);
        }
        unitsMap.set(u.repository_path, u);
      } else {
        this._logger.warn(`Unit without repository_path found: ${u.id}`);
      }
    }
    if (unitsMap.size === 0) return;

    this._logger.info(`Successfully added ${unitsMap.size} new units.`);
    this._logger.info(`Creating ${paramsToAdd.length} new unit parameters ...`);

    // !!! IMPORTANT: replace parent unit entities for parameters in order to save their relations
    for (const param of paramsToAdd) {
      const parentUnit = param.model_item;
      if (parentUnit.repository_path && unitsMap.has(parentUnit.repository_path)) {
        const newParentUnit = unitsMap.get(parentUnit.repository_path);
        param.model_item = { data: [newParentUnit] };
      } else {
        this._logger.warn(`Unit parameter ${param.name} has no model_item.repository_path.`);
      }
    }
    // add parameters
    const unitParams = await this.postEntities<UnitParamBody, UnitParam>("entity_parameters", paramsToAdd);
    this._logger.info(`Successfully added ${unitParams.length} new unit parameters.`);
  }

  public static updateUnits = async (units: UnitBody[]) => {
    if (!units?.length) return;
    this._logger.debug(`updateUnits: length=${units.length} ...`);
    const updatedUnits = await this.putEntities<UnitBody, Unit>(MODEL_ITEMS, units);
    return updatedUnits;
  }

  private static getScmRepositoryId = async (repoURL: string): Promise<number> => {
    this._logger.debug(`getScmRepositoryId: url=[${repoURL}] ...`);
    const scmRepoQuery = Query.field('url').equal(escapeQueryVal(repoURL)).build();
    const res = await this._octane.get('scm_repository_roots').fields(ID).query(scmRepoQuery).limit(1).execute();
    if (!res || !res.total_count || !res.data.length) {
      throw new Error(`SCM Repository not found.`);
    }
    const id = res.data[0].id;
    this._logger.debug("SCM Repository:", id);
    return id;
  }

  private static mapEntitiesByPackageAndName = (tests: Test[]): Map<string, Test> => {
    const groupedEntities = new Map<string, Test>();
    for (const t of tests) {
      groupedEntities.set(`${t.package ?? ''}#${t.name}`, t);
    }
    return groupedEntities;
  }

  private static updatePluginVersion = async (instanceId: String): Promise<void> => {
    const ver = this.PLUGIN_VERSION;
    this._logger.debug(`updatePluginVersion: plugin_version=${ver} ...`);
    const querystring = require('querystring');
    const sdk = '';
    const client_id = this._config.octaneClientId;
    const selfUrl = querystring.escape(this._config.repoUrl);
    await this._octane.executeCustomRequest(
      `${this.ANALYTICS_CI_INTERNAL_API_URL}/servers/${instanceId}/tasks?self-type=${this.GITHUB_ACTIONS}&api-version=1&sdk-version=${sdk}&plugin-version=${ver}&self-url=${selfUrl}&client-id=${client_id}&client-server-user=`,
      Octane.operationTypes.get
    );
  };

  public static getMbtTestSuiteData = async (suiteRunId: number): Promise<Map<number, MbtTestData>> => {
    this._logger.debug(`getMbtTestSuiteData: suiteRunId=${suiteRunId} ...`);
    const res: { [key: string]: string } = await this._octane.executeCustomRequest(`${this.CI_API_URL}/suite_runs/${suiteRunId}/get_suite_data`, Octane.operationTypes.get);
    this._logger.debug("getMbtTestSuiteData:", res);
    const decodedMap = new Map<number, MbtTestData>();

    for (const [runId, base64Str] of Object.entries(res)) {
      try {
        const decodedStr = Buffer.from(base64Str, 'base64').toString('utf8');
        this._logger.debug(`${runId}: ${decodedStr}`);
        const testData: MbtTestData = JSON.parse(decodedStr);
        decodedMap.set(Number(runId), testData);
      } catch (err) {
        this._logger.error(`getMbtTestSuiteData: Failed to decode or parse Base64 string for key ${runId}: ${(err as Error).message}`);
        throw err;
      }
    }

    return decodedMap;
  }

  public static getCiJob = async (ciId: string, ciServer: CiServer): Promise<CiJob | undefined> => {
    this._logger.debug(`getCiJob: {ci_id='${ciId}, ci_server.id='${ciServer.id}'} ...`);

    const jobQuery = Query.field('ci_id')
      .equal(escapeQueryVal(ciId))
      .and(Query.field('ci_server').equal(Query.field('id').equal(ciServer.id)))
      .build();

    const res = await this._octane
      .get('ci_jobs')
      .fields('id,ci_id,name,ci_server{name,instance_id}')
      .query(jobQuery)
      .execute();

    if (!res || !res.total_count || !res.data.length) {
      return undefined;
    }

    return res.data[0];
  };

  public static createCiJob = async (ciJob: CiJobBody): Promise<CiJob> => {
    this._logger.debug(`createCiJob: {ci_id='${ciJob.jobCiId}', ci_server.id='${ciJob.ciServer?.id}'} ...`);

    const ciJobToCreate = {
      name: ciJob.name,
      parameters: ciJob.parameters,
      ci_id: ciJob.jobCiId,
      ci_server: {
        id: ciJob.ciServer?.id,
        type: ciJob.ciServer?.type
      },
      branch: ciJob.branchName
    };

    const res = await this._octane.create('ci_jobs', ciJobToCreate).fields('id,ci_id,name,ci_server{name,instance_id}').execute();

    if (!res || !res.total_count || !res.data.length) {
      throw Error('Could not create the CI job entity.');
    }

    return res.data[0];
  };

  public static fetchEntities = async <T>(collectionName: string, query: Query = Query.NULL, fields: string[] = []): Promise<T[]> => {
    this._logger.debug(`fetchEntities: collectionName=${collectionName} ...`);
    const qry = query === Query.NULL ? "" : query.build();
    const entities: T[] = [];
    const MAX_LIMIT = 1000;
    let go = false;
    do {
      try {
        const res = await this._octane.get(collectionName).query(qry).fields(...fields).offset(entities.length).limit(MAX_LIMIT).orderBy("id").execute();
        go = res.total_count === MAX_LIMIT && res.data?.length === MAX_LIMIT;
        res.data?.length && entities.push(...res.data);
      } catch (error: any) {
        this._logger.error(`Error fetching entities from collection '${collectionName}': ${error.message}`);
        throw error; // Re-throw the error to be handled by the caller
      }
    } while (go);
    return entities;
  };

  public static postEntities = async <T, U>(collectionName: string, entries: T[], fields: string[] = []): Promise<U[]> => {
    this._logger.debug(`postEntities: collectionName=${collectionName}, length=${entries.length} ...`);
    const results: U[] = [];
    const MAX_LIMIT = 100;
    const partitions: T[][] = this.partition(entries, MAX_LIMIT);
    for (const entities of partitions) {
      const res = await this._octane.create(collectionName, entities).fields(...fields).execute();
      res.data?.length && results.push(...res.data); // TODO debug to see if res or res.data contains the content
    }
    return results;
  }

  public static putEntities = async <T, U>(collectionName: string, entries: T[], fields: string[] = []): Promise<U[]> => {
    this._logger.debug(`putEntities: collectionName=${collectionName}, length=${entries.length} ...`);
    const results: U[] = [];
    const MAX_LIMIT = 100;
    const partitions: T[][] = this.partition(entries, MAX_LIMIT);
    for (const entities of partitions) {
      const res = await this._octane.updateBulk(collectionName, entities).fields(...fields).execute();
      res.data?.length && results.push(...res.data); // TODO debug to see if res or res.data contains the content
    }
    return results;
  }

  /**
   * Partitions an array into smaller arrays of a specified size.
   * @param array The array to partition.
   * @param size The size of each partition.
   * @returns An array of partitioned arrays.
   */
  private static partition = <T>(array: T[], size: number): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size));
    }
    return result;
  }
}
