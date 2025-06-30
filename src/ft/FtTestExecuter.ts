import * as path from 'path';
import { promises as fs } from 'fs';
import { UftTestInfo } from '../mbt/MbtTestData';
import { Logger } from '../utils/logger';
import { ExitCode } from './ExitCode';
import FTL from './FTL';
import { checkFileExists, checkReadWriteAccess, escapePropVal, formatTimestamp } from '../utils/utils';

const _logger = new Logger('MbtPreTestExecuter');

export default class FtTestExecuter {
  public static async preProcess(uftTestInfos: UftTestInfo[]): Promise<ExitCode> {
    _logger.debug(`preProcess: ...`);

    const propsFullPath = await this.createPropsFile(uftTestInfos);
    await checkFileExists(propsFullPath);
    const actionBinPath = await FTL.ensureToolExists();
    const exitCode = await FTL.runTool(actionBinPath, propsFullPath);
    _logger.debug(`preProcess: exitCode=${exitCode}`);
    return exitCode;
  }

  private static async createPropsFile(testInfos: UftTestInfo[]): Promise<string> {
    if (!testInfos.length) return '';
    _logger.debug(`createPropsFile: testInfos.length=${testInfos.length} ...`);
    const wsDir = process.env.RUNNER_WORKSPACE!; // e.g., C:\GitHub_runner\_work\ufto-tests\
    await checkReadWriteAccess(wsDir);

    const resFullPath = path.join(wsDir, `results_${formatTimestamp()}.xml`);
    const mtbxFullPath = await this.createMtbxFile(wsDir, testInfos);
    await checkFileExists(mtbxFullPath);
    const props: { [key: string]: string } = {
      runType: 'FileSystem',
      Test1: escapePropVal(mtbxFullPath),
      resultsFilename: resFullPath
    };

    //TODO add Mobile props

    const propsFullPath = path.join(wsDir, `props_${formatTimestamp()}.txt`);

    try {
      await fs.writeFile(propsFullPath, Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch (error: any) {
      _logger.error(`createPropsFile: ${error.message}`);
      throw new Error('Failed when creating properties file');
    }

    return propsFullPath;
  }

  private static async createMtbxFile(dirPath: string, testInfos: UftTestInfo[]): Promise<string> {
    const mtbxFullPath = path.join(dirPath, `test_suite.mtbx`);
    _logger.debug(`createMtbxFile: [${mtbxFullPath}]`);
    let xml = "";
    testInfos.map(async (testInfo, i) => {
      const idx = i + 1;
      const name = testInfo.testName;
      const fullPath = path.join(dirPath, `_${idx}`, name);
      xml += `<Mtbx>\n  <Test name="${name}" path="${fullPath}" />\n</Mtbx>\n`;
    });

    await fs.writeFile(mtbxFullPath, xml, 'utf8');
    return mtbxFullPath;
  }

}