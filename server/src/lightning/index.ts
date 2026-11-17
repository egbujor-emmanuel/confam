import type { Config } from "../config.ts";
import { LndHoldInvoiceProvider } from "./lnd.ts";
import { NwcHoldInvoiceProvider } from "./nwc.ts";
import type { HoldInvoiceProvider } from "./types.ts";

export function createHoldInvoiceProvider(cfg: Config): HoldInvoiceProvider {
  if (cfg.LN_BACKEND === "lnd") {
    // loadConfig guarantees both values are present for the lnd backend.
    return new LndHoldInvoiceProvider(cfg.LND_REST_URL as string, cfg.LND_INVOICE_MACAROON_HEX as string);
  }
  return new NwcHoldInvoiceProvider(cfg.MERCHANT_NWC_URL as string);
}

export * from "./types.ts";
export * from "./crypto.ts";
