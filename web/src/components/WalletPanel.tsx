import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig } from "../api.ts";
import { sats } from "../format.ts";
import { forgetWallet, saveWalletUrl } from "../wallet.ts";

type Props = {
  config: AppConfig | null;
  isConnected: boolean;
  balance: number | null;
  onClose: () => void;
  onChanged: () => void;
};

export function WalletPanel({ config, isConnected, balance, onClose, onChanged }: Props) {
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
          Your wallet
        </p>
        {isConnected ? (
          <>
            <h2 className="money">{balance === null ? "…" : sats(balance)}</h2>
            <p className="muted">Connected with Nostr Wallet Connect. Your keys stay with your wallet provider, not with Confam.</p>
            <div className="btn-row">
              <button ref={firstButton} type="button" className="btn" onClick={onClose}>
                Done
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  forgetWallet();
                  onChanged();
                }}
              >
                Disconnect this wallet
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Pay in one tap</h2>
            <p className="muted">Connect a Lightning wallet, or grab a free test wallet to try Confam right now.</p>
            <div className="btn-row">
              {config?.testWallet.enabled && (
                <button ref={firstButton} type="button" className="btn lime" onClick={handleCreate} disabled={isBusy}>
                  {isBusy ? <span className="spinner" aria-hidden="true" /> : null}
                  {isBusy ? "Creating…" : `Get a free test wallet (${sats(config.testWallet.balanceSats ?? 0)})`}
                </button>
              )}
            </div>
            <hr className="dash" />
            <div className="field">
              <label className="label" htmlFor="nwc">
                Or paste a Nostr Wallet Connect link
              </label>
              <input id="nwc" className="input mono" placeholder="nostr+walletconnect://…" value={nwc} onChange={(e) => setNwc(e.target.value)} autoComplete="off" />
              <span className="hint">Tip: create the connection with a small spending budget (e.g. in Alby Hub). It stays on this device.</span>
            </div>
            <button type="button" className="btn ghost" onClick={handleConnect} disabled={!nwc.startsWith("nostr+walletconnect://")}>
              Connect this wallet
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
