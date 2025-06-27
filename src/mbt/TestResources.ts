export interface TestResources {
  functionLibraries: string[];
  recoveryScenarios: RecoveryScenario[];
}
export interface RecoveryScenario {
  path: string;
  name: string;
}