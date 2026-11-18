import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { money, sats } from "../../format.ts";
import { useT } from "../../i18n.ts";

/** Debounced live quote: local amount -> sats. */
export function useQuote(amount: number, currency: string): number | null {
  const [quote, setQuote] = useState<number | null>(null);
  useEffect(() => {
    if (!amount) {
      setQuote(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .quote(amount, currency)
        .then((q) => alive && setQuote(q.amountSats))
        .catch(() => alive && setQuote(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [amount, currency]);
  return quote;
}

type QuoteRowsProps = {
  amount: number;
  currency: string;
};

export function QuoteRows({ amount, currency }: QuoteRowsProps) {
  const { lang, t } = useT();
  const quote = useQuote(amount, currency);
  if (!amount) return null;
  return (
    <dl className="rows quote" aria-live="polite">
      <div>
        <dt>{t.youPay}</dt>
        <dd className="money">{money(amount, currency, lang)}</dd>
      </div>
      <div>
        <dt>{t.inBitcoin}</dt>
        <dd className="money">{quote ? `≈ ${sats(quote, lang)}` : "…"}</dd>
      </div>
    </dl>
  );
}

type SubmitProps = {
  canSubmit: boolean;
  isBusy: boolean;
  error: string | null;
};

export function SubmitBar({ canSubmit, isBusy, error }: SubmitProps) {
  const { t } = useT();
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="btn-row">
        <button type="submit" className="btn lime" disabled={!canSubmit || isBusy}>
          {isBusy ? <span className="spinner" aria-hidden="true" /> : null}
          {isBusy ? t.preparing : t.continuePay}
        </button>
      </div>
    </>
  );
}

type AmountChipsProps = {
  amounts: number[];
  value: string;
  currency: string;
  onPick: (v: string) => void;
};

export function AmountChips({ amounts, value, currency, onPick }: AmountChipsProps) {
  const { lang } = useT();
  if (amounts.length === 0) return null;
  return (
    <div className="chips" aria-label="Quick amounts">
      {amounts.map((a) => (
        <button key={a} type="button" className="chip" aria-pressed={value === String(a)} onClick={() => onPick(String(a))}>
          {money(a, currency, lang)}
        </button>
      ))}
    </div>
  );
}
