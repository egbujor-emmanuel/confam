import { afterAll, describe, expect, it } from "vitest";
import { RemoteBackup, tursoRemote, type RemoteSql } from "../../src/orders/backup.ts";
import { OrderStore } from "../../src/orders/store.ts";
import type { NewOrder } from "../../src/orders/types.ts";

/**
 * LIVE: the real Turso database from .env (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN). Writes one probe
 * order, restores it into a fresh store, then deletes it. Skipped when Turso is not configured.
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // no .env: rely on the process environment
}
const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
const id = `probe${Date.now().toString(36)}`;
let remote: RemoteSql | null = null;
const log = { info: () => {}, warn: (m: string) => console.warn(m) };

afterAll(async () => {
  await remote?.batch([
    { sql: "DELETE FROM order_events WHERE order_id = ?", args: [id] },
    { sql: "DELETE FROM orders WHERE id = ?", args: [id] },
  ]);
});

describe.skipIf(!url || !token)("Turso backup (live)", () => {
  it("creates the tables, pushes an order with its preimage, and restores it into a fresh disk", async () => {
    remote = await tursoRemote(url as string, token as string);
    const a = new OrderStore(":memory:");
    const backup = new RemoteBackup(a, remote, log);
    await backup.init();
    a.insert(
      {
        id, category: "airtime", provider: "vtpass", countryCode: "SN", currency: "XOF", serviceId: "foreign-airtime", operatorId: "216",
        variationCode: "5028", productLabel: "LIVE PROBE", amountLocal: 1000, billersCode: null, phone: null, recipientMasked: "x",
        meterType: null, customerName: null, amountSats: 1, ratePerBtc: 1, rateSource: "probe", paymentHash: id.padEnd(64, "0"),
        preimage: "ab".repeat(32), invoice: "lnbc", invoiceExpiresAt: 1, requestId: id,
      } as NewOrder,
      Date.now(),
    );
    const started = Date.now();
    expect(await backup.push()).toBe(2);
    console.info(`[turso] push took ${Date.now() - started} ms`);
    expect(await remote.query("SELECT id, product_label, preimage FROM orders WHERE id = ?", [id])).toEqual([
      { id, product_label: "LIVE PROBE", preimage: "ab".repeat(32) },
    ]);

    // A fresh disk restores everything currently in the copy (including this probe).
    const b = new OrderStore(":memory:");
    const restored = await new RemoteBackup(b, remote, log).init();
    expect(restored.restoredOrders).toBeGreaterThanOrEqual(1);
    expect(b.get(id)?.preimage).toBe("ab".repeat(32));
    expect(b.events(id).map((e) => e.to)).toEqual(["awaiting_payment"]);
  }, 60_000);
});
