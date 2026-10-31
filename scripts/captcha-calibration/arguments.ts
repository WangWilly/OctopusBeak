import { CALIBRATION_BANKS, isCalibrationBank, type CalibrationBank } from "./banks.ts";

export const DEFAULT_COUNT = 60;
export const MAX_COUNT = 200;
export const DEFAULT_DELAY_MS = 3000;
export const MIN_DELAY_MS = 2000;

export type Command =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "collect"; bank: CalibrationBank; corpus?: string; count: number; delayMs: number; headless: boolean }>
  | Readonly<{ kind: "prelabel"; bank: CalibrationBank; corpus?: string }>
  | Readonly<{ kind: "label"; bank: CalibrationBank; corpus?: string; listen?: string }>
  | Readonly<{ kind: "evaluate"; bank: CalibrationBank; corpus?: string; json: boolean }>;

export type ParsedArguments = Command | Readonly<{ kind: "usage-error"; message: string }>;

export const USAGE = [
  "CAPTCHA calibration (development only; issue #224). The maintainer labels; no agent solves CAPTCHA images.",
  "",
  `  npm run calibrate:captcha -- collect <bank> --allow-live-source [--count N] [--delay-ms D] [--corpus DIR] [--headless]`,
  "  npm run calibrate:captcha -- prelabel <bank> [--corpus DIR]",
  "  npm run calibrate:captcha -- label <bank> [--corpus DIR] [--listen ADDRESS]",
  "  npm run calibrate:captcha -- evaluate <bank> [--corpus DIR] [--json]",
  "",
  `Banks: ${CALIBRATION_BANKS.join(", ")}.`,
  `collect: --count defaults to ${DEFAULT_COUNT} (at most ${MAX_COUNT}); --delay-ms defaults to ${DEFAULT_DELAY_MS} (at least ${MIN_DELAY_MS}).`,
  "label: --listen takes 127.0.0.1 (the default) or this Mac's Tailscale IPv4 address (100.64.0.0/10), to label from a phone on your tailnet.",
  "The corpus defaults to ~/OctopusBeakCalibration/<bank> and must stay outside the repository.",
].join("\n");

type Subcommand = Exclude<Command["kind"], "help">;

const FLAGS: Readonly<Record<Subcommand, Readonly<{ values: readonly string[]; switches: readonly string[] }>>> = {
  collect: { values: ["--count", "--delay-ms", "--corpus"], switches: ["--allow-live-source", "--headless"] },
  prelabel: { values: ["--corpus"], switches: [] },
  label: { values: ["--corpus", "--listen"], switches: [] },
  evaluate: { values: ["--corpus"], switches: ["--json"] },
};

function integer(value: string): number | null {
  return /^\d+$/u.test(value) ? Number(value) : null;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  const error = (message: string) => ({ kind: "usage-error", message }) as const;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const [subcommand, bank, ...rest] = args;
  if (!Object.hasOwn(FLAGS, subcommand!)) return error(`Unknown subcommand: ${subcommand}`);
  const kind = subcommand as Subcommand;
  if (bank === undefined || !isCalibrationBank(bank)) return error(`Unknown bank: ${bank ?? "(missing)"}`);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (FLAGS[kind].switches.includes(flag)) {
      switches.add(flag);
    } else if (FLAGS[kind].values.includes(flag)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return error(`${flag} needs a value.`);
      values.set(flag, value);
      index += 1;
    } else {
      return error(`Unknown option for ${kind}: ${flag}`);
    }
  }
  const corpus = values.get("--corpus");
  const common = { bank, ...(corpus === undefined ? {} : { corpus }) };
  if (kind === "prelabel") return { kind, ...common };
  if (kind === "label") {
    const listen = values.get("--listen");
    if (listen === undefined) return { kind, ...common };
    if (!isLabelListenAddress(listen)) return error("--listen must be 127.0.0.1 or a Tailscale IPv4 address in 100.64.0.0/10.");
    return { kind, ...common, listen };
  }
  if (kind === "evaluate") return { kind, ...common, json: switches.has("--json") };
  if (!switches.has("--allow-live-source")) return error("collect contacts the bank's public login endpoints; pass --allow-live-source.");
  const count = integer(values.get("--count") ?? String(DEFAULT_COUNT));
  if (count === null || count < 1 || count > MAX_COUNT) return error(`--count must be an integer from 1 to ${MAX_COUNT}.`);
  const delayMs = integer(values.get("--delay-ms") ?? String(DEFAULT_DELAY_MS));
  if (delayMs === null || delayMs < MIN_DELAY_MS) return error(`--delay-ms must be an integer of at least ${MIN_DELAY_MS}.`);
  return { kind, ...common, count, delayMs, headless: switches.has("--headless") };
}

/** Loopback, or Tailscale's CGNAT range, so the label page is never offered on a LAN or public interface. */
export function isLabelListenAddress(address: string): boolean {
  if (address === "127.0.0.1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address)?.slice(1).map(Number);
  if (!octets || octets.some((octet) => octet > 255)) return false;
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}
