import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./fubon-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /function signOutFubon/);
assert.match(source, /activateControlWithoutPointer/);
assert.match(source, /logoutNow/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.fubon/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "loan"/,
);
assert.equal(source.match(/await signInFubon\(/g)?.length, 1);
assert.match(
  source,
  /finally \{[\s\S]*?stopSessionKeepAlive\(\);[\s\S]*?signOutFubon\(page\)/,
);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-fubon-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server.ssrLoadModule(
  "/src/workflows/fubon-all-statements.ts",
).finally(() => server.close());
const workflow = module.default;
const runFubonAllStatements = module.runFubonAllStatements;
assert.equal(workflow.handler, runFubonAllStatements);

const selectionKey = "LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES";
const previousSelection = process.env[selectionKey];
process.env[selectionKey] = "credit_card";
const calls: string[] = [];
const page = {
  on: () => calls.push("dialog-listener"),
};
const ctx = { page, session: "fubon-session" };
const creditCards = { files: ["credit-card.csv"] };
let output: unknown;
try {
  output = await runFubonAllStatements(
    ctx,
    {
      credentials: { fubon_user_id: "id" },
      statements: {},
      creditCards: {},
      loans: {},
    },
    {
      signInFubon: async (actualPage: unknown, session: string) => {
        assert.equal(actualPage, page);
        assert.equal(session, ctx.session);
        calls.push("login");
      },
      keepBrowserWindowOutOfForeground: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("background");
      },
      startFubonSessionKeepAlive: (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("keepalive-start");
        return () => calls.push("keepalive-stop");
      },
      runSectionOutOfForeground: async (
        actualPage: unknown,
        section: string,
        run: () => Promise<unknown>,
      ) => {
        assert.equal(actualPage, page);
        calls.push(`section:${section}`);
        return run();
      },
      runFubonStatements: async () => {
        throw new Error("unselected deposit ran");
      },
      runFubonCreditCardStatements: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("credit-card");
        return creditCards;
      },
      runFubonLoanStatements: async () => {
        throw new Error("unselected loan ran");
      },
      signOutFubon: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("logout");
      },
    },
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
}

assert.deepEqual(output, {
  statements: undefined,
  creditCards,
  loans: undefined,
});
assert.deepEqual(calls, [
  "dialog-listener",
  "login",
  "background",
  "keepalive-start",
  "section:creditCards",
  "credit-card",
  "keepalive-stop",
  "logout",
]);
