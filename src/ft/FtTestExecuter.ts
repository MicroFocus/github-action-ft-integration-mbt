import * as path from 'path';
import { promises as fs } from 'fs';
import { UftTestInfo } from '../mbt/MbtTestData';
import { Logger } from '../utils/logger';
import { ExitCode } from './ExitCode';
import FTL from './FTL';
import { checkFileExists, checkReadWriteAccess, escapePropVal, getTimestamp } from '../utils/utils';
import { config } from '../config/config';

const logger = new Logger('FtTestExecuter');

export default class FtTestExecuter {
  public static async process(testInfos: UftTestInfo[]): Promise<{ exitCode: ExitCode; resFullPath: string }> {
    logger.debug(`process: mbtTestInfos.length=${testInfos.length} ...`);
    const wsPath = process.env.RUNNER_WORKSPACE!; // e.g., C:\GitHub_runner\_work\ufto-tests\
    await checkReadWriteAccess(wsPath);
    const suffix = getTimestamp();
    const { propsFullPath, resFullPath } = await this.createPropsFile(wsPath, suffix, testInfos);
    await checkFileExists(propsFullPath);
    const actionBinPath = await FTL.ensureToolExists();
    const exitCode = await FTL.runTool(actionBinPath, propsFullPath);
    logger.debug(`process: exitCode=${exitCode}`);
    return { exitCode, resFullPath: resFullPath };
  }

  private static async createPropsFile(wsPath: string, suffix: string,
    testInfos: UftTestInfo[]): Promise<{ propsFullPath: string, resFullPath: string }> {

    const propsFullPath = path.join(wsPath, `props_${suffix}.txt`);
    const resFullPath = path.join(wsPath, `results_${suffix}.xml`);
    const mtbxFullPath = path.join(wsPath, `testsuite_${suffix}.mtbx`);

    logger.debug(`createPropsFile: [${propsFullPath}] ...`);
    await this.createMtbxFile(wsPath, mtbxFullPath, testInfos);
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
      logger.error(`createPropsFile: ${error.message}`);
      throw new Error('Failed when creating properties file');
    }

    return { propsFullPath, resFullPath };
  }

  private static async createMtbxFile(wsPath: string, mtbxFullPath: string, testInfos: UftTestInfo[]): Promise<string> {
    logger.debug(`createMtbxFile: [${mtbxFullPath}]`);
    let xml = "<Mtbx>\n";
    testInfos.map(async (testInfo, i) => {
      const idx = i + 1;
      const name = testInfo.testName;
      const fullPath = path.join(wsPath, FTL._MBT, `_${idx}`, name);
      xml += `  <Test name="${name}" path="${fullPath}" />\n`;
    });
    xml += `</Mtbx>`;

    await fs.writeFile(mtbxFullPath, xml, 'utf8');
    return mtbxFullPath;
  }

}