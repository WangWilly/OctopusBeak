/** A provider prevented the workflow from reaching its expected sign-in form. */
export class SourceAccessChallengeError extends Error {
  constructor() {
    super("Source access was blocked by an external verification challenge.");
    this.name = "SourceAccessChallengeError";
  }
}

/** A provider explicitly reported that its source page is temporarily unavailable. */
export class SourceUnavailableError extends Error {
  constructor() {
    super("Source login page is temporarily unavailable.");
    this.name = "SourceUnavailableError";
  }
}

/** A provider's App protocol no longer accepts or matches what the workflow implements. */
export class ProviderProtocolOutdatedError extends Error {
  constructor() {
    super("The provider's App protocol no longer matches this workflow.");
    this.name = "ProviderProtocolOutdatedError";
  }
}
