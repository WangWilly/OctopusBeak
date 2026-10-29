import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The website's download buttons resolve to this unversioned copy in the latest release. */
export const SITE_DMG = "OctopusBeak-arm64.dmg";

const HEADER = "date,tag,asset,downloads";
const INSTALLER = /\.(?:dmg|zip)$/iu;

/** Installer download counts of every published release, as cumulative rows for one date. */
export function snapshotRows(releases, date) {
  return releases
    .filter((release) => !release.draft)
    .flatMap((release) =>
      release.assets
        .filter((asset) => INSTALLER.test(asset.name))
        .map((asset) => ({ date, tag: release.tag_name, asset: asset.name, downloads: asset.download_count })),
    )
    .sort(compareRows);
}

function compareRows(left, right) {
  return left.date.localeCompare(right.date) || left.tag.localeCompare(right.tag) || left.asset.localeCompare(right.asset);
}

export function parseHistory(csv) {
  const lines = csv.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  if (lines[0] !== HEADER) throw new Error(`Unexpected download history header: ${lines[0]}`);
  return lines.slice(1).map((line, index) => {
    const [date, tag, asset, downloads, ...rest] = line.split(",");
    const count = Number(downloads);
    if (rest.length > 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") || !tag || !asset || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Malformed download history row ${index + 2}: ${line}`);
    }
    return { date, tag, asset, downloads: count };
  });
}

/** Today's snapshot replaces any earlier snapshot taken on the same date. */
export function mergeHistory(history, snapshot) {
  const dates = new Set(snapshot.map((row) => row.date));
  return [...history.filter((row) => !dates.has(row.date)), ...snapshot].sort(compareRows);
}

export function formatHistory(rows) {
  return [HEADER, ...rows.map((row) => `${row.date},${row.tag},${row.asset},${row.downloads}`)].join("\n") + "\n";
}

function sum(rows) {
  return rows.reduce((total, row) => total + row.downloads, 0);
}

function kind(asset) {
  if (asset === SITE_DMG) return "site";
  return asset.toLowerCase().endsWith(".dmg") ? "dmg" : "zip";
}

export function summarize(rows, releases, recentDays = 30) {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const latestDate = dates.at(-1);
  if (!latestDate) return "# Download statistics\n\nNo snapshot yet.\n";
  const latest = rows.filter((row) => row.date === latestDate);
  const published = new Map(releases.map((release) => [release.tag_name, release.published_at?.slice(0, 10) ?? ""]));

  const lines = [
    "# Download statistics",
    "",
    `Snapshot: ${latestDate}. Counts are cumulative GitHub Release installer downloads (DMG and ZIP), not unique people or installs.`,
    "",
    `- Total installer downloads: **${sum(latest)}**`,
    `- Through the website button (\`${SITE_DMG}\`): **${sum(latest.filter((row) => row.asset === SITE_DMG))}**`,
    "",
    "## By release",
    "",
    "| Release | Published | Website DMG | Versioned DMG | ZIP | Total |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  const tags = [...new Set(latest.map((row) => row.tag))].sort((left, right) =>
    (published.get(right) ?? "").localeCompare(published.get(left) ?? "") || right.localeCompare(left),
  );
  for (const tag of tags) {
    const release = latest.filter((row) => row.tag === tag);
    const byKind = (name) => sum(release.filter((row) => kind(row.asset) === name));
    lines.push(`| ${tag} | ${published.get(tag) ?? ""} | ${byKind("site")} | ${byKind("dmg")} | ${byKind("zip")} | ${sum(release)} |`);
  }

  lines.push("", `## New downloads per snapshot (last ${recentDays})`, "", "| Since | Until | New downloads |", "| --- | --- | ---: |");
  const totals = dates.map((date) => ({ date, total: sum(rows.filter((row) => row.date === date)) }));
  const deltas = totals.slice(1).map((current, index) => ({ since: totals[index].date, until: current.date, added: current.total - totals[index].total }));
  for (const delta of deltas.slice(-recentDays).reverse()) {
    lines.push(`| ${delta.since} | ${delta.until} | ${delta.added} |`);
  }
  if (deltas.length === 0) lines.push("| | | Needs a second snapshot |");
  lines.push("", "A negative number means a release or asset was deleted between snapshots.", "");
  return lines.join("\n");
}

async function fetchReleases(repository, token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status} ${await response.text()}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

async function main() {
  const outputDirectory = resolve(process.argv[2] ?? "download-stats");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY must name owner/repo.");
  const date = process.env.DOWNLOAD_STATS_DATE ?? new Date().toISOString().slice(0, 10);

  const releases = await fetchReleases(repository, process.env.GITHUB_TOKEN);
  const historyPath = join(outputDirectory, "history.csv");
  const history = existsSync(historyPath) ? parseHistory(readFileSync(historyPath, "utf8")) : [];
  const rows = mergeHistory(history, snapshotRows(releases, date));

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(historyPath, formatHistory(rows));
  writeFileSync(join(outputDirectory, "README.md"), summarize(rows, releases));
  console.log(`Recorded ${rows.filter((row) => row.date === date).length} installer counts for ${date}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
