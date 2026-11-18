import { randomBytes } from "node:crypto";
import { z } from "zod";
import { findCountry, toInternational, type Country } from "../countries.ts";
import { AppError } from "../errors.ts";
import { newPreimagePair, type HoldInvoiceProvider } from "../lightning/index.ts";
import { localToSats, type RateService } from "../pricing/rates.ts";
import type { ProviderId } from "../providers/types.ts";
import { INTL_SERVICE_ID } from "../providers/vtpass.ts";
import { maskId, maskName } from "../util/mask.ts";
import { acceptPhone, SANDBOX_INTL_NUMBERS } from "../util/phone.ts";
import type { Catalog } from "../vtpass/catalog.ts";
import type { VtpassClient } from "../vtpass/client.ts";
import { costNgn, type IntlCatalog } from "../vtpass/intl.ts";
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
    variationCode: z.string().regex(/^[\w.-]{1,60}$/).optional(),
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
  /** VTpass international airtime/data catalogue (null when VTpass is not configured). */
  intl: IntlCatalog | null;
  /** ISO codes VTpass sells international airtime to (loaded from the catalogue at startup). */
  intlCountries: ReadonlySet<string>;
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
> & {
  /** International orders: the naira VTpass charges, which the sats price is computed from. */
  costNgn?: number;
};

const fmt = (n: number, currency: string): string =>
  `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n)} ${currency}`;

export class OrderService {
  private readonly now: () => number;

  constructor(private readonly deps: OrderServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Which provider serves (country, category)? Everything runs on VTpass: Nigerian airtime, data and
   * electricity, and international airtime/data for the countries VTpass's catalogue lists.
   */
  route(country: Country, category: Category): ProviderId | null {
    if (!this.deps.vtpass) return null;
    if (country.iso === "NG") return "vtpass";
    if (category === "electricity") return null; // electricity: Nigeria only
    return this.deps.intl && this.deps.intlCountries.has(country.iso) ? "vtpass" : null;
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

    const { costNgn: cost, ...product } = country.iso === "NG" ? await this.vtpassProduct(input, country) : await this.intlProduct(input, country);

    // International orders are priced from what VTpass charges in naira, so the sats always cover the cost.
    const rate = await this.deps.rates.current(cost === undefined ? product.currency : "NGN").catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now. Try again in a minute.");
    });
    const amountSats = localToSats(cost ?? product.amountLocal, rate.perBtc, this.deps.limits.feeBps);
    // Local units per BTC actually paid, so the order page converts sats <-> local amount consistently.
    const ratePerBtc = cost === undefined ? rate.perBtc : (product.amountLocal * 100_000_000) / amountSats;
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
        ratePerBtc,
        rateSource: cost === undefined ? rate.source : `${rate.source} (NGN) + VTpass rate`,
        paymentHash: paymentHashHex,
        preimage: preimageHex,
        invoice,
        invoiceExpiresAt: nowMs + this.deps.limits.invoiceExpirySec * 1000,
        requestId: newRequestId(new Date(nowMs)),
      },
      nowMs,
    );
  }

  /** International airtime/data via VTpass: product and price always come from VTpass's catalogue. */
  private async intlProduct(input: CreateOrderInput, country: Country): Promise<Product> {
    const intl = this.deps.intl;
    if (!intl || input.category === "electricity") throw new AppError(400, "unsupported", "That service is not available in this country yet.");
    if (!input.operatorId) throw new AppError(400, "unknown_operator", "Pick a mobile network.");
    if (!input.variationCode) throw new AppError(400, "unknown_plan", "Pick a product.");
    const intlPhone = this.deps.vtpassSandbox && SANDBOX_INTL_NUMBERS.has(input.phone.replace(/\s/g, "")) ? input.phone.replace(/\s/g, "") : toInternational(input.phone, country);
    if (!intlPhone) throw new AppError(400, "bad_phone", `Enter a valid ${country.name} phone number.`);
    const operator = (await intl.operators(country.iso, input.category)).find((o) => o.operatorId === input.operatorId);
    if (!operator) throw new AppError(400, "unknown_operator", "That network is not available.");
    const offer = await intl.findOffer(operator.operatorId, input.category, input.variationCode);
    const amountLocal = offer.isFixed ? (offer.amountLocal as number) : (input.amountLocal ?? 0);
    const cost = costNgn(offer, amountLocal);
    if (cost > this.deps.limits.maxNgn) throw new AppError(400, "bad_amount", "That amount is above Confam's per-order limit.");
    const label = offer.isFixed ? `${operator.name}: ${offer.name}` : `${fmt(amountLocal, offer.currency)} ${operator.name} airtime`;
    return {
      category: input.category,
      provider: "vtpass",
      countryCode: country.iso,
      currency: offer.currency,
      serviceId: INTL_SERVICE_ID,
      operatorId: operator.operatorId,
      variationCode: offer.variationCode,
      productLabel: label,
      amountLocal,
      billersCode: intlPhone,
      phone: intlPhone,
      recipientMasked: `+${maskId(intlPhone)}`,
      meterType: null,
      customerName: null,
      costNgn: cost,
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
