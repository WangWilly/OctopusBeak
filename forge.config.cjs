const { existsSync, statSync } = require("node:fs");
const { join } = require("node:path");

const shouldSign = process.env.OCTOPUSBEAK_SIGN === "1";
const notaryProfile = process.env.OCTOPUSBEAK_NOTARY_PROFILE || "OctopusBeakNotary";
const notaryKeychain = process.env.OCTOPUSBEAK_NOTARY_KEYCHAIN;
const desktopOAuthConfigRelativePath = "data/google-oauth/google-oauth-desktop-client.json";
const desktopOAuthConfigPath = join(__dirname, desktopOAuthConfigRelativePath);

function assertDesktopOAuthConfig() {
  if (!existsSync(desktopOAuthConfigPath) || !statSync(desktopOAuthConfigPath).isFile()) {
    throw new Error(`Desktop Google OAuth client config is required for packaging: ${desktopOAuthConfigRelativePath}`);
  }
}

module.exports = {
  hooks: {
    prePackage: () => {
      assertDesktopOAuthConfig();
    },
  },
  packagerConfig: {
    name: "OctopusBeak",
    executableName: "OctopusBeak",
    appBundleId: "app.octopusbeak.desktop",
    appCategoryType: "public.app-category.finance",
    icon: "electron/assets/icon",
    asar: false,
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.githooks($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.svelte-kit($|\/)/,
      /^\/\.env(?:\..*)?$/,
      /^\/\.libretto($|\/)/,
      /^\/\.superpowers($|\/)/,
      /^\/site($|\/)/,
      /^\/data\/(?!google-oauth(?:$|\/))/,
      /^\/data\/google-oauth\/(?!google-oauth-desktop-client\.json$)/,
      /^\/docs($|\/)/,
      /^\/downloads($|\/)/,
      /^\/playground($|\/)/,
      /^\/out($|\/)/,
    ],
    ...(shouldSign
      ? {
          osxSign: {},
          osxNotarize: {
            keychainProfile: notaryProfile,
            ...(notaryKeychain ? { keychain: notaryKeychain } : {}),
          },
        }
      : {}),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
