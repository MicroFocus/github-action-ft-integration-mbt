import * as fs from 'fs-extra';
import * as path from 'path';
import { MqmTestResultsBuilder } from './MqmTestResultsBuilder';
import { Logger } from '../utils/logger'
import { config } from '../config/config';
import FTL from '../ft/FTL';
import { TestResult } from './TestResult';

const logger = new Logger('TestResultManager');

export class TestResultManager {
  public static async buildOctaneXmlFile(jobName: string, buildId: number, junitResult: TestResult): Promise<string> {
    logger.debug(`buildOctaneXmlFile: job: ${jobName}, build: ${buildId}`);
    const mbtPath = path.join(config.workPath, FTL._MBT);
    await fs.ensureDir(mbtPath);
    const junitResXmlFile = path.join(mbtPath, 'junitResult.xml');
    await fs.writeFile(junitResXmlFile, junitResult.toXML());
    const mqmTestsFile = path.join(mbtPath, 'mqmTests.xml');

    const runResultsFilesMap = await this.collectRunResultsXmlFiles(mbtPath);
    logger.debug(`Found ${runResultsFilesMap.size} run_results.xml files for job: ${jobName}, build: ${buildId}`);

    const builder = new MqmTestResultsBuilder(junitResult, jobName, buildId, mqmTestsFile, runResultsFilesMap);
    await builder.invoke();
    logger.debug(`buildOctaneXmlFile: Finished writing mqmTests.xml`);
    return mqmTestsFile;
  }

  private static async collectRunResultsXmlFiles(mbtPath: string): Promise<Map<number, string>> {
    logger.debug(`collectRunResultsXmlFiles: mbtPath=[${mbtPath}] ...`);
    const runResultsFilesMap = new Map<number, string>();
    const files = await fs.readdir(mbtPath, { recursive: true, encoding: 'utf8' });
    const runResultsFiles = files.filter(file => file.endsWith('run_results.xml'));

    for (const file of runResultsFiles) {
      const filePath = path.join(mbtPath, file);
      const runId = this.extractRunIdFromPath(filePath);
      runResultsFilesMap.set(runId, filePath);
    }

    return runResultsFilesMap;
  }

  private static extractRunIdFromPath(filePath: string): number {
    logger.debug(`extractRunIdFromPath: [${filePath}]`);
    const dirParts = path.parse(filePath).dir.split(path.sep);
    const reportIndex = dirParts.lastIndexOf(dirParts.find(part => /^Report.*/.test(part)) || '');
    if (reportIndex > 1) return parseInt(dirParts[reportIndex - 2], 10);
    throw new Error(`extractRunIdFromPath: Invalid path [${filePath}]`);
  }
}