import { randomBytes } from "node:crypto";
import { z } from "zod";
import { findCountry, toInternational, type Country } from "../countries.ts";
import { AppError } from "../errors.ts";
import { newPreimagePair, type HoldInvoiceProvider } from "../lightning/index.ts";
import { localToSats, type RateService } from "../pricing/rates.ts";
import { atAirtimeLimits } from "../africastalking/coverage.ts";
import type { ProviderId } from "../providers/types.ts";
import type { ReloadlyCatalog } from "../reloadly/catalog.ts";
import { maskId, maskName } from "../util/mask.ts";
import { acceptPhone } from "../util/phone.ts";
import type { Catalog } from "../vtpass/catalog.ts";
import type { VtpassClient } from "../vtpass/client.ts";
import { newRequestId } from "../vtpass/requestId.ts";
import type { OrderStore } from "./store.ts";
import type { Category, NewOrder, Order } from "./types.ts";

const iso = z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase());
const serviceId = z.string().regex(/^[a-z0-9-]{2,40}$/);
const operatorId = z.string().regex(/^\d{1,8}$/);
const phone = z.string().trim().min(6).max(20);
const amount = z.number().positive().max(10_000_000);

export const CreateOrderSchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("airtime"),
    countryCode: iso,
    phone,
    amountLocal: amount,
    serviceID: serviceId.optional(),
    operatorId: operatorId.optional(),
  }),
  z.object({
    category: z.literal("data"),
    countryCode: iso,
    phone,
    serviceID: serviceId.optional(),
    variationCode: z.string().regex(/^[\w.-]{1,60}$/).optional(),
    operatorId: operatorId.optional(),
    amountLocal: amount.optional(),
  }),
  z.object({
    category: z.literal("electricity"),
    countryCode: iso,
    serviceID: serviceId,
    meterNumber: z.string().regex(/^\d{6,13}$/, "meter number must be 6-13 digits"),
    meterType: z.enum(["prepaid", "postpaid"]),
    phone,
    amountLocal: amount,
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
  vtpassCatalog: Catalog;
  reloadly: ReloadlyCatalog | null;
  /** Africa's Talking airtime is configured (no catalogue needed: AT routes by number). */
  africastalking?: boolean;
  rates: Pick<RateService, "current">;
  limits: { minNgn: number; maxNgn: number; maxSats: number; feeBps: number; invoiceExpirySec: number };
  vtpassSandbox: boolean;
  now?: () => number;
}

type Product = Pick<
  NewOrder,
  | "category"
  | "provider"
  | "countryCode"
  | "currency"
  | "serviceId"
  | "operatorId"
  | "variationCode"
  | "productLabel"
  | "amountLocal"
  | "billersCode"
  | "phone"
  | "recipientMasked"
  | "meterType"
  | "customerName"
>;

const fmt = (n: number, currency: string): string =>
  `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n)} ${currency}`;

export class OrderService {
  private readonly now: () => number;

  constructor(private readonly deps: OrderServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Which provider serves (country, category)? Nigeria prefers VTpass (it also sells data and electricity);
   * airtime elsewhere goes to Africa's Talking where it covers the country, then Reloadly.
   */
  route(country: Country, category: Category): ProviderId | null {
    if (country.iso === "NG" && this.deps.vtpass) return "vtpass";
    if (category === "electricity") return null; // electricity: Nigeria via VTpass for now
    if (category === "airtime" && this.deps.africastalking && atAirtimeLimits(country.iso)) return "africastalking";
    return this.deps.reloadly ? "reloadly" : null;
  }

  async verifyMeter(serviceID: string, meterNumber: string, meterType: "prepaid" | "postpaid"): Promise<MeterInfo> {
    if (!this.deps.vtpass) throw new AppError(503, "provider_unconfigured", "Bill provider is not configured yet.");
    if (!/^\d{6,13}$/.test(meterNumber)) throw new AppError(400, "bad_meter", "Meter number must be 6-13 digits.");
    if (!(await this.deps.vtpassCatalog.find("electricity", serviceID))) {
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
    const country = findCountry(input.countryCode);
    if (!country) throw new AppError(400, "unknown_country", "That country is not supported yet.");
    const provider = this.route(country, input.category);
    if (!provider) throw new AppError(503, "provider_unconfigured", "This service is not available in that country yet.");

    const product =
      provider === "vtpass"
        ? await this.vtpassProduct(input, country)
        : provider === "africastalking"
          ? this.atAirtimeProduct(input, country)
          : await this.reloadlyProduct(input, country);

    const rate = await this.deps.rates.current(product.currency).catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now. Try again in a minute.");
    });
    const amountSats = localToSats(product.amountLocal, rate.perBtc, this.deps.limits.feeBps);
    if (amountSats > this.deps.limits.maxSats) {
      throw new AppError(400, "bad_amount", "That amount is above Confam's per-order limit.");
    }
    const { preimageHex, paymentHashHex } = newPreimagePair();
    const nowMs = this.now();
    const { invoice } = await this.deps.ln.createHoldInvoice({
      amountSats,
      paymentHashHex,
      memo: `Confam: ${product.productLabel}`.slice(0, 100),
      expirySec: this.deps.limits.invoiceExpirySec,
    });

    return this.deps.store.insert(
      {
        ...product,
        id: randomBytes(16).toString("base64url"),
        amountSats,
        ratePerBtc: rate.perBtc,
        rateSource: rate.source,
        paymentHash: paymentHashHex,
        preimage: preimageHex,
        invoice,
        invoiceExpiresAt: nowMs + this.deps.limits.invoiceExpirySec * 1000,
        requestId: newRequestId(new Date(nowMs)),
      },
      nowMs,
    );
  }

  private atAirtimeProduct(input: CreateOrderInput, country: Country): Product {
    const limits = atAirtimeLimits(country.iso);
    if (input.category !== "airtime" || !limits) throw new AppError(400, "unsupported", "Only airtime is available in that country yet.");
    const intl = toInternational(input.phone, country);
    if (!intl) throw new AppError(400, "bad_phone", `Enter a valid ${country.name} phone number.`);
    const amountLocal = input.amountLocal;
    if (amountLocal < limits.min || amountLocal > limits.max) {
      throw new AppError(400, "bad_amount", `Choose ${fmt(limits.min, limits.currency)} to ${fmt(limits.max, limits.currency)}.`);
    }
    return {
      category: "airtime",
      provider: "africastalking",
      countryCode: country.iso,
      currency: limits.currency,
      serviceId: `at-airtime-${country.iso.toLowerCase()}`,
      operatorId: null,
      variationCode: null,
      productLabel: `${fmt(amountLocal, limits.currency)} airtime`,
      amountLocal,
      billersCode: null,
      phone: intl,
      recipientMasked: `+${maskId(intl)}`,
      meterType: null,
      customerName: null,
    };
  }

  private async reloadlyProduct(input: CreateOrderInput, country: Country): Promise<Product> {
    const catalog = this.deps.reloadly;
    if (!catalog) throw new AppError(503, "provider_unconfigured", "This service is not available yet.");
    if (input.category === "electricity") throw new AppError(400, "unsupported", "Electricity is not available in that country yet.");
    const intl = toInternational(input.phone, country);
    if (!intl) throw new AppError(400, "bad_phone", `Enter a valid ${country.name} phone number.`);

    if (input.category === "airtime") {
      const op = input.operatorId ? await catalog.operator(input.operatorId) : await catalog.detect(intl, country.iso);
      if (op.isData) throw new AppError(400, "bad_operator", "Pick an airtime network, not a data plan.");
      const amountLocal = input.amountLocal;
      const ok = op.fixedAmounts.length
        ? op.fixedAmounts.includes(amountLocal)
        : (op.minAmount === null || amountLocal >= op.minAmount) && (op.maxAmount === null || amountLocal <= op.maxAmount);
      if (!ok) {
        const range = op.fixedAmounts.length
          ? op.fixedAmounts.map((a) => fmt(a, op.currency)).join(", ")
          : `${fmt(op.minAmount ?? 0, op.currency)} to ${fmt(op.maxAmount ?? 0, op.currency)}`;
        throw new AppError(400, "bad_amount", `For ${op.name}, choose ${range}.`);
      }
      return this.reloadlyBase(country, intl, op.operatorId, `${fmt(amountLocal, op.currency)} ${op.name} airtime`, amountLocal, op.currency, "airtime");
    }

    if (!input.operatorId || input.amountLocal === undefined) throw new AppError(400, "unknown_plan", "Pick a data plan.");
    const plan = (await catalog.dataPlans(country.iso)).find(
      (p) => p.operatorId === input.operatorId && p.amountLocal === input.amountLocal,
    );
    if (!plan) throw new AppError(400, "unknown_plan", "That data plan is not available.");
    return this.reloadlyBase(country, intl, plan.operatorId, `${plan.operatorName}: ${plan.name}`, plan.amountLocal, country.currency, "data");
  }

  private reloadlyBase(
    country: Country,
    intl: string,
    opId: string,
    label: string,
    amountLocal: number,
    currency: string,
    category: "airtime" | "data",
  ): Product {
    return {
      category,
      provider: "reloadly",
      countryCode: country.iso,
      currency,
      serviceId: `reloadly-${opId}`,
      operatorId: opId,
      variationCode: null,
      productLabel: label,
      amountLocal,
      billersCode: null,
      phone: intl,
      recipientMasked: `+${maskId(intl)}`,
      meterType: null,
      customerName: null,
    };
  }

  private async vtpassProduct(input: CreateOrderInput, country: Country): Promise<Product> {
    const phoneNorm = acceptPhone(input.phone, this.deps.vtpassSandbox);
    if (!phoneNorm) throw new AppError(400, "bad_phone", "Enter a valid Nigerian phone number, e.g. 0803 123 4567.");
    const base = { provider: "vtpass" as const, countryCode: country.iso, currency: "NGN", operatorId: null };

    if (input.category === "airtime") {
      const svc = await this.requireVtpass("airtime", input.serviceID);
      const amountLocal = this.checkNgn(input.amountLocal, svc.minAmount, svc.maxAmount);
      return {
        ...base,
        category: "airtime",
        serviceId: svc.serviceID,
        variationCode: null,
        productLabel: `₦${amountLocal.toLocaleString("en-NG")} ${svc.name}`,
        amountLocal,
        billersCode: null,
        phone: phoneNorm,
        recipientMasked: maskId(phoneNorm),
        meterType: null,
        customerName: null,
      };
    }

    if (input.category === "data") {
      const svc = await this.requireVtpass("data", input.serviceID);
      const variation = (await this.deps.vtpassCatalog.listVariations(svc.serviceID)).find((v) => v.code === input.variationCode);
      if (!variation) throw new AppError(400, "unknown_plan", "That data plan is not available.");
      // Price always comes from the provider catalogue, never from the client.
      const amountLocal = this.checkNgn(Math.round(variation.amountNgn), null, null);
      return {
        ...base,
        category: "data",
        serviceId: svc.serviceID,
        variationCode: variation.code,
        productLabel: `${svc.name}: ${variation.name}`,
        amountLocal,
        billersCode: phoneNorm,
        phone: phoneNorm,
        recipientMasked: maskId(phoneNorm),
        meterType: null,
        customerName: null,
      };
    }

    const svc = await this.requireVtpass("electricity", input.serviceID);
    const meter = await this.verifyMeter(svc.serviceID, input.meterNumber, input.meterType);
    const amountLocal = this.checkNgn(input.amountLocal, meter.minAmount ?? svc.minAmount, svc.maxAmount);
    return {
      ...base,
      category: "electricity",
      serviceId: svc.serviceID,
      variationCode: input.meterType,
      productLabel: `₦${amountLocal.toLocaleString("en-NG")} ${svc.name} (${input.meterType})`,
      amountLocal,
      billersCode: input.meterNumber,
      phone: phoneNorm,
      recipientMasked: `meter ${maskId(input.meterNumber)}`,
      meterType: input.meterType,
      customerName: maskName(meter.customerName),
    };
  }

  private async requireVtpass(category: Category, serviceID: string | undefined) {
    const svc = serviceID ? await this.deps.vtpassCatalog.find(category, serviceID) : null;
    if (!svc) throw new AppError(400, "unknown_service", "That service is not available.");
    return svc;
  }

  private checkNgn(value: number, svcMin: number | null, svcMax: number | null): number {
    const min = Math.max(this.deps.limits.minNgn, svcMin ?? 0);
    const max = Math.min(this.deps.limits.maxNgn, svcMax ?? Number.POSITIVE_INFINITY);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AppError(400, "bad_amount", `Amount must be between ₦${min.toLocaleString("en-NG")} and ₦${max.toLocaleString("en-NG")}.`);
    }
    return value;
  }
}
