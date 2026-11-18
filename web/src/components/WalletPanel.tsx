import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig } from "../api.ts";
import { sats } from "../format.ts";
import { useT } from "../i18n.ts";
import { forgetWallet, saveWalletUrl } from "../wallet.ts";

type Props = {
  config: AppConfig | null;
  isConnected: boolean;
  balance: number | null;
  onClose: () => void;
  onChanged: () => void;
};

export function WalletPanel({ config, isConnected, balance, onClose, onChanged }: Props) {
  const { lang, t } = useT();
  const [nwc, setNwc] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButton.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleCreate(): Promise<void> {
    setError(null);
    setIsBusy(true);
    try {
      const { nwcUrl } = await api.testWallet();
      saveWalletUrl(nwcUrl);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create a test wallet.");
    } finally {
      setIsBusy(false);
    }
  }

  function handleConnect(): void {
    setError(null);
    try {
      saveWalletUrl(nwc.trim());
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid link.");
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow" id="wallet-title">
          {t.walletTitle}
        </p>
        {isConnected ? (
          <>
            <h2 className="money">{balance === null ? "…" : sats(balance, lang)}</h2>
            <p className="muted">{t.walletConnectedNote}</p>
            <div className="btn-row">
              <button ref={firstButton} type="button" className="btn" onClick={onClose}>
                {t.done}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  forgetWallet();
                  onChanged();
                }}
              >
                {t.disconnect}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>{t.payInOneTap}</h2>
            <p className="muted">{t.walletIntro}</p>
            {config?.testWallet.enabled && (
              <div className="btn-row">
                <button ref={firstButton} type="button" className="btn lime" onClick={handleCreate} disabled={isBusy}>
                  {isBusy ? <span className="spinner" aria-hidden="true" /> : null}
                  {isBusy ? t.creating : t.freeTestWallet(sats(config.testWallet.balanceSats ?? 0, lang))}
                </button>
              </div>
            )}
            <hr className="dash" />
            <div className="field">
              <label className="label" htmlFor="nwc">
                {t.pasteNwc}
              </label>
              <input id="nwc" className="input mono" placeholder="nostr+walletconnect://…" value={nwc} onChange={(e) => setNwc(e.target.value)} autoComplete="off" />
              <span className="hint">{t.nwcTip}</span>
            </div>
            <button type="button" className="btn ghost" onClick={handleConnect} disabled={!nwc.startsWith("nostr+walletconnect://")}>
              {t.connectThis}
            </button>
          </>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
