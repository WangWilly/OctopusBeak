# Octopus Beak

This context covers guided first-run setup and the financial automation needed to collect, import, and review a user's data.

## Language

**Onboarding progression**:
The guided sequence that helps a new user configure a credential source, collect statements, import them, and confirm the resulting overview. It may pause for human assistance and resume later.

**Credential setup**:
The act of enabling a credential source, entering its credentials, and choosing the statement types required before collection.

**Statement selection**:
The set of statement types chosen for an enabled credential source to collect.

**Trusted financial overview**:
A reviewable, traceable view that unifies a person's financial positions and statement activity across supported Taiwan financial institutions.
_Avoid_: Dashboard, portfolio view, financial summary

**Core user**:
A person in Taiwan who manages at least three bank, credit-card, or investment accounts and is tired of consolidating them manually in spreadsheets. This is the initial audience, not a permanent limit on who OctopusBeak may serve.
_Avoid_: macOS user, all personal-finance users

**Supported source**:
A financial institution or service whose data-collection and import path has been verified for the current Beta. A planned or previously working integration is not a supported source.
_Avoid_: Supported bank, available integration

**Statement run summary**:
A compact record of one automation task run's statement collection outcome, including each selected statement type's result and the overall outcome.

**Automation session finalization**:
The act of relinquishing an owned automation session after a run, including graceful close, daemon teardown when needed, and removal of the session's ownership record.
_Avoid_: Session close (which names only the graceful close operation).

**Automation task**:
A reusable scheduled unit that can be started manually, in a batch, or as a resume.

**Automation task run**:
One persisted execution attempt of an automation task, including its output, status, and any retained session. A run waiting for human input remains that run; resuming creates a new run for the subsequent outcome.

**Automation task run finalization**:
The act of deciding an automation task run's terminal outcome, recording its result, and relinquishing or retaining its automation session.

**Automation task run finalization intent**:
The stated outcome and session disposition that guide how an automation task run is finalized.

**Automation session disposition**:
The decision to retain an automation session for human assistance or relinquish it after a task run.

**Automation task run force-quit**:
An operator-initiated action that ends a task run waiting for human input by relinquishing its exact automation session and finalizing the run as failed.
