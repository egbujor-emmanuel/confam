import { NWCClient } from "@getalby/sdk/nwc";
import { afterAll, describe, expect, it } from "vitest";
import { NwcHoldInvoiceProvider } from "../../src/lightning/nwc.ts";
import { newPreimagePair } from "../../src/lightning/crypto.ts";
import { OrderEngine } from "../../src/orders/engine.ts";
import { OrderStore } from "../../src/orders/store.ts";
import { ReceiptSigner } from "../../src/receipts/sign.ts";
import { DELIVERED, FAILED, FakeVtpass, silentLog } from "../fakes.ts";

/**
 * LIVE: real hold invoices on real NWC wallets (faucet.nwc.dev test wallets), driven by the real
 * OrderEngine. VTpass outcomes are scripted here; the VTpass sandbox has its own live test.
 */
const faucet = async (sats: number): Promise<string> => {
  const res = await fetch(`https://faucet.nwc.dev?balance=${sats}`, { method: "POST" });
  const url = (await res.text()).trim();
  if (!url.startsWith("nostr+walletconnect://")) throw new Error(`faucet failed: ${url.slice(0, 80)}`);
  return url;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toClose: { close(): void }[] = [];
afterAll(() => toClose.forEach((c) => c.close()));

async function runScenario(vtpassResponse: unknown) {
  const merchant = new NwcHoldInvoiceProvider(await faucet(10_000));
  const payer = new NWCClient({ nostrWalletConnectUrl: await faucet(10_000) });
  toClose.push(merchant, payer);

  const store = new OrderStore(":memory:");
  const vt = new FakeVtpass([vtpassResponse]);
  const engine = new OrderEngine({
    store,
    ln: merchant,
    vtpass: vt,
    signer: new ReceiptSigner("22".repeat(32)),
    log: silentLog,
    cfg: { vendDeadlineSec: 60, tickMs: 1000 },
  });

  const sats = 21;
  const { preimageHex, paymentHashHex } = newPreimagePair();
  const { invoice } = await merchant.createHoldInvoice({ amountSats: sats, paymentHashHex, memo: "Confam live test", expirySec: 600 });
  const order = store.insert(
    {
      id: "liveorder0000000000000",
      category: "airtime",
      serviceId: "mtn",
      variationCode: null,
      productLabel: "₦50 MTN Airtime VTU",
      billersCode: null,
      phone: "08011111111",
      recipientMasked: "0801****111",
      meterType: null,
      customerName: null,
      amountNgn: 50,
      amountSats: sats,
      rateNgnPerBtc: 150_000_000,
      rateSource: "test",
      paymentHash: paymentHashHex,
      preimage: preimageHex,
      invoice,
      invoiceExpiresAt: Date.now() + 600_000,
      requestId: "202611172100livetest",
    },
    Date.now(),
  );

  const before = (await payer.getBalance()).balance;
  const payment = payer
    .payInvoice({ invoice })
    .then((r) => ({ ok: true as const, preimage: r.preimage }))
    .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

  await engine.start();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const s = store.get(order.id)?.state;
    if (s === "completed" || s === "released") break;
  }
  engine.stop();
  const result = await payment;
  await sleep(1500);
  const after = (await payer.getBalance()).balance;
  return { store, order, vt, result, before, after, sats, preimageHex };
}

describe("LIVE: hold invoices on real NWC wallets through the order engine", () => {
  it("delivered -> settles: payer is charged exactly the invoice amount and gets the preimage", async () => {
    const r = await runScenario(DELIVERED);
    const final = r.store.get(r.order.id)!;
    expect(final.state).toBe("completed");
    expect(r.vt.payCalls).toHaveLength(1);
    expect(r.result).toMatchObject({ ok: true, preimage: r.preimageHex });
    expect(r.before - r.after).toBeGreaterThanOrEqual(r.sats * 1000);
    expect(r.before - r.after).toBeLessThanOrEqual(r.sats * 1000 + 10_000); // invoice + at most a small routing fee
  });

  it("failed -> cancels: the payer's balance returns exactly to where it started", async () => {
    const r = await runScenario(FAILED);
    const final = r.store.get(r.order.id)!;
    expect(final.state).toBe("released");
    expect(final.releaseReason).toBe("delivery_failed");
    expect(r.result.ok).toBe(false);
    expect(r.after).toBe(r.before);
  });
});
