# Download statistics

Status: Current

The `Download Stats` workflow (`.github/workflows/download-stats.yml`) runs once a day and can be started by hand. It reads every published GitHub Release through the API and records the cumulative download count of each installer (`.dmg` and `.zip`) with `scripts/download-stats.mjs`. `SHA256SUMS.txt` and Draft Releases are left out.

The results live on the `download-stats` branch, which shares no history with `main`:

- `history.csv` holds one row per snapshot date, release tag, and installer: `date,tag,asset,downloads`. A second run on the same UTC date replaces that date's rows.
- `README.md` shows the latest totals, the downloads through the website button, a table per release, and the new downloads between consecutive snapshots.

The website buttons link to `releases/latest/download/OctopusBeak-arm64.dmg` (see [Desktop Release](../desktop-release.md)), so the `OctopusBeak-arm64.dmg` counts are downloads through the website. The versioned DMG and the ZIP are mostly downloaded from the Release page.

GitHub keeps only the cumulative count of each asset, so growth before the first snapshot cannot be split by day. The counts include repeat downloads, crawlers, and scripts; they are not unique people and not installs. Deleting a release or asset removes its counts, and the next growth row shows a negative number.

To run the snapshot locally:

```bash
GITHUB_REPOSITORY=WangWilly/OctopusBeak GITHUB_TOKEN=<token> node scripts/download-stats.mjs download-stats
```
