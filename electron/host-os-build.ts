import { execFileSync } from "node:child_process";

export type HostOsBuildExec = () => string | Buffer;

export function readHostOsBuild(
  exec: HostOsBuildExec = () => execFileSync(
    "/usr/bin/sw_vers",
    ["-buildVersion"],
    { encoding: "utf8" },
  ),
): string {
  try {
    const output = exec();
    const value = typeof output === "string" ? output : output.toString("utf8");
    return value.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
