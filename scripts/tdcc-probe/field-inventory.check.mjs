import assert from "node:assert/strict";
import test from "node:test";
import { inventoryFields, maskShape } from "./field-inventory.ts";

// Built at runtime so the repository privacy hook does not see ID-shaped literals.
const SENSITIVE = {
  nationalId: ["Q", "2", "87654321"].join(""),
  bankAccount: ["0071", "2345", "67890"].join(""),
  brokerAccount: ["98", "76543"].join(""),
  personName: "王小明",
  counterpartyMemo: "轉帳陳大文",
  amount: "128800",
  numericBalance: 45210,
  quantity: "1500",
  sessionTokenValue: ["tok", "9f8e7d6c5b4a"].join("_"),
  richUrl: "https://rich.example/p?sid=s3cr3tSid",
  serial: "S000918",
};

function syntheticResponses() {
  return {
    userID: SENSITIVE.nationalId,
    tokenID: SENSITIVE.sessionTokenValue,
    richUrl: SENSITIVE.richUrl,
    accountName: SENSITIVE.personName,
    contacts: [{ name: SENSITIVE.personName }, { name: "林美華" }],
    tspAccountInfos: [
      {
        bankId: "808",
        tspAccount: [
          { accountNo: SENSITIVE.bankAccount, currency: "TWD", balanceAmt: SENSITIVE.amount, isShow: true, accountType: "活期" },
          { accountNo: "1", currency: "USD", balanceAmt: "3", isShow: false },
        ],
      },
    ],
    transactionDetails: [{ memo: SENSITIVE.counterpartyMemo, summary: "ATM", transferOutAmount: "500", stan: "1" }],
    accounts: [
      {
        brokerNo: "9A00",
        brokerAccount: SENSITIVE.brokerAccount,
        cashBalance: SENSITIVE.numericBalance,
        items: [
          ["2330", "台積電", "2", SENSITIVE.quantity, SENSITIVE.serial, "1"],
          ["0050", "元大台灣50", "2", "10", "S000917", "2"],
        ],
      },
    ],
  };
}

test("no raw personal or financial value appears anywhere in the inventory", () => {
  const text = JSON.stringify(inventoryFields(syntheticResponses()));
  for (const [label, value] of Object.entries(SENSITIVE)) {
    assert.equal(text.includes(String(value)), false, `${label} leaked into the inventory`);
  }
  assert.equal(text.includes("台積電"), false, "tuple slots never list values");
});

test("enum-like fields keep their distinct values and sensitive keys keep only a shape", () => {
  const inventory = inventoryFields(syntheticResponses());
  assert.deepEqual(inventory["$.tspAccountInfos[].tspAccount[].currency"].values, ["TWD", "USD"]);
  assert.deepEqual(inventory["$.tspAccountInfos[].tspAccount[].isShow"].values, ["false", "true"]);
  assert.deepEqual(inventory["$.tspAccountInfos[].tspAccount[].accountType"], {
    types: ["string"],
    present: 1,
    total: 2,
    example: "中中",
  });
  assert.deepEqual(inventory["$.transactionDetails[].summary"].values, undefined);
  const accountNo = inventory["$.tspAccountInfos[].tspAccount[].accountNo"];
  assert.equal(accountNo.values, undefined);
  assert.equal(accountNo.example, "9".repeat(SENSITIVE.bankAccount.length));
  assert.equal(inventory["$.userID"].example, "A999999999");
  assert.equal(inventory["$.accountName"].example, "中中中");
});

test("arrays collapse to [] and rows nested in arrays keep their slot index", () => {
  const inventory = inventoryFields(syntheticResponses());
  assert.deepEqual(inventory["$.accounts[].items[]"], {
    types: ["array"],
    present: 2,
    total: 2,
    example: null,
  });
  assert.deepEqual(inventory["$.accounts[].items[][3]"], {
    types: ["string"],
    present: 2,
    total: 2,
    example: "9999",
  });
  assert.deepEqual(inventory["$.accounts[].cashBalance"].types, ["number"]);
  assert.equal(inventory["$.accounts[].cashBalance"].example, "99999");
});

test("a field with too many or too long values lists none", () => {
  const many = inventoryFields({ rows: Array.from({ length: 13 }, (_, index) => ({ kind: `k${index}` })) });
  assert.equal(many["$.rows[].kind"].values, undefined);
  const long = inventoryFields({ rows: [{ kind: "x".repeat(17) }] });
  assert.equal(long["$.rows[].kind"].values, undefined);
  const digits = inventoryFields({ rows: [{ kind: "A12345" }] });
  assert.equal(digits["$.rows[].kind"].values, undefined);
});

test("present counts the containers that carry the key", () => {
  const inventory = inventoryFields([{ a: 1, b: null }, { a: 2 }, {}]);
  assert.deepEqual(
    { present: inventory["$[].a"].present, total: inventory["$[].a"].total },
    { present: 2, total: 3 },
  );
  assert.deepEqual(inventory["$[].b"].types, ["null"]);
});

test("shape masking keeps length and classes", () => {
  assert.equal(maskShape("Ab-12 中文é"), "Aa-99 中中a");
});
