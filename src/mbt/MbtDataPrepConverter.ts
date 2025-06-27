import { calcByExpr, escapePropVal } from "../utils/utils";
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
        const action = calcByExpr(unit.pathInScm, /:(.*)/, 1);
        const actionPath = escapePropVal(`${repoFolderPath}\\${unitPathTmp}`);
        let script = `\\r\\nLoadAndRunAction "${actionPath}","${action}"`;
        if (unit?.parameters?.length) {
          script += `,rngAll${this.extractActionParams(unit.parameters)}`;
        }

        script += `\\r\\nIf Reporter.CurrentActionIterationStatus \\= 1 Then\\r\\nExitAction\\r\\nEnd If`;
        return { unitId: unit.unitId, testPath: unit.testPath, basicScript: script } as MbtScriptData;
      });
  }

  private static extractDataTableIterations(data: MbtDataSet, testName: string): string {
    _logger.debug(`extractDataTableIterations: testName=${testName} ...`);
    if (data?.parameters?.length) {
      const csvRows: string[] = [];
      csvRows.push(data.parameters.map(this.escapeCsvVal).join(",")); // add header row
      data.iterations.forEach(iteration => {
        const row = iteration.map(this.escapeCsvVal).join(","); // add data row
        csvRows.push(row);
      });
      const csvStr = csvRows.join("\n");
      _logger.debug(`csvStr=${csvStr}`);
      return Buffer.from(csvStr, 'utf-8').toString('base64');
    }
    return "";
  }

  public static buildMbtTestInfo(repoFolderPath: string, runId: number, mbtTestData: MbtTestData, testDataMap: Map<number, TestData>): MbtTestInfo {
    const testName = testDataMap.get(runId)?.testName!;
    _logger.debug(`buildMbtTestInfo: testName=${testName}, runId=${runId} ...`);
    return {
      runId: runId,
      testName: testName,
      scriptData: this.generateScriptData(mbtTestData.actions, repoFolderPath),
      underlyingTests: mbtTestData.actions.map(ud => ud.testPath ?? ""),
      unitIds: mbtTestData.actions.map(ud => ud.unitId),
      encodedIterationsStr: this.extractDataTableIterations(mbtTestData.data, testName)
    };
  }

  private static escapeCsvVal(val: string): string {
    // Remove the outer dbl-quotes
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }

    // Escape internal double quotes by doubling them
    if (val.includes('"')) {
      val = val.replace(/"/g, '""');
    }

    // Enclose in double quotes if it contains special characters
    return /[",\n\r]/.test(val) ? `"${val}"` : val;
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
