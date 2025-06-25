import ToolType from "../dto/ft/ToolType";
import TestData from "./TestData";
import TestParserFactory from "./TestParserFactory";
import { Logger } from "../utils/logger";
import { calcByExpr } from "../utils/utils";
const _logger = new Logger("TestParamsParser");

export default class TestParamsParser {
  public static parseTestData(testData: string, framework: ToolType = ToolType.MBT): Map<number, TestData> {
    _logger.debug(`parseTestData: framework=${framework}, testData="${testData}"`);
    const strTestParam = calcByExpr(testData, /^v1:(.+)$/, 1);
    const arrTestParam = strTestParam.split(';');
    const testDataMap = new Map<number, TestData>();

    arrTestParam.forEach(p => {
      try {
        const testParts = p.split('|');
        const parsedTestData = TestParserFactory.getParser(framework).parseTestParam(testParts);
        testDataMap.set(parsedTestData.runId, parsedTestData);
      } catch (e) {
        throw new Error(`Failed to save string: ${(e as Error).message}`);
      }
    });

    return testDataMap;
  }
}