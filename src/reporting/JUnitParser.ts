import { Logger } from '../utils/logger';
import { TestResult } from './TestResult';

const logger: Logger = new Logger('JUnitParser');

export class JUnitParser {
  private readonly keepLongStdio: boolean;
  private readonly xmlResFilePath: string;
  private readonly externalAssets: string;

  constructor(xmlResFilePath: string, keepLongStdio: boolean = true, externalAssets: string = "") {
    this.keepLongStdio = keepLongStdio;
    this.xmlResFilePath = xmlResFilePath;
    this.externalAssets = externalAssets;
  }

  public async parseResult(): Promise<TestResult> {
    logger.info(`parseResult: [${this.xmlResFilePath}] ...`);

    if (!this.xmlResFilePath) {
      return new TestResult();
    }

    const testRes = new TestResult(this.keepLongStdio);
    await testRes.parsePossiblyEmpty(this.xmlResFilePath, this.externalAssets);
    return testRes;
  }
}