import { createInterface } from "node:readline/promises";

export type ProbeTerminal = Readonly<{
  print(line: string): void;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}>;

export function createProbeTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): ProbeTerminal {
  return {
    print(line) {
      output.write(`${line}\n`);
    },
    async ask(question) {
      const lines = createInterface({ input, output, terminal: input.isTTY });
      try {
        return (await lines.question(question)).trim();
      } finally {
        lines.close();
      }
    },
    askHidden(question) {
      if (!input.isTTY) throw new Error("Hidden input needs an interactive terminal.");
      output.write(question);
      input.setRawMode(true);
      input.setEncoding("utf8");
      input.resume();
      return new Promise((resolve, reject) => {
        let value = "";
        const finish = (error?: Error) => {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          output.write("\n");
          if (error) reject(error);
          else resolve(value);
        };
        const onData = (chunk: string) => {
          for (const character of chunk) {
            if (character === "\r" || character === "\n") return finish();
            if (character === "\u0003") return finish(new Error("Cancelled."));
            if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
            else value += character;
          }
        };
        input.on("data", onData);
      });
    },
  };
}
