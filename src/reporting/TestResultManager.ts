import * as fs from 'fs-extra';
import * as path from 'path';
import { MqmTestResultsBuilder } from './MqmTestResultsBuilder';
import { Logger } from '../utils/logger'
import { config } from '../config/config';
import FTL from '../ft/FTL';
import { TestResult } from './TestResult';
import { BuildInfo } from './interfaces';
import GitHubClient from '../client/githubClient';

const logger = new Logger('TestResultManager');

export class TestResultManager {
  public static async buildOctaneXmlFile(buildInfo: BuildInfo, junitResult: TestResult): Promise<string> {
    logger.debug(`buildOctaneXmlFile: ...`, buildInfo);
    const mbtPath = path.join(config.workPath, FTL._MBT);
    await fs.ensureDir(mbtPath);
    const junitResXmlFile = path.join(mbtPath, 'junitResult.xml');
    await fs.writeFile(junitResXmlFile, junitResult.toXML());
    const mqmTestsFile = path.join(mbtPath, 'mqmTests.xml');
    const runResultsFilesMap = await this.collectRunResultsXmlFiles(mbtPath);

    const artifactId = await this.buildArtifact(buildInfo.buildId, mbtPath, runResultsFilesMap);

    const builder = new MqmTestResultsBuilder(junitResult, { ...buildInfo, artifactId }, mqmTestsFile, runResultsFilesMap);
    await builder.invoke();
    logger.debug(`buildOctaneXmlFile: Finished writing mqmTests.xml`);
    return mqmTestsFile;
  }

  private static async buildArtifact(buildId: number, mbtPath: string, runResultsFilesMap: Map<number, string>): Promise<number> {
    logger.debug(`buildArtifact: buildId=${buildId} ...`);
    const directories: string[] = [];
    for (const filePath of runResultsFilesMap.values()) {
      const directory = path.dirname(filePath);
      directories.push(directory);
    }
    //TODO add junitResult.xml, mqmTests.xml and eventually other files (results_###.xml ?)
    const artifactName = await GitHubClient.uploadArtifact(mbtPath, directories);
    const artifacts = await GitHubClient.getWorkflowRunArtifacts(buildId);
    for (const artifact of artifacts) {
      logger.debug(`Artifact: ${artifact.name}, id=${artifact.id}`);
      if (artifact.name === artifactName) {
        return artifact.id;
      }
    }
    return 0;
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
      logger.debug(`runId=${runId}, [${filePath}]`);
    }

    logger.debug(`Found ${runResultsFilesMap.size} run_results.xml files`);
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