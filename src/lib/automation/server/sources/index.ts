import { FUBON_SOURCE } from "./fubon.ts";
import { ESUN_SOURCE } from "./esun.ts";
import { YUANTA_SOURCE } from "./yuanta.ts";
import { YUANTA_TRADE_SOURCE } from "./yuanta-trade.ts";
import { CATHAY_SOURCE } from "./cathay.ts";
import { HNCB_SOURCE } from "./hncb.ts";
import { CTBC_SOURCE } from "./ctbc.ts";
import { POST_SOURCE } from "./post.ts";
import { SINOPAC_SOURCE } from "./sinopac.ts";
import { LINEBANK_SOURCE } from "./linebank.ts";
import { EINVOICE_SOURCE } from "./einvoice.ts";
import { MAICOIN_SOURCE } from "./maicoin.ts";
import { TDCC_SOURCE } from "./tdcc.ts";
import type { StatementSelectionGroup } from "../../statement-selection.ts";
import type { VerifiedSource } from "./verified-source.ts";

/** ADR 0057: every Verified source, in the order the App lists them. */
export const VERIFIED_SOURCES: readonly VerifiedSource[] = [
  FUBON_SOURCE,
  ESUN_SOURCE,
  YUANTA_SOURCE,
  YUANTA_TRADE_SOURCE,
  CATHAY_SOURCE,
  HNCB_SOURCE,
  CTBC_SOURCE,
  POST_SOURCE,
  SINOPAC_SOURCE,
  LINEBANK_SOURCE,
  EINVOICE_SOURCE,
  MAICOIN_SOURCE,
  TDCC_SOURCE,
];

export function verifiedSourceById(id: string): VerifiedSource | undefined {
  return VERIFIED_SOURCES.find((source) => source.id === id);
}

/** The Statement Selection a source offers, as its credential group carries it. */
export function statementSelectionGroup(source: VerifiedSource): StatementSelectionGroup | undefined {
  return source.statementSelection && {
    id: source.id,
    label: source.label,
    enabledKey: source.enabledKey,
    statementSelectionKey: source.statementSelection.key,
    statementTypes: source.statementSelection.products.map(({ id }) => ({ id })),
  };
}
