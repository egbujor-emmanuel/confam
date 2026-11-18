import type { BackupRow, OrderStore } from "./store.ts";
import { SCHEMA } from "./store.ts";

/** The few SQL operations the backup needs from the remote database (Turso via @libsql/client). */
export interface RemoteSql {
  /** Runs statements atomically (all or nothing). */
  batch(statements: { sql: string; args: unknown[] }[]): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<BackupRow[]>;
}

export interface BackupLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Keeps a durable copy of the order database in a remote SQLite-compatible database, so a host
 * restart (free hosts wipe the disk) never loses orders, receipts or the preimages of locked payments.
 *
 * The local database stays the live one: the engine reads and writes it synchronously. Changed rows
 * are pushed every few seconds; on a fresh start the local database is restored from the copy before
 * the engine runs, so locked payments resume exactly where they were.
 */
export class RemoteBackup {
  private lastUpdatedAt = 0;
  /** Orders already pushed whose updated_at equals the watermark (so idle pushes send nothing). */
  private pushedAtWatermark = new Set<string>();
  private lastEventSeq = 0;
  private pushing = false;

  constructor(
    private readonly store: Pick<OrderStore, "isEmpty" | "changedSince" | "importRows">,
    private readonly remote: RemoteSql,
    private readonly log: BackupLog,
  ) {}

  /** Creates the remote tables if needed, then restores them into an empty local database. */
  async init(): Promise<{ restoredOrders: number }> {
    const statements = SCHEMA.split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((sql) => ({ sql, args: [] }));
    await this.remote.batch(statements);
    if (!this.store.isEmpty()) {
      // This disk survived: push everything it has so the copy is complete.
      return { restoredOrders: 0 };
    }
    const orders = await this.remote.query("SELECT * FROM orders");
    const events = await this.remote.query("SELECT * FROM order_events ORDER BY seq ASC");
    this.store.importRows(orders, events);
    this.advance(orders, events);
    if (orders.length > 0) this.log.info(`restored ${orders.length} orders and ${events.length} events from the backup`);
    return { restoredOrders: orders.length };
  }

  /** Pushes rows changed since the last successful push. Safe to call on a timer; never overlaps. */
  async push(): Promise<number> {
    if (this.pushing) return 0;
    this.pushing = true;
    try {
      const changed = this.store.changedSince(this.lastUpdatedAt, this.lastEventSeq);
      const orders = changed.orders.filter((o) => !(Number(o.updated_at) === this.lastUpdatedAt && this.pushedAtWatermark.has(String(o.id))));
      const events = changed.events;
      if (orders.length === 0 && events.length === 0) return 0;
      const statements = [
        ...orders.map((row) => {
          const cols = Object.keys(row);
          return { sql: `INSERT OR REPLACE INTO orders (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => row[c] ?? null) };
        }),
        ...events.map((e) => ({
          sql: "INSERT OR IGNORE INTO order_events (seq, order_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?, ?)",
          args: [e.seq, e.order_id, e.at, e.from_state, e.to_state, e.note].map((v) => v ?? null),
        })),
      ];
      await this.remote.batch(statements);
      // Advance the watermarks only after the remote accepted the rows.
      this.advance(orders, events);
      return orders.length + events.length;
    } catch (err) {
      this.log.warn(`backup push failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.pushing = false;
    }
  }

  private advance(orders: readonly BackupRow[], events: readonly BackupRow[]): void {
    for (const o of orders) {
      const at = Number(o.updated_at ?? 0);
      if (at > this.lastUpdatedAt) {
        this.lastUpdatedAt = at;
        this.pushedAtWatermark = new Set();
      }
      if (at === this.lastUpdatedAt) this.pushedAtWatermark.add(String(o.id));
    }
    for (const e of events) this.lastEventSeq = Math.max(this.lastEventSeq, Number(e.seq ?? 0));
  }

  /** Pushes on an interval; returns a stop function (which also makes a final push). */
  start(intervalMs = 5000): () => Promise<void> {
    const timer = setInterval(() => void this.push(), intervalMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await this.push();
    };
  }
}

/** Adapts @libsql/client (remote Turso database) to RemoteSql. */
export async function tursoRemote(url: string, authToken: string): Promise<RemoteSql> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken });
  return {
    async batch(statements) {
      await client.batch(
        statements.map((s) => ({ sql: s.sql, args: s.args as (string | number | bigint | null | Uint8Array)[] })),
        "write",
      );
    },
    async query(sql, args = []) {
      const rs = await client.execute({ sql, args: args as (string | number | bigint | null | Uint8Array)[] });
      return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, normalize(r[i])])) as BackupRow);
    },
  };
}

/** libSQL returns integers as numbers (or bigint for very large values); node:sqlite takes both. */
function normalize(v: unknown): BackupRow[string] {
  if (v === undefined) return null;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as BackupRow[string];
}
