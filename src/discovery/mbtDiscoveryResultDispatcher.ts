/*
 * Copyright 2016-2025 Open Text.
 *
 * The only warranties for products and services of Open Text and
 * its affiliates and licensors (�Open Text�) are as may be set forth
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
import OctaneClient from '../client/octaneClient';
import { Logger } from '../utils/logger';
import { EntityConstants } from '../dto/octane/general/EntityConstants';
import UftoTestAction from '../dto/ft/UftoTestAction';
import { OctaneStatus } from '../dto/ft/OctaneStatus';
import DiscoveryResult from '../discovery/DiscoveryResult';
import Folder, { BaseFolder } from '../dto/octane/general/Folder';
import UftoTestParam from '../dto/ft/UftoTestParam';
import { UftoParamDirection } from '../dto/ft/UftoParamDirection';
import UnitBody, { UnitParamBody } from '../dto/octane/general/bodies/UnitBody';
import { extractScmTestPath } from '../utils/utils';
import Unit from '../dto/octane/general/Unit';
import FolderBody from '../dto/octane/general/bodies/FolderBody';
const LIST_NODE = "list_node";
const INPUT = "input";
const OUTPUT = "output";
const logger: Logger = new Logger('mbtDiscoveryResultDispatcher');

const getAutoDiscoveredFolder = async (executorId: number): Promise<BaseFolder> => {
  let autoDiscoveredFolder: BaseFolder | null = await OctaneClient.getRunnerDedicatedFolder(executorId);
  if (autoDiscoveredFolder == null)
    autoDiscoveredFolder = await OctaneClient.getGitMirrorFolder();

  if (autoDiscoveredFolder == null) {
    throw new Error("Failed to get auto-discovered folder");
  }
  return autoDiscoveredFolder;
}

const createParentFolders = async (newActions: UftoTestAction[], autoDiscoveredFolder: BaseFolder): Promise<Map<string, Folder>> => {
  logger.debug(`createParentFolders: length=${newActions.length}, folder=${autoDiscoveredFolder.name} ...`);
  // find existing sub folders. each folder's name is the test name that contains the actions
  const existingSubFolders = await OctaneClient.fetchChildFolders(autoDiscoveredFolder);
  const existingSubFoldersMap: Map<string, Folder> = new Map<string, Folder>(
    existingSubFolders.map(folder => [folder.name, folder])
  );

  const testNames: Set<string> = new Set(newActions.map(action => action.testName!));

  // Find which folders are missing and need to be created
  for (const folderName of existingSubFoldersMap.keys()) {
    testNames.delete(folderName);
  }
  if (testNames.size > 0) {
    const newFoldersMap = await OctaneClient.createFolders(testNames, autoDiscoveredFolder);
    if (newFoldersMap?.size) {
      for (const [key, value] of newFoldersMap) {
        existingSubFoldersMap.set(key, value);
      }
    }
  }

  return existingSubFoldersMap;
}

// count the distinct tests paths from all the given units
const countDistinctTests = (units: Unit[]): number => {
  const distinctPaths = new Set(units.map(u => extractScmTestPath(u.repository_path)));
  return distinctPaths.size;
};

const updateFolders = async (folders: Folder[], oldName2newNameMap: Map<string, string>): Promise<void> => {
  if (folders?.length) {
    logger.debug(`updateFolders: folders.length=${folders.length} ...`);
    const foldersToUpdate: FolderBody[] = folders.map((f: Folder) => {
      return { id: `${f.id}`, name: oldName2newNameMap.get(f.name) } as FolderBody;
    });
    await OctaneClient.updateFolders(foldersToUpdate);
  }
}

const updateParentFolders = async (scmRepositoryId: number, updatedActions: UftoTestAction[], autoDiscoveredFolder: Folder): Promise<Map<string, Folder>> => {
  logger.debug(`updateParentFolders: scmRepositoryId=${scmRepositoryId}, updatedActions.length=${updatedActions.length}, autoDiscoveredFolder=${autoDiscoveredFolder.name} ...`);
  const oldNameToNewNameMap = updatedActions.reduce((acc, action) => {
    if (action.moved && action.testName && action.oldTestName && action.testName !== action.oldTestName) {
      acc.set(action.oldTestName!, action.testName!);
    }
    return acc;
  }, new Map<string, string>());

  if (oldNameToNewNameMap.size === 0) return new Map<string, Folder>();

  // check if the folders by the new names already exist
  const existingFolders = await OctaneClient.fetchChildFolders(autoDiscoveredFolder, [...oldNameToNewNameMap.values()]);
  const existingFoldersMap: Map<string, Folder> = new Map<string, Folder>(
    existingFolders.map(folder => [folder.name, folder])
  );

  // filter out duplicate folders
  let folderNamesToUpdate = [...oldNameToNewNameMap.entries()].filter(([_, value]) => !existingFoldersMap.has(value)).map(([key]) => key);

  if (folderNamesToUpdate.length) { // if the folder name does not exist rename the current parent folder
    // extract all the units from the potential folders needed to be renamed. this is required in order to validate that
    // the folder contains only units from the same moved test. otherwise, we can't rename the folder but create a new folder
    // and move all the units of the moved test under the new folder
    const units = await OctaneClient.fetchUnitsFromFolders(scmRepositoryId, Object.freeze(folderNamesToUpdate));
    // Group units by parent folder name
    const folderNameToUnitsMap = new Map<string, Unit[]>(
      units.reduce((acc, unit) => {
        const parentName = unit.parent?.name;
        if (!parentName) {
          logger.warn(`Unit ${unit.name} has no parent folder, skipping...`);
          return acc; // Skip if no parent name
        }

        const unitsForFolder = acc.get(parentName) ?? [];
        unitsForFolder.push(unit);
        acc.set(parentName, unitsForFolder);
        return acc;
      }, new Map<string, Unit[]>())
    );

    // Filter folders with multiple distinct tests
    const foldersWithMultipleTests = new Set(
      [...folderNamesToUpdate].filter(folderName => {
        const units = folderNameToUnitsMap.get(folderName);
        return units && countDistinctTests(units) > 1;
      })
    );
    // a folder should be renamed only if it contains units from the same test
    folderNamesToUpdate = folderNamesToUpdate.filter(folderName => !foldersWithMultipleTests.has(folderName));
    // remove the folders containing units from multiple tests
    if (folderNamesToUpdate.length) {
      const folders2update = await OctaneClient.fetchChildFolders(autoDiscoveredFolder, folderNamesToUpdate);
      await updateFolders(folders2update, oldNameToNewNameMap);
    }
    // create the new folders for the moved units
    if (foldersWithMultipleTests?.size) {
      const foldersToCreate = new Set<string>();
      for (const folderName of foldersWithMultipleTests) {
        const newFolderName = oldNameToNewNameMap.get(folderName);
        newFolderName && foldersToCreate.add(newFolderName);
      }
      const newFoldersMap = await OctaneClient.createFolders(foldersToCreate, autoDiscoveredFolder);
      // Append newFoldersMap to existingFoldersMap
      for (const [key, value] of newFoldersMap.entries()) {
        existingFoldersMap.set(key, value);
      }
    }

    // potential duplicated folder names. in this case we need to update the parent folder link in the relevant units
    return existingFoldersMap;
  }

  return new Map<string, Folder>();
}

const createUnitParam = (param: UftoTestParam, unit: UnitBody): UnitParamBody => {
  const direction = param.direction == UftoParamDirection.IN ? INPUT : OUTPUT;
  return {
    type: EntityConstants.MbtUnitParameter.ENTITY_NAME,
    subtype: EntityConstants.MbtUnitParameter.ENTITY_SUBTYPE,
    name: param.name,
    model_item: { repository_path: unit.repository_path }, //TODO check if this is correct
    parameter_type: { id: `list_node.entity_parameter_type.${direction}`, type: LIST_NODE },
    value: param.defaultValue,
  };
}

/* If there is no parent folder, but we have an id, that means we are creating the model for an old unit which exists in Octane
 but should be updated anyway to update the test runner field for example
 this is the common case when a runner was deleted, then later on recreated with the same repository, under a different runner name.

 If this unit entity is for a unit which already exists in Octane, and was not moved, the folder shouldn't be updated so don't pass any value
 and in this case there will be no parent folder during sync (as we are not pulling all the folders on each sync,
 only the new ones to push them to Octane)
*/
const buildUnit = (executorId: number, scmRepositoryId: number, action: UftoTestAction, parentId: number|null, unitParams: UnitParamBody[] | null = null): UnitBody => {
  if (!parentId && !action.id) {
    throw new Error("Received null parent folder, when trying to create a new unit entity");
  }

  let unit: UnitBody = {
    ... (parentId ? { parent: { id: parentId, type: "model_item" } } : {}),
    ... (action.description ? { description: action.description } : {}),
    name: !action.logicalName || action.logicalName.startsWith("Action") ? `${action.testName}:${action.name}` : action.logicalName,
    test_runner: { id: executorId, type: "executor" },
    repository_path: action.repositoryPath
  };
  if (action.id) {
    unit = { ...unit,
      id: action.id,
    }; 
  } else {
    unit = { ...unit,
      type: EntityConstants.MbtUnit.ENTITY_NAME,
      subtype: EntityConstants.MbtUnit.ENTITY_SUBTYPE,
      automation_status: { id: "list_node.automation_status.automated", type: LIST_NODE },
      scm_repository: { id: scmRepositoryId, type: "scm_repository" }
    }
  }

  //we need to add the unit to each param for later update
  if (unitParams) {
    action.parameters?.forEach(p => {
      unitParams.push(createUnitParam(p, unit));
    });
  }

  return unit;
}

const dispatchNewActions = async (executorId: number, scmRepositoryId: number, newActions: UftoTestAction[], autoDiscoveredFolder: BaseFolder): Promise<boolean> => {
  logger.debug(`dispatchNewActions: executorId=${executorId}, scmRepositoryId=${scmRepositoryId}, length=${newActions.length}, folder=${autoDiscoveredFolder.name} ...`);
  if (newActions?.length) {
    const foldersMap = await createParentFolders(newActions, autoDiscoveredFolder);
    const paramsToAdd: UnitParamBody[] = []; // add external parameter entities list to be filled by each action creation
    // add units
    const unitsToAdd: UnitBody[] = [];
    for (const action of newActions) {
      if (!action.testName) {
        logger.error(`Test name is undefined for action ${action.name}`);
        continue;
      }
      const parentFolder = foldersMap.get(action.testName);
      if (!parentFolder) {
        logger.error(`Parent folder for test ${action.testName} not found`);
        continue;
      }
      unitsToAdd.push(buildUnit(executorId, scmRepositoryId, action, parentFolder.id, paramsToAdd));
    }
    await OctaneClient.createUnits(unitsToAdd, paramsToAdd);
  }
  return true;
}

// we do not delete units. instead, we reset some of their attributes
const dispatchDeletedActions = async (deletedActions: UftoTestAction[]): Promise<boolean> => {
  logger.debug(`dispatchDeletedActions: length=${deletedActions.length} ...`);
  if (deletedActions?.length) {
    const unitsToDelete: UnitBody[] = [];
    for (const action of deletedActions) {
      if (!action.id) {
        logger.error(`ID is undefined for action ${action.name}`);
        continue;
      }
      const unit: UnitBody = {
        id: action.id,
        repository_path: null,
        automation_status: { id: "list_node.automation_status.not_automated", type: LIST_NODE },
        test_runner: null
      };
      unitsToDelete.push(unit);
    }
    await OctaneClient.updateUnits(unitsToDelete);
  }

  return true;
}

const dispatchUpdatedActions = async (executorId: number, scmRepositoryId: number, updatedActions: UftoTestAction[], parentFolder: Folder): Promise<boolean> => {
  if (updatedActions?.length) {
    logger.info(`Updating ${updatedActions.length} actions ...`);
    const existingFoldersMap = await updateParentFolders(scmRepositoryId, updatedActions, parentFolder);
    // convert actions to unit entities
    const unitsToUpdate: UnitBody[] = updatedActions.map(action => {
      const parentFolder = action.testName ? existingFoldersMap.get(action.testName) ?? null : null;
      return buildUnit(executorId, scmRepositoryId, action, parentFolder?.id ?? null);
    });

    // update units
    await OctaneClient.updateUnits(unitsToUpdate);
  }

  return true;
}

const dispatchDiscoveryResults = async (executorId: number, scmRepositoryId: number, result: DiscoveryResult) => {
  logger.info('Dispatching discovery results ...');
  const allActions = result.getAllTests().flatMap(aTest => aTest.actions);
  const actionsByStatusMap: Map<OctaneStatus, UftoTestAction[]> = allActions.reduce((acc, action) => {
    const status = action.octaneStatus;
    if (!acc.has(status)) {
      acc.set(status, []);
    }
    acc.get(status)!.push(action);
    return acc;
  }, new Map<OctaneStatus, UftoTestAction[]>());

  const autoDiscoveredFolder = await getAutoDiscoveredFolder(executorId);

  // handle new actions - create new units and parameters in octane
  let newActionsSynced = true;
  if (actionsByStatusMap.has(OctaneStatus.NEW)) {
    newActionsSynced = await dispatchNewActions(executorId, scmRepositoryId, actionsByStatusMap.get(OctaneStatus.NEW)!, autoDiscoveredFolder);
  }

  // handle deleted actions - currently do nothing
  let delActionsSynced = true;
  if (actionsByStatusMap.has(OctaneStatus.DELETED)) {
    delActionsSynced = await dispatchDeletedActions(actionsByStatusMap.get(OctaneStatus.DELETED)!);
  }

  let updatedActionsSynced = true;
  if (actionsByStatusMap.has(OctaneStatus.MODIFIED)) {
    updatedActionsSynced = await dispatchUpdatedActions(executorId, scmRepositoryId, actionsByStatusMap.get(OctaneStatus.MODIFIED)!, autoDiscoveredFolder);
  }

  return newActionsSynced && delActionsSynced && updatedActionsSynced;
}

export { dispatchDiscoveryResults }
