const { packagedBrowserArtifactIgnore } = require("./scripts/desktop-browser-payload.cjs");

const shouldSign = process.env.OCTOPUSBEAK_SIGN === "1";
const notaryProfile = process.env.OCTOPUSBEAK_NOTARY_PROFILE || "OctopusBeakNotary";
const notaryKeychain = process.env.OCTOPUSBEAK_NOTARY_KEYCHAIN;

module.exports = {
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
      /^\/data($|\/)/,
      packagedBrowserArtifactIgnore,
      /^\/docs($|\/)/,
      /^\/downloads($|\/)/,
      /^\/playground($|\/)/,
      /^\/out($|\/)/,
      /^\/reports($|\/)/,
      /^\/scripts\/tdcc-probe(?:\.mjs$|$|\/)/,
      /^\/scripts\/esun-deposit-probe(?:\.ts$|$|\/)/,
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
        icon: "electron/assets/icon.icns",
        background: "electron/assets/dmg-background.png",
        iconSize: 112,
        contents: ({ appPath }) => [
          { x: 170, y: 220, type: "file", path: appPath },
          { x: 490, y: 220, type: "link", path: "/Applications" },
          { x: 170, y: 640, type: "position", path: ".background" },
          { x: 490, y: 640, type: "position", path: ".VolumeIcon.icns" },
        ],
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
