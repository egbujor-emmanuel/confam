/**
 * In-browser wallet over Nostr Wallet Connect. The SDK is loaded lazily (only when the user
 * opens or uses the wallet) to keep the first page load small on slow networks.
 */
type NWCClientType = import("@getalby/sdk/nwc").NWCClient;

const KEY = "confam.nwc";
let client: NWCClientType | null = null;
let clientUrl: string | null = null;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function savedWalletUrl(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveWalletUrl(url: string): void {
  if (!url.startsWith("nostr+walletconnect://")) throw new Error("That is not a Nostr Wallet Connect link.");
  try {
    storage()?.setItem(KEY, url);
  } catch {
    /* private mode: wallet works for this session only */
  }
  disconnect();
  clientUrl = url;
}

export function forgetWallet(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
  disconnect();
}

function disconnect(): void {
  client?.close();
  client = null;
  clientUrl = null;
}

async function getClient(): Promise<NWCClientType> {
  const url = clientUrl ?? savedWalletUrl();
  if (!url) throw new Error("No wallet connected.");
  if (client && clientUrl === url) return client;
  const { NWCClient } = await import("@getalby/sdk/nwc");
  client = new NWCClient({ nostrWalletConnectUrl: url });
  clientUrl = url;
  return client;
}

export async function walletBalanceSats(): Promise<number> {
  const c = await getClient();
  const { balance } = await c.getBalance();
  return Math.floor(balance / 1000);
}

/**
 * Pays a (hold) invoice. With hold invoices the call only resolves once the merchant settles
 * (delivery confirmed) or rejects once it cancels, so callers should not block the UI on it.
 */
export async function walletPay(invoice: string): Promise<{ preimage: string }> {
  const c = await getClient();
  return c.payInvoice({ invoice });
}
