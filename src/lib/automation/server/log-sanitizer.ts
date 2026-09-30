import { stripVTControlCharacters } from "node:util";

export const MAX_AUTOMATION_LOG_LINES = 200;
export const MAX_AUTOMATION_LOG_BYTES = 64 * 1024;

const SECRET_FIELD_PATTERN = /((?:password|passwd|token|secret|authorization|cookie|otp|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi;

/** Remove terminal controls and obvious secret-bearing field values. */
export function sanitizeAutomationLogChunk(value: string) {
  return stripVTControlCharacters(value).replace(
    SECRET_FIELD_PATTERN,
    "$1[REDACTED]",
  );
}

/** Return the bounded, renderer/database-safe tail used by every boundary. */
export function sanitizeAutomationLogTail(value: string) {
  const lines = sanitizeAutomationLogChunk(value)
    .split(/\r?\n/)
    .slice(-MAX_AUTOMATION_LOG_LINES);
  let output = lines.join("\n");
  while (Buffer.byteLength(output, "utf8") > MAX_AUTOMATION_LOG_BYTES) {
    const firstBreak = output.indexOf("\n");
    if (firstBreak < 0) {
      output = output.slice(-MAX_AUTOMATION_LOG_BYTES);
      break;
    }
    output = output.slice(firstBreak + 1);
  }
  return output;
}
