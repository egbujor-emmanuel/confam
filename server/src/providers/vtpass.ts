import type { Order } from "../orders/types.ts";
import { classifyVtpass, extractToken, extractTransactionId, extractUnits } from "../vtpass/classify.ts";
import { VtpassNetworkError, type PayParams, type VtpassClient } from "../vtpass/client.ts";
import type { BillProvider, VendResult } from "./types.ts";

/** VTpass: Nigerian airtime, data and electricity, plus international airtime and data. */
export class VtpassProvider implements BillProvider {
  readonly id = "vtpass" as const;

  constructor(
    private readonly client: Pick<VtpassClient, "pay" | "requery">,
    /** Customer email VTpass requires on international orders (never a real user's address). */
    private readonly intlEmail = "sandbox@sandbox.vtpass.com",
  ) {}

  async purchase(order: Order): Promise<VendResult> {
    try {
      return toResult(await this.client.pay(buildVtpassPayParams(order, this.intlEmail)), 0);
    } catch (err) {
      return pendingFromError(err);
    }
  }

  async check(order: Order, secondsSincePurchase: number): Promise<VendResult> {
    try {
      return toResult(await this.client.requery(order.requestId), secondsSincePurchase);
    } catch (err) {
      return pendingFromError(err);
    }
  }
}

function toResult(body: unknown, secondsSincePay: number): VendResult {
  const cls = classifyVtpass(body, { secondsSincePay });
  return {
    ...cls,
    txId: extractTransactionId(body),
    token: extractToken(body),
    units: extractUnits(body),
  };
}

function pendingFromError(err: unknown): VendResult {
  const reason = err instanceof VtpassNetworkError ? `no response: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { outcome: "pending", code: null, status: null, reason };
}

export const INTL_SERVICE_ID = "foreign-airtime";

export function buildVtpassPayParams(order: Order, intlEmail = "sandbox@sandbox.vtpass.com"): PayParams {
  const phone = order.phone ?? "";
  if (order.serviceId === INTL_SERVICE_ID) {
    // https://vtpass.com/documentation/foreign-airtime/ : the variation code sets the product, the
    // amount (local currency) only matters for flexible top-ups.
    return {
      requestId: order.requestId,
      serviceID: INTL_SERVICE_ID,
      billersCode: phone,
      variationCode: order.variationCode ?? "",
      amount: order.amountLocal,
      phone,
      extra: {
        operator_id: order.operatorId ?? "",
        country_code: order.countryCode,
        product_type_id: order.category === "data" ? "4" : "1",
        email: intlEmail,
      },
    };
  }
  switch (order.category) {
    case "airtime":
      return { requestId: order.requestId, serviceID: order.serviceId, amount: order.amountLocal, phone };
    case "data":
      return {
        requestId: order.requestId,
        serviceID: order.serviceId,
        billersCode: order.billersCode ?? phone,
        variationCode: order.variationCode ?? "",
        amount: order.amountLocal,
        phone,
      };
    case "electricity":
      return {
        requestId: order.requestId,
        serviceID: order.serviceId,
        billersCode: order.billersCode ?? "",
        variationCode: order.meterType ?? "prepaid",
        amount: order.amountLocal,
        phone,
      };
  }
}
