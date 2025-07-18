import { RunResultsSteps } from './interfaces';
import { JUnitTestResult } from './JUnitTestResult';
import { Logger } from '../utils/logger';
import { TestResult } from './TestResult';
import { CaseResult } from './CaseResult';
import { getMBTData } from './utils';
import path from 'path';
import { getLastFolderFromPath } from '../utils/utils';

const logger = new Logger('JUnitXmlIterator');
export class JUnitXmlIterator {
  private jobName: string;
  private buildId: number;
  //private runFolder: string;
  private buildStarted: number;
  private runResultsFilesMap: Map<number, string>;
  private testNameToJunitResultMap: Map<string, JUnitTestResult> = new Map();
  private moduleName: string = '';
  private packageName: string = '';
  private id: string = '';
  private className: string = '';
  private testName: string = '';
  private testDuration: number = 0;
  private status: string = 'PASSED';
  private stackTraceStr: string = '';
  private errorType: string = '';
  private errorMsg: string = '';
  private externalURL: string = '';
  private description: string = '';
  private resultData: RunResultsSteps[] = [];
  private runId: number | null = null;
  private externalAssets: string = '';

  constructor(jobName: string, buildId: number, /*runFolder: string, */buildStarted: number, runResultsFilesMap: Map<number, string>) {
    this.jobName = jobName;
    this.buildId = buildId;
    //this.runFolder = runFolder;
    this.buildStarted = buildStarted;
    this.runResultsFilesMap = runResultsFilesMap;
  }

  public async processXmlResult(result: TestResult): Promise<void> {
    if (result.suites) {
      for (const suite of result.suites) {
        this.id = suite.id || '';
        if (suite.cases) {
          for (const testCase of suite.cases) {
            await this.processTestCase(testCase);
          }
        }
      }
    }
  }

  private async processTestCase(tc: CaseResult): Promise<void> {
    this.moduleName = this.className = this.packageName = ""; //TODO double-check / test better
    this.testName = (tc.testName || ''); //getLastFolderFromPath
    this.testDuration = tc.duration || 0;
    this.status = tc.skipped ? 'SKIPPED' : 'PASSED';
    this.stackTraceStr = tc.errorStackTrace || '';
    this.errorMsg = tc.errorDetails || '';
    const runId = tc.runId;
    if (this.runResultsFilesMap.has(runId)) {
      const runResXmlFilePath = this.runResultsFilesMap.get(runId);
      this.resultData = await getMBTData(runResXmlFilePath!) || [];
    } else {
      logger.error(`processTestCase: Run results file not found for runId: ${runId}`);
    }

    if (tc.stdout) {
      this.description = this.extractValueFromStdout(tc.stdout, '__octane_description_start__', '__octane_description_end__', '');
      this.externalURL = this.extractValueFromStdout(tc.stdout, '__octane_external_url_start__', '__octane_external_url_end__', '');
    }

    const testError = this.stackTraceStr || this.errorMsg
      ? { stackTraceStr: this.stackTraceStr, errorType: this.errorType, errorMsg: this.errorMsg }
      : null;

    this.runId = tc.runId;
    const testResult = new JUnitTestResult(
      this.moduleName,
      this.packageName,
      this.className,
      this.testName,
      this.status,
      this.testDuration,
      this.buildStarted,
      testError,
      this.externalURL,
      this.description,
      this.resultData,
      this.buildId,
      //this.runFolder,
      this.runId,
      this.externalAssets
    );

    this.testNameToJunitResultMap.set(this.testName, testResult);
  }

  private extractValueFromStdout(stdoutValue: string, startString: string, endString: string, defaultValue: string): string {
    let result = defaultValue;
    const startIndex = stdoutValue.indexOf(startString);
    if (startIndex > 0) {
      const endIndex = stdoutValue.indexOf(endString, startIndex);
      if (endIndex > 0) {
        result = stdoutValue.substring(startIndex + startString.length, endIndex).trim();
      }
    }
    return result;
  }

  public getTestResults(): JUnitTestResult[] {
    return Array.from(this.testNameToJunitResultMap.values());
  }
}