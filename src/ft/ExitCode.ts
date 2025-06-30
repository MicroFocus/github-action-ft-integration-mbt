export enum ExitCode {
  Passed = 0,
  Failed = -1,
  PartialFailed = -2,
  Aborted = -3,
  Unstable = -4,
  AlmNotConnected = -5,
  Unkonwn = -99
}