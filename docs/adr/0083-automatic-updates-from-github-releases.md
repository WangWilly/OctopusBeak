# Automatic updates from GitHub Releases

Status: accepted

Amends the Local-only privacy positioning in [`PRODUCT.md`](../../PRODUCT.md) a third time, and settles the "Count requests to an update feed" option that [ADR 0078](0078-opt-in-anonymous-daily-usage-ping.md) deferred.

The App has no update check. A person learns about a new version only from the website or GitHub, and most never look. Bank sites change their pages without notice, and the fix for a broken source ships only as a new release, so an App that stays on an old version keeps failing after the fix exists.

**A released build checks GitHub for a newer release, downloads it in the background, and installs it when the person restarts or quits the App. It is on by default.**

- **Where the request goes.** The App reads `https://github.com/WangWilly/OctopusBeak/releases/latest/download/update-feed-darwin-arm64.json` and, when it names another version, downloads that release's ZIP from GitHub. Both requests go to GitHub, never to a host we operate. GitHub sees the connecting address and that this Mac runs OctopusBeak, as it does for any download. The request carries no data, no identifier, and no count, and nothing records it for us: update requests are never counted, and nothing about them reaches the usage statistics receiver.
- **Electron's built-in updater.** The main process uses Electron's `autoUpdater` (Squirrel.Mac) with a JSON feed. Squirrel.Mac checks that the downloaded app is signed by the same Developer ID as the running one before it installs anything.
- **The feed moves only forward.** The release workflow writes the feed for every release and uploads it with the installers; `releases/latest` resolves only to the newest published release that is not a prerelease, so a draft or a prerelease is never offered. Squirrel.Mac treats any version other than the running one as an update, so the feed names only the latest release. A release cannot be withdrawn by publishing an older one: a version that has migrated the ledger schema cannot be opened by an older App, so a fix ships as a new version.
- **When it checks.** Once the automation runtime is ready after launch, then every 6 hours, and when the person turns the switch on or selects Check now. Development builds and test fixtures never check.
- **Restart waits for runs.** A downloaded update installs when the App quits. The App never restarts by itself: it shows one notification ("新版 X 已下載，重新啟動即可更新"), and Settings offers Restart to update. That button is disabled, and the request refused, while a run is active, because restarting would stop a sign-in the person may be in the middle of, or a collection that would then have to start over. Quitting the App normally also installs the update; quitting already stops active runs through the usual shutdown, so the ledger closes before the new version replaces the app.
- **Settings.** An Automatic updates section shows the current version, what the updater is doing, the switch, and Check now. Turning the switch off stops checking. An update already downloaded still installs at the next quit, because Squirrel.Mac has already staged it, and Settings says so.
- **Where it cannot update.** Squirrel.Mac cannot replace an app running from a read-only volume, which includes an app opened straight from the DMG or from Downloads under App Translocation. Settings then asks the person to move OctopusBeak to Applications. Other failures are silent: they are logged as a code without the error message, and the next check tries again.

## Considered options

- **update.electronjs.org.** Rejected. It is a free service run by a third party that sits between the App and GitHub and sees every check. A static feed file in the release gives the same result with no service in between.
- **A third-party updater or SDK** (electron-updater, Sparkle). Rejected. electron-updater adds a dependency and its own metadata format for what Electron already does on macOS; Sparkle needs a native framework and a separate signing key.
- **Notify only, and link to the download.** Rejected. A person still has to download about 430 MB, open the DMG, and replace the app by hand; most would not, and the fix for a broken source would still not reach them.
- **Off by default, like usage statistics.** Rejected. Usage statistics serve us; an update serves the person, and an App that cannot follow bank-site changes stops working. The request carries nothing about the person, and the switch is in Settings.
- **Restart automatically when idle.** Rejected. A person may be about to start a sync, and an App that restarts by itself looks broken.
- **Count requests to the feed.** Rejected. ADR 0078 counts consenting users; counting update checks would count everyone without asking.
- **Delta updates.** Not available: Squirrel.Mac downloads the whole ZIP.

## Consequences

- `PRODUCT.md`, `README.md`, and `README.en.md` name automatic updates as a request the App makes to GitHub, alongside usage statistics and Error reports.
- Every release must carry `update-feed-darwin-arm64.json`, listed in `SHA256SUMS.txt`, and the ZIP it names. A release without the feed leaves every installed App on its current version; a feed that names a missing ZIP makes every check fail until the next release.
- The ZIP is about 430 MB, and each update downloads all of it.
- A person who never quits the App keeps the old version until they restart or quit.
