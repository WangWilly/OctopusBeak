import { constants, accessSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

export const CERTIFICATE_FILE_EXTENSIONS = ["pfx", "p12"] as const;

export type CertificateFileValidation =
  | { valid: true; path: string; filename: string }
  | { valid: false; reason: "invalid-extension" | "missing-or-unreadable" };

export function certificateFilename(filePath: string) {
  return basename(filePath.trim());
}

export function validateCertificateFilePath(filePath: string): CertificateFileValidation {
  const normalized = filePath.trim();
  const extension = extname(normalized).slice(1).toLowerCase();
  if (!CERTIFICATE_FILE_EXTENSIONS.includes(extension as "pfx" | "p12")) {
    return { valid: false, reason: "invalid-extension" };
  }
  if (!isAbsolute(normalized)) return { valid: false, reason: "missing-or-unreadable" };
  try {
    const metadata = statSync(normalized);
    accessSync(normalized, constants.R_OK);
    if (!metadata.isFile()) return { valid: false, reason: "missing-or-unreadable" };
  } catch {
    return { valid: false, reason: "missing-or-unreadable" };
  }
  return { valid: true, path: normalized, filename: certificateFilename(normalized) };
}
