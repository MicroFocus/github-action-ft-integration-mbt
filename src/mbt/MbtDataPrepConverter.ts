import { calcByExpr } from "../utils/utils";
import MbtTestData, { UnitDetails, MbtScriptData, TestParam, MbtDataSet, MbtTestInfo } from '../mbt/MbtTestData';
import { Buffer } from 'buffer';
import { Logger } from '../utils/logger';
import TestData from "./TestData";
const _logger = new Logger('MbtDataPrepConverter');

export default class MbtDataPrepConverter {
  private static generateScriptData(units: UnitDetails[], repoFolderPath: string): MbtScriptData[] {
    _logger.debug(`generateScriptData: units.length=${units.length}, repoFolderPath=[${repoFolderPath}] ...`);
    return units
      .filter(unit => unit.pathInScm.includes(':'))
      .map(unit => {
        const unitPathTmp = calcByExpr(unit.pathInScm, /(.*)\\Action/, 1);
        unit.testPath = `${repoFolderPath}\\${unitPathTmp}`;

        let script = `\r\nLoadAndRunAction "${repoFolderPath}\\${unitPathTmp}","${calcByExpr(unit.pathInScm, /:(.*)/, 1)}"`;
        if (unit?.parameters?.length) {
          script += `,rngAll${this.extractActionParams(unit.parameters)}`;
        }

        script += `\r\nIf Reporter.CurrentActionIterationStatus = 1 Then\r\nExitAction\r\nEnd If`;
        return { unitId: unit.unitId, testPath: unit.testPath, basicScript: script } as MbtScriptData;
      });
  }

  private static extractDataTableIterations(data: MbtDataSet, testName: string): string {
    _logger.debug(`extractDataTableIterations: testName=${testName} ...`);
    let encodedIterationsStr = "";
    if (data?.parameters?.length) {
      const csvRows: string[] = [];
      csvRows.push(data.parameters.map(this.escapeCsvVal).join(",")); // add header row
      data.iterations.forEach(iteration => {
        const row = iteration.map(this.escapeCsvVal).join(","); // add data row
        csvRows.push(row);
      });
      const csvStr = csvRows.join("\n");
      encodedIterationsStr = Buffer.from(csvStr, 'utf-8').toString('base64');
      _logger.debug(`csvStr=${csvStr}`);
    }
    return encodedIterationsStr;
  }

  public static buildMbtTestInfo(repoFolderPath: string, executionId: number, runId: number, mbtTestData: MbtTestData, testDataMap: Map<number, TestData>): MbtTestInfo {
    _logger.debug(`buildMbtTestInfo: executionId=${executionId}, runId=${runId} ...`);
    const mbtScript = this.generateScriptData(mbtTestData.actions, repoFolderPath);
    const underlyingTests = mbtTestData.actions.map(ud => ud.testPath ?? "");
    const unitIds = mbtTestData.actions.map(ud => ud.unitId);
    const testName = testDataMap.get(runId)?.testName!;
    const strEncodedIterations = this.extractDataTableIterations(mbtTestData.data, testName);
    return {
      executionId: executionId,
      runId: runId,
      testName: testName,
      scriptData: mbtScript,
      underlyingTests: underlyingTests,
      unitIds: unitIds,
      encodedIterationsStr: strEncodedIterations
    };
  }

  private static escapeCsvVal(value: string): string {
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1); // Remove the outer quotes
    }

    // Escape internal double quotes by doubling them
    if (value.includes('"')) {
      value = value.replace(/"/g, '""');
    }

    // Enclose in double quotes if it contains special characters
    return /[",\n\r]/.test(value) ? `"${value}"` : value;
  }

  private static extractActionParams(params: TestParam[]): string {
    const inParams = params
      .filter(p => p.type.toLowerCase() === 'input')
      .map(p => p.outputParameter ? `,${p.outputParameter}` : `,DataTable("${p.name}")`)
      .join('');

    const outParams = params
      .filter(p => p.type.toLowerCase() === 'output')
      .map(p => `,${p.name}`)
      .join('');

    return inParams + outParams;
  }
}
