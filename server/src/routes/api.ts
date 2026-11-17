import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { HoldInvoiceProvider } from "../lightning/types.ts";
import { CreateOrderSchema, type OrderService } from "../orders/service.ts";
import type { OrderStore } from "../orders/store.ts";
import type { Category } from "../orders/types.ts";
import { toPublicOrder } from "../orders/view.ts";
import { ngnToSats, type RateService } from "../pricing/rates.ts";
import type { ReceiptSigner } from "../receipts/sign.ts";
import type { Catalog } from "../vtpass/catalog.ts";

export interface ApiDeps {
  cfg: Config;
  store: OrderStore;
  orders: OrderService;
  /** Asks the order engine to process an order right away (it also polls on its own). */
  kick: (orderId: string) => void;
  catalog: Catalog;
  rates: Pick<RateService, "current">;
  signer: ReceiptSigner;
  ln: HoldInvoiceProvider;
  fetchImpl?: typeof fetch;
}

const CATEGORIES = ["airtime", "data", "electricity"] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError(400, "invalid_input", first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input");
  }
  return r.data;
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { cfg } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => ({
    lightning: { backend: deps.ln.kind, network: cfg.LIGHTNING_NETWORK_LABEL },
    provider: { configured: cfg.vtpassConfigured, sandbox: cfg.vtpassIsSandbox },
    limits: { minNgn: cfg.MIN_ORDER_NGN, maxNgn: cfg.MAX_ORDER_NGN, vendDeadlineSec: cfg.VEND_DEADLINE_SEC },
    testWallet: cfg.TEST_WALLET_FAUCET ? { enabled: true, balanceSats: cfg.TEST_WALLET_BALANCE_SATS } : { enabled: false },
    receipts: { npub: deps.signer.npub, pubkey: deps.signer.pubkeyHex },
  }));

  app.get<{ Params: { category: string } }>("/api/catalog/:category", async (req) => {
    const category = parse(z.enum(CATEGORIES), req.params.category) as Category;
    return { services: await deps.catalog.list(category) };
  });

  app.get<{ Params: { serviceID: string } }>("/api/catalog/variations/:serviceID", async (req) => {
    const serviceID = parse(z.string().regex(/^[a-z0-9-]{2,40}-data$/), req.params.serviceID);
    return { variations: await deps.catalog.listVariations(serviceID) };
  });

  app.post(
    "/api/meter/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const body = parse(
        z.object({
          serviceID: z.string().regex(/^[a-z0-9-]{2,40}$/),
          meterNumber: z.string().regex(/^\d{6,13}$/),
          meterType: z.enum(["prepaid", "postpaid"]),
        }),
        req.body,
      );
      return deps.orders.verifyMeter(body.serviceID, body.meterNumber, body.meterType);
    },
  );

  app.get<{ Querystring: { amountNgn?: string } }>("/api/quote", async (req) => {
    const amountNgn = parse(z.coerce.number().int().min(1).max(cfg.MAX_ORDER_NGN), req.query.amountNgn);
    const rate = await deps.rates.current().catch(() => {
      throw new AppError(503, "no_rate", "Bitcoin price is unavailable right now.");
    });
    return {
      amountNgn,
      amountSats: ngnToSats(amountNgn, rate.ngnPerBtc, cfg.SERVICE_FEE_BPS),
      ngnPerBtc: rate.ngnPerBtc,
      source: rate.source,
    };
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
