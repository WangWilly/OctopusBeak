# Running the TDCC e-Passbook probe

The TDCC probe is a development-only command for Phase 0 of [ADR 0041](../adr/0041-tdcc-epassbook-app-protocol-source.md). It signs in to TDCC e-Passbook with the production client in `src/workflows/tdcc-epassbook-client.ts` and calls every endpoint. It then writes a redacted field inventory, which Phase 1 uses to settle each product's Source Contract. It never writes to the canonical store, and the installer does not include it.

## Before you run it

1. Quit Octopus Beak. The App and the probe both write `credentials.json`, and the App can overwrite the probe's changes.
2. Have your TDCC e-Passbook sign-in details ready. If TDCC does not trust the probe's device, you also need access to the email address and mobile phone registered with TDCC.

## Run the probe

```sh
npm run probe:tdcc -- --help
npm run probe:tdcc
```

`--help` prints the usage and the resolved `credentials.json` path, then exits without network access. Without arguments, the probe runs as an Electron main script, because only Electron's `safeStorage` can decrypt the App's `credentials.json`. It uses the App's name and userData folder (`OCTOPUSBEAK_USER_DATA`, or `OctopusBeak` under the system application-data folder). It refuses to run if `safeStorage` cannot encrypt. On macOS, the first run can ask for access to the `OctopusBeak Safe Storage` keychain item, because the development Electron binary is not the signed App.

The probe does these steps in order:

1. It reads the TDCC user ID and password from `credentials.json`. If they are missing, it asks for them in the terminal, with hidden password input, and saves them.
2. It loads the device identity (a fixed common Android model and a random device ID). It creates a new identity only when none exists or the saved one belongs to a different user ID. A password change keeps the identity.
3. If a session token is saved, it checks the token with one positions request and records whether the token was valid and how old it was.
4. If no valid session exists, it signs in. If TDCC does not trust the device, the probe runs Source device registration. Type the Email OTP when the terminal asks for it, and the SMS OTP if TDCC asks for that too. The probe never saves an OTP.
5. It calls positions (TR001), funds (TR051V1), settlement balances (TSP006), settlement transactions (TSP007, all pages), trades (TR002, all pages for each broker account), and the asset trend (TR087).
6. After a fresh sign-in, it asks whether the e-Passbook phone app was signed out. Check the phone and answer `y`, `n`, or `skip`.

## Output

- `reports/tdcc-probe/<timestamp>.json`: the session result and, for each endpoint, the call, page, and failure counts and a field inventory.
- `reports/tdcc-probe/session-log.jsonl`: one line for each run, with the sign-in time, saved-session validity and age, registration result, and phone-app answer.

The report also lists each visible settlement account whose currency is not an ISO 4217 code, such as `NAN`, under `nonIsoSettlementAccounts`. It records the currency and three facts: whether the balance is non-zero, whether the available balance is non-zero, and whether TSP007 returned any transactions. A value that is not a plain decimal shows as `unparseable`, and a failed TSP007 call shows as `call-failed`. [ADR 0042](../adr/0042-tdcc-admission-direct-source-precedence-and-passbook-movements.md) does not admit these accounts.

`reports/` is git-ignored and excluded from the installer. The field inventory lists every JSON path, with array items collapsed to `[]` and positional row slots kept as `[n]`. For each path, it records the value types, present and total counts, and a masked example: digits become `9`, letters `A` or `a`, CJK characters `中`, and the length stays the same. Distinct values appear only for short enum-like fields whose key does not name an identifier, account, name, amount, balance, quantity, price, date, token, or contact detail. The report never contains raw national IDs, account numbers, names, amounts, or tokens.

Device identity and the session token are Authentication secrets. They stay in the safeStorage-encrypted `credentials.json` under the `LIBRETTO_CLOUD_TDCC_*` keys, and are never copied into a workflow environment.
