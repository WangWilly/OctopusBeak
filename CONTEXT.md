# Octopus Beak

This context covers guided first-run setup and the financial automation needed to collect, import, and review a user's data.

## Language

**Onboarding progression**:
The guided sequence that helps a new user configure a credential source, collect statements, import them, and confirm the resulting overview. It may pause for human assistance and resume later.

**Credential setup**:
The act of enabling a credential source, entering its credentials, and choosing the statement types required before collection.

**Statement selection**:
The set of statement types chosen for an enabled credential source to collect.

**Automation session finalization**:
The act of relinquishing an owned automation session after a run, including graceful close, daemon teardown when needed, and removal of the session's ownership record.
_Avoid_: Session close (which names only the graceful close operation).
