import { Logger } from '../utils/logger';
import * as fs from 'fs';
import * as sax from 'sax';
import { CaseResult } from './CaseResult';
import { escapeXML, parseTimeToFloat } from '../utils/utils';

const logger: Logger = new Logger('SuiteResult');

export class SuiteResult {
  public file: string | null = null;
  public name: string = "";
  public externalAssets: string = "";
  public enclosingBlocks: string[] = [];
  public enclosingBlockNames: string[] = [];
  public stdout: string = "";
  public stderr: string = "";
  public cases: CaseResult[] = [];
  public duration: number = 0;
  public id: string = "";
  private casesByName: Map<string, CaseResult> = new Map<string, CaseResult>();
  private time: string = "";
  public timestamp: string = "";

  constructor(xmlResFilePath: string, suite: any | null = null) {
    if (suite) {
      const attrs = suite.attributes;
      let name = attrs.name;
      if (name == null) {
        name = `(${xmlResFilePath})`;
      } else {
        const pkg = attrs.package;
        pkg && (name = `${pkg}.${name}`);
      }
      this.name = name.replace(/[/\\:?#%<>]/g, '_');
      this.file = xmlResFilePath;
      this.id = attrs.id ?? "";
      this.timestamp = attrs.timestamp ?? "";
      if (attrs.time) {
        this.duration = parseTimeToFloat(attrs.time as string);
      }
    } else {
      const name = `(${xmlResFilePath})`;
      this.name = name.replace(/[/\\:?#%<>]/g, '_');
    }
  }

  public static async parse(xmlFilePath: string, keepLongStdio: boolean): Promise<SuiteResult[]> {
    const r: SuiteResult[] = [];
    await this.parseXML(xmlFilePath, keepLongStdio, r);
    return r;
  }

  private static parseXML(xmlFilePath: string, keepLongStdio: boolean, r: SuiteResult[]): Promise<void> {
    logger.debug(`parseXML: [${xmlFilePath}], keepLongStdio=${keepLongStdio} ...`);
    return new Promise((resolve, reject) => {
      const parser = sax.createStream(true, { trim: true });

      let testSuite: SuiteResult | null = null;
      let testCase: CaseResult | null = null;
      let currentText: string = "";
      let attrs: any = null; // Track attributes for the current node
      let suiteStack: SuiteResult[] = []; // Track suite hierarchy
      let nodeName = "";

      const handleOpentag = (node: any) => {
        logger.debug(`handleOpentag: ${node.name}`);
        nodeName = node.name;
        attrs = node.attributes;
        if (nodeName === "testsuite") {
          testSuite = new SuiteResult(xmlFilePath, node);
          r.push(testSuite); // Add to root result array immediately
          suiteStack.push(testSuite); // Push to stack to track hierarchy
        } else if (nodeName === "testcase") {
          if (!testSuite) {
            logger.warn("Testcase found outside of a testsuite, skipping.");
            return;
          }
          testCase = new CaseResult(testSuite, attrs);
        } else if (nodeName === "error" || nodeName === "failure") {
          currentText = "";
        } else if (nodeName === "skipped") {
          if (testCase) {
            testCase.skipped = true;
            testCase.skippedMessage = attrs.message as string || "";
          }
        }
      };

      const handleText = (text: string) => {
        logger.debug(`handleText: ${text}`);
        if (testCase) {
          if (nodeName === "system-out") {
            testCase.stdout = this.possiblyTrimStdio(testCase, keepLongStdio, text);
          } else if (nodeName === "system-err") {
            testCase.stderr = this.possiblyTrimStdio(testCase, keepLongStdio, text);
          } else if ((nodeName === "error" || nodeName === "failure")) {
            currentText += text;
          }
        }
      };

      const handleClosetag = (tagName: string) => {
        logger.debug(`handleClosetag: ${tagName}`);
        if (testSuite) {
          if (testCase) {
            if (tagName === "testcase") {
              testSuite.addCase(testCase);
              testCase = null;
            } else if (tagName === "error" || tagName === "failure") {
              testCase.errorStackTrace = currentText;
              if (attrs?.message) {
                testCase.errorDetails = attrs.message as string;
              }
            }
          } else if (tagName === "testsuite") {
            suiteStack.pop(); // Pop current suite from stack
            testSuite = suiteStack.length > 0 ? suiteStack[suiteStack.length - 1] : null; // Restore parent suite or null
          }
        }
      };

      parser.on('opentag', handleOpentag);
      parser.on('text', handleText);
      parser.on('closetag', handleClosetag);
      parser.on('error', (error: Error) => {
        logger.error("parseXML: ", error);
        reject(error);
      });
      parser.on('end', () => {
        logger.debug(`parseXML: XML parsing completed.`);
        resolve();
      });

      fs.createReadStream(xmlFilePath).pipe(parser);
    });
  }

  public addCase(cr: CaseResult): void {
    this.cases.push(cr);
    this.casesByName.set(cr.testName, cr);
    if (!this.hasTimeAttr()) {
      this.duration += cr.duration;
    }
  }

  private hasTimeAttr(): boolean {
    return this.time !== "";
  }

  public merge(sr: SuiteResult): void {
    if (sr.hasTimeAttr() !== this.hasTimeAttr()) {
      logger.warn("Merging of suiteresults with incompatible time attribute may lead to incorrect durations in reports.");
    }

    if (this.hasTimeAttr()) {
      this.duration += sr.duration;
    }

    for (const cr of sr.cases) {
      cr.parent = this;
      this.addCase(cr);
    }
  }

  private static possiblyTrimStdio(testCase: CaseResult, keepLongStdio: boolean, stdio: string): string | null {
    if (stdio == null) {
      return null;
    }
    if (keepLongStdio) {
      return stdio;
    }
    const len = stdio.length;
    const halfMaxSize = testCase.errorStackTrace ? 50000 : 500;
    const middle = len - halfMaxSize * 2;
    if (middle <= 0) {
      return stdio;
    }
    return stdio.substring(0, halfMaxSize) + "\n...[truncated " + middle + " chars]...\n" + stdio.substring(len - halfMaxSize, len);
  }

  public toXML(indent: number = 1): string {
    const tabs = "\t".repeat(indent);
    let xml = `${tabs}<suite>\n`;
    xml += `${tabs}\t<file>${escapeXML(this.file)}</file>\n`;
    xml += `${tabs}\t<name>${escapeXML(this.name)}</name>\n`;
    xml += `${tabs}\t<enclosingBlocks>${this.enclosingBlocks.length > 0 ? escapeXML(this.enclosingBlocks.join(",")) : ""}</enclosingBlocks>\n`;
    xml += `${tabs}\t<enclosingBlockNames>${this.enclosingBlockNames.length > 0 ? escapeXML(this.enclosingBlockNames.join(",")) : ""}</enclosingBlockNames>\n`;
    xml += `${tabs}\t<duration>${this.duration.toFixed(5)}</duration>\n`;
    xml += `${tabs}\t<cases>\n`;
    for (const testCase of this.cases) {
      xml += testCase.toXML(indent + 2);
    }
    xml += `${tabs}\t</cases>\n`;
    xml += `${tabs}</suite>\n`;
    return xml;
  }
}