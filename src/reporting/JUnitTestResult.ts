import { XMLElement } from 'xmlbuilder';
import { XmlWritableTestResult, RunResultsSteps, RunResultsStep, UftResultStepParameter } from './interfaces';

export class JUnitTestResult implements XmlWritableTestResult {
  public moduleName: string;
  public packageName: string;
  public className: string;
  public testName: string;
  public description: string;
  public started: number;
  public externalReportUrl: string;
  public resultData: RunResultsSteps[];
  public result: string;
  public duration: number;
  public testError: any | null;
  //public buildId: number;
  //public runFolder: string;
  public runId: number | null;
  public externalAssets: string;

  constructor(
    moduleName: string,
    packageName: string,
    className: string,
    testName: string,
    result: string,
    duration: number,
    started: number,
    testError: any | null,
    externalReportUrl: string,
    description: string,
    resultData: any[],
    //buildId: number,
    //runFolder: string,
    runId: number | null,
    externalAssets: string
  ) {
    this.moduleName = moduleName;
    this.packageName = packageName;
    this.className = className;
    this.testName = testName;
    this.description = description;
    this.started = started;
    this.externalReportUrl = externalReportUrl;
    this.resultData = resultData;
    this.result = result;
    this.duration = duration;
    this.testError = testError;
    //this.buildId = buildId;
    //this.runFolder = runFolder;
    this.runId = runId;
    this.externalAssets = externalAssets;
  }

  public writeXmlElement(root: XMLElement): void {
    let attrs: { [key: string]: string } = {
      module: this.moduleName,
      package: this.packageName,
      class: this.className,
      name: this.testName,
      duration: `${Math.round(this.duration)}`,
      status: this.result,
      started: this.started.toString(),
      external_assets: this.externalAssets,
      run_type: "MBT"
    };
    if (this.externalReportUrl) {
      attrs = { ...attrs, external_report_url: this.externalReportUrl };
    }

    const testRun = root.e('test_run', attrs);

    if (this.testError) {
      const error = testRun.e('error', {
        type: this.testError.errorType,
        message: this.testError.errorMsg
      });
      error.raw(this.testError.stackTraceStr);
    }

    if (this.description) {
      testRun.e('description', {}, this.description);
    }

    if (this.resultData.length) {
      this.resultData.forEach((step: RunResultsSteps, index: number) => {
        const steps = testRun.e('steps', { iteration: (index + 1).toString() });
        step.steps.forEach((s: RunResultsStep, idx: number) => {
          const stepElement = steps.e('step', { name: s.name, duration: `${s.duration}`, status: s.status });
          if (s.errorMessage) {
            stepElement.e('error_message', {}, s.errorMessage);
          }

          if (s.inputParameters?.length) {
            const inputParameters = stepElement.e('input_parameters');
            s.inputParameters.forEach((p: UftResultStepParameter) => {
              inputParameters.e('parameter', { name: p.name, value: p.value, type: p.type });
            });
          }

          if (s.outputParameters?.length) {
            const outputParameters = stepElement.e('output_parameters');
            s.outputParameters.forEach((p: UftResultStepParameter) => {
              outputParameters.e('parameter', {
                name: p.name,
                value: p.value,
                type: p.type
              });
            });
          }
        });
      });
    }
  }
}