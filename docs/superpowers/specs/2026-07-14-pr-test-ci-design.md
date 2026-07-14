# PR Test CI Design

## Goal

Every pull request must run all repository tests and produce a readable test report before merge. Coverage is reported but has no minimum threshold.

## Approach

Use Node's built-in test runner and reporters. This matches the repository's existing `node:assert`-based `*.check.*` and `*.test.*` files and avoids adding a test framework or reporting dependency.

## Test Commands

Add package scripts that run every tracked test convention under `src`, `electron`, and `scripts`:

- `test` prints the normal test result locally.
- `test:ci` enables Node's built-in coverage, writes a human-readable summary, and writes JUnit XML.

Both commands cover `*.check.ts`, `*.test.ts`, and the JavaScript module variants currently used by the repository. Coverage is informational only; no line, branch, or function threshold is configured.

## GitHub Actions Workflow

Add one pull-request workflow with one required job:

1. Check out the pull request commit.
2. Install the repository's supported Node version.
3. Run `npm ci` from the committed lockfile.
4. Create the report directory and run `npm run test:ci`.
5. On success or failure, append the text report to the GitHub Actions job summary.
6. On success or failure, upload the text report and JUnit XML as a downloadable artifact.

The test step's exit status determines the job status. Report publishing uses `if: always()` so a failing suite still leaves diagnostic output. Workflow permissions remain read-only.

## Merge Enforcement

The workflow creates a stable status check. After the workflow exists and has run at least once, configure the repository's GitHub Ruleset or branch protection rule to require that check before merging. The workflow alone cannot enforce merge protection.

## Error Handling

- `npm ci` failure blocks the job and therefore the merge.
- Any test failure blocks the job and therefore the merge.
- Report upload must not conceal the original test failure.
- If report generation itself fails, the CI job fails rather than passing without the required report.

## Verification

- Run the local test command and confirm every current test file is discovered.
- Run the CI report command and confirm it creates valid JUnit XML and a coverage summary without enforcing a threshold.
- Validate the workflow syntax and review the final diff.
- After the first GitHub run, mark its job check as required in repository rules.

## Non-goals

- Migrating tests to Vitest, Jest, or another framework.
- Adding a coverage service or PR annotation bot.
- Enforcing a coverage minimum.
- Running credential-dependent live banking workflows.
