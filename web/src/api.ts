export type Category = "airtime" | "data" | "electricity";
export type OrderState = "awaiting_payment" | "locked" | "vending" | "delivered" | "completed" | "released" | "expired";

export interface AppConfig {
  lightning: { backend: string; network: string };
  provider: { configured: boolean; sandbox: boolean };
  limits: { minNgn: number; maxNgn: number; vendDeadlineSec: number };
  testWallet: { enabled: boolean; balanceSats?: number };
  receipts: { npub: string; pubkey: string };
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

export interface MeterInfo {
  customerName: string | null;
  address: string | null;
  minAmount: number | null;
}

export interface Order {
  id: string;
  state: OrderState;
  headline: string;
  detail: string;
  category: Category;
  product: string;
  recipient: string;
  customerName: string | null;
  amountNgn: number;
  amountSats: number;
  rateNgnPerBtc: number;
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
  | { category: "airtime"; serviceID: string; phone: string; amountNgn: number }
  | { category: "data"; serviceID: string; phone: string; variationCode: string }
  | { category: "electricity"; serviceID: string; meterNumber: string; meterType: "prepaid" | "postpaid"; phone: string; amountNgn: number };

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

export const api = {
  config: () => request<AppConfig>("/api/config"),
  services: (category: Category) => request<{ services: Service[] }>(`/api/catalog/${category}`).then((r) => r.services),
  variations: (serviceID: string) =>
    request<{ variations: Variation[] }>(`/api/catalog/variations/${encodeURIComponent(serviceID)}`).then((r) => r.variations),
  verifyMeter: (serviceID: string, meterNumber: string, meterType: "prepaid" | "postpaid") =>
    request<MeterInfo>("/api/meter/verify", { method: "POST", body: JSON.stringify({ serviceID, meterNumber, meterType }) }),
  quote: (amountNgn: number) =>
    request<{ amountNgn: number; amountSats: number; ngnPerBtc: number }>(`/api/quote?amountNgn=${amountNgn}`),
  createOrder: (input: CreateOrderInput) => request<Order>("/api/orders", { method: "POST", body: JSON.stringify(input) }),
  order: (id: string) => request<Order>(`/api/orders/${encodeURIComponent(id)}`),
  testWallet: () => request<{ nwcUrl: string; balanceSats: number }>("/api/test-wallet", { method: "POST" }),
};
