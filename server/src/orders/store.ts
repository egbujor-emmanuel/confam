import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { NewOrder, Order, OrderEvent, OrderState } from "./types.ts";

const COLUMNS: Record<keyof Order, string> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
  state: "state",
  category: "category",
  provider: "provider",
  countryCode: "country_code",
  currency: "currency",
  serviceId: "service_id",
  operatorId: "operator_id",
  variationCode: "variation_code",
  productLabel: "product_label",
  billersCode: "billers_code",
  phone: "phone",
  recipientMasked: "recipient_masked",
  meterType: "meter_type",
  customerName: "customer_name",
  amountLocal: "amount_local",
  amountSats: "amount_sats",
  ratePerBtc: "rate_per_btc",
  rateSource: "rate_source",
  paymentHash: "payment_hash",
  preimage: "preimage",
  invoice: "invoice",
  invoiceExpiresAt: "invoice_expires_at",
  requestId: "request_id",
  lockedAt: "locked_at",
  vendStartedAt: "vend_started_at",
  lastRequeryAt: "last_requery_at",
  deliveredAt: "delivered_at",
  completedAt: "completed_at",
  releasedAt: "released_at",
  releaseReason: "release_reason",
  providerCode: "provider_code",
  providerStatus: "provider_status",
  providerRef: "provider_ref",
  providerTxId: "provider_tx_id",
  token: "token",
  units: "units",
  failureDetail: "failure_detail",
  receiptJson: "receipt_json",
  reconState: "recon_state",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  service_id TEXT NOT NULL,
  operator_id TEXT,
  variation_code TEXT,
  product_label TEXT NOT NULL,
  billers_code TEXT,
  phone TEXT,
  recipient_masked TEXT NOT NULL,
  meter_type TEXT,
  customer_name TEXT,
  amount_local REAL NOT NULL,
  amount_sats INTEGER NOT NULL,
  rate_per_btc REAL NOT NULL,
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
  provider_ref TEXT,
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

type Row = Record<string, SQLInputValue>;
export type OrderPatch = Partial<Omit<Order, "id" | "state" | "createdAt">>;

export class OrderStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  insert(order: NewOrder, now: number): Order {
    const full: Order = {
      ...order,
      createdAt: now,
      updatedAt: now,
      state: "awaiting_payment",
      lockedAt: null,
      vendStartedAt: null,
      lastRequeryAt: null,
      deliveredAt: null,
      completedAt: null,
      releasedAt: null,
      releaseReason: null,
      providerCode: null,
      providerStatus: null,
      providerRef: null,
      providerTxId: null,
      token: null,
      units: null,
      failureDetail: null,
      receiptJson: null,
      reconState: null,
    };
    const keys = Object.keys(COLUMNS) as (keyof Order)[];
    const sql = `INSERT INTO orders (${keys.map((k) => COLUMNS[k]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    this.tx(() => {
      this.db.prepare(sql).run(...keys.map((k) => toSql(full[k])));
      this.addEvent({ orderId: full.id, at: now, from: null, to: "awaiting_payment", note: "hold invoice issued" });
    });
    return full;
  }

  get(id: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  getByPaymentHash(hash: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE payment_hash = ?").get(hash) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  listByStates(states: readonly OrderState[]): Order[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at ASC`)
      .all(...states) as Row[];
    return rows.map(fromRow);
  }

  listWatchingRecon(): Order[] {
    return (this.db.prepare("SELECT * FROM orders WHERE recon_state = 'watching'").all() as Row[]).map(fromRow);
  }

  /**
   * Atomic compare-and-set: moves `id` from `from` to `to` only if it is still in `from`.
   * Returns the updated order, or null if another worker already moved it.
   */
  transition(id: string, from: OrderState, to: OrderState, patch: OrderPatch, note: string, now: number): Order | null {
    const fields: OrderPatch = { ...patch, updatedAt: now };
    const keys = Object.keys(fields) as (keyof OrderPatch)[];
    const sets = ["state = ?", ...keys.map((k) => `${COLUMNS[k]} = ?`)].join(", ");
    let changed = 0;
    this.tx(() => {
      const res = this.db
        .prepare(`UPDATE orders SET ${sets} WHERE id = ? AND state = ?`)
        .run(to, ...keys.map((k) => toSql(fields[k])), id, from);
      changed = Number(res.changes);
      if (changed === 1) this.addEvent({ orderId: id, at: now, from, to, note });
    });
    return changed === 1 ? this.get(id) : null;
  }

  /** Non-state field updates (e.g. last requery time, reconciliation result). */
  patch(id: string, patch: OrderPatch, now: number): void {
    const fields: OrderPatch = { ...patch, updatedAt: now };
    const keys = Object.keys(fields) as (keyof OrderPatch)[];
    this.db
      .prepare(`UPDATE orders SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => toSql(fields[k])), id);
  }

  events(orderId: string): OrderEvent[] {
    const rows = this.db
      .prepare("SELECT order_id, at, from_state, to_state, note FROM order_events WHERE order_id = ? ORDER BY seq ASC")
      .all(orderId) as Row[];
    return rows.map((r) => ({
      orderId: String(r.order_id),
      at: Number(r.at),
      from: (r.from_state as OrderState | null) ?? null,
      to: r.to_state as OrderState,
      note: String(r.note),
    }));
  }

  close(): void {
    this.db.close();
  }

  private addEvent(e: OrderEvent): void {
    this.db
      .prepare("INSERT INTO order_events (order_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)")
      .run(e.orderId, e.at, e.from, e.to, e.note);
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
}

function fromRow(row: Row): Order {
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(COLUMNS)) out[key] = row[col] ?? null;
  return out as unknown as Order;
}
