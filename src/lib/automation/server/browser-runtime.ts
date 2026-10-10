import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type BrowserRuntimeProfileId =
  | "default"
  | "ctbc-login"
  | "cathay-login"
  | "esun-login";

export type BrowserRuntimeIdentity = Readonly<{
  profileId: string;
  profileRevision: number;
  chromiumVersion: string;
}>;

export type BrowserRuntimeConfiguration = Readonly<{
  identity: BrowserRuntimeIdentity;
  userAgent: string;
  args: readonly string[];
  cookieResetDomain: string | null;
}>;

export type BrowserRuntimeDependencies = Readonly<{
  getChromiumVersion?: () => Promise<string>;
  platform?: NodeJS.Platform;
}>;

export type BrowserRuntime = Readonly<{
  resolve(profile?: BrowserRuntimeProfileId): Promise<BrowserRuntimeConfiguration>;
}>;

export type BrowserRuntimeConfigurationErrorCode =
  | "unsupported-profile"
  | "chromium-version-unavailable"
  | "unsupported-platform"
  | "request-header-rewrite-failed";

export class BrowserRuntimeConfigurationError extends Error {
  readonly code: BrowserRuntimeConfigurationErrorCode;

  constructor(code: BrowserRuntimeConfigurationErrorCode) {
    super(`browser-runtime/${code}`);
    this.name = "BrowserRuntimeConfigurationError";
    this.code = code;
  }
}

type ProfileSettings = Readonly<{
  revision: number;
  compatibilityArgs: readonly string[];
  cookieResetDomain: string | null;
}>;

const profileSettings: Readonly<Record<BrowserRuntimeProfileId, ProfileSettings>> = {
  default: {
    revision: 1,
    compatibilityArgs: [],
    cookieResetDomain: null,
  },
  "ctbc-login": {
    revision: 1,
    compatibilityArgs: ["--disable-blink-features=AutomationControlled"],
    cookieResetDomain: "ctbcbank.com",
  },
  "cathay-login": {
    revision: 1,
    compatibilityArgs: [],
    cookieResetDomain: "cathaybk.com.tw",
  },
  "esun-login": {
    revision: 1,
    compatibilityArgs: [],
    cookieResetDomain: "esunbank.com.tw",
  },
};

const CHROMIUM_VERSION_PATTERN = /^\d{2,3}\.\d+\.\d+\.\d+$/u;
const require = createRequire(import.meta.url);
let installedChromiumVersion: Promise<string> | null = null;

async function readPlaywrightChromiumVersion(): Promise<string> {
  const packageJsonPath = require.resolve("playwright-core/package.json");
  const browsersJsonPath = join(dirname(packageJsonPath), "browsers.json");
  const metadata = JSON.parse(await readFile(browsersJsonPath, "utf8")) as {
    browsers?: Array<{ name?: unknown; browserVersion?: unknown }>;
  };
  const version = metadata.browsers?.find((browser) => browser.name === "chromium")?.browserVersion;
  if (typeof version !== "string" || !CHROMIUM_VERSION_PATTERN.test(version)) {
    throw new BrowserRuntimeConfigurationError("chromium-version-unavailable");
  }
  return version;
}

async function bundledChromiumVersion(): Promise<string> {
  if (!installedChromiumVersion) {
    installedChromiumVersion = readPlaywrightChromiumVersion().catch((error: unknown) => {
      installedChromiumVersion = null;
      if (error instanceof BrowserRuntimeConfigurationError) throw error;
      throw new BrowserRuntimeConfigurationError("chromium-version-unavailable");
    });
  }
  return await installedChromiumVersion;
}

function chromePlatformToken(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin": return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32": return "Windows NT 10.0; Win64; x64";
    case "linux": return "X11; Linux x86_64";
    default: throw new BrowserRuntimeConfigurationError("unsupported-platform");
  }
}

export function cookieResetDomainForBrowserProfile(
  profile: BrowserRuntimeProfileId | undefined,
): string | null {
  const profileId = profile ?? "default";
  if (!Object.hasOwn(profileSettings, profileId)) {
    throw new BrowserRuntimeConfigurationError("unsupported-profile");
  }
  return profileSettings[profileId].cookieResetDomain;
}

export function createBrowserRuntime(dependencies: BrowserRuntimeDependencies = {}): BrowserRuntime {
  const getChromiumVersion = dependencies.getChromiumVersion ?? bundledChromiumVersion;
  const platform = dependencies.platform ?? process.platform;

  return {
    async resolve(profile?: BrowserRuntimeProfileId): Promise<BrowserRuntimeConfiguration> {
      const profileId = profile ?? "default";
      if (!Object.hasOwn(profileSettings, profileId)) {
        throw new BrowserRuntimeConfigurationError("unsupported-profile");
      }

      let chromiumVersion: string;
      try {
        chromiumVersion = await getChromiumVersion();
      } catch {
        throw new BrowserRuntimeConfigurationError("chromium-version-unavailable");
      }
      if (!CHROMIUM_VERSION_PATTERN.test(chromiumVersion)) {
        throw new BrowserRuntimeConfigurationError("chromium-version-unavailable");
      }

      const settings = profileSettings[profileId];
      const platformToken = chromePlatformToken(platform);
      return {
        identity: {
          profileId,
          profileRevision: settings.revision,
          chromiumVersion,
        },
        userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`,
        args: [...settings.compatibilityArgs],
        cookieResetDomain: settings.cookieResetDomain,
      };
    },
  };
}

export const browserRuntime = createBrowserRuntime();
