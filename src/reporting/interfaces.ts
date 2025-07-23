/*export interface Suite {
  file: string | null;
  name: string;
  externalAssets: string;
  enclosingBlocks: string[];
  enclosingBlockNames: string[];
  stdout: string;
  stderr: string;
  cases: Case[];
  duration: number;
  runId: string;
  id: string;
  casesByName: Map<string, Case>;
  time: string;
}

export interface Case {
  duration: number;
  className: string;
  testName: string;
  skipped: boolean;
  skippedMessage: string | null;
  stdout: string | null;
  stderr: string | null;
  errorStackTrace: string;
  errorDetails: string;
}

export interface Result {
  keepLongStdio: boolean;
  duration: number;
  suites: Suite[];
}*/

/*export interface JUnitTestResult {
  moduleName: string;
  packageName: string;
  className: string;
  testName: string;
  description: string;
  started: number;
  externalReportUrl: string;
  runnerType: string;
  resultData: any[];
  octaneSupportsSteps: boolean;
  result: string;
  duration: number;
  testError: any | null;
  buildId: number;
  runFolder: string;
  runId: number;
  testingToolType: string;
  externalAssets: string;
}*/

export interface ResultFields {
  framework: string;
  testingTool: string;
  // Add other fields as needed
}

export interface XmlWritableTestResult {
  writeXmlElement(writer: any): void;
}

// Define interfaces for the nested structures in resultData
export interface Step {
  name: string;
  duration: number;
  status: string;
  errorMessage?: string;
  inputParameters: Param[];
  outputParameters: Param[];
}

export interface Param {
  name: string;
  value: string;
  type: string;
}

export interface ResultDataItem {
  steps: Step[];
}

export interface ReportResults {
  version: string;
  reportNode: ReportNode;
}

export interface ReportNode {
  type: string;
  reportNode?: ReportNode | ReportNode[];
  data: ReportNodeData;
}

export interface ReportNodeData {
  name: string;
  description?: string;
  errorText?: string;
  duration: number;
  result: string;
  inputParameters?: { parameter: Parameter | Parameter[] };
  outputParameters?: { parameter: Parameter | Parameter[] };
}

export interface Parameter {
  name: string;
  value: string;
  type: string; // default type is String
}

export interface UftResultStepParameter {
  name: string;
  value: string;
  type: string; // default type is String
}

export interface UftResultStepData {
  parents: string[];
  type: string;
  result: string;
  message: string;
  duration: number;
  inputParameters?: UftResultStepParameter[];
  outputParameters?: UftResultStepParameter[];
}

export interface UftResultIterationData {
  steps: UftResultStepData[];
  duration: number;
}

export interface RunResults {
  iterations: RunResultsSteps[];
}

export interface RunResultsStepParameter {
  name: string;
  value: string;
  type: string; // default type is String
}

export interface RunResultsStep {
  name: string; // name of the test method
  status: string;
  errorMessage: string;
  duration: number;
  inputParameters?: RunResultsStepParameter[];
  outputParameters?: RunResultsStepParameter[];
}

export interface RunResultsSteps {
  steps: RunResultsStep[];
  duration: number;
}

export interface BuildInfo {
  serverId: string;
  jobId: string;
  buildId: number;
  artifactId?: number;
}