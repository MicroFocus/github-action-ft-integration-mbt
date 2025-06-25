import MbtTestParser from "./MbtTestParser";
import TestParser from "./TestParser";
import ToolType from '../dto/ft/ToolType';

export default class TestParserFactory {
  public static getParser(framework: ToolType = ToolType.MBT): TestParser {
    return new MbtTestParser();
  }
}
