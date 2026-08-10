import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCertificateFilePath } from "./credential-file.ts";

test("certificate files must be readable absolute .pfx or .p12 files", () => {
  const directory = mkdtempSync(join(tmpdir(), "certificate-file-"));
  try {
    const pfxPath = join(directory, "certificate.pfx");
    const p12Path = join(directory, "certificate.P12");
    const textPath = join(directory, "certificate.txt");
    writeFileSync(pfxPath, "pfx");
    writeFileSync(p12Path, "p12");
    writeFileSync(textPath, "text");

    assert.deepEqual(validateCertificateFilePath(pfxPath), {
      valid: true,
      path: pfxPath,
      filename: "certificate.pfx",
    });
    assert.equal(validateCertificateFilePath(p12Path).valid, true);
    assert.deepEqual(validateCertificateFilePath(textPath), {
      valid: false,
      reason: "invalid-extension",
    });
    assert.deepEqual(validateCertificateFilePath(join(directory, "missing.pfx")), {
      valid: false,
      reason: "missing-or-unreadable",
    });
    assert.deepEqual(validateCertificateFilePath("relative.pfx"), {
      valid: false,
      reason: "invalid-extension",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
