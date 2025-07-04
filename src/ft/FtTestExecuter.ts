import * as path from 'path';
import { promises as fs } from 'fs';
import { UftTestInfo } from '../mbt/MbtTestData';
import { Logger } from '../utils/logger';
import { ExitCode } from './ExitCode';
import FTL from './FTL';
import { checkFileExists, checkReadWriteAccess, escapePropVal, getTimestamp } from '../utils/utils';
import { config } from '../config/config';

const _logger = new Logger('FtTestExecuter');

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
    const wsDir = process.env.RUNNER_WORKSPACE!; // e.g., C:\GitHub_runner\_work\ufto-tests\
    const suffix = getTimestamp();
    const propsFullPath = path.join(wsDir, `props_${suffix}.txt`);
    _logger.debug(`createPropsFile: [${propsFullPath}] ...`);
    await checkReadWriteAccess(wsDir);

    const resFullPath = path.join(wsDir, `results_${suffix}.xml`);
    const mtbxFullPath = await this.createMtbxFile(wsDir, suffix, testInfos);
    await checkFileExists(mtbxFullPath);
    const props: { [key: string]: string } = {
      runType: FTL.FileSystem,
      Test1: escapePropVal(mtbxFullPath),
      resultsFilename: escapePropVal(resFullPath)
    };

    if (config.digitalLabUrl && config.digitalLabExecToken) {
      props["MobileHostAddress"] = config.digitalLabUrl;
      props["MobileExecToken"] = config.digitalLabExecToken;
      // TODO props["MobileExecDescription"] = `${config.mobileExecDescription} Test: ${testName}`;
    }
    try {
      await fs.writeFile(propsFullPath, Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch (error: any) {
      _logger.error(`createPropsFile: ${error.message}`);
      throw new Error('Failed when creating properties file');
    }

    return propsFullPath;
  }

  private static async createMtbxFile(dirPath: string, suffix: string, testInfos: UftTestInfo[]): Promise<string> {
    const mtbxFullPath = path.join(dirPath, `test_suite_${suffix}.mtbx`);
    _logger.debug(`createMtbxFile: [${mtbxFullPath}]`);
    let xml = "<Mtbx>\n";
    testInfos.map(async (testInfo, i) => {
      const idx = i + 1;
      const name = testInfo.testName;
      const fullPath = path.join(dirPath, FTL._MBT, `_${idx}`, name);
      xml += `  <Test name="${name}" path="${fullPath}" />\n`;
    });
    xml += `</Mtbx>`;

    await fs.writeFile(mtbxFullPath, xml, 'utf8');
    return mtbxFullPath;
  }

}