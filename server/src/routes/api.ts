import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.ts";
import { COUNTRIES, findCountry, toInternational } from "../countries.ts";
import { AppError } from "../errors.ts";
import type { HoldInvoiceProvider } from "../lightning/types.ts";
import { CreateOrderSchema, type OrderService } from "../orders/service.ts";
import type { OrderStore } from "../orders/store.ts";
import type { Category } from "../orders/types.ts";
import { toPublicOrder } from "../orders/view.ts";
import { localToSats, type RateService } from "../pricing/rates.ts";
import type { ReceiptSigner } from "../receipts/sign.ts";
import type { Catalog } from "../vtpass/catalog.ts";
import { costNgn, type IntlCatalog } from "../vtpass/intl.ts";

export interface ApiDeps {
  cfg: Config;
  store: OrderStore;
  orders: OrderService;
  /** Asks the order engine to process an order right away (it also polls on its own). */
  kick: (orderId: string) => void;
  catalog: Catalog;
  intl: IntlCatalog | null;
  rates: Pick<RateService, "current">;
  signer: ReceiptSigner;
  ln: HoldInvoiceProvider;
  fetchImpl?: typeof fetch;
}

const CATEGORIES = ["airtime", "data", "electricity"] as const;
const isoSchema = z.string().regex(/^[A-Za-z]{2}$/);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError(400, "invalid_input", first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input");
  }
  return r.data;
}

function requireCountry(iso: string) {
  const c = findCountry(iso);
  if (!c) throw new AppError(400, "unknown_country", "That country is not supported yet.");
  return c;
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { cfg } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => ({
    lightning: { backend: deps.ln.kind, network: cfg.LIGHTNING_NETWORK_LABEL },
    providers: {
      vtpass: { configured: cfg.vtpassConfigured, sandbox: cfg.vtpassIsSandbox },
    },
    limits: { minNgn: cfg.MIN_ORDER_NGN, maxNgn: cfg.MAX_ORDER_NGN, maxSats: cfg.MAX_ORDER_SATS, vendDeadlineSec: cfg.VEND_DEADLINE_SEC },
    testWallet: cfg.TEST_WALLET_FAUCET ? { enabled: true, balanceSats: cfg.TEST_WALLET_BALANCE_SATS } : { enabled: false },
    receipts: { npub: deps.signer.npub, pubkey: deps.signer.pubkeyHex },
  }));

  app.get("/api/countries", async () => {
    const all = COUNTRIES.map((c) => ({
      ...c,
      services: Object.fromEntries(CATEGORIES.map((cat) => [cat, deps.orders.route(c, cat)])),
    }));
    // Only list countries we can actually serve; with no provider configured, list all so the UI still renders.
    const served = all.filter((c) => Object.values(c.services).some(Boolean));
    return { countries: served.length > 0 ? served : all };
  });

  // VTpass international airtime/data: networks per country, then products (with naira cost) per network.
  const intlCategory = z.enum(["airtime", "data"]);
  app.get<{ Querystring: { country?: string; category?: string } }>("/api/intl/operators", async (req) => {
    const country = requireCountry(parse(isoSchema, req.query.country));
    const category = parse(intlCategory, req.query.category ?? "airtime");
    if (!deps.intl || deps.orders.route(country, category) !== "vtpass" || country.iso === "NG") {
      throw new AppError(503, "provider_unconfigured", "This service is not available in that country yet.");
    }
    return { operators: await deps.intl.operators(country.iso, category) };
  });

  app.get<{ Querystring: { operator?: string; category?: string } }>("/api/intl/offers", async (req) => {
    if (!deps.intl) throw new AppError(503, "provider_unconfigured", "This service is not available yet.");
    const operatorId = parse(z.string().regex(/^\d{1,8}$/), req.query.operator);
    const category = parse(intlCategory, req.query.category ?? "airtime");
    const offers = await deps.intl.offers(operatorId, category);
    // The customer sees local amounts; the naira cost stays server-side (it only sets the sats price).
    return {
      offers: offers.map((o) => ({
        variationCode: o.variationCode,
        name: o.name,
        currency: o.currency,
        isFixed: o.isFixed,
        amountLocal: o.amountLocal,
        minLocal: o.minLocal,
        maxLocal: o.maxLocal,
      })),
    };
  });

  // Exact sats for an international product: priced from VTpass's naira cost, as the order will be.
  app.get<{ Querystring: { operator?: string; category?: string; variation?: string; amount?: string } }>("/api/intl/quote", async (req) => {
    if (!deps.intl) throw new AppError(503, "provider_unconfigured", "This service is not available yet.");
    const operatorId = parse(z.string().regex(/^\d{1,8}$/), req.query.operator);
    const category = parse(intlCategory, req.query.category ?? "airtime");
    const variation = parse(z.string().regex(/^[\w.-]{1,60}$/), req.query.variation);
    const offer = await deps.intl.findOffer(operatorId, category, variation);
    const amountLocal = offer.isFixed ? (offer.amountLocal as number) : parse(z.coerce.number().positive().max(10_000_000), req.query.amount);
    const cost = costNgn(offer, amountLocal);
    const rate = await deps.rates.current("NGN").catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now.");
    });
    return { amountLocal, currency: offer.currency, amountSats: localToSats(cost, rate.perBtc, cfg.SERVICE_FEE_BPS) };
  });

  // VTpass (Nigeria) catalogue.
  app.get<{ Params: { category: string } }>("/api/catalog/:category", async (req) => {
    const category = parse(z.enum(CATEGORIES), req.params.category) as Category;
    return { services: await deps.catalog.list(category) };
  });

  app.get<{ Params: { serviceID: string } }>("/api/catalog/variations/:serviceID", async (req) => {
    const serviceID = parse(z.string().regex(/^[a-z0-9-]{2,40}-data$/), req.params.serviceID);
    return { variations: await deps.catalog.listVariations(serviceID) };
  });

  app.post("/api/meter/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = parse(
      z.object({
        serviceID: z.string().regex(/^[a-z0-9-]{2,40}$/),
        meterNumber: z.string().regex(/^\d{6,13}$/),
        meterType: z.enum(["prepaid", "postpaid"]),
      }),
      req.body,
    );
    return deps.orders.verifyMeter(body.serviceID, body.meterNumber, body.meterType);
  });

  app.get<{ Querystring: { amount?: string; currency?: string } }>("/api/quote", async (req) => {
    const amount = parse(z.coerce.number().positive().max(10_000_000), req.query.amount);
    const currency = parse(z.string().regex(/^[A-Za-z]{3}$/), req.query.currency ?? "NGN").toUpperCase();
    if (!COUNTRIES.some((c) => c.currency === currency)) throw new AppError(400, "unknown_currency", "Unsupported currency.");
    const rate = await deps.rates.current(currency).catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now.");
    });
    return { amount, currency, amountSats: localToSats(amount, rate.perBtc, cfg.SERVICE_FEE_BPS), perBtc: rate.perBtc, source: rate.source };
  });

  app.post("/api/orders", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = parse(CreateOrderSchema, req.body);
    const order = await deps.orders.create(input);
    deps.kick(order.id);
    reply.code(201);
    return toPublicOrder(order, deps.store.events(order.id));
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req) => {
    const id = parse(z.string().regex(/^[A-Za-z0-9_-]{22}$/), req.params.id);
    const order = deps.store.get(id);
    if (!order) throw new AppError(404, "not_found", "Order not found.");
    return toPublicOrder(order, deps.store.events(id));
  });

  app.post("/api/test-wallet", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async () => {
    if (!cfg.TEST_WALLET_FAUCET) throw new AppError(404, "disabled", "Test wallets are disabled.");
    let text = "";
    try {
      const res = await fetchImpl(`https://faucet.nwc.dev?balance=${cfg.TEST_WALLET_BALANCE_SATS}`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
      });
      text = (await res.text()).trim();
    } catch {
      throw new AppError(502, "faucet_unavailable", "The test-wallet faucet is unavailable. Try again shortly.");
    }
    if (!text.startsWith("nostr+walletconnect://")) {
      throw new AppError(502, "faucet_unavailable", "The test-wallet faucet returned an unexpected response.");
    }
    return { nwcUrl: text, balanceSats: cfg.TEST_WALLET_BALANCE_SATS };
  });
}
