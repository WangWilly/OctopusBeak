import assert from "node:assert/strict";
import test from "node:test";
import type { DamagedLedgerDto } from "../desktop/api.ts";
import {
  cancelDamagedLedgerDelete,
  confirmDamagedLedgerDelete,
  damagedLedgersShown,
  deleteDamagedLedger,
  NO_DAMAGED_LEDGERS,
  readDamagedLedgers,
  type DamagedLedgersBridge,
  type DamagedLedgersView,
} from "./damaged-ledgers.ts";

const NEWER: DamagedLedgerDto = { id: "2026-11-20T08-00-00Z", bytes: 5 * 1024 * 1024, setAsideAt: "2026-11-20T08:00:00.000Z", deletable: true };
const OLDER: DamagedLedgerDto = { id: "2026-11-01T02-03-04Z", bytes: null, setAsideAt: "2026-11-01T02:03:04.000Z", deletable: true };

function bridge(ledgers: DamagedLedgerDto[], fail: { read?: boolean; delete?: boolean } = {}) {
  const deleted: string[] = [];
  const host: DamagedLedgersBridge = {
    damagedLedgers: async () => {
      if (fail.read) throw new Error("unreadable");
      return ledgers;
    },
    deleteDamagedLedger: async (id) => {
      if (fail.delete) throw new Error("A damaged ledger a restore may name cannot be deleted.");
      deleted.push(id);
      ledgers = ledgers.filter((ledger) => ledger.id !== id);
      return ledgers;
    },
  };
  return { host, deleted };
}

test("the row shows only while a damaged ledger exists, and once more to say the last one is deleted", async () => {
  assert.equal(damagedLedgersShown(NO_DAMAGED_LEDGERS), "hidden");
  assert.equal(damagedLedgersShown(await readDamagedLedgers(bridge([]).host, NO_DAMAGED_LEDGERS)), "hidden");
  const view = await readDamagedLedgers(bridge([NEWER, OLDER]).host, NO_DAMAGED_LEDGERS);
  assert.deepEqual(view, { ledgers: [NEWER, OLDER], action: { kind: "idle" } }, "in the order the host lists them, newest first");
  assert.equal(damagedLedgersShown(view), "ledgers");
  assert.equal(damagedLedgersShown({ ledgers: [], action: { kind: "deleted" } }), "all-deleted", "only to say the last one is deleted");
  assert.equal(damagedLedgersShown({ ledgers: [OLDER], action: { kind: "deleted" } }), "ledgers");
});

test("a failed read keeps what was read last", async () => {
  const view: DamagedLedgersView = { ledgers: [NEWER], action: { kind: "idle" } };
  assert.equal(await readDamagedLedgers(bridge([], { read: true }).host, view), view);
});

test("Delete opens a confirm for that ledger only; Cancel closes it and deletes nothing", async () => {
  const { host, deleted } = bridge([NEWER, OLDER]);
  let view = await readDamagedLedgers(host, NO_DAMAGED_LEDGERS);
  view = confirmDamagedLedgerDelete(view, OLDER.id);
  assert.deepEqual(view.action, { kind: "confirming", id: OLDER.id });
  view = confirmDamagedLedgerDelete(view, NEWER.id);
  assert.deepEqual(view.action, { kind: "confirming", id: NEWER.id }, "another's Delete moves the confirm to it");
  assert.equal(confirmDamagedLedgerDelete(view, "2026-01-01T00-00-00Z"), view, "an id not listed opens nothing");
  view = cancelDamagedLedgerDelete(view);
  assert.deepEqual(view.action, { kind: "idle" });
  assert.equal(await deleteDamagedLedger(host, view, () => {}), view, "nothing deletes without the confirm");
  assert.deepEqual(deleted, []);
});

test("a confirmed delete shows it under way, then what is left and that it was deleted", async () => {
  const { host, deleted } = bridge([NEWER, OLDER]);
  const shown: DamagedLedgersView[] = [];
  let view = confirmDamagedLedgerDelete(await readDamagedLedgers(host, NO_DAMAGED_LEDGERS), NEWER.id);
  view = await deleteDamagedLedger(host, view, (next) => shown.push(next));
  assert.deepEqual(deleted, [NEWER.id]);
  assert.deepEqual(shown.map((next) => next.action), [{ kind: "deleting", id: NEWER.id }, { kind: "deleted" }]);
  assert.deepEqual(view, { ledgers: [OLDER], action: { kind: "deleted" } });

  view = await deleteDamagedLedger(host, confirmDamagedLedgerDelete(view, OLDER.id), () => {});
  assert.deepEqual(view, { ledgers: [], action: { kind: "deleted" } });
  assert.equal(damagedLedgersShown(view), "all-deleted", "the row stays to say so");
});

test("a refused or failed delete keeps the ledger, says so beside it, and reads the list again", async () => {
  const { host } = bridge([NEWER, OLDER], { delete: true });
  let view = confirmDamagedLedgerDelete(await readDamagedLedgers(host, NO_DAMAGED_LEDGERS), OLDER.id);
  view = await deleteDamagedLedger(host, view, () => {});
  assert.deepEqual(view, { ledgers: [NEWER, OLDER], action: { kind: "failed", id: OLDER.id } });
  assert.deepEqual(confirmDamagedLedgerDelete(view, OLDER.id).action, { kind: "confirming", id: OLDER.id }, "it can be tried again");

  // Gone meanwhile, as after a reset: nothing is left to fail on.
  view = await readDamagedLedgers(bridge([NEWER]).host, view);
  assert.deepEqual(view, { ledgers: [NEWER], action: { kind: "idle" } });
});

test("a ledger a restore file keeps has no Delete to confirm, whichever the reason, and says why instead of failing", async () => {
  for (const hold of ["restore-under-way", "restore-unreadable"] as const) {
    const held: DamagedLedgerDto = { ...NEWER, deletable: false, hold };
    const { host, deleted } = bridge([held, OLDER]);
    const view = await readDamagedLedgers(host, NO_DAMAGED_LEDGERS);
    assert.deepEqual(view.ledgers[0], held, `${hold} reaches the row as the host gives it`);
    assert.equal(confirmDamagedLedgerDelete(view, held.id), view, `${hold}: no confirm opens`);
    assert.equal(await deleteDamagedLedger(host, view, () => {}), view);
    assert.deepEqual(deleted, []);
    assert.deepEqual(confirmDamagedLedgerDelete(view, OLDER.id).action, { kind: "confirming", id: OLDER.id }, "another stays deletable");
  }

  // Refused because a restore file came to name it meanwhile: the line says why, not "try again".
  let ledgers: DamagedLedgerDto[] = [NEWER];
  const host: DamagedLedgersBridge = {
    damagedLedgers: async () => ledgers,
    deleteDamagedLedger: async () => {
      ledgers = [{ ...NEWER, deletable: false, hold: "restore-under-way" }];
      throw new Error("A damaged ledger a restore may name cannot be deleted: restore-under-way.");
    },
  };
  const view = await deleteDamagedLedger(host, confirmDamagedLedgerDelete(await readDamagedLedgers(host, NO_DAMAGED_LEDGERS), NEWER.id), () => {});
  assert.deepEqual(view, { ledgers, action: { kind: "idle" } });
});
