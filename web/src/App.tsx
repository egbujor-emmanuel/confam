import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AppConfig, type Category, type Country } from "./api.ts";
import { BuyForm } from "./components/BuyForm.tsx";
import { Home } from "./components/Home.tsx";
import { OrderPage } from "./components/OrderPage.tsx";
import { WalletPanel } from "./components/WalletPanel.tsx";
import { initialCountry, saveCountry } from "./country.ts";
import { useHashRoute, useWalletBalance } from "./hooks.ts";
import { DICTS, LangContext, detectLang, saveLang, type Lang } from "./i18n.ts";

const CATEGORIES: readonly Category[] = ["airtime", "data", "electricity"];

export function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryIso, setCountryIso] = useState(initialCountry);
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const wallet = useWalletBalance(5000);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
    api.countries().then(setCountries).catch(() => setCountries([]));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    saveLang(l);
  }, []);
  const onCountry = useCallback((iso: string) => {
    setCountryIso(iso);
    saveCountry(iso);
  }, []);

  const t = DICTS[lang];
  const langValue = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  const country = countries.find((c) => c.iso === countryIso) ?? countries[0] ?? null;

  const buyMatch = route.match(/^#\/buy\/(\w+)$/);
  const orderMatch = route.match(/^#\/order\/([A-Za-z0-9_-]{22})$/);
  const buyCategory = buyMatch && CATEGORIES.includes(buyMatch[1] as Category) ? (buyMatch[1] as Category) : null;

  let page;
  if (orderMatch?.[1]) page = <OrderPage orderId={orderMatch[1]} config={config} onOpenWallet={() => setIsWalletOpen(true)} />;
  else if (buyCategory) page = <BuyForm category={buyCategory} config={config} countries={countries} country={country} onCountry={onCountry} />;
  else page = <Home config={config} countries={countries} country={country} onCountry={onCountry} />;

  // Compact in the header (exact balance lives in the wallet sheet) so the bar fits a 360px phone.
  // Below 400px the "sats" unit is hidden visually; the accessible name always carries it.
  const compactBalance =
    wallet.connected && wallet.balance !== null
      ? new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(wallet.balance)
      : null;
  const walletAria = wallet.connected
    ? `${t.walletAria}: ${wallet.balance === null ? "…" : `${new Intl.NumberFormat(lang).format(wallet.balance)} sats`}`
    : t.connectWallet;
  const anySandbox = config ? Object.values(config.providers).some((p) => p.configured && p.sandbox) : false;

  return (
    <LangContext.Provider value={langValue}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#/" aria-label="Confam">
            <img className="brand-mark" src="/icons/brand-96.webp" width="34" height="34" alt="" decoding="async" />
            <span className="brand-name">Confam</span>
          </a>
          <div className="topbar__actions">
            <div className="lang-switch" role="group" aria-label="Language">
              {(["en", "fr"] as const).map((l) => (
                <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
            <button type="button" className="wallet-chip" onClick={() => setIsWalletOpen(true)} aria-haspopup="dialog" aria-label={walletAria}>
              <span aria-hidden="true">⚡</span>
              {wallet.connected ? (
                <span className="num" aria-hidden="true">
                  {compactBalance ?? "…"}
                  {compactBalance !== null && <span className="unit"> sats</span>}
                </span>
              ) : (
                <span aria-hidden="true">
                  <span className="label-long">{t.connectWallet}</span>
                  <span className="label-short">{t.connectShort}</span>
                </span>
              )}
            </button>
          </div>
        </header>

        <main>{page}</main>

        <footer className="footer">
          <p>
            {t.footer1} {anySandbox ? t.footerTest : ""}
          </p>
          <p>
            <a href="https://github.com/egbujor-emmanuel/confam" rel="noopener noreferrer" target="_blank">
              {t.openSource}
            </a>{" "}
            · {t.footer2}
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
    </LangContext.Provider>
  );
}
