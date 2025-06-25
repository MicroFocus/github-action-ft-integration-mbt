export interface TestResources {
  functionLibraries: string[];
  recoveryScenarioData: RecoveryScenarioData[];
}
export interface RecoveryScenarioData {
  path: string;
  name: string;
}