export class TspParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TspParseError";
  }
}

