import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed App reads releases/latest/download/<this> (src/lib/settings/app-updates.ts). */
export const UPDATE_FEED_FILE = "update-feed-darwin-arm64.json";
const RELEASES = "https://github.com/WangWilly/OctopusBeak/releases/download";

export function updateZipName(version) {
  return `OctopusBeak-darwin-arm64-${version}.zip`;
}

/**
 * Squirrel.Mac's JSON feed (ADR 0083). It treats any version other than the running one as an
 * update, so the feed names only this release; an older App always moves forward to it.
 */
export function updateFeed(version, publishedAt) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Not a release version: ${version}`);
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          name: `OctopusBeak ${version}`,
          pub_date: publishedAt.toISOString(),
          url: `${RELEASES}/v${version}/${updateZipName(version)}`,
        },
      },
    ],
  };
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Writes the feed into the make directory, refusing when the ZIP it names was not built. */
export function writeUpdateFeed({ makeDirectory, version, publishedAt }) {
  const zips = filesUnder(makeDirectory).filter((path) => basename(path) === updateZipName(version));
  if (zips.length !== 1) {
    throw new Error(`Expected exactly one ${updateZipName(version)} in ${makeDirectory}, found ${zips.length}.`);
  }
  const path = join(makeDirectory, UPDATE_FEED_FILE);
  writeFileSync(path, `${JSON.stringify(updateFeed(version, publishedAt), null, 2)}\n`);
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const makeDirectory = resolve(process.argv[2] ?? "out/make");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(writeUpdateFeed({ makeDirectory, version, publishedAt: new Date() }));
}
