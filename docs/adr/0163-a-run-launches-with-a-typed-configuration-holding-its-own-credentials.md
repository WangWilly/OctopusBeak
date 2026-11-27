# A run launches with a typed configuration holding its own credentials

Status: accepted

Amends [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md).

A run's configuration was a `NodeJS.ProcessEnv`. `automationConfigEnv` copied `process.env`, laid every setting and every decrypted credential over it, deleted the host-only keys and rewrote `NODE_ENV` from `production` to `development`. That shape dates from when a workflow was a child process. Workflows now run in worker threads and receive a typed input, and no process receives this environment.

The shape had three costs:

- Every run held the decrypted credentials of every source for its whole life, although its input reads only its own.
- Readers indexed one string map with string keys. Nothing named which keys a run could read, and a setting looked like a credential.
- Write admission ([ADR 0148](0148-the-workflow-socket-serves-only-workflow-operations-and-refuses-unowned-commits.md)) rebuilt the whole environment, every credential included, for each gated write. The Collection scope fingerprint ([ADR 0067](0067-workflow-execution-owns-per-execution-state.md)) reads one group's settings and its text sign-in fields.

No reader was left for the copy of `process.env` or the `NODE_ENV` rewrite. The failure-diagnostics path read its file path and the App root through the launch environment. Those are process facts, and the worker runtime and the RPC server already read them from `process.env`.

## Decision

- **`RunConfiguration` replaces the environment on the launch path.** It is defined once, in `config-files.ts`. `settings` holds the stored settings as strings, as `settingsToEnv` yields them, so the Statement Selection and visibility helpers keep their signatures. `credentials` holds the stored credentials. Both are read-only, and nothing in either comes from `process.env`.
- **A run holds only the credentials its workflow declares.** Each App workflow registration names its `credentialKeys`, derived from the declarations that already exist. A Verified source declares its secret sign-in fields when its input takes them, as `credentials` or through `extra`, and the card identity secret when it declares `managedIdentitySecret`. A Preview source declares its `previewSourceKeys`. Exchange rates and the packaged fixtures declare none. `runConfiguration` keeps only those keys and never a host-only one.
- **The plan carries the configuration.** `TaskRunPlan.launchConfiguration` replaces `launchEnv` ([ADR 0075](0075-a-task-run-resolves-its-plan-once.md)). A registration's `inputFromConfiguration` replaces `inputFromEnvironment`, and a source's `input.extra` takes the configuration.
- **Write admission builds the configuration of the run's own task.** `collectionScopeAdmission` hands the run's task id to `taskRunConfiguration`, so a gated write no longer assembles every source's credentials. It still reads and decrypts `credentials.json`. The fingerprint covers what it did before: the enabled flag, the selected statement types, and the text sign-in fields of the task's group.
- **The developer script builds its configuration from the shell on purpose.** `scripts/workflow-dev.ts run-app` calls `runConfigurationFromEnvironment(process.env, credentialKeys)`. Each settings key becomes a setting, and every other variable the workflow declares becomes a credential. Checks that state a configuration as one flat map use the same adapter.

## Considered options

- **Keep the environment and cache the scope fingerprint.** Rejected. It saves the cost of rebuilding the environment for each gated write, which nobody has measured, and it leaves every run holding every source's credentials.
- **Keep one merged string map, filtered to the run's keys.** Rejected. It narrows the credentials, but a reader still cannot tell a setting from a credential.

## Consequences

- A variable set in the launching shell reaches no run, whatever its name. The App's stores are the only source of settings and credentials, so the settings no longer take precedence over environment variables, as ADR 0057 put it. No environment variable reaches the run at all.
- MaiCoin's input no longer reads `MAX_PROVIDER_EMAIL`. Neither store can hold it, so only the shell could supply it. The sync still takes the email that MAX reports.
- A source whose input reads a credential outside its declared keys fails `run-configuration.check.ts`. It no longer receives an empty string without notice.
- A gated write still decrypts the credentials file. Whether it can avoid that is a separate question.
