type NavigatorPlatformInfo = {
  platform: string;
  userAgentData?: { platform?: string };
};

export function isMacPlatform(info: NavigatorPlatformInfo) {
  const platform = info.userAgentData?.platform || info.platform;
  return platform.toLowerCase().startsWith("mac");
}
