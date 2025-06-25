import * as path from 'path';
import * as fs from 'fs/promises';
import { Logger } from '../utils/logger';
import { TestResources, RecoveryScenarioData } from './TestResources';
import { formatTimestamp, getGuiTestDocument } from '../utils/utils';
import { TspParseError } from '../utils/TspParseError';
import { MbtScriptData, MbtTestInfo } from './MbtTestData';

const _logger = new Logger('MbtPreTestExecuter');

export default class MbtPreTestExecuter {

  public static async createMbtPropsFile(testInfos: MbtTestInfo[]): Promise<string> {
    if (!testInfos.length) return '';
    _logger.info(`createMbtPropsFile: length=[${testInfos.length}], executionId=${testInfos[0].executionId}`);
    const workDir = process.cwd();
    const mbtPropsPath = path.join(workDir, "___mbt");

    const props: { [key: string]: string } = {
      runType: 'MBT',
      resultsFilename: 'must be here',
      parentFolder: mbtPropsPath,
      repoFolder: workDir,
    };
    await Promise.all(testInfos.map(async (testInfo, i) => {
      const idx = i + 1;
      props[`test${idx}`] = testInfo.testName;
      props[`package${idx}`] = `_${idx}`;
      props[`script${idx}`] = await this.updateTestScriptResources(testInfo.scriptData);
      props[`unitIds${idx}`] = testInfo.unitIds.join(';');
      props[`underlyingTests${idx}`] = testInfo.underlyingTests.join(';');
      props[`datableParams${idx}`] = testInfo.encodedIterationsStr;
    }));

    const mbtPropsFullPath = path.join(workDir, `mbt_props_${formatTimestamp()}.txt`);

    try {
      await fs.mkdir(mbtPropsPath, { recursive: true });
      await fs.writeFile(mbtPropsFullPath, Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch (error: any) {
      _logger.error(`createMbtPropsFile: ${error.message}`);
      throw new Error('Failed when creating MBT properties file');
    }

    return mbtPropsFullPath;
  }

  private static extractTestResources = async (testPath: string): Promise<TestResources> => {
    _logger.debug(`extractTestResources: testPath=${testPath}`);
    const content: TestResources = {
      functionLibraries: [],
      recoveryScenarioData: []
    };

    try {
      const doc = await getGuiTestDocument(`${testPath}\\Test.tsp`);
      if (!doc) {
        throw new TspParseError("No document parsed");
      }

      const flNodes = doc.getElementsByTagName('FuncLib');
      for (let i = 0; i < flNodes.length; i++) {
        const fl = flNodes.item(i)?.textContent;
        fl && content.functionLibraries.push(`${testPath}/${fl}`);
      }

      const rsNode = doc.getElementsByTagName('RecoveryScenarios').item(0);
      if (rsNode) {
        const rsParts = rsNode.textContent?.split('*') || [];
        rsParts.forEach(rsPart => {
          const rsAsArray = rsPart.split('|');
          if (rsAsArray.length > 1) {
            const rsData: RecoveryScenarioData = { path: `${testPath}/${rsAsArray[0]}`, name: rsAsArray[1] };
            content.recoveryScenarioData.push(rsData);
          }
        });
      }
    } catch (error: any) {
      _logger.error(`extractTestResources: ${error.message}; Continuing with empty resources`);
    }

    return content;
  }

  private static updateTestScriptResources = async (scriptData: MbtScriptData[]): Promise<string> => {
    let index = 0;
    const scriptLines: string[] = [];
    _logger.debug(`updateTestScriptResources: scriptData.length=${scriptData.length}`);

    for (const unit of scriptData) {
      let script = '';

      if (index === 0 || (scriptData[index - 1] && unit.testPath !== scriptData[index].testPath)) {
        const testPath = unit.testPath;
        if (!await this.isTestFolder(testPath)) {
          throw new Error(`updateTestScriptResources: invalid test path [${testPath}] of unit id ${unit.unitId}`);
        }

        const testResources = await this.extractTestResources(testPath);

        if (testResources.functionLibraries.length) {
          script += 'RestartFLEngine\r\n';
          for (const fl of testResources.functionLibraries) {
            script += ` LoadFunctionLibrary "${fl}"\r\n`;
          }
        }

        if (testResources.recoveryScenarioData.length) {
          const scenarios = testResources.recoveryScenarioData.map(rs => `"${rs.path}|${rs.name}|1|1*"`).join(',');
          script += `LoadRecoveryScenario ${scenarios}`;
        }
      }

      script += unit.basicScript;
      scriptLines.push(script);
      index++;
    }

    return scriptLines.join('\r\n');
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