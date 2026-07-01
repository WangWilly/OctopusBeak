const shouldSign = process.env.OCTOPUSBEAK_SIGN === "1";
const notaryProfile = process.env.OCTOPUSBEAK_NOTARY_PROFILE || "OctopusBeakNotary";

module.exports = {
  packagerConfig: {
    name: "OctopusBeak",
    executableName: "OctopusBeak",
    appBundleId: "app.octopusbeak.desktop",
    appCategoryType: "public.app-category.finance",
    asar: false,
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.svelte-kit($|\/)/,
      /^\/\.env$/,
      /^\/data($|\/)/,
      /^\/downloads($|\/)/,
      /^\/docs\/specs($|\/)/,
      /^\/docs\/superpowers($|\/)/,
      /^\/out($|\/)/,
    ],
    ...(shouldSign
      ? {
          osxSign: {},
          osxNotarize: {
            keychainProfile: notaryProfile,
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
