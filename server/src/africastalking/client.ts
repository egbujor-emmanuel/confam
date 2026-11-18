type FetchLike = typeof fetch;

export interface AtCredentials {
  /** Application username; "sandbox" selects the sandbox hosts. */
  username: string;
  apiKey: string;
}

/** Final or interim airtime status, per the Africa's Talking airtime docs. */
export type AtAirtimeStatus = "Queued" | "Sent" | "Success" | "Failed" | (string & {});

export interface AtSendResult {
  /** "Sent" (accepted, final status comes later) or "Failed" (rejected, nothing charged). */
  status: AtAirtimeStatus;
  requestId: string | null;
  errorMessage: string | null;
}

export class AtNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtNetworkError";
  }
}

export class AtApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "AtApiError";
  }
}

/** AT uses the literal string "None" for empty fields. */
const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" && v !== "None" ? v : null);

/**
 * Africa's Talking Airtime API (https://developers.africastalking.com/docs/airtime/sending).
 * The network is resolved by Africa's Talking from the number, so no operator lookup is needed.
 */
export class AtClient {
  readonly isSandbox: boolean;
  private readonly base: string;

  constructor(
    private readonly creds: AtCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.isSandbox = creds.username === "sandbox";
    this.base = this.isSandbox ? "https://api.sandbox.africastalking.com" : "https://api.africastalking.com";
  }

  /**
   * Sends one airtime top-up. `idempotencyKey` (our order reference) makes a repeated request a no-op
   * on AT's side; the engine already guarantees this is called at most once per order.
   */
  async sendAirtime(p: { phoneE164: string; currency: string; amount: number; idempotencyKey: string }): Promise<AtSendResult> {
    const body = await this.request<{
      errorMessage?: string;
      responses?: { status?: string; requestId?: string; errorMessage?: string }[];
    }>(
      "POST",
      "/version1/airtime/send",
      // Form-encoded with `recipients` as a JSON string, exactly as the official SDK sends it
      // (africastalking-node.js lib/customAxios/airtime.js); success is HTTP 201.
      new URLSearchParams({
        username: this.creds.username,
        recipients: JSON.stringify([{ phoneNumber: p.phoneE164, amount: `${p.currency} ${p.amount}` }]),
      }),
      { "Idempotency-Key": p.idempotencyKey },
    );
    const entry = body.responses?.[0];
    if (!entry) {
      // The whole request was rejected (e.g. bad credentials, insufficient balance): nothing was sent.
      return { status: "Failed", requestId: null, errorMessage: clean(body.errorMessage) ?? "airtime request rejected" };
    }
    return { status: entry.status ?? "Failed", requestId: clean(entry.requestId), errorMessage: clean(entry.errorMessage) };
  }

  /** https://developers.africastalking.com/docs/airtime/query/find_transaction_status */
  async airtimeStatus(requestId: string): Promise<AtAirtimeStatus | null> {
    const q = new URLSearchParams({ username: this.creds.username, transactionId: requestId });
    const body = await this.request<{ status?: string; data?: { status?: string } }>("GET", `/query/transaction/find?${q}`);
    return clean(body.data?.status) ?? clean(body.status);
  }

  private async request<T>(method: "GET" | "POST", path: string, form?: URLSearchParams, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.base), {
        method,
        headers: {
          accept: "application/json",
          apiKey: this.creds.apiKey,
          ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
          ...extra,
        },
        body: form === undefined ? undefined : form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AtNetworkError(err instanceof Error ? err.message : "Africa's Talking unreachable");
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg = clean((parsed as { errorMessage?: string } | null)?.errorMessage) ?? (text.slice(0, 160) || `HTTP ${res.status}`);
      throw new AtApiError(res.status, msg);
    }
    if (parsed === null) throw new AtApiError(res.status, "Africa's Talking returned a non-JSON response");
    return parsed as T;
  }
}
