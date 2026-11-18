import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type MeterInfo } from "../../api.ts";
import { money, sats } from "../../format.ts";
import { useT } from "../../i18n.ts";

/** International products are quoted from VTpass's naira cost (exactly what the invoice will be). */
export type IntlQuoteKey = { operatorId: string; category: "airtime" | "data"; variationCode: string };

/** Debounced live quote: local amount -> sats. */
export function useQuote(amount: number, currency: string, intl?: IntlQuoteKey | null): number | null {
  const [quote, setQuote] = useState<number | null>(null);
  const intlKey = intl ? `${intl.operatorId}|${intl.category}|${intl.variationCode}` : "";
  useEffect(() => {
    if (!amount) {
      setQuote(null);
      return;
    }
    let alive = true;
    const [operatorId, category, variationCode] = intlKey.split("|") as [string, "airtime" | "data", string];
    const t = setTimeout(() => {
      (intlKey ? api.intlQuote(operatorId, category, variationCode, amount) : api.quote(amount, currency))
        .then((q) => alive && setQuote(q.amountSats))
        .catch(() => alive && setQuote(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [amount, currency, intlKey]);
  return quote;
}

type QuoteRowsProps = {
  amount: number;
  currency: string;
  intl?: IntlQuoteKey | null;
};

export function QuoteRows({ amount, currency, intl }: QuoteRowsProps) {
  const { lang, t } = useT();
  const quote = useQuote(amount, currency, intl);
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
  /** What still blocks the button, in plain words (shown under it, never a silent grey button). */
  missing?: string | null;
};

export function SubmitBar({ canSubmit, isBusy, error, missing }: SubmitProps) {
  const { t } = useT();
  const blocker = !canSubmit && !isBusy && missing ? missing : null;
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="btn-row">
        <button type="submit" className="btn lime" disabled={!canSubmit || isBusy} aria-describedby={blocker ? "submit-blocker" : undefined}>
          {isBusy ? <span className="spinner" aria-hidden="true" /> : null}
          {isBusy ? t.preparing : t.continuePay}
        </button>
      </div>
      <p id="submit-blocker" className="hint submit-hint" aria-live="polite">
        {blocker ? `${t.toContinue} ${blocker}` : ""}
      </p>
    </>
  );
}

/** Inline field error, tied to its input with aria-describedby. */
export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <span id={id} className="field-error" role="alert">
      {message}
    </span>
  );
}

/** A tap-to-fill chip for the providers' sandbox test numbers (only rendered in test mode). */
export function TestFill({ label, onFill }: { label: string; onFill: () => void }) {
  return (
    <button type="button" className="chip chip--small" onClick={onFill}>
      {label}
    </button>
  );
}

/**
 * Meter lookup for one meter number. A reply for a number the customer has since edited is ignored,
 * and editing the number clears both the old result and the old error.
 */
export function useMeterCheck(key: string, verify: () => Promise<MeterInfo>, fallbackError: string, isAutoReady = false) {
  const [meter, setMeter] = useState<MeterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const currentKey = useRef(key);

  useEffect(() => {
    currentKey.current = key;
    setMeter(null);
    setError(null);
    setIsVerifying(false);
  }, [key]);

  const check = useCallback(async (): Promise<void> => {
    const asked = currentKey.current;
    setError(null);
    setIsVerifying(true);
    try {
      const info = await verify();
      if (currentKey.current === asked) setMeter(info);
    } catch (err) {
      if (currentKey.current === asked) setError(err instanceof ApiError ? err.message : fallbackError);
    } finally {
      if (currentKey.current === asked) setIsVerifying(false);
    }
  }, [verify, fallbackError]);

  // Once the number looks complete, check it after a short pause in typing: no separate step to find.
  useEffect(() => {
    if (!isAutoReady) return;
    const timer = setTimeout(() => void check(), AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, isAutoReady, check]);

  return { meter, error, isVerifying, check };
}

const AUTO_CHECK_DELAY_MS = 700;

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
