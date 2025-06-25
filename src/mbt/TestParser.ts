import TestData from "./TestData";
export default interface TestParser {
  parseTestParam(param: string[]): TestData;
}
