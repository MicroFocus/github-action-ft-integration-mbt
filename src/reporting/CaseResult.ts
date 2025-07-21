import { SuiteResult } from './SuiteResult';
import { escapeXML, parseTimeToFloat } from '../utils/utils';

export class CaseResult {
  public duration: number;
  public className: string;
  public testName: string;
  public skipped: boolean;
  public skippedMessage: string|null;
  public stdout: string|null;
  public stderr: string|null;
  public errorStackTrace: string = "";
  public errorDetails: string = "";
  public parent: SuiteResult;
  public runId: number;

  constructor(parent: SuiteResult, attrs: any) {
    let classname = attrs.classname as string ?? parent.name;
    let nameAttr = attrs.name;
    if (!classname && nameAttr.contains(".")) {
      classname = nameAttr.substring(0, nameAttr.lastIndexOf('.'));
      nameAttr = nameAttr.substring(nameAttr.lastIndexOf('.') + 1);
    }

    this.className = classname ?? "unnamed";
    this.testName = nameAttr;
    this.parent = parent;
    this.stdout = null;
    this.stderr = null;
    this.duration = parseTimeToFloat(attrs.time);
    this.skipped = false;
    this.skippedMessage = null;
    this.runId = parseInt(attrs.runid ?? 0, 10);
  }

  public toXML(indent: number = 2): string {
    const tabs = "\t".repeat(indent);
    let xml = `${tabs}<case>\n`;
    xml += `${tabs}\t<runId>${this.runId}</duration>\n`;
    xml += `${tabs}\t<duration>${this.duration.toFixed(5)}</duration>\n`;
    xml += `${tabs}\t<className>${escapeXML(this.className)}</className>\n`;
    xml += `${tabs}\t<testName>${escapeXML(this.testName)}</testName>\n`;
    xml += `${tabs}\t<skipped>${this.skipped}</skipped>\n`;
    xml += `${tabs}\t<skippedMessage>${escapeXML(this.skippedMessage)}</skippedMessage>\n`;
    xml += `${tabs}\t<stdout>${escapeXML(this.stdout)}</stdout>\n`;
    xml += `${tabs}\t<errorStackTrace>${escapeXML(this.errorStackTrace)}</errorStackTrace>\n`;
    xml += `${tabs}\t<errorDetails>${escapeXML(this.errorDetails)}</errorDetails>\n`;
    xml += `${tabs}</case>\n`;
    return xml;
  }
}