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
    extraResource: process.platform === "darwin"
      ? ["build-helpers/apple-system-model-helper"]
      : [],
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.githooks($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.svelte-kit($|\/)/,
      /^\/\.env(?:\..*)?$/,
      /^\/credentials\.json$/,
      /^\/\.libretto($|\/)/,
      /^\/\.superpowers($|\/)/,
      /^\/site($|\/)/,
      /^\/data($|\/)/,
      /^\/docs($|\/)/,
      /^\/downloads($|\/)/,
      /^\/playground($|\/)/,
      /^\/out($|\/)/,
      /^\/build-helpers($|\/)/,
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
