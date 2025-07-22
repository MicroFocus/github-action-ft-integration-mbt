import * as fs from 'fs-extra';
import { JUnitXmlIterator } from './JUnitXmlIterator';
import { create } from 'xmlbuilder';
import { TestResult } from './TestResult';
import { Logger } from '../utils/logger';

const logger = new Logger('MqmTestResultsBuilder');

export class MqmTestResultsBuilder {
  //private junitResFilePath: string;
  private junitResult: TestResult
  private jobId: string;
  private buildId: number;
  private serverId: string;
  private tmpMqmTestsFile: string;
  private buildStarted: number;
  private runResultsFilesMap: Map<number, string>;

  constructor(
    junitResult: TestResult, serverId: string, jobId: string, buildId: number, tmpMqmTestsFile: string, runResultsFilesMap: Map<number, string>) {
    //this.junitResFilePath = junitResFilePath;
    this.junitResult = junitResult;
    this.jobId = jobId;
    this.buildId = buildId;
    this.serverId = serverId;
    this.buildStarted = Date.now();
    this.tmpMqmTestsFile = tmpMqmTestsFile;
    this.runResultsFilesMap = runResultsFilesMap;
  }

  public async invoke(): Promise<void> {
    //const xmlData = await fs.readFile(this.junitResFilePath, 'utf-8');
    try {
      logger.debug(`invoke: Processing JUnit test results ...`);

      const iterator = new JUnitXmlIterator(this.buildStarted, this.runResultsFilesMap);
      await iterator.processXmlResult(this.junitResult);
      const testResults = iterator.getTestResults();

      await fs.ensureFile(this.tmpMqmTestsFile as string);

      const root = create('test_result');
      root.e('build', {
        server_id: this.serverId,
        job_id: this.jobId,
        build_id: this.buildId
      });

      const testRuns = root.e('test_runs');
      for (const testResult of testResults) {
        testResult.writeXmlElement(testRuns);
      }

      const xmlString = root.end({ pretty: true });
      logger.debug(xmlString); // Log the XML string to ensure it contains data

      // Use Promises for file stream operations
      await new Promise((resolve, reject) => {
        const tempFileStream = fs.createWriteStream(this.tmpMqmTestsFile, { flags: 'a' });

        tempFileStream.on('finish', () => {
          logger.debug('File has been written successfully');
          resolve(true);
        });

        tempFileStream.on('error', (err) => {
          logger.error('Error writing to file:', err);
          reject(err);
        });

        tempFileStream.write(xmlString);
        tempFileStream.end();
      });

      logger.debug(`invoke: Finished writing test results to ${this.tmpMqmTestsFile}`);

    } catch (error) {
      logger.error('Error in invoke method:', error as Error);
    }
  }
}