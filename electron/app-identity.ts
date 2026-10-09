import path from "node:path";
import type { App } from "electron";

/**
 * Every OctopusBeak process must use this name and userData folder to reach
 * the same safeStorage key and credentials.json. Returns the userData path.
 */
export function applyOctopusBeakAppIdentity(app: App) {
  app.setName("OctopusBeak");
  app.setPath("userData", process.env.OCTOPUSBEAK_USER_DATA || path.join(app.getPath("appData"), "OctopusBeak"));
  return app.getPath("userData");
}
