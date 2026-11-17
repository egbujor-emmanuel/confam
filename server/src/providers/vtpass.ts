import type { Order } from "../orders/types.ts";
import { classifyVtpass, extractToken, extractTransactionId, extractUnits } from "../vtpass/classify.ts";
import { VtpassNetworkError, type PayParams, type VtpassClient } from "../vtpass/client.ts";
import type { BillProvider, VendResult } from "./types.ts";

/** Nigeria: airtime, data, electricity (prepaid tokens) and TV via VTpass. */
export class VtpassProvider implements BillProvider {
  readonly id = "vtpass" as const;

  constructor(private readonly client: Pick<VtpassClient, "pay" | "requery">) {}

  async purchase(order: Order): Promise<VendResult> {
    try {
      return toResult(await this.client.pay(buildVtpassPayParams(order)), 0);
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

export function buildVtpassPayParams(order: Order): PayParams {
  const phone = order.phone ?? "";
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
