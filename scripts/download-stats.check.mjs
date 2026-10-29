import assert from "node:assert/strict";
import { test } from "node:test";

import { formatHistory, mergeHistory, parseHistory, snapshotRows, summarize } from "./download-stats.mjs";

const releases = [
  {
    tag_name: "v0.9.5",
    draft: false,
    published_at: "2026-10-20T00:00:00Z",
    assets: [
      { name: "OctopusBeak-arm64.dmg", download_count: 40 },
      { name: "OctopusBeak-0.9.5-arm64.dmg", download_count: 7 },
      { name: "OctopusBeak-darwin-arm64-0.9.5.zip", download_count: 3 },
      { name: "SHA256SUMS.txt", download_count: 9 },
    ],
  },
  { tag_name: "v0.9.6", draft: true, published_at: null, assets: [{ name: "OctopusBeak-arm64.dmg", download_count: 1 }] },
];

test("snapshot keeps installers of published releases only", () => {
  const rows = snapshotRows(releases, "2026-10-29");
  assert.deepEqual(
    rows.map((row) => `${row.tag}/${row.asset}=${row.downloads}`),
    ["v0.9.5/OctopusBeak-0.9.5-arm64.dmg=7", "v0.9.5/OctopusBeak-arm64.dmg=40", "v0.9.5/OctopusBeak-darwin-arm64-0.9.5.zip=3"],
  );
});

test("history round-trips and a same-day snapshot replaces the earlier one", () => {
  const first = snapshotRows(releases, "2026-10-28");
  const history = parseHistory(formatHistory(first));
  assert.deepEqual(history, first);

  const rerun = mergeHistory(history, snapshotRows(releases, "2026-10-28"));
  assert.equal(rerun.length, first.length);

  const next = mergeHistory(history, snapshotRows(releases, "2026-10-29"));
  assert.equal(next.length, first.length * 2);
});

test("history rejects malformed rows", () => {
  assert.throws(() => parseHistory("date,tag,asset,downloads\n2026-10-29,v1,a.dmg,-1\n"), /Malformed/);
  assert.throws(() => parseHistory("wrong\n"), /header/);
  assert.deepEqual(parseHistory(""), []);
});

test("summary reports totals, the website button and per-snapshot growth", () => {
  const before = snapshotRows(releases, "2026-10-28").map((row) => ({ ...row, downloads: row.downloads - 1 }));
  const rows = mergeHistory(before, snapshotRows(releases, "2026-10-29"));
  const summary = summarize(rows, releases);
  assert.match(summary, /Total installer downloads: \*\*50\*\*/);
  assert.match(summary, /website button \(`OctopusBeak-arm64.dmg`\): \*\*40\*\*/);
  assert.match(summary, /\| v0\.9\.5 \| 2026-10-20 \| 40 \| 7 \| 3 \| 50 \|/);
  assert.match(summary, /\| 2026-10-28 \| 2026-10-29 \| 3 \|/);
});
