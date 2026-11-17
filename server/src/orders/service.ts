import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { newPreimagePair, type HoldInvoiceProvider } from "../lightning/index.ts";
import { ngnToSats, type RateService } from "../pricing/rates.ts";
import { maskId, maskName } from "../util/mask.ts";
import { acceptPhone } from "../util/phone.ts";
import type { Catalog } from "../vtpass/catalog.ts";
import type { VtpassClient } from "../vtpass/client.ts";
import { newRequestId } from "../vtpass/requestId.ts";
import type { OrderStore } from "./store.ts";
import type { Category, NewOrder, Order } from "./types.ts";

const serviceId = z.string().regex(/^[a-z0-9-]{2,40}$/);
const phone = z.string().trim().min(10).max(16);
const amount = z.number().int().positive();

export const CreateOrderSchema = z.discriminatedUnion("category", [
  z.object({ category: z.literal("airtime"), serviceID: serviceId, phone, amountNgn: amount }),
  z.object({ category: z.literal("data"), serviceID: serviceId, phone, variationCode: z.string().regex(/^[\w.-]{1,60}$/) }),
  z.object({
    category: z.literal("electricity"),
    serviceID: serviceId,
    meterNumber: z.string().regex(/^\d{6,13}$/, "meter number must be 6-13 digits"),
    meterType: z.enum(["prepaid", "postpaid"]),
    phone,
    amountNgn: amount,
  }),
]);
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export interface MeterInfo {
  customerName: string | null;
  address: string | null;
  minAmount: number | null;
}

export interface OrderServiceDeps {
  store: OrderStore;
  ln: HoldInvoiceProvider;
  vtpass: Pick<VtpassClient, "verifyMerchant"> | null;
  catalog: Catalog;
  rates: Pick<RateService, "current">;
  limits: { minNgn: number; maxNgn: number; feeBps: number; invoiceExpirySec: number };
  sandbox: boolean;
  now?: () => number;
}

interface Product {
  category: Category;
  serviceId: string;
  variationCode: string | null;
  label: string;
  amountNgn: number;
  billersCode: string | null;
  phone: string;
  recipientMasked: string;
  meterType: "prepaid" | "postpaid" | null;
  customerName: string | null;
}

export class OrderService {
  private readonly now: () => number;

  constructor(private readonly deps: OrderServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async verifyMeter(serviceID: string, meterNumber: string, meterType: "prepaid" | "postpaid"): Promise<MeterInfo> {
    if (!this.deps.vtpass) throw new AppError(503, "provider_unconfigured", "Bill provider is not configured yet.");
    if (!/^\d{6,13}$/.test(meterNumber)) throw new AppError(400, "bad_meter", "Meter number must be 6-13 digits.");
    if (!(await this.deps.catalog.find("electricity", serviceID))) {
      throw new AppError(400, "unknown_service", "Unknown electricity company.");
    }
    const body = (await this.deps.vtpass.verifyMerchant({ billersCode: meterNumber, serviceID, type: meterType })) as {
      code?: string;
      content?: Record<string, unknown>;
    } | null;
    const c = body?.content ?? {};
    const name = typeof c.Customer_Name === "string" ? c.Customer_Name.trim() : "";
    if (body?.code !== "000" || c.WrongBillersCode === true || typeof c.error === "string" || !name) {
      throw new AppError(422, "meter_not_found", "We couldn't find that meter. Check the number and company.");
    }
    if (typeof c.Can_Vend === "string" && c.Can_Vend.toLowerCase() === "no") {
      throw new AppError(422, "meter_cannot_vend", "This meter can't receive tokens right now.");
    }
    const min = Number(c.Min_Purchase_Amount ?? c.Minimum_Amount);
    return {
      customerName: name,
      address: typeof c.Address === "string" ? c.Address.trim() : null,
      minAmount: Number.isFinite(min) && min > 0 ? min : null,
    };
  }

  async create(input: CreateOrderInput): Promise<Order> {
    if (!this.deps.vtpass) throw new AppError(503, "provider_unconfigured", "Bill provider is not configured yet.");
    const product = await this.resolveProduct(input);

    const rate = await this.deps.rates.current().catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now. Try again in a minute.");
    });
    const amountSats = ngnToSats(product.amountNgn, rate.ngnPerBtc, this.deps.limits.feeBps);
    const { preimageHex, paymentHashHex } = newPreimagePair();
    const nowMs = this.now();
    const { invoice } = await this.deps.ln.createHoldInvoice({
      amountSats,
      paymentHashHex,
      memo: `Confam: ${product.label}`.slice(0, 100),
      expirySec: this.deps.limits.invoiceExpirySec,
    });

    const order: NewOrder = {
      id: randomBytes(16).toString("base64url"),
      category: product.category,
      serviceId: product.serviceId,
      variationCode: product.variationCode,
      productLabel: product.label,
      billersCode: product.billersCode,
      phone: product.phone,
      recipientMasked: product.recipientMasked,
      meterType: product.meterType,
      customerName: product.customerName,
      amountNgn: product.amountNgn,
      amountSats,
      rateNgnPerBtc: rate.ngnPerBtc,
      rateSource: rate.source,
      paymentHash: paymentHashHex,
      preimage: preimageHex,
      invoice,
      invoiceExpiresAt: nowMs + this.deps.limits.invoiceExpirySec * 1000,
      requestId: newRequestId(new Date(nowMs)),
    };
    return this.deps.store.insert(order, nowMs);
  }

  private async resolveProduct(input: CreateOrderInput): Promise<Product> {
    const phoneNorm = acceptPhone(input.phone, this.deps.sandbox);
    if (!phoneNorm) throw new AppError(400, "bad_phone", "Enter a valid Nigerian phone number, e.g. 0803 123 4567.");

    if (input.category === "airtime") {
      const svc = await this.requireService("airtime", input.serviceID);
      const amountNgn = this.checkAmount(input.amountNgn, svc.minAmount, svc.maxAmount);
      return {
        category: "airtime",
        serviceId: svc.serviceID,
        variationCode: null,
        label: `₦${amountNgn.toLocaleString("en-NG")} ${svc.name}`,
        amountNgn,
        billersCode: null,
        phone: phoneNorm,
        recipientMasked: maskId(phoneNorm),
        meterType: null,
        customerName: null,
      };
    }

    if (input.category === "data") {
      const svc = await this.requireService("data", input.serviceID);
      const variation = (await this.deps.catalog.listVariations(svc.serviceID)).find((v) => v.code === input.variationCode);
      if (!variation) throw new AppError(400, "unknown_plan", "That data plan is not available.");
      // Price always comes from the provider catalogue, never from the client.
      const amountNgn = this.checkAmount(Math.round(variation.amountNgn), null, null);
      return {
        category: "data",
        serviceId: svc.serviceID,
        variationCode: variation.code,
        label: `${svc.name}: ${variation.name}`,
        amountNgn,
        billersCode: phoneNorm,
        phone: phoneNorm,
        recipientMasked: maskId(phoneNorm),
        meterType: null,
        customerName: null,
      };
    }

    const svc = await this.requireService("electricity", input.serviceID);
    const meter = await this.verifyMeter(svc.serviceID, input.meterNumber, input.meterType);
    const amountNgn = this.checkAmount(input.amountNgn, meter.minAmount ?? svc.minAmount, svc.maxAmount);
    return {
      category: "electricity",
      serviceId: svc.serviceID,
      variationCode: input.meterType,
      label: `₦${amountNgn.toLocaleString("en-NG")} ${svc.name} (${input.meterType})`,
      amountNgn,
      billersCode: input.meterNumber,
      phone: phoneNorm,
      recipientMasked: `meter ${maskId(input.meterNumber)}`,
      meterType: input.meterType,
      customerName: maskName(meter.customerName),
    };
  }

  private async requireService(category: Category, serviceID: string) {
    const svc = await this.deps.catalog.find(category, serviceID);
    if (!svc) throw new AppError(400, "unknown_service", "That service is not available.");
    return svc;
  }

  private checkAmount(value: number, svcMin: number | null, svcMax: number | null): number {
    const min = Math.max(this.deps.limits.minNgn, svcMin ?? 0);
    const max = Math.min(this.deps.limits.maxNgn, svcMax ?? Number.POSITIVE_INFINITY);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AppError(400, "bad_amount", `Amount must be between ₦${min.toLocaleString("en-NG")} and ₦${max.toLocaleString("en-NG")}.`);
    }
    return value;
  }
}
