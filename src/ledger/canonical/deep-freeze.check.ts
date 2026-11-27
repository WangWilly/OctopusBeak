import assert from "node:assert/strict";
import test from "node:test";
import { deepFreeze } from "./deep-freeze.ts";

test("deepFreeze freezes nested objects and arrays and returns the same reference", () => {
  const symbolKey = Symbol("evidence");
  const value = {
    rows: [{ amount: "1.00" }, [{ deep: true }]],
    nested: { inner: { leaf: 1 } },
    [symbolKey]: { hidden: true },
  };
  const frozen = deepFreeze(value);

  assert.equal(frozen, value);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.rows));
  assert.ok(Object.isFrozen(value.rows[0]));
  assert.ok(Object.isFrozen(value.rows[1]));
  assert.ok(Object.isFrozen((value.rows[1] as unknown[])[0]));
  assert.ok(Object.isFrozen(value.nested.inner));
  assert.ok(Object.isFrozen(value[symbolKey]), "symbol-keyed children are frozen");
});

test("deepFreeze terminates on a cycle and freezes every member", () => {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = { a };
  a.b = b;
  a.self = a;

  assert.equal(deepFreeze(a), a);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(b));
});

test("deepFreeze returns primitives and null unchanged", () => {
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze(undefined), undefined);
  assert.equal(deepFreeze("text"), "text");
  assert.equal(deepFreeze(42), 42);
});

test("deepFreeze freezes non-plain objects by their own keys only", () => {
  class Holder {
    readonly child: { n: number };
    constructor(child: { n: number }) {
      this.child = child;
    }
  }
  const date = new Date(0);
  const map = new Map([["k", { n: 1 }]]);
  const holder = new Holder({ n: 2 });
  const callback = Object.assign(() => 0, { tag: { n: 3 } });
  deepFreeze({ date, map, holder, callback });

  assert.ok(Object.isFrozen(date));
  assert.equal(date.setTime(1), 1, "freezing a Date leaves its internal time mutable");
  assert.ok(Object.isFrozen(map));
  assert.ok(!Object.isFrozen(map.get("k")), "Map entries are not own keys and stay unfrozen");
  assert.ok(Object.isFrozen(holder));
  assert.ok(Object.isFrozen(holder.child));
  assert.ok(!Object.isFrozen(Holder.prototype), "the prototype is not descended into");
  assert.ok(!Object.isFrozen(callback), "functions are neither frozen nor descended into");
  assert.ok(!Object.isFrozen(callback.tag));
});

test("deepFreeze throws on a non-empty typed array and accepts an empty one", () => {
  assert.throws(() => deepFreeze({ bytes: new Uint8Array([1]) }), TypeError);
  const empty = new Uint8Array(0);
  deepFreeze({ empty });
  assert.ok(Object.isFrozen(empty));
});
