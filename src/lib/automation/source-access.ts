/** A provider prevented the workflow from reaching its expected sign-in form. */
export class SourceAccessChallengeError extends Error {
  constructor() {
    super("Source access was blocked by an external verification challenge.");
    this.name = "SourceAccessChallengeError";
  }
}
