import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RemoteBackup, tursoRemote, type RemoteSql } from "../src/orders/backup.ts";
import { OrderStore, type BackupRow } from "../src/orders/store.ts";
import type { NewOrder } from "../src/orders/types.ts";

/** A real SQLite database standing in for Turso. */
function sqliteRemote(): RemoteSql & { db: DatabaseSync; failNext: boolean } {
  const db = new DatabaseSync(":memory:");
  const r = {
    db,
    failNext: false,
    async batch(statements: { sql: string; args: unknown[] }[]) {
      if (r.failNext) {
        r.failNext = false;
        throw new Error("network down");
      }
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.args as never[]));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async query(sql: string, args: unknown[] = []) {
      return db.prepare(sql).all(...(args as never[])) as BackupRow[];
    },
  };
  return r;
}

const silent = { info: () => {}, warn: () => {} };

const newOrder = (id: string, paymentHash: string, requestId: string): NewOrder =>
  ({
    id,
    category: "airtime",
    provider: "vtpass",
    countryCode: "SN",
    currency: "XOF",
    serviceId: "foreign-airtime",
    operatorId: "216",
    variationCode: "5028",
    productLabel: "1,000 XOF Senegal Orange airtime",
    amountLocal: 1000,
    billersCode: "221771234567",
    phone: "221771234567",
    recipientMasked: "+2217*****567",
    meterType: null,
    customerName: null,
    amountSats: 3128,
    ratePerBtc: 31969309,
    rateSource: "test",
    paymentHash,
    preimage: "aa".repeat(32),
    invoice: "lnbc1",
    invoiceExpiresAt: 2_000_000,
    requestId,
  }) as NewOrder;

describe("RemoteBackup", () => {
  it("copies orders, events and preimages, and restores them into a fresh disk", async () => {
    const remote = sqliteRemote();
    const a = new OrderStore(":memory:");
    const backupA = new RemoteBackup(a, remote, silent);
    expect(await backupA.init()).toEqual({ restoredOrders: 0 });
    a.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    a.transition("o1", "awaiting_payment", "locked", { lockedAt: 1500 }, "payment locked (not sent)", 1500);
    expect(await backupA.push()).toBeGreaterThan(0);

    // The host restarts with an empty disk.
    const b = new OrderStore(":memory:");
    const backupB = new RemoteBackup(b, remote, silent);
    expect(await backupB.init()).toEqual({ restoredOrders: 1 });
    expect(b.get("o1")).toEqual(a.get("o1"));
    expect(b.get("o1")?.preimage).toBe("aa".repeat(32)); // a locked payment can still be settled
    expect(b.events("o1")).toEqual(a.events("o1"));

    // New events after the restore continue the sequence instead of colliding.
    b.transition("o1", "locked", "vending", { vendStartedAt: 2000 }, "buying from provider", 2000);
    expect(b.events("o1").map((e) => e.to)).toEqual(["awaiting_payment", "locked", "vending"]);
  });

  it("pushes only what changed and nothing when idle", async () => {
    const remote = sqliteRemote();
    const a = new OrderStore(":memory:");
    const backup = new RemoteBackup(a, remote, silent);
    await backup.init();
    a.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    expect(await backup.push()).toBe(2); // order + creation event
    expect(await backup.push()).toBe(0); // idle: nothing re-sent
    a.insert(newOrder("o2", "22".repeat(32), "r2"), 3000);
    expect(await backup.push()).toBe(2);
    a.patch("o1", { providerStatus: "x" }, 3000); // same millisecond as o2: still pushed
    expect(await backup.push()).toBe(1);
    expect(await backup.push()).toBe(0);
    expect((remote.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(2);
  });

  it("keeps changes for the next push when the remote is unreachable", async () => {
    const remote = sqliteRemote();
    const a = new OrderStore(":memory:");
    const backup = new RemoteBackup(a, remote, silent);
    await backup.init();
    a.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    remote.failNext = true;
    expect(await backup.push()).toBe(0);
    expect(await backup.push()).toBe(2);
    expect((remote.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(1);
  });

  it("does not overwrite a surviving local disk on start", async () => {
    const remote = sqliteRemote();
    const a = new OrderStore(":memory:");
    a.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    expect(await new RemoteBackup(a, remote, silent).init()).toEqual({ restoredOrders: 0 });
  });
});

describe("OrderStore.importRows", () => {
  it("ignores columns that are not part of the schema", () => {
    const s = new OrderStore(":memory:");
    const src = new OrderStore(":memory:");
    src.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    const { orders } = src.changedSince(0, 0);
    s.importRows(orders.map((o) => ({ ...o, "evil); DROP TABLE orders; --": 1 })), []);
    expect(s.get("o1")?.productLabel).toBe("1,000 XOF Senegal Orange airtime");
  });
});

describe("tursoRemote (the real @libsql/client adapter, against a local libSQL database)", () => {
  it("creates tables, writes in a batch and reads rows back with the same values", async () => {
    const remote = await tursoRemote("file::memory:", "");
    const a = new OrderStore(":memory:");
    const backup = new RemoteBackup(a, remote, silent);
    await backup.init();
    a.insert(newOrder("o1", "11".repeat(32), "r1"), 1000);
    await backup.push();
    const rows = await remote.query("SELECT id, amount_local, amount_sats, preimage FROM orders");
    expect(rows).toEqual([{ id: "o1", amount_local: 1000, amount_sats: 3128, preimage: "aa".repeat(32) }]);
  });
});
