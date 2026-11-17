import { useEffect, useState } from "react";
import { api, type AppConfig, type Category } from "./api.ts";
import { BuyForm } from "./components/BuyForm.tsx";
import { Home } from "./components/Home.tsx";
import { OrderPage } from "./components/OrderPage.tsx";
import { WalletPanel } from "./components/WalletPanel.tsx";
import { sats } from "./format.ts";
import { useHashRoute, useWalletBalance } from "./hooks.ts";

const CATEGORIES: readonly Category[] = ["airtime", "data", "electricity"];

export function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const wallet = useWalletBalance(5000);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const buyMatch = route.match(/^#\/buy\/(\w+)$/);
  const orderMatch = route.match(/^#\/order\/([A-Za-z0-9_-]{22})$/);
  const buyCategory = buyMatch && CATEGORIES.includes(buyMatch[1] as Category) ? (buyMatch[1] as Category) : null;

  let page;
  if (orderMatch?.[1]) page = <OrderPage orderId={orderMatch[1]} config={config} onOpenWallet={() => setIsWalletOpen(true)} />;
  else if (buyCategory) page = <BuyForm key={buyCategory} category={buyCategory} config={config} />;
  else page = <Home config={config} />;

  const walletLabel = wallet.connected ? (wallet.balance === null ? "Wallet…" : sats(wallet.balance)) : "Connect wallet";

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Confam home">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 64 64">
              <path d="M14 33l11 11 25-26" fill="none" stroke="#0b3d2e" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Confam
        </a>
        <button type="button" className="wallet-chip" onClick={() => setIsWalletOpen(true)} aria-haspopup="dialog">
          <span aria-hidden="true">⚡</span>
          <span className={wallet.connected ? "num" : undefined}>{walletLabel}</span>
        </button>
      </header>

      <main>{page}</main>

      <footer className="footer">
        <p>
          Payments use Lightning <strong>hold invoices</strong>: settled only after the provider confirms delivery.
          {config?.provider.sandbox ? " Running on test networks (VTpass sandbox)." : ""}
        </p>
        <p>
          <a href="https://github.com/" rel="noopener noreferrer" target="_blank">
            Open source
          </a>{" "}
          · Built for Dakar Bitcoin Hack 2026
        </p>
      </footer>

      {isWalletOpen && (
        <WalletPanel
          config={config}
          isConnected={wallet.connected}
          balance={wallet.balance}
          onClose={() => setIsWalletOpen(false)}
          onChanged={wallet.reconnect}
        />
      )}
    </div>
  );
}
