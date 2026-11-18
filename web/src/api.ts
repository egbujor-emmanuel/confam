export type Category = "airtime" | "data" | "electricity";
export type OrderState = "awaiting_payment" | "locked" | "vending" | "delivered" | "completed" | "released" | "expired";
export type ProviderId = "vtpass" | "reloadly" | "africastalking";

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

export interface OperatorInfo {
  operatorId: string;
  name: string;
  currency: string;
  minAmount: number | null;
  maxAmount: number | null;
  fixedAmounts: number[];
  suggestedAmounts: number[];
  logo: string | null;
  isData: boolean;
  /** The provider routes by number itself (Africa's Talking): no single network to show. */
  isAutoNetwork?: boolean;
}

export interface DataPlan {
  operatorId: string;
  operatorName: string;
  amountLocal: number;
  name: string;
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
  | { category: "airtime"; countryCode: string; phone: string; amountLocal: number; serviceID?: string; operatorId?: string }
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only declare JSON when there is a body: Fastify rejects an empty body sent as application/json.
    const headers = init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers;
    res = await fetch(path, { ...init, headers });
  } catch {
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
  detectOperator: (country: string, phone: string) =>
    request<{ operator: OperatorInfo }>(`/api/operators/detect?country=${q(country)}&phone=${q(phone)}`).then((r) => r.operator),
  dataPlans: (country: string) => request<{ plans: DataPlan[] }>(`/api/data-plans?country=${q(country)}`).then((r) => r.plans),
  services: (category: Category) => request<{ services: Service[] }>(`/api/catalog/${category}`).then((r) => r.services),
  variations: (serviceID: string) => request<{ variations: Variation[] }>(`/api/catalog/variations/${q(serviceID)}`).then((r) => r.variations),
  verifyMeter: (serviceID: string, meterNumber: string, meterType: "prepaid" | "postpaid") =>
    request<MeterInfo>("/api/meter/verify", { method: "POST", body: JSON.stringify({ serviceID, meterNumber, meterType }) }),
  quote: (amount: number, currency: string) =>
    request<{ amount: number; currency: string; amountSats: number; perBtc: number }>(`/api/quote?amount=${amount}&currency=${q(currency)}`),
  createOrder: (input: CreateOrderInput) => request<Order>("/api/orders", { method: "POST", body: JSON.stringify(input) }),
  order: (id: string) => request<Order>(`/api/orders/${q(id)}`),
  testWallet: () => request<{ nwcUrl: string; balanceSats: number }>("/api/test-wallet", { method: "POST" }),
};
