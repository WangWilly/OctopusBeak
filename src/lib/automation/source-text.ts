/** Source decoding is strict: a malformed byte must not become financial evidence. */
export interface SourceTextPort {
  decode(bytes: Uint8Array, charset: string): string;
  stream(charset: string): SourceTextStream;
  assertIntact(text: string): void;
}

export interface SourceTextStream {
  push(bytes: Uint8Array): string;
  finish(): string;
}

export class SourceTextIntegrityError extends Error {
  constructor(reason: "invalid-encoding" | "replacement-character") {
    super(`Source text integrity failed: ${reason}`);
    this.name = "SourceTextIntegrityError";
  }
}

function decoder(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset, { fatal: true });
  } catch {
    throw new SourceTextIntegrityError("invalid-encoding");
  }
}

function decodeWith(decoder: TextDecoder, bytes?: Uint8Array, stream = false): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new SourceTextIntegrityError("invalid-encoding");
  }
}

function assertIntact(text: string): void {
  if (text.includes("\uFFFD")) {
    throw new SourceTextIntegrityError("replacement-character");
  }
}

export const strictSourceText: SourceTextPort = {
  assertIntact,
  decode(bytes, charset) {
    const text = decodeWith(decoder(charset), bytes);
    assertIntact(text);
    return text;
  },
  stream(charset) {
    const textDecoder = decoder(charset);
    let finished = false;
    return {
      push(bytes) {
        if (finished) throw new Error("Source text stream is finished.");
        const text = decodeWith(textDecoder, bytes, true);
        strictSourceText.assertIntact(text);
        return text;
      },
      finish() {
        if (finished) throw new Error("Source text stream is finished.");
        finished = true;
        const text = decodeWith(textDecoder);
        strictSourceText.assertIntact(text);
        return text;
      },
    };
  },
};

/**
 * Collapse every whitespace run in provider text to one space and trim. `\s`
 * and `trim()` already cover U+00A0 and U+3000, so callers need no extra replace.
 */
export function collapseSourceWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Turn U+00A0 and U+3000 into spaces and trim, keeping interior whitespace,
 * because the result is the provider lexeme stored as evidence.
 */
export function trimSourceLexeme(value: unknown): string {
  return String(value ?? "").replace(/[\u00a0\u3000]/gu, " ").trim();
}
