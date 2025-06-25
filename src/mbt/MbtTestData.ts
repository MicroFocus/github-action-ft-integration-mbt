export default interface MbtTestData {
  data: MbtDataSet;
  actions: UnitDetails[];
}

export interface MbtDataSet {
  parameters: string[];
  iterations: string[][];
}

export interface UnitDetails {
  testingToolType: string;
  pathInScm: string;
  name: string;
  unitId: number;
  parameters?: TestParam[];
  order: number;
  testPath?: string;
  script?: string;
  path?: string;
}

export interface TestParam {
  id: string;
  name: string;
  type: string;
  order: number;
  outputParameter: string;
  originalName: string;
  unitParameterId: string;
  unitParameterName: string;
  parameterId: string;
}

export interface MbtScriptData {
  unitId: number;
  testPath: string;
  basicScript: string;
}

export interface MbtTestInfo extends UftTestInfo {
  scriptData: MbtScriptData[];
  underlyingTests: string[];
  unitIds: number[];
  encodedIterationsStr: string;
}

export interface UftTestInfo {
  executionId: number;
  runId: number;
  testName: string;
}