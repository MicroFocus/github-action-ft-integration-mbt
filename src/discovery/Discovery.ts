import { Logger } from '../utils/logger';
import { exec } from '@actions/exec';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { UftoTestType } from '../dto/ft/UftoTestType';
import ToolType from '../dto/ft/ToolType';
import AutomatedTest from '../dto/ft/AutomatedTest';
import ScmResourceFile from '../dto/ft/ScmResourceFile';
import { OctaneStatus } from '../dto/ft/OctaneStatus';
import { Document, Element } from '@xmldom/xmldom';
import UftoTestAction from '../dto/ft/UftoTestAction';
import UftoTestParam from '../dto/ft/UftoTestParam';
import ScmChangesWrapper, { ScmAffectedFileWrapper } from './ScmChangesWrapper';
import { getHeadCommitSha, getParentFolderFullPath, getTestPathPrefix, getTestType, isBlank, isTestMainFile, getSafeDomParser, extractXmlFromTspOrMtrFile, getGuiTestDocument, getApiTestDocument, getFileIfExist } from '../utils/utils';
import { config } from '../config/config';
import DiscoveryResult from './DiscoveryResult';
import { TspParseError } from '../utils/TspParseError';

const _logger: Logger = new Logger('Discovery');
const _toolType = config.testingTool === "mbt" ? ToolType.MBT : ToolType.UFT;

const UFT_COMPONENT_NODE_NAME = "Component";
const UFT_DEPENDENCY_NODE_NAME = "Dependency";
const UFT_ACTION_TYPE_ATTR = "Type";
const UFT_ACTION_KIND_ATTR = "Kind";
const UFT_ACTION_SCOPE_ATTR = "Scope";
const UFT_ACTION_LOGICAL_ATTR = "Logical";
const UFT_ACTION_TYPE_VALUE = "1";
const UFT_ACTION_KIND_VALUE = "16";
const UFT_ACTION_SCOPE_VALUE = "0";
const ACTION_0 = "action0";
const RESOURCE_MTR = "resource.mtr";
const UFT_PARAM_ARGS_COLL_NODE_NAME = "ArgumentsCollection";
const UFT_PARAM_ARG_NAME_NODE_NAME = "ArgName";
const UFT_PARAM_ARG_DEFAULT_VALUE_NODE_NAME = "ArgDefaultValue";
const UFT_ACTION_DESCRIPTION_NODE_NAME = "Description";
const ARG_DIRECTION = "ArgDirection";
const TEXT_XML = "text/xml";
const _folders2skip = [".git", ".github"];
const ADD = 'ADD';
const DELETE = 'DELETE';
const EDIT = 'EDIT';
const _XLSX = ".xlsx";
const _XLS = ".xls";
const _ST = ".st";
const _TSP = ".tsp";
export default class Discovery {
  private _workDir: string;
  private _tests: AutomatedTest[] = [];
  private _scmResxFiles: ScmResourceFile[] = [];
  constructor(workDir: string) {
    _logger.debug('Discovery constructor ...');
    this._workDir = workDir;
  }

  public hasChanges(): boolean {
    return this._tests.length > 0 || this._scmResxFiles.length > 0;
  }

  public getTests(): AutomatedTest[] {
    return this._tests;
  }

  private getNewTests(): ReadonlyArray<AutomatedTest> {
    return this.getTestsByOctaneStatus(OctaneStatus.NEW);
  }

  private getUpdatedTests(): ReadonlyArray<AutomatedTest> {
    return this.getTestsByOctaneStatus(OctaneStatus.MODIFIED);
  }

  private getDeletedTests(): ReadonlyArray<AutomatedTest> {
    return this.getTestsByOctaneStatus(OctaneStatus.DELETED);
  }

  private getTestsByOctaneStatus(status: OctaneStatus): ReadonlyArray<AutomatedTest> {
    return Object.freeze(this._tests.filter(automatedTest => automatedTest.octaneStatus === status));
  }

  private getNewScmResxFiles(): ReadonlyArray<ScmResourceFile> {
    return this.getResxFilesByOctaneStatus(OctaneStatus.NEW);
  }

  private getDeletedScmResxFiles(): ReadonlyArray<ScmResourceFile> {
    return this.getResxFilesByOctaneStatus(OctaneStatus.DELETED);
  }

  private getResxFilesByOctaneStatus(status: OctaneStatus): ReadonlyArray<ScmResourceFile> {
    return Object.freeze(this._scmResxFiles.filter(scmResxFile => scmResxFile.octaneStatus === status));
  }  

  private getScmResxFiles(): ScmResourceFile[] {
    return this._scmResxFiles;
  }

  private removeTestDuplicatedForUpdateTests() {
    const keys = new Set<string>();
    const testsToRemove: AutomatedTest[] = [];

    for (const test of this.getUpdatedTests()) {
        const key = `${test.packageName}_${test.name}`;
        if (keys.has(key)) {
            testsToRemove.push(test);
        }
        keys.add(key);
    }

    this._tests = this._tests.filter(test => !testsToRemove.includes(test));
  }

  private removeFalsePositiveDataTables(tests: ReadonlyArray<AutomatedTest>, scmResxFiles: ReadonlyArray<ScmResourceFile>) {
    if (!tests?.length || !scmResxFiles?.length) return;

    // Precompute test paths into a Set
    const testPaths = new Set<string>(tests.map(t => isBlank(t.packageName) ? t.name : path.join(t.packageName, t.name)));

    // Single-pass filter on _scmResxFiles
    this._scmResxFiles = this._scmResxFiles.filter(file => {
      const parentName = path.dirname(file.relativePath);
      return !Array.from(testPaths).some(testPath => parentName.includes(testPath));
    });
  }

  private sortTests(): void {
    this._tests.sort((o1, o2) => {
      const comparePackage = o1.packageName.localeCompare(o2.packageName);
      if (comparePackage === 0) {
        return o1.name.localeCompare(o2.name);
      } else {
        return comparePackage;
      }
    });
  }

  private sortDataTables(): void {
    this._scmResxFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }  

  public async startScanning(oldCommit: string): Promise<DiscoveryResult> {
    _logger.info('BEGIN Scanning ...');
    const didFullCheckout = await this.checkoutRepo();
    const newCommit = await getHeadCommitSha(this._workDir);
    let isFullSync = true;
    if (didFullCheckout) {
      await this.doFullDiscovery();
    } else {
      if (oldCommit) {
        const affectedFiles = await ScmChangesWrapper.getScmChanges(_toolType, this._workDir, oldCommit, newCommit);
        await this.doSyncDiscovery(affectedFiles);
        isFullSync = false;
      } else {
        await this.doFullDiscovery();
      }
    }
    _logger.info(`isFullSync = ${isFullSync}`);
    _logger.info('END Scanning ...');
    return new DiscoveryResult(newCommit, this._tests, this._scmResxFiles, isFullSync);
  }

  private async doFullDiscovery() {
    await this.scanDirRecursively(this._workDir);
    //not sure if we need this, tests and data tables might be already sorted
    //this.sortTests();
    //this.sortDataTables();
  }

  private async doSyncDiscovery(affectedFiles: ScmAffectedFileWrapper[]) {
    await this.doChangeSetDetection(affectedFiles);
    this.removeTestDuplicatedForUpdateTests();
    this.removeFalsePositiveDataTables(this.getDeletedTests(), this.getDeletedScmResxFiles());
    this.removeFalsePositiveDataTables(this.getNewTests(), this.getNewScmResxFiles());
    this.sortTests();
    this.sortDataTables();
  }

  private async doChangeSetDetection(affectedFiles: ScmAffectedFileWrapper[]) {
    for (const affectedFileWrapper of affectedFiles) {
      if (affectedFileWrapper.newPath.startsWith('"')) { //TODO: not sure if must handle this case
        //result.setHasQuotedPaths(true);
      }
      const affectedFileFullPath = path.join(this._workDir, affectedFileWrapper.newPath);
      if (isTestMainFile(affectedFileFullPath)) {
        await this.handleTestChanges(affectedFileWrapper, affectedFileFullPath);
      } else if (_toolType === ToolType.UFT && this.isDataTableFile(affectedFileWrapper.newPath)) {
        await this.handleDataTableChanges(affectedFileWrapper, affectedFileFullPath);
      } else if (_toolType === ToolType.MBT && this.isUftoActionFile(affectedFileWrapper.newPath)) {
        await this.handleActionChanges(affectedFileWrapper, affectedFileFullPath);
      }
    }
  }
  private async handleActionChanges(affectedFileWrapper: ScmAffectedFileWrapper, affectedFileFullPath: string) {
    // TODO: not implemented yet in java
  }
  private isUftoActionFile(filePath: string) {
    return path.basename(filePath).toLowerCase() === RESOURCE_MTR;
  }
  private async handleDataTableChanges(affFileWrapper: ScmAffectedFileWrapper, affFileFullPath: string) {
    const resxFile = this.createScmResxFile(affFileFullPath, affFileWrapper.oldId, affFileWrapper.newId);
    const fileExists = fs.existsSync(affFileFullPath);

    if (affFileWrapper.changeType === ADD) {
      const testDirFullPath = getParentFolderFullPath(affFileFullPath);
      const items = await fs.promises.readdir(testDirFullPath) ?? [];
      const testType = await this.getTestType(items);
      if (testType.isNone()) {
        fileExists && this._scmResxFiles.push(resxFile);
      }
    } else if (affFileWrapper.changeType === DELETE) {
      if (!fileExists) {
        resxFile.octaneStatus = OctaneStatus.DELETED;
        this._scmResxFiles.push(resxFile);
      }
    }
  }
  private async handleTestChanges(affFileWrapper: ScmAffectedFileWrapper, affFileFullPath: string) {
    const testDirFullPath = getParentFolderFullPath(affFileFullPath);
    const fileExists = fs.existsSync(affFileFullPath);
    const testType = getTestType(affFileWrapper.newPath);
    const test = fileExists ?
        await this.createAutomatedTestEx(testDirFullPath, testType, affFileWrapper.oldId, affFileWrapper.newId) :
        await this.createAutomatedTest(testDirFullPath, testType, affFileWrapper.oldId, affFileWrapper.newId);
    if (affFileWrapper.changeType === ADD) {
      fileExists && this._tests.push(test);
    } else if (affFileWrapper.changeType === DELETE) {
      if (!fileExists) {
        test.executable = false;
        test.octaneStatus = OctaneStatus.DELETED;
        this._tests.push(test);
      }
    } else if (affFileWrapper.changeType === EDIT) {
      if (fileExists) {
        this.updateOldData(test, affFileWrapper);
        test.isMoved = this.isTestMoved(test);
        test.octaneStatus = OctaneStatus.MODIFIED;
        this._tests.push(test);      
      }
    }
  }
  
  private updateOldData(test: AutomatedTest, affFileWrapper: ScmAffectedFileWrapper) {
    const oldPath = affFileWrapper.oldPath;
    if(!isBlank(oldPath)) {
        const parts = oldPath!.split("/");
        const oldTestName = parts[parts.length - 2];
        test.oldName = oldTestName;
        // make sure path in windows style
        let oldPackageName = "";
        if(parts.length > 2) { // only in case the test is not under the root folder
          oldPackageName = oldPath!.substring(0, oldPath!.indexOf(oldTestName) - 1).replace(/\//g, "\\");
        }
        test.oldPackageName = oldPackageName;
    }
}

  // a test is considered moved either if its name has changed or its folder path
  private isTestMoved(test: AutomatedTest): boolean {
    if (!isBlank(test.oldName) && test.oldPackageName != null && !isBlank(test.name) && test.packageName != null) {
      return test.name !== test.oldName || test.packageName !== test.oldPackageName;
    }
    return false;
  }

  private async scanDirRecursively(subDirFullPath: string) {
    if (_folders2skip.includes(path.basename(subDirFullPath))) {
      return;
    }

    const items = await fs.promises.readdir(subDirFullPath) ?? [];
    const testType = await this.getTestType(items);
    if (testType.isNone()) {
      for (const item of items) {
        const fullPath = path.join(subDirFullPath, item);
        const stats = await fs.promises.stat(fullPath);
        if (stats.isDirectory()) {
          await this.scanDirRecursively(fullPath);
        } else if (this.isDataTableFile(item)) {
          const scmResxFile = this.createScmResxFile(fullPath);
          this._scmResxFiles.push(scmResxFile);
        }
      }
    } else if (!(_toolType === ToolType.MBT && testType === UftoTestType.API)) {
      const automTest = await this.createAutomatedTestEx(subDirFullPath, testType);
      this._tests.push(automTest);
    }
  }

  private async createAutomatedTest(subDirFullPath: string, testType: UftoTestType, oldId?: string, newId?: string): Promise<AutomatedTest> {
    const testName = path.basename(subDirFullPath);
    const relativePath = this.getRelativePath(subDirFullPath);
    let packageName = "";
    if (relativePath.length > testName.length) {
      const segments = relativePath.split(path.sep);
      packageName = segments.slice(0, -1).join(path.sep);
    }

    const test: AutomatedTest = {
      name: testName,
      packageName: packageName,
      uftOneTestType: testType,
      executable: true,
      actions: [],
      octaneStatus: OctaneStatus.NEW,
      changeSetSrc: oldId,
      changeSetDst: newId
    };
    return test;
  }

  private async createAutomatedTestEx(subDirFullPath: string, testType: UftoTestType, oldId?: string, newId?: string): Promise<AutomatedTest> {
    const test = await this.createAutomatedTest(subDirFullPath, testType, oldId, newId);
    const doc = await this.getDocument(subDirFullPath, testType);
    let descr = this.getTestDescription(doc, testType);
    descr = this.convertToHtmlFormatIfRequired(descr);
    test.description = descr ?? "";

    // discover actions only for mbt toolType and gui tests
    if (_toolType == ToolType.MBT && testType === UftoTestType.GUI) {
      const actionPathPrefix = this.getActionPathPrefix(test, false);
      const actions = await this.parseActionsAndParameters(doc, actionPathPrefix, test.name, subDirFullPath);
      test.actions = actions;    
    }

    return test;
  }

  async parseActionsAndParameters(doc: Document | null, actionPathPrefix: string, testName: string, dirPath: string): Promise<UftoTestAction[]> {
    const actions: UftoTestAction[] = [];

    if (!doc) {
        _logger.warn("received null gui test document, actions will not be parsed");
    } else {
        const actionMap = this.parseActionComponents(doc, testName);
        this.fillActionsLogicalName(doc, actionMap, actionPathPrefix);
        actions.push(...Array.from(actionMap.values()));
        try {
            await this.readParameters(dirPath, actionMap);
        } catch (error: any) {
            _logger.error(`Failed to parse action's parameters: ${error?.message}`);
        }
    }

    return actions;
  }

  private fillActionsLogicalName(document: Document, actionMap: Map<string, UftoTestAction>, actionPathPrefix: string): void {
    const dependencyNodes = document.getElementsByTagName(UFT_DEPENDENCY_NODE_NAME);
    for (let i = 0; i < dependencyNodes.length; i++) {
      const dependencyNode = dependencyNodes.item(i);
      if (dependencyNode) {
        const attributes = dependencyNode.attributes;
        const type = attributes.getNamedItem(UFT_ACTION_TYPE_ATTR)?.nodeValue;
        const kind = attributes.getNamedItem(UFT_ACTION_KIND_ATTR)?.nodeValue;
        const scope = attributes.getNamedItem(UFT_ACTION_SCOPE_ATTR)?.nodeValue;
        const logicalName = attributes.getNamedItem(UFT_ACTION_LOGICAL_ATTR)?.nodeValue;

        if (type === UFT_ACTION_TYPE_VALUE && kind === UFT_ACTION_KIND_VALUE && scope === UFT_ACTION_SCOPE_VALUE && logicalName) {
          const dependencyStr = dependencyNode.textContent;
          const actionName = dependencyStr?.substring(0, dependencyStr.indexOf("\\"));
          if (actionName && actionName.toLowerCase() !== ACTION_0) { // action0 is not relevant
            const action = actionMap.get(actionName);
            if (action) {
                action.logicalName = logicalName;
                this.setActionPath(action, actionPathPrefix);
            }
          }
        }
      }
    }
  }

  private setActionPath(action: UftoTestAction, actionPathPrefix: string): void {
    const actionName = action.logicalName || action.name;
    action.repositoryPath = `${actionPathPrefix}\\${action.name}:${actionName}`;
  }

  private async readParameters(dirPath: string, actionMap: Map<string, UftoTestAction>): Promise<void> {
    for (const [actionName, action] of actionMap.entries()) {
      const actionFolder = `${dirPath}/${actionName}`;
      try {
        const resourceMtrFile = await getFileIfExist(actionFolder, RESOURCE_MTR);
        if (resourceMtrFile) {
          await this.parseActionMtrFile(resourceMtrFile, action);
        } else {
          _logger.warn(`resource.mtr file for action ${actionName} does not exist`);
        }
      } catch (error) {
        action.parameters = [];
        _logger.warn(`folder for action ${actionName} does not exist: ${(error as Error).message}`);
      }
    }
  }

  private parseActionComponents(document: Document, testName: string): Map<string, UftoTestAction> {
    const actionMap = new Map<string, UftoTestAction>();

    const componentNodes = document.getElementsByTagName(UFT_COMPONENT_NODE_NAME);
    for (let i = 0; i < componentNodes.length; i++) {
      const componentNode = componentNodes.item(i);
      if (componentNode) {
        const actionName = componentNode.textContent;
        if (actionName && actionName.toLowerCase() !== ACTION_0) {
          const action: UftoTestAction = {
            name: actionName,
            testName: testName,
            octaneStatus: OctaneStatus.NEW
          };
          actionMap.set(actionName, action);
        }
      }
    }

    return actionMap;
  }

  private async parseActionMtrFile(resourceMtrFile: string, action: UftoTestAction): Promise<void> {
    const params: UftoTestParam[] = [];
    const xmlContent = await extractXmlFromTspOrMtrFile(resourceMtrFile);
    const parser = getSafeDomParser();
    const cleanXmlContent = xmlContent.replace(/^\uFEFF/, ''); // Remove BOM if present
    const doc = parser.parseFromString(cleanXmlContent, TEXT_XML) as Document;
    const argumentsCollectionElement = doc.getElementsByTagName(UFT_PARAM_ARGS_COLL_NODE_NAME);
    if (argumentsCollectionElement.length > 0) {
        const argumentsCollectionItem = argumentsCollectionElement.item(0);
        const childArgumentElements = argumentsCollectionItem?.childNodes;
        if (childArgumentElements) {
            for (let i = 0; i < childArgumentElements.length; i++) {
                const argElem = childArgumentElements.item(i) as Element;
                const param: UftoTestParam = {
                    name: argElem.getElementsByTagName(UFT_PARAM_ARG_NAME_NODE_NAME).item(0)?.textContent ?? '',
                    direction: parseInt(argElem.getElementsByTagName(ARG_DIRECTION).item(0)?.textContent ?? '0', 10),
                    octaneStatus: OctaneStatus.NEW
                };
                const defaultValNode = argElem.getElementsByTagName(UFT_PARAM_ARG_DEFAULT_VALUE_NODE_NAME).item(0);
                if (defaultValNode) {
                    param.defaultValue = defaultValNode.textContent ?? '';
                }
                params.push(param);
            }
        }
    }

    action.parameters = params;
    action.description = doc.getElementsByTagName(UFT_ACTION_DESCRIPTION_NODE_NAME).item(0)?.textContent ?? '';
  }

  private convertToHtmlFormatIfRequired(description: string | null): string | null {
    if (description === null || !description.includes('\n')) {
        return description;
    }
    // aaa\nbbb => <html><body><p>aaa</p><p>bbb</p></body></html>
    const lines = description.split('\n');
    const sb: string[] = [];
    sb.push('<html><body>');
    for (const line of lines) {
        sb.push('<p>', line, '</p>\n');
    }
    sb.push('</body></html>');
    return sb.join('');
  }

  private getTestDescription(doc: Document | null, testType: UftoTestType): string | null {
    if (doc == null || testType.isNone()) {
      return null;
    }

    let description = "";
    if (testType == UftoTestType.GUI) {
      description = doc.getElementsByTagName("Description").item(0)?.textContent ?? "";
    } else {
      description = this.getTestDescriptionFromAPITest(doc) ?? "";
    }
    if (description != null) {
      description = description.trim();
    }
    return description;
  }

  private getTestDescriptionFromAPITest(document: Document): string | null {
    // Actions.xml
    // <Actions>
    // <Action internalName="MainAction" userDefinedName="APITest1" description="radi end test description" />
    // </Actions>

    const actions = document.getElementsByTagName("Action");
    for (let i = 0; i < actions.length; i++) {
      const action = actions.item(i);
      if (action) {
        const attributes = action.attributes;
        const internalNameAttr = attributes.getNamedItem("internalName");
        if (internalNameAttr && internalNameAttr.nodeValue === "MainAction") {
          const descriptionAttr = attributes.getNamedItem("description");
          if (descriptionAttr) {
            return descriptionAttr.nodeValue;
          }
        }
      }
    }
    return null;
  }

  private async getDocument(dirPath: string, testType: UftoTestType): Promise<Document | null> {
    if (testType === UftoTestType.GUI) {
      const doc = await getGuiTestDocument(dirPath);
      if (!doc) {
        throw new TspParseError("No document parsed");
      }

      // Additional security checks
      const entities = doc.getElementsByTagName("ENTITY");
      if (entities.length > 0) {
        throw new TspParseError("External entities detected in XML");
      }
      return doc;
    } else {
      return getApiTestDocument(dirPath);
    };
  }

  // in case a test was moved and we need the action path prefix before the move then set orgPath to true
  private getActionPathPrefix(test: AutomatedTest, orgPath: boolean): string {
    return getTestPathPrefix(test, orgPath);
  }

  private isDataTableFile(file: string) : boolean {
    const ext = path.extname(file).toLowerCase();
    return ext === _XLSX || ext === _XLS;
  }

  private async getTestType(paths: string[]): Promise<UftoTestType> {
    if (!paths?.length) {
      return UftoTestType.None;
    }
    for (const p of paths) {
      const ext = path.extname(p).toLowerCase();
      if (ext === _ST) {
        return UftoTestType.API;
      }
      if (ext === _TSP) {
        return UftoTestType.GUI;
      }
    }
    return UftoTestType.None;
  }

  private createScmResxFile(fullFilePath: string, oldId?: string, newId?: string): ScmResourceFile {
    const resxFile: ScmResourceFile = {
        name: fullFilePath,
        relativePath: this.getRelativePath(fullFilePath),
        octaneStatus: OctaneStatus.NEW,
        changeSetSrc: oldId,
        changeSetDst: newId
    };

    return resxFile;
  }

  private getRelativePath(subPath: string): string {
    return path.relative(this._workDir, subPath);
  }

  private async checkoutRepo(): Promise<boolean> {
    _logger.info('BEGIN checkoutRepo ...');
    try {
      const token = core.getInput('githubToken', { required: true });
      let didFullCheckout = false;

      const authRepoUrl = config.repoUrl.replace('https://', `https://x-access-token:${token}@`);
      _logger.debug(`Expected authRepoUrl: ${authRepoUrl}`);

      // Filter process.env to exclude undefined values
      const filteredEnv: { [key: string]: string } = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          filteredEnv[key] = value;
        }
      }

      // Configure Git options with common properties
      const gitOptions = {
        cwd: this._workDir,     // Common working directory
        ignoreReturnCode: true, // Ignore non-zero exit codes by default
        silent: false,          // Keep false for debugging
        env: filteredEnv,       // Use filtered env with only string values
        listeners: {            // Common listeners for all Git commands
          stderr: (data: Buffer) => printWarn(data) // for debug only
        }
      };

      function printWarn (data: Buffer) {
        if (data) {
          const msg = data.toString().trim();
          _logger.warn(msg);
        }
      };

      // Check if _work\ufto-tests is a Git repository
      const gitDir = path.join(this._workDir, '.git');
      if (fs.existsSync(gitDir)) {
        _logger.info('Working directory is a Git repo, checking remote URL...');

        // Get the current remote URL with specific stdout capture
        let currentRemoteUrl = '';
        const getUrlOutput: string[] = [];
        const getUrlExitCode = await exec('git', ['remote', 'get-url', 'origin'], {
          ...gitOptions,
          listeners: {
            ...gitOptions.listeners,
            stdout: (data: Buffer) => getUrlOutput.push(data.toString().trim())
          }
        });
        if (getUrlExitCode === 0) {
          currentRemoteUrl = getUrlOutput.join('').trim();
          _logger.debug(`Current remote URL: ${currentRemoteUrl}`);
        } else {
          _logger.warn('Failed to get current remote URL, proceeding with set-url');
        }

        // Compare current URL with base repoUrl (ignoring token)
        if (currentRemoteUrl == authRepoUrl) {
          _logger.info('Remote URL base matches.');
        } else {
          _logger.info('Remote URL does not match, setting to authenticated URL...');
          const setUrlExitCode = await exec('git', ['remote', 'set-url', 'origin', authRepoUrl], gitOptions);
          if (setUrlExitCode !== 0) {
            throw new Error(`git remote set-url failed with exit code ${setUrlExitCode}`);
          }
        }

        // Perform the pull
        _logger.info('Pulling updates...');
        const pullExitCode = await exec('git', ['pull'], gitOptions);
        if (pullExitCode !== 0) {
          throw new Error(`git pull failed with exit code ${pullExitCode}`);
        }
      } else {
        _logger.info(`Cloning repository into ${this._workDir}`);
        const cloneExitCode = await exec('git', ['clone', authRepoUrl, '.'], gitOptions);
        if (cloneExitCode !== 0) {
          throw new Error(`git clone failed with exit code ${cloneExitCode}`);
        }
        didFullCheckout = true;
      }
      _logger.info('END checkoutRepo ...');
      return didFullCheckout;
    } catch (error: any) {
      _logger.error('Error in checkoutRepo: ' + error?.message);
      throw error;
    }
  }
}

