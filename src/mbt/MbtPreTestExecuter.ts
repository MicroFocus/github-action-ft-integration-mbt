import * as path from 'path';
import { promises as fs } from 'fs';
import { Logger } from '../utils/logger';
import { TestResources, RecoveryScenario } from './TestResources';
import { checkFileExists, escapePropVal, getTimestamp, getGuiTestDocument } from '../utils/utils';
import { TspParseError } from '../utils/TspParseError';
import { MbtScriptData, MbtTestInfo } from './MbtTestData';
import { ExitCode } from '../ft/ExitCode';
import FTL from '../ft/FTL';

const logger = new Logger('MbtPreTestExecuter');

export default class MbtPreTestExecuter {
  public static async preProcess(mbtTestInfos: MbtTestInfo[]): Promise<boolean> {
    logger.debug(`preProcess: mbtTestInfos.length=${mbtTestInfos.length} ...`);
    const mbtPropsFullPath = await this.createMbtPropsFile(mbtTestInfos);
    await checkFileExists(mbtPropsFullPath);
    const actionBinPath = await FTL.ensureToolExists();
    const exitCode = await FTL.runTool(actionBinPath, mbtPropsFullPath);
    logger.debug(`preProcess: exitCode=${exitCode}`);
    return exitCode === ExitCode.Passed;
  }

  private static async createMbtPropsFile(testInfos: MbtTestInfo[]): Promise<string> {
    logger.debug(`createMbtPropsFile: testInfos.length=${testInfos.length} ...`);
    const wsDir = process.env.RUNNER_WORKSPACE; // e.g., C:\GitHub_runner\_work\ufto-tests\
    if (!wsDir) {
      const err = `Missing environment variable: RUNNER_WORKSPACE`;
      logger.error(err);
      throw new Error(err);
    }
    // Check read/write access to RUNNER_WORKSPACE
    try {
      await fs.access(wsDir, fs.constants.R_OK | fs.constants.W_OK);
      logger.debug(`Read/write access confirmed for [${wsDir}]`);
    } catch (error: any) {
      const err = `No read/write access to [${wsDir}]: ${error.message}`;
      logger.error(err);
      throw new Error(err);
    }

    const props: { [key: string]: string } = {
      runType: FTL.MBT,
      resultsFilename: 'must be here',
      parentFolder: escapePropVal(path.join(wsDir, FTL._MBT)),
      repoFolder: escapePropVal(process.cwd()),
    };
    await Promise.all(testInfos.map(async (testInfo, i) => {
      const idx = i + 1;
      props[`test${idx}`] = testInfo.testName;
      props[`package${idx}`] = `_${idx}`;
      props[`script${idx}`] = await this.updateTestScriptResources(testInfo.scriptData);
      props[`unitIds${idx}`] = testInfo.unitIds.join(';');
      props[`underlyingTests${idx}`] = escapePropVal(testInfo.underlyingTests.join(';'));
      props[`datableParams${idx}`] = testInfo.encodedIterationsStr;
    }));

    const mbtPropsFullPath = path.join(wsDir, `mbt_props_${getTimestamp()}.txt`);

    try {
      await fs.writeFile(mbtPropsFullPath, Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch (error: any) {
      logger.error(`createMbtPropsFile: ${error.message}`);
      throw new Error('Failed when creating MBT properties file');
    }

    return mbtPropsFullPath;
  }

  private static extractTestResources = async (testPath: string): Promise<TestResources> => {
    logger.debug(`extractTestResources: testPath=${testPath}`);
    const content: TestResources = {
      functionLibraries: [],
      recoveryScenarios: []
    };

    try {
      const doc = await getGuiTestDocument(`${testPath}`);
      if (!doc) {
        throw new TspParseError("No document parsed");
      }

      const flNodes = doc.getElementsByTagName('FuncLib');
      for (let i = 0; i < flNodes.length; i++) {
        const fl = flNodes.item(i)?.textContent;
        fl && content.functionLibraries.push(path.join(testPath, fl));
      }

      const rsNode = doc.getElementsByTagName('RecoveryScenarios').item(0);
      if (rsNode) {
        const rsParts = rsNode.textContent?.split('*') || [];
        rsParts.forEach(rsPart => {
          const rsAsArray = rsPart.split('|');
          if (rsAsArray.length > 1) {
            const rsPath = path.join(testPath, rsAsArray[0]);
            const rsData: RecoveryScenario = { path: rsPath, name: rsAsArray[1] };
            content.recoveryScenarios.push(rsData);
          }
        });
      }
    } catch (error: any) {
      logger.error(`extractTestResources: ${error.message}; Continuing with empty resources`);
    }

    return content;
  }

  private static updateTestScriptResources = async (scriptData: MbtScriptData[]): Promise<string> => {
    let index = 0;
    const scriptLines: string[] = [];
    logger.debug(`updateTestScriptResources: scriptData.length=${scriptData.length}`);

    for (const unit of scriptData) {
      let script = '';

      if (index === 0 || (scriptData[index - 1] && unit.testPath !== scriptData[index].testPath)) {
        const testPath = unit.testPath;
        if (!await this.isTestFolder(testPath)) {
          throw new Error(`updateTestScriptResources: invalid test path [${testPath}] of unit id ${unit.unitId}`);
        }

        const testResources = await this.extractTestResources(testPath);

        if (testResources.functionLibraries.length) {
          script += 'RestartFLEngine\\r\\n';
          for (const fl of testResources.functionLibraries) {
            script += ` LoadFunctionLibrary "${escapePropVal(fl)}"\\r\\n`;
          }
        }

        if (testResources.recoveryScenarios.length) {
          const scenarios = testResources.recoveryScenarios.map(rs => `"${escapePropVal(rs.path)}|${rs.name}|1|1*"`).join(',');
          script += `LoadRecoveryScenario ${scenarios}`;
        }
      }

      script += unit.basicScript;
      scriptLines.push(script);
      index++;
    }

    return scriptLines.join('\\r\\n');
  }

  private static async isTestFolder(testPath: string): Promise<boolean> {
    const testName = path.basename(testPath);
    try {
      await fs.access(path.join(testPath, 'Test.tsp'));
      return true;
    } catch {
      try {
        await fs.access(path.join(testPath, `${testName}.st`));
        return true;
      } catch {
        return false;
      }
    }
  }
}