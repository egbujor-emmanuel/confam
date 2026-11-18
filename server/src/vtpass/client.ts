type FetchLike = typeof fetch;

export interface VtpassCredentials {
  baseUrl: string;
  apiKey: string;
  publicKey: string;
  secretKey: string;
}

export interface PayParams {
  requestId: string;
  serviceID: string;
  amount?: number;
  phone: string;
  billersCode?: string;
  variationCode?: string;
  /** International airtime/data fields: operator_id, country_code, product_type_id, email. */
  extra?: Record<string, string>;
}

export interface VtpassService {
  serviceID: string;
  name: string;
  minimium_amount?: string;
  maximum_amount?: string;
  image?: string;
}

export interface VtpassVariation {
  variation_code: string;
  name: string;
  variation_amount: string;
  fixedPrice?: string;
}

/** Network-level failure (timeout, DNS, connection reset). The outcome of a /pay call is then UNKNOWN. */
export class VtpassNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VtpassNetworkError";
  }
}

/**
 * Thin VTpass REST client. Auth per https://vtpass.com/documentation/authentication/ :
 * GET -> api-key + public-key ; POST -> api-key + secret-key.
 */
export class VtpassClient {
  constructor(
    private readonly creds: VtpassCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  /** Returns the raw JSON body (or null if the body was empty/not JSON). Classification happens elsewhere. */
  pay(p: PayParams): Promise<unknown> {
    const body: Record<string, string | number> = { request_id: p.requestId, serviceID: p.serviceID, phone: p.phone };
    if (p.amount !== undefined) body.amount = p.amount;
    if (p.billersCode !== undefined) body.billersCode = p.billersCode;
    if (p.variationCode !== undefined) body.variation_code = p.variationCode;
    if (p.extra) Object.assign(body, p.extra);
    return this.post("/api/pay", body);
  }

  requery(requestId: string): Promise<unknown> {
    return this.post("/api/requery", { request_id: requestId });
  }

  verifyMerchant(p: { billersCode: string; serviceID: string; type?: string }): Promise<unknown> {
    const body: Record<string, string> = { billersCode: p.billersCode, serviceID: p.serviceID };
    if (p.type) body.type = p.type;
    return this.post("/api/merchant-verify", body);
  }

  async services(identifier: string): Promise<VtpassService[]> {
    const body = (await this.get(`/api/services?identifier=${encodeURIComponent(identifier)}`)) as {
      content?: unknown;
    } | null;
    return Array.isArray(body?.content) ? (body.content as VtpassService[]) : [];
  }

  async variations(serviceID: string): Promise<VtpassVariation[]> {
    const body = (await this.get(`/api/service-variations?serviceID=${encodeURIComponent(serviceID)}`)) as {
      content?: { variations?: unknown; varations?: unknown };
    } | null;
    const list = body?.content?.variations ?? body?.content?.varations; // VTpass returns both spellings
    return Array.isArray(list) ? (list as VtpassVariation[]) : [];
  }

  private get(path: string): Promise<unknown> {
    return this.send(path, { method: "GET", headers: { "api-key": this.creds.apiKey, "public-key": this.creds.publicKey } });
  }

  private post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.send(path, {
      method: "POST",
      headers: { "api-key": this.creds.apiKey, "secret-key": this.creds.secretKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.creds.baseUrl), {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new VtpassNetworkError(err instanceof Error ? err.message : "VTpass unreachable");
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null; // non-JSON (e.g. HTML error page): caller classifies as pending
    }
  }
}
