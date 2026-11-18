type FetchLike = typeof fetch;

/** Senegal bill codes (https://docs.dexpay.africa/en/guides/bill-payments). Confam sells Woyofal prepaid electricity. */
export const WOYOFAL = "WOYOFAL_SN_BILL";

/** A person is waiting on a meter lookup, so it gives up sooner than a payment call. */
const INQUIRY_TIMEOUT_MS = 15_000;

export type DexpayBillStatus = "initiated" | "processing" | "completed" | "failed" | "refunded" | (string & {});

export interface DexpayBillPayment {
  reference: string;
  status: DexpayBillStatus;
  token: string | null;
  amount: number | null;
  totalDebited: number | null;
  providerTxId: string | null;
  failureReason: string | null;
  customData: string | null;
}

export interface DexpayMeter {
  referenceClient: string;
  customerName: string | null;
  address: string | null;
  meterStatus: string | null;
}

export class DexpayNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DexpayNetworkError";
  }
}

export class DexpayApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string | null,
    message: string,
    /** For 409 IDEMPOTENT_REPLAY: the payment that already exists for this key. */
    readonly existing: { reference: string; status: DexpayBillStatus } | null = null,
  ) {
    super(message);
    this.name = "DexpayApiError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toPayment(b: Record<string, unknown>): DexpayBillPayment {
  return {
    reference: String(b.reference ?? ""),
    status: String(b.status ?? ""),
    token: str(b.token),
    amount: num(b.amount),
    totalDebited: num(b.total_debited),
    providerTxId: str(b.provider_tx_id),
    failureReason: str(b.failure_reason) ?? str(b.message),
    customData: str(b.custom_data),
  };
}

/**
 * DEXPAY bill payments API (https://docs.dexpay.africa). Auth: `x-api-secret` (sk_test_… for the
 * sandbox at https://api-sandbox.dexpay.africa/api/v1, sk_live_… for production).
 */
export class DexpayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  get isSandbox(): boolean {
    return new URL(this.baseUrl).hostname.includes("sandbox");
  }

  async inquiry(serviceCode: string, referenceClient: string): Promise<DexpayMeter> {
    const body = (await this.request(
      "POST",
      "/bill-payments/inquiry",
      { service_code: serviceCode, reference_client: referenceClient },
      {},
      INQUIRY_TIMEOUT_MS,
    )) as { reference_client?: string; bills?: Record<string, unknown>[] };
    const bill = body.bills?.[0];
    if (!bill) throw new DexpayApiError(404, "NO_BILL", "DEXPAY returned no bill for this meter");
    return {
      referenceClient: body.reference_client ?? referenceClient,
      customerName: str(bill.customer_name),
      address: str(bill.address),
      meterStatus: str(bill.meter_status),
    };
  }

  /** One purchase. The Idempotency-Key makes a repeat return the original payment (409), never a new one. */
  async pay(p: { serviceCode: string; referenceClient: string; amount: number; idempotencyKey: string; customData: string }): Promise<DexpayBillPayment> {
    const body = await this.request(
      "POST",
      "/bill-payments/pay",
      { service_code: p.serviceCode, reference_client: p.referenceClient, amount: p.amount, customData: p.customData },
      { "Idempotency-Key": p.idempotencyKey },
    );
    return toPayment(body as Record<string, unknown>);
  }

  async get(reference: string): Promise<DexpayBillPayment | null> {
    try {
      return toPayment((await this.request("GET", `/bill-payments/${encodeURIComponent(reference)}`)) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof DexpayApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  /** Recent payments for a service (newest first), used to recover a payment whose reply was lost. */
  async listSince(serviceCode: string, fromIso: string, page = 1): Promise<DexpayBillPayment[]> {
    const q = new URLSearchParams({ service_code: serviceCode, from: fromIso, limit: "50", page: String(page) });
    const body = (await this.request("GET", `/bill-payments?${q}`)) as { data?: unknown } | unknown[];
    const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data) : [];
    return list.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null).map(toPayment);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { accept: "application/json", "x-api-secret": this.secretKey, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DexpayNetworkError(err instanceof Error ? err.message : "DEXPAY unreachable");
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { code?: string; message?: string; reference?: string; status?: string };
      const existing = res.status === 409 && p.reference ? { reference: p.reference, status: String(p.status ?? "") } : null;
      throw new DexpayApiError(res.status, p.code ?? null, p.message ?? `DEXPAY HTTP ${res.status}`, existing);
    }
    if (parsed === null) throw new DexpayApiError(res.status, null, "DEXPAY returned a non-JSON response");
    return parsed;
  }
}
