import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_OUTPUT = "data/google-oauth/google-oauth-desktop-client.json";
const CLIENT_ID_ENV = "GOOGLE_OAUTH_DESKTOP_CLIENT_ID";
const CLIENT_SECRET_ENV = "GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET";

function fail(message) {
  process.stderr.write(`Google OAuth config generation failed: ${message}\n`);
  process.exitCode = 1;
}

function requiredSecret(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

function outputPathFromArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) return resolve(process.cwd(), DEFAULT_OUTPUT);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error("usage is --output <path>");
  }
  return resolve(process.cwd(), args[1]);
}

function writeOwnerOnlyFile(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

try {
  const clientId = requiredSecret(CLIENT_ID_ENV);
  const clientSecret = requiredSecret(CLIENT_SECRET_ENV);
  const outputPath = outputPathFromArgs();
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const config = {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://127.0.0.1"],
    },
  };
  writeOwnerOnlyFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write("Temporary Google OAuth client config created.\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  fail(message);
}
