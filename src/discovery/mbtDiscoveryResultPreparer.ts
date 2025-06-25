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
import { Query } from '@microfocus/alm-octane-js-rest-sdk';
import OctaneClient from '../client/octaneClient';
import { Logger } from '../utils/logger';
import { EntityConstants } from '../dto/octane/general/EntityConstants';
import AutomatedTest from '../dto/ft/AutomatedTest';
import { escapeQueryVal, extractScmPathFromActionPath, extractScmTestPath, getTestPathPrefix, extractActionLogicalNameFromActionPath, extractActionNameFromActionPath } from '../utils/utils';
import UftoTestAction from '../dto/ft/UftoTestAction';
import { OctaneStatus } from '../dto/ft/OctaneStatus';
import DiscoveryResult from '../discovery/DiscoveryResult';
import Unit from '../dto/octane/general/Unit';

const _logger: Logger = new Logger('mbtDiscoveryResultPreparer');
const { ID, REPOSITORY_PATH, SCM_REPOSITORY } = EntityConstants.MbtUnit;

const mbtPrepDiscoveryRes4Sync = async (executorId: number, scmRepositoryId: number, discoveryRes: DiscoveryResult) => {
  if (discoveryRes.isFullSync()) {
    _logger.info(`Preparing full sync dispatch with MBT for executor ${executorId}`);
    const units = await fetchUnitsByScmRepository(scmRepositoryId);
    const existingUnitsByRepo = units.reduce((acc, unit) => {
      const key = unit.repository_path;
      acc.set(key, unit);
      return acc;
    }, new Map<string, Unit>());
    removeExistingUnits(discoveryRes, existingUnitsByRepo);
  } else {
    _logger.info(`Preparing incremental sync dispatch with MBT for executor ${executorId}`);
    await handleDeletedTests(discoveryRes.getDeletedTests());
    await handleAddedTests(discoveryRes);
    await handleUpdatedTests(discoveryRes.getUpdatedTests());
    await handleMovedTests(discoveryRes.getUpdatedTests());
    return;
  }
}

const fetchUnitsByScmRepository = async (scmRepositoryId: number): Promise<Unit[]> => {
  const qry1 = Query.field(SCM_REPOSITORY).equal(Query.field(ID).equal(scmRepositoryId))
    .and(Query.field(REPOSITORY_PATH).notEqual(Query.NULL));  // folders are also model items, but they don't have a repository path (it is null, also a different subtype)
  return await OctaneClient.fetchUnits(qry1);
}

const convertUnitToAction = (unit: Unit, octStatus: OctaneStatus): UftoTestAction => {
  return {
    id: `${unit.id}`,
    name: unit.name,
    logicalName: unit.name,
    octaneStatus: octStatus,
    repositoryPath: unit.repository_path
  };
};

const handleAddedTests = async (discoveryRes: DiscoveryResult) => {
  const newTests = discoveryRes.getNewTests();
  if (!newTests?.length) {
    return;
  }
  _logger.info(`Processing new tests. Count: ${newTests.length}.`);

  // Collect repository paths of actions for new tests that are not moved
  const newActionsRepositoryPaths = newTests
    .filter(automatedTest => !automatedTest.isMoved)
    .flatMap(automatedTest => automatedTest.actions)
    .map(a => escapeQueryVal(a.repositoryPath!));

  if (!newActionsRepositoryPaths?.length) {
    _logger.warn('No repository paths found for new tests.');
    return;
  }
  const qry = Query.field(REPOSITORY_PATH).inComparison(newActionsRepositoryPaths);
  const unitsFromServer = await OctaneClient.fetchUnits(qry);

  if (!unitsFromServer?.length) {
    _logger.warn('No units found in Octane for the given repository paths.');
    return;
  }

  const octaneUnitsMap = unitsFromServer.reduce((acc, u) => {
    const repoPath = u.repository_path;
    acc.set(repoPath, u); // add or update the key-value pair. If a duplicate key is encountered, the value will be overwritten.
    return acc;
  }, new Map<string, Unit>());

  removeExistingUnits(discoveryRes, octaneUnitsMap);
}

const handleUpdatedTests = async (updatedTests: ReadonlyArray<AutomatedTest>) => {
  if (!updatedTests?.length) {
    return;
  }
  updatedTests = updatedTests.filter(test => !test.isMoved);
  if (!updatedTests?.length) {
    return;
  }
  _logger.info(`Processing updated tests. Count: ${updatedTests.length}.`);

  // there are 4 cases:
  // 1. new action -> action will exist in the automated test but not in octane
  // 2. delete action -> action will exist in octane but not in the automated test
  // 3. updated action -> action will exist both in the automated test and in octane and will differ in the logical
  // name and/or description
  // 4. not modified action -> action in the automated test is equal to the unit in octane

  const scmPathToActionMap: Map<string, UftoTestAction> = new Map(
    updatedTests.flatMap(test => test.actions).map(action => {
      const key = extractScmPathFromActionPath(action.repositoryPath!);
      return [key, action] as [string, UftoTestAction];
    })
  );

  // create a condition for each test to fetch its units by the old test name
  const qry = updatedTests.reduce((acc, test) => {
    const q = getActionPathPrefixQuery(test, false);
    return acc === Query.NULL ? q : acc.or(q);
  }, Query.NULL);

  const unitsFromServer = await OctaneClient.fetchUnits(qry);
  const scmPathToUnitMap = unitsFromServer.reduce((acc, u) => {
    const scmPath = extractScmPathFromActionPath(u.repository_path);
    acc.set(scmPath, u);
    return acc;
  }, new Map<string, Unit>());

  handleUpdatedTestAddedActionCase(scmPathToActionMap, scmPathToUnitMap);
  handleUpdatedTestDeletedActionCase(scmPathToActionMap, scmPathToUnitMap, updatedTests);
  handleUpdatedTestUpdatedActionCase(scmPathToActionMap, scmPathToUnitMap);

  // just a validation
  if (scmPathToActionMap.size || scmPathToUnitMap.size) {
    _logger.warn("Not all of the existing units or actions were processed");
  }

}

const handleDeletedTests = async (deletedTests: ReadonlyArray<AutomatedTest>) => {
  if (!deletedTests?.length) {
    return;
  }
  // create a condition for each test to fetch its units by the old test name
  const qry = deletedTests.reduce((acc, test) => {
    const q = getActionPathPrefixQuery(test, false);
    return acc === Query.NULL ? q : acc.or(q);
  }, Query.NULL);

  const unitsFromServer = await OctaneClient.fetchUnits(qry);

  // Since the test was already deleted from the SCM, the automated test will not contain any UFT actions.
  // We need to map each unit from Octane to the automated test and create a marker UFT action with only the unit ID
  // so later we will be able to update the unit entities.
  deletedTests.forEach(automatedTest => {
    const actionPathPrefix = getTestPathPrefix(automatedTest, false);
    // Find all the unit entities that belong to this test
    const unitsOfTest = unitsFromServer.filter(unit =>
      unit.repository_path.startsWith(actionPathPrefix)
    );
    // Remove the filtered units from the original units array
    unitsFromServer.splice(unitsFromServer.indexOf(unitsOfTest[0]), unitsOfTest.length);
    // Convert unit entities to test actions
    automatedTest.actions = unitsOfTest.map(unit => {
      return convertUnitToAction(unit, OctaneStatus.DELETED);
    });
  });
}

const getActionPathPrefixQuery = (test: AutomatedTest, orgPath: boolean): Query => {
  const actionPathPrefix = getTestPathPrefix(test, orgPath);
  const actionPathPrefixEscaped = escapeQueryVal(actionPathPrefix);
  return Query.field(REPOSITORY_PATH).equal(`${actionPathPrefixEscaped}*`);
}

//TODO check if the logic is 100% correct, ask Itay about entityHelper.useUnitToRunnerLogic() from MbtDiscoveryResultPreparerImpl.java
const removeExistingUnits = (discoveryRes: DiscoveryResult, octaneUnitsMap: Map<string, Unit>) => {
 discoveryRes.getAllTests().forEach(test => {
    test.actions = test.actions.filter(action => {
      if (!action.repositoryPath) return true; // Keep if no repositoryPath
      const u = octaneUnitsMap.get(action.repositoryPath!);
      if (!u) return true; // Keep the action if no Octane Unit is found
      if (u.test_runner) return false; // Remove the action if test_runner exists
      action.octaneStatus = OctaneStatus.MODIFIED;
      action.id = `${u.id}`;
      return true; // Keep the action
    });
  });
};

// handle case 1 for added actions
const handleUpdatedTestAddedActionCase = (scmPathToActionMap: Map<string, UftoTestAction>, scmPathToUnitMap: Map<string, Unit>): void => {
  const addedActions = Array.from(scmPathToActionMap.keys()).filter(key => !scmPathToUnitMap.has(key));
  if (addedActions.length > 0) {
    _logger.debug(`Found ${addedActions.length} updated tests for added action`);

    addedActions.forEach(p => {
      const action = scmPathToActionMap.get(p);
      if (action) {
        action.octaneStatus = OctaneStatus.NEW; // not required, just for readability
        scmPathToActionMap.delete(p);
      }
    });
  }
}

// handle case 2 for deleted actions
const handleUpdatedTestDeletedActionCase = (
  scmPathToActionMap: Map<string, UftoTestAction>,
  scmPathToUnitMap: Map<string, Unit>,
  updatedTests: ReadonlyArray<AutomatedTest>): void => {

  const deletedActions = Array.from(scmPathToUnitMap.keys()).filter(key => !scmPathToActionMap.has(key));

  if (deletedActions.length > 0) {
    let updatedTestsCounter = 0;

    deletedActions.forEach(s => {
      const scmTestPath = extractScmTestPath(s);
      if (!scmTestPath) {
        const u = scmPathToUnitMap.get(s);
        if (u) {
          _logger.warn(`Repository path ${s} of unit id: ${u.id}, name: "${u.name}" is not valid and will be discarded`);
          scmPathToUnitMap.delete(s);
        }
      } else {
        // Try to match between the automated test and the units to be deleted. Since the action was already deleted
        // from the SCM, we need to update Octane. The handling is the same as handling a deleted test. We need
        // to mark the deleted actions and provide only the unit id.
        updatedTests.forEach(automatedTest => {
          const calculatedTestPath = getTestPathPrefix(automatedTest, false).toLowerCase();
          // Match found. Add a marker action to the automated test.
          if (calculatedTestPath === scmTestPath) {
            const entity = scmPathToUnitMap.get(s);
            if (entity) {
              const action = convertUnitToAction(entity, OctaneStatus.DELETED);
              automatedTest.actions.push(action);
              updatedTestsCounter++;
            }
          }
        });
        scmPathToUnitMap.delete(s);
        _logger.info(`Found ${updatedTestsCounter} updated tests for deleted action`);
      }
    });
  }
};

// handle case 3 for updated actions
const handleUpdatedTestUpdatedActionCase = (
  scmPathToActionMap: Map<string, UftoTestAction>,
  scmPathToUnitMap: Map<string, Unit>
): void => {
  // updated action candidates
  const sameActions = Array.from(scmPathToUnitMap.keys()).filter(key => scmPathToActionMap.has(key));

  if (sameActions.length > 0) {
    sameActions.forEach(scmPath => {
      const action = scmPathToActionMap.get(scmPath);
      const unit = scmPathToUnitMap.get(scmPath);

      if (action && unit) {
        // if the logical name has changed, mark the action as modified
        const logicalName = extractActionLogicalNameFromActionPath(unit.repository_path).toLowerCase();
        if (action.logicalName!.toLowerCase() === logicalName) {
          action.octaneStatus = OctaneStatus.NONE;
        } else {
          action.id = `${unit.id}`;
          action.octaneStatus = OctaneStatus.MODIFIED;
        }

        action.parameters?.forEach(p => {
          p.octaneStatus = OctaneStatus.NONE; // currently do not support parameter changes
        });

        scmPathToActionMap.delete(scmPath);
        scmPathToUnitMap.delete(scmPath);
      }
    });
  }
}

const handleMovedTests = async (updatedTests: ReadonlyArray<AutomatedTest>) => {
  if (!updatedTests?.length) return;
  const movedTests = updatedTests.filter(test => test.isMoved);
  if (!movedTests?.length) return;

  // create a condition for each test to fetch its units by the old test name
  const qry = movedTests.reduce((acc, test) => {
    const q = getActionPathPrefixQuery(test, true);
    return acc === Query.NULL ? q : acc.or(q);
  }, Query.NULL);

  const unitsFromServer = await OctaneClient.fetchUnits(qry);

  // now, we need to match between the original units and the automated test by the original action path prefix.
  // then, we will store a mapping between what the new action path should be and the unit id and update each unit
  // with the id and update the status to modified

  movedTests.forEach(aTest => {
    // match units from octane to automated test by the original repository path prefix
    const origActionPathPrefix = getTestPathPrefix(aTest, true);
    const units = unitsFromServer.filter(u => u.repository_path.startsWith(origActionPathPrefix));

    // since the repository path for the action is changed, we need to compare the actions/units by the action name from UFTOne: Action1, Action2 etc.
    // a map that contains the action name: Action1, Action2 ... to the entity from Octane.
    const actionNameToUnitMap = units.reduce((acc, unit) => {
      const actionName = extractActionNameFromActionPath(unit.repository_path);
      acc.set(actionName, unit);
      return acc;
    }, new Map<string, Unit>());

    // a map of the action name to the action from UFTOne
    const actionNameToUftActionMap = aTest.actions.reduce((acc, action) => {
      acc.set(action.name, action);
      return acc;
    }, new Map<string, UftoTestAction>());

    // handle add actions
    const addedActions = Array.from(actionNameToUftActionMap.keys()).filter(key => !actionNameToUnitMap.has(key));

    if (addedActions.length > 0) {
      _logger.info(`Found ${addedActions.length} added actions for moved test ${aTest.name}`);
    }

    // handle deleted actions
    const deletedActionNames = Array.from(actionNameToUnitMap.keys()).filter(key => !actionNameToUftActionMap.has(key));

    if (deletedActionNames.length > 0) {
      _logger.info(`Found ${deletedActionNames.length} deleted actions for moved test ${aTest.name}`);
      // add the action as deleted to the automated test
      deletedActionNames.forEach(aName => {
        const entity = actionNameToUnitMap.get(aName);
        if (entity) {
          const action = convertUnitToAction(entity, OctaneStatus.DELETED);
          action.name = aName;
          aTest.actions.push(action);
        }
      });
    }

    // handle moved actions - not deleted and not added
    aTest.actions
      .filter(uftTestAction => !addedActions.includes(uftTestAction.name) && !deletedActionNames.includes(uftTestAction.name))
      .forEach(action => {
        const unit = actionNameToUnitMap.get(action.name);
        if (unit) {
          action.id = `${unit.id}`;
          action.octaneStatus = OctaneStatus.MODIFIED;
          action.moved = true;
          action.oldTestName = aTest.oldName;
          action.parameters = []; // currently the java code sets octaneStatus to NONE for all params and then deletes all params
        }
      });

    // remove the matched entities to remove duplicates
    unitsFromServer.splice(0, unitsFromServer.length, ...unitsFromServer.filter(unit => !units.includes(unit)));
  });

  // when we reach here all the units from octane should have been removed
  if (unitsFromServer.length > 0) {
    _logger.warn("Not all units from octane were mapped to moved tests");
  }
}

export {
  mbtPrepDiscoveryRes4Sync
};
