type FetchLike = typeof fetch;

export interface ReloadlyCredentials {
  clientId: string;
  clientSecret: string;
  /** https://topups-sandbox.reloadly.com (test mode) or https://topups.reloadly.com */
  baseUrl: string;
  authUrl?: string;
}

export interface ReloadlyOperator {
  operatorId: number;
  name: string;
  bundle?: boolean;
  data?: boolean;
  pin?: boolean;
  supportsLocalAmounts?: boolean;
  denominationType?: "RANGE" | "FIXED";
  destinationCurrencyCode?: string;
  localMinAmount?: number | null;
  localMaxAmount?: number | null;
  localFixedAmounts?: number[];
  localFixedAmountsDescriptions?: Record<string, string> | null;
  suggestedAmountsMap?: Record<string, number> | null;
  logoUrls?: string[];
  country?: { isoName: string; name: string };
}

export interface TopupStatus {
  status: string | null;
  transactionId: string | null;
  operatorTransactionId: string | null;
  deliveredAmount: number | null;
  deliveredAmountCurrencyCode: string | null;
  pinCode: string | null;
}

export class ReloadlyNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReloadlyNetworkError";
  }
}

export class ReloadlyApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ReloadlyApiError";
  }
}

const ACCEPT = "application/com.reloadly.topups-v1+json";

/**
 * Reloadly Airtime API (https://docs.reloadly.com/airtime). OAuth2 client-credentials token
 * whose audience is the API base URL; tokens are cached until shortly before expiry.
 */
export class ReloadlyClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: ReloadlyCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  autoDetectOperator(phoneE164Digits: string, countryIso: string): Promise<ReloadlyOperator> {
    return this.request<ReloadlyOperator>(
      "GET",
      `/operators/auto-detect/phone/${encodeURIComponent(phoneE164Digits)}/countries/${encodeURIComponent(countryIso)}?suggestedAmountsMap=true`,
    );
  }

  async operatorsByCountry(countryIso: string): Promise<ReloadlyOperator[]> {
    const body = await this.request<unknown>(
      "GET",
      `/operators/countries/${encodeURIComponent(countryIso)}?includeData=true&includeBundles=true&suggestedAmountsMap=true`,
    );
    return Array.isArray(body) ? (body as ReloadlyOperator[]) : [];
  }

  getOperator(operatorId: number): Promise<ReloadlyOperator> {
    return this.request<ReloadlyOperator>("GET", `/operators/${operatorId}?suggestedAmountsMap=true`);
  }

  /** Returns Reloadly's transactionId. Uses local currency amounts and a unique customIdentifier (idempotency). */
  async topupAsync(p: {
    operatorId: number;
    amountLocal: number;
    countryIso: string;
    phoneE164Digits: string;
    customIdentifier: string;
  }): Promise<string> {
    const body = await this.request<{ transactionId?: number | string }>("POST", "/topups-async", {
      operatorId: String(p.operatorId),
      amount: String(p.amountLocal),
      useLocalAmount: true,
      customIdentifier: p.customIdentifier,
      recipientPhone: { countryCode: p.countryIso, number: p.phoneE164Digits },
    });
    if (body.transactionId === undefined || body.transactionId === null) {
      throw new ReloadlyApiError(200, null, "Reloadly returned no transactionId");
    }
    return String(body.transactionId);
  }

  async topupStatus(transactionId: string): Promise<TopupStatus> {
    const body = await this.request<{
      status?: string;
      transaction?: {
        transactionId?: number | string;
        status?: string;
        operatorTransactionId?: string | null;
        deliveredAmount?: number;
        deliveredAmountCurrencyCode?: string;
        pinDetail?: { code?: string | number | null } | null;
      };
    }>("GET", `/topups/${encodeURIComponent(transactionId)}/status`);
    const tx = body.transaction;
    return {
      status: body.status ?? tx?.status ?? null,
      transactionId: tx?.transactionId !== undefined ? String(tx.transactionId) : transactionId,
      operatorTransactionId: tx?.operatorTransactionId ?? null,
      deliveredAmount: typeof tx?.deliveredAmount === "number" ? tx.deliveredAmount : null,
      deliveredAmountCurrencyCode: tx?.deliveredAmountCurrencyCode ?? null,
      pinCode: tx?.pinDetail?.code !== undefined && tx.pinDetail.code !== null ? String(tx.pinDetail.code) : null,
    };
  }

  /** Recovery path when the async call's response was lost: find the top-up by our own reference. */
  async findByCustomIdentifier(customIdentifier: string): Promise<{ transactionId: string; status: string | null } | null> {
    const body = await this.request<{ content?: { transactionId?: number | string; status?: string }[] }>(
      "GET",
      `/topups/reports/transactions?customIdentifier=${encodeURIComponent(customIdentifier)}&size=1&page=1`,
    );
    const first = body.content?.[0];
    return first?.transactionId !== undefined ? { transactionId: String(first.transactionId), status: first.status ?? null } : null;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    let res: Response;
    try {
      res = await this.fetchImpl(this.creds.authUrl ?? "https://auth.reloadly.com/oauth/token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          grant_type: "client_credentials",
          audience: this.creds.baseUrl,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ReloadlyNetworkError(err instanceof Error ? err.message : "Reloadly auth unreachable");
    }
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !body?.access_token) throw new ReloadlyApiError(res.status, "AUTH", "Reloadly authentication failed");
    const ttlMs = Math.max(60, (body.expires_in ?? 3600) - 120) * 1000;
    this.token = { value: body.access_token, expiresAt: this.now() + ttlMs };
    return body.access_token;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.creds.baseUrl), {
        method,
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ReloadlyNetworkError(err instanceof Error ? err.message : "Reloadly unreachable");
    }
    if (res.status === 401 && !retried) {
      this.token = null; // expired early: refresh once (never for the purchase call's body twice, see provider)
      if (method === "GET") return this.request<T>(method, path, body, true);
    }
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const p = parsed as { errorCode?: string; message?: string } | null;
      throw new ReloadlyApiError(res.status, p?.errorCode ?? null, p?.message ?? `Reloadly HTTP ${res.status}`);
    }
    return parsed as T;
  }
}
