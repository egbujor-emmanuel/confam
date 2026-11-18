import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().default("0.0.0.0"),
    PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    DB_PATH: z.string().default("./data/confam.db"),

    // Lightning backend: the merchant wallet that issues hold invoices.
    LN_BACKEND: z.enum(["nwc", "lnd"]).default("nwc"),
    MERCHANT_NWC_URL: z.string().startsWith("nostr+walletconnect://").optional(),
    LND_REST_URL: z.url().optional(),
    LND_INVOICE_MACAROON_HEX: z
      .string()
      .regex(/^[0-9a-fA-F]+$/)
      .optional(),
    LIGHTNING_NETWORK_LABEL: z.string().default("NWC test wallets"),

    // VTpass bill-payment API (sandbox by default).
    VTPASS_BASE_URL: z.url().default("https://sandbox.vtpass.com"),
    VTPASS_API_KEY: z.string().min(1).optional(),
    VTPASS_PUBLIC_KEY: z.string().min(1).optional(),
    VTPASS_SECRET_KEY: z.string().min(1).optional(),

    /**
     * Where the international airtime/data catalogue is read from (public endpoints). Defaults to
     * VTPASS_BASE_URL; https://vtpass.com gives the real per-country networks and prices.
     */
    VTPASS_INTL_CATALOG_URL: z.url().optional(),
    /** Customer email VTpass requires on international orders. Defaults to VTpass's sandbox address. */
    VTPASS_CUSTOMER_EMAIL: z.email().default("sandbox@sandbox.vtpass.com"),

    // Signs delivery receipts (Nostr event signatures).
    NOSTR_SECRET_KEY_HEX: z.string().regex(/^[0-9a-fA-F]{64}$/),

    // Money rules.
    INVOICE_EXPIRY_SEC: z.coerce.number().int().min(60).max(3600).default(600),
    VEND_DEADLINE_SEC: z.coerce.number().int().min(15).max(900).default(90),
    MIN_ORDER_NGN: z.coerce.number().int().min(1).default(50),
    MAX_ORDER_NGN: z.coerce.number().int().min(1).default(50000),
    /** Per-order cap in any currency, expressed in sats. */
    MAX_ORDER_SATS: z.coerce.number().int().min(100).default(100000),
    SERVICE_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(0),

    // Demo helpers.
    TEST_WALLET_FAUCET: bool.default(true),
    TEST_WALLET_BALANCE_SATS: z.coerce.number().int().min(1000).max(100000).default(25000),
    ENGINE_TICK_MS: z.coerce.number().int().min(250).max(10000).default(1500),
  })
  .superRefine((env, ctx) => {
    if (env.LN_BACKEND === "nwc" && !env.MERCHANT_NWC_URL) {
      ctx.addIssue({ code: "custom", path: ["MERCHANT_NWC_URL"], message: "required when LN_BACKEND=nwc" });
    }
    if (env.LN_BACKEND === "lnd" && (!env.LND_REST_URL || !env.LND_INVOICE_MACAROON_HEX)) {
      ctx.addIssue({
        code: "custom",
        path: ["LND_REST_URL"],
        message: "LND_REST_URL and LND_INVOICE_MACAROON_HEX are required when LN_BACKEND=lnd",
      });
    }
    if (env.MIN_ORDER_NGN >= env.MAX_ORDER_NGN) {
      ctx.addIssue({ code: "custom", path: ["MIN_ORDER_NGN"], message: "must be below MAX_ORDER_NGN" });
    }
  });

export type Config = z.infer<typeof EnvSchema> & {
  vtpassConfigured: boolean;
  vtpassIsSandbox: boolean;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` lines in .env mean "not set": drop empty strings so optional values stay optional.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration. Run "npm run setup" or fix .env:\n${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    vtpassConfigured: Boolean(cfg.VTPASS_API_KEY && cfg.VTPASS_PUBLIC_KEY && cfg.VTPASS_SECRET_KEY),
    vtpassIsSandbox: new URL(cfg.VTPASS_BASE_URL).hostname.startsWith("sandbox."),
    corsOrigins: cfg.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
