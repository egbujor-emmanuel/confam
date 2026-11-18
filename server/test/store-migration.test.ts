import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrderStore } from "../src/orders/store.ts";

/** The exact schema shipped in the first commit (66c35ce), before multi-country support. */
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  category TEXT NOT NULL,
  service_id TEXT NOT NULL,
  variation_code TEXT,
  product_label TEXT NOT NULL,
  billers_code TEXT,
  phone TEXT,
  recipient_masked TEXT NOT NULL,
  meter_type TEXT,
  customer_name TEXT,
  amount_ngn INTEGER NOT NULL,
  amount_sats INTEGER NOT NULL,
  rate_ngn_per_btc REAL NOT NULL,
  rate_source TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  preimage TEXT NOT NULL,
  invoice TEXT NOT NULL,
  invoice_expires_at INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  locked_at INTEGER,
  vend_started_at INTEGER,
  last_requery_at INTEGER,
  delivered_at INTEGER,
  completed_at INTEGER,
  released_at INTEGER,
  release_reason TEXT,
  provider_code TEXT,
  provider_status TEXT,
  provider_tx_id TEXT,
  token TEXT,
  units TEXT,
  failure_detail TEXT,
  receipt_json TEXT,
  recon_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS idx_orders_recon ON orders(recon_state);
CREATE TABLE IF NOT EXISTS order_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  at INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("OrderStore migration", () => {
  it("upgrades a v1 (Nigeria-only) database in place and keeps its orders readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "confam-mig-"));
    dirs.push(dir);
    const path = join(dir, "v1.db");
    const v1 = new DatabaseSync(path);
    v1.exec(V1_SCHEMA);
    v1.prepare(
      `INSERT INTO orders (id, created_at, updated_at, state, category, service_id, product_label, recipient_masked,
        amount_ngn, amount_sats, rate_ngn_per_btc, rate_source, payment_hash, preimage, invoice, invoice_expires_at, request_id)
       VALUES ('old1', 1, 1, 'completed', 'airtime', 'mtn', 'N500 MTN', '0801****111', 500, 333, 150000000, 'test', 'ph', 'pre', 'lnbc', 2, 'rid1')`,
    ).run();
    v1.close();

    const store = new OrderStore(path);
    const old = store.get("old1");
    expect(old).toMatchObject({ provider: "vtpass", countryCode: "NG", currency: "NGN", amountLocal: 500, ratePerBtc: 150000000, operatorId: null, providerRef: null });
    store.close();

    // Opening an already-migrated database is a no-op.
    const again = new OrderStore(path);
    expect(again.get("old1")?.amountLocal).toBe(500);
    again.close();
  });
});
