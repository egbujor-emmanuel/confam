/**
 * Decides what a VTpass response means for the money.
 *
 *   delivered -> settle the hold invoice (the customer pays)
 *   failed    -> cancel the hold invoice (the customer's sats are released, never charged)
 *   pending   -> keep the lock, requery; if still unknown at the deadline, release the lock
 *
 * Rules from https://vtpass.com/documentation/response-codes/ :
 *  - "000" means processed: the real outcome is content.transactions.status (initiated | pending | delivered).
 *  - "Take any response that differs from the guidelines... as pending, and initiate a transaction requery."
 *  - "If transaction times out or response is not received, please treat as pending."
 */
export type VendOutcome = "delivered" | "failed" | "pending";

export interface Classification {
  outcome: VendOutcome;
  code: string | null;
  status: string | null;
  reason: string;
}

/** Codes that definitively mean "not processed / not charged". */
const FAILED_CODES: Record<string, string> = {
  "016": "transaction failed",
  "091": "transaction not processed",
  "010": "variation code does not exist",
  "011": "invalid arguments",
  "012": "product does not exist",
  "013": "below minimum amount",
  "017": "above maximum amount",
  "018": "provider wallet balance too low",
  "019": "likely duplicate transaction",
  "021": "provider account locked",
  "022": "provider account suspended",
  "023": "provider API access not enabled",
  "024": "provider account inactive",
  "027": "server IP not whitelisted",
  "028": "product not whitelisted",
  "030": "biller not reachable",
  "031": "below minimum quantity",
  "032": "above maximum quantity",
  "034": "service suspended",
  "035": "service inactive",
  "040": "transaction reversed",
  "085": "improper request id",
  "087": "invalid provider credentials",
};

const FAILED_TX_STATUSES = new Set(["failed", "reversed", "refunded", "cancelled", "canceled"]);

export interface ClassifyOptions {
  /** Seconds since the /pay call was first attempted (kept for callers; 015 no longer depends on it). */
  secondsSincePay?: number;
}

export function classifyVtpass(body: unknown, _opts: ClassifyOptions = {}): Classification {
  if (body === null || body === undefined || typeof body !== "object") {
    return { outcome: "pending", code: null, status: null, reason: "no response body" };
  }
  const b = body as { code?: unknown; content?: { transactions?: { status?: unknown } } };
  const code = typeof b.code === "string" ? b.code : typeof b.code === "number" ? String(b.code).padStart(3, "0") : null;
  const rawStatus = b.content?.transactions?.status;
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : null;

  if (code === "000") {
    if (status === "delivered") return { outcome: "delivered", code, status, reason: "delivered" };
    if (status && FAILED_TX_STATUSES.has(status)) return { outcome: "failed", code, status, reason: `status ${status}` };
    return { outcome: "pending", code, status, reason: `processed, status ${status ?? "unknown"}` };
  }

  if (code === "015") {
    // "Request id not found" on requery is not proof of non-delivery: a lagging provider can still
    // deliver it. Keep the lock; the vend deadline releases it, and reconciliation keeps watching.
    return { outcome: "pending", code, status, reason: "request not visible at the provider yet" };
  }

  if (code && code in FAILED_CODES) {
    return { outcome: "failed", code, status, reason: FAILED_CODES[code] ?? "failed" };
  }

  // 099 processing, 089 wait, 044 resolved, 001 query, 014 duplicate request id, 083 system error,
  // and anything unrecognised: never guess. Keep the lock and requery.
  return { outcome: "pending", code, status, reason: `unclear response${code ? ` (code ${code})` : ""}` };
}

/** Extracts a prepaid electricity token like "Token : 2636 2054 4059 8275 7802" -> "2636 2054 4059 8275 7802". */
export function extractToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const tx = (b.content as { transactions?: { extras?: unknown } } | undefined)?.transactions;
  const candidates = [b.token, b.purchased_code, b.mainToken, tx?.extras];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const digits = c.replace(/\D/g, "");
    if (digits.length >= 16 && digits.length <= 24) return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  }
  return null;
}

export function extractUnits(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const units = (body as Record<string, unknown>).units;
  return typeof units === "string" && units !== "N/A" ? units : null;
}

export function extractTransactionId(body: unknown): string | null {
  const id = (body as { content?: { transactions?: { transactionId?: unknown } } } | null)?.content?.transactions
    ?.transactionId;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}
