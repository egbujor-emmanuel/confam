export type Category = "airtime" | "data" | "electricity";
export type OrderState = "awaiting_payment" | "locked" | "vending" | "delivered" | "completed" | "released" | "expired";
export type ProviderId = "vtpass" | "dexpay";

export interface AppConfig {
  lightning: { backend: string; network: string };
  providers: Record<ProviderId, { configured: boolean; sandbox: boolean }>;
  limits: { minNgn: number; maxNgn: number; maxSats: number; vendDeadlineSec: number };
  testWallet: { enabled: boolean; balanceSats?: number };
  receipts: { npub: string; pubkey: string };
}

export interface Country {
  iso: string;
  name: string;
  nameFr: string;
  dial: string;
  currency: string;
  flag: string;
  services: Record<Category, ProviderId | null>;
}

export interface Service {
  serviceID: string;
  name: string;
  minAmount: number | null;
  maxAmount: number | null;
  image: string | null;
}

export interface Variation {
  code: string;
  name: string;
  amountNgn: number;
}

/** A mobile network VTpass sells to in a country (international airtime/data). */
export interface IntlOperator {
  operatorId: string;
  name: string;
  logo: string | null;
}

/** A flexible top-up range or a fixed-price bundle, in the recipient's currency. */
export interface IntlOffer {
  variationCode: string;
  name: string;
  currency: string;
  isFixed: boolean;
  amountLocal: number | null;
  minLocal: number | null;
  maxLocal: number | null;
}

export interface MeterInfo {
  customerName: string | null;
  address: string | null;
  minAmount: number | null;
}

export interface Order {
  id: string;
  state: OrderState;
  category: Category;
  countryCode: string;
  currency: string;
  product: string;
  recipient: string;
  customerName: string | null;
  amountLocal: number;
  amountSats: number;
  ratePerBtc: number;
  invoice: string | null;
  invoiceExpiresAt: number;
  token: string | null;
  units: string | null;
  releaseReason: string | null;
  deliveredAfterRelease: boolean;
  receipt: SignedReceipt | null;
  timeline: { at: number; state: OrderState; note: string }[];
}

export interface SignedReceipt {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type CreateOrderInput =
  | { category: "airtime"; countryCode: string; phone: string; amountLocal: number; serviceID?: string; operatorId?: string; variationCode?: string }
  | { category: "data"; countryCode: string; phone: string; serviceID?: string; variationCode?: string; operatorId?: string; amountLocal?: number }
  | { category: "electricity"; countryCode: string; serviceID: string; meterNumber: string; meterType: "prepaid" | "postpaid"; phone: string; amountLocal: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** On a slow 3G link a reply can take seconds; past this, say so instead of spinning forever. */
const REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only declare JSON when there is a body: Fastify rejects an empty body sent as application/json.
    const headers = init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers;
    res = await fetch(path, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, "timeout", "Confam is taking too long to answer. Check your connection and try again.");
    }
    throw new ApiError(0, "offline", "You seem to be offline. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? "Something went wrong. Try again.");
  }
  return body as T;
}

const q = encodeURIComponent;

export const api = {
  config: () => request<AppConfig>("/api/config"),
  countries: () => request<{ countries: Country[] }>("/api/countries").then((r) => r.countries),
  intlOperators: (country: string, category: "airtime" | "data") =>
    request<{ operators: IntlOperator[] }>(`/api/intl/operators?country=${q(country)}&category=${category}`).then((r) => r.operators),
  intlOffers: (operatorId: string, category: "airtime" | "data") =>
    request<{ offers: IntlOffer[] }>(`/api/intl/offers?operator=${q(operatorId)}&category=${category}`).then((r) => r.offers),
  intlQuote: (operatorId: string, category: "airtime" | "data", variationCode: string, amount: number) =>
    request<{ amountLocal: number; currency: string; amountSats: number }>(
      `/api/intl/quote?operator=${q(operatorId)}&category=${category}&variation=${q(variationCode)}&amount=${amount}`,
    ),
  services: (category: Category) => request<{ services: Service[] }>(`/api/catalog/${category}`).then((r) => r.services),
  variations: (serviceID: string) => request<{ variations: Variation[] }>(`/api/catalog/variations/${q(serviceID)}`).then((r) => r.variations),
  verifyMeter: (serviceID: string, meterNumber: string, meterType: "prepaid" | "postpaid") =>
    request<MeterInfo>("/api/meter/verify", { method: "POST", body: JSON.stringify({ serviceID, meterNumber, meterType }) }),
  verifyWoyofal: (meterNumber: string) => request<MeterInfo>("/api/meter/woyofal", { method: "POST", body: JSON.stringify({ meterNumber }) }),
  woyofalQuote: (amount: number) => request<{ amount: number; fee: number; currency: string; amountSats: number }>(`/api/woyofal/quote?amount=${amount}`),
  quote: (amount: number, currency: string) =>
    request<{ amount: number; currency: string; amountSats: number; perBtc: number }>(`/api/quote?amount=${amount}&currency=${q(currency)}`),
  createOrder: (input: CreateOrderInput) => request<Order>("/api/orders", { method: "POST", body: JSON.stringify(input) }),
  order: (id: string) => request<Order>(`/api/orders/${q(id)}`),
  testWallet: () => request<{ nwcUrl: string; balanceSats: number }>("/api/test-wallet", { method: "POST" }),
};
