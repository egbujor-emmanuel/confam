import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = {
  MERCHANT_NWC_URL: "nostr+walletconnect://abc?relay=wss://r.example&secret=00",
  NOSTR_SECRET_KEY_HEX: "11".repeat(32),
};

describe("loadConfig", () => {
  it("treats empty .env values as unset (fresh setup boots)", () => {
    const cfg = loadConfig({ ...base, LND_REST_URL: "", LND_INVOICE_MACAROON_HEX: "", VTPASS_API_KEY: "", VTPASS_PUBLIC_KEY: " " });
    expect(cfg.LND_REST_URL).toBeUndefined();
    expect(cfg.vtpassConfigured).toBe(false);
    expect(cfg.vtpassIsSandbox).toBe(true);
  });

  it("requires the merchant wallet for the nwc backend and LND creds for the lnd backend", () => {
    expect(() => loadConfig({ NOSTR_SECRET_KEY_HEX: base.NOSTR_SECRET_KEY_HEX })).toThrow(/MERCHANT_NWC_URL/);
    expect(() => loadConfig({ ...base, LN_BACKEND: "lnd" })).toThrow(/LND_REST_URL/);
  });

  it("rejects a malformed signing key", () => {
    expect(() => loadConfig({ ...base, NOSTR_SECRET_KEY_HEX: "xyz" })).toThrow(/NOSTR_SECRET_KEY_HEX/);
  });

  it("detects live vs sandbox VTpass and parses booleans", () => {
    const cfg = loadConfig({ ...base, VTPASS_BASE_URL: "https://vtpass.com", TEST_WALLET_FAUCET: "false" });
    expect(cfg.vtpassIsSandbox).toBe(false);
    expect(cfg.TEST_WALLET_FAUCET).toBe(false);
  });
});
