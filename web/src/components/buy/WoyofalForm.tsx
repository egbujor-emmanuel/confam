import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Country } from "../../api.ts";
import { money, sats } from "../../format.ts";
import { navigate } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { AmountChips, FieldError, SubmitBar, useMeterCheck } from "./shared.tsx";

type Props = {
  country: Country;
  sandbox: boolean;
};

const MIN_XOF = 500;
const MAX_XOF = 100_000;
const QUICK = [1000, 2000, 5000, 10_000];

/** Senegal: Woyofal prepaid electricity (Senelec) through DEXPAY. The token appears on the order page. */
export function WoyofalForm({ country, sandbox }: Props) {
  const { lang, t } = useT();
  const [meterNumber, setMeterNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ fee: number; amountSats: number } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountXof = Number(amount);
  const inRange = Number.isInteger(amountXof) && amountXof >= MIN_XOF && amountXof <= MAX_XOF;

  const verify = useCallback(() => api.verifyWoyofal(meterNumber), [meterNumber]);
  const { meter, error: meterError, isVerifying, check: handleVerifyMeter } = useMeterCheck(meterNumber, verify, "Could not check that meter.", meterNumber.length >= 11);
  const canCheckMeter = meterNumber.length >= 6 && !isVerifying;

  // Exact quote (recharge + DEXPAY's fee), debounced.
  useEffect(() => {
    setQuote(null);
    if (!inRange) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .woyofalQuote(amountXof)
        .then((q) => alive && setQuote({ fee: q.fee, amountSats: q.amountSats }))
        .catch(() => alive && setQuote(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amountXof, inRange]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      const order = await api.createOrder({
        category: "electricity",
        countryCode: country.iso,
        serviceID: "woyofal",
        meterNumber,
        meterType: "prepaid",
        phone,
        amountLocal: amountXof,
      });
      navigate(`#/order/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your order.");
      setIsBusy(false);
    }
  }

  const phoneOk = phone.replace(/\D/g, "").length >= 7;
  const canSubmit = meter !== null && inRange && phoneOk;
  const rangeText = [money(MIN_XOF, "XOF", lang), money(MAX_XOF, "XOF", lang)] as const;
  const amountError = amount !== "" && !inRange ? t.amountOutOfRange(...rangeText) : null;
  const missing = !meter ? t.needMeter : !phoneOk ? t.needPhone : !inRange ? t.needAmount(...rangeText) : null;

  return (
    <form onSubmit={handleSubmit} noValidate>
      <p className="muted">{t.woyofalCompany}</p>
      <div className="field">
        <label className="label" htmlFor="meter">
          {t.meterNumber}
        </label>
        <input
          id="meter"
          className="input mono"
          inputMode="numeric"
          autoComplete="off"
          value={meterNumber}
          aria-invalid={meterError ? true : undefined}
          aria-describedby={meterError ? "meter-error" : undefined}
          onChange={(e) => setMeterNumber(e.target.value.replace(/\D/g, "").slice(0, 20))}
          onBlur={() => {
            if (!meter && canCheckMeter) void handleVerifyMeter();
          }}
        />
        <FieldError id="meter-error" message={meterError} />
        {sandbox && <span className="hint">{t.sandboxWoyofal}</span>}
      </div>
      {meter ? (
        <p className="notice info" role="status">
          ✓ <strong>{meter.customerName ?? t.meterFound}</strong>
          {meter.address ? ` · ${meter.address}` : ""}
        </p>
      ) : (
        <button type="button" className="btn ghost" disabled={!canCheckMeter} onClick={() => void handleVerifyMeter()}>
          {isVerifying ? <span className="spinner" aria-hidden="true" /> : null}
          {isVerifying ? t.checkingMeter : t.checkMeter}
        </button>
      )}
      <div className="spacer" />

      <div className="field">
        <label className="label" htmlFor="phone">
          {t.yourPhone}
        </label>
        <div className="phone-input">
          <span className="phone-input__dial" aria-hidden="true">
            +{country.dial}
          </span>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel-national" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <span className="hint">{t.tokenCopyHint}</span>
      </div>

      <div className="field">
        <label className="label" htmlFor="amount">
          {t.amount} (XOF)
        </label>
        <input
          id="amount"
          className="input mono"
          inputMode="numeric"
          value={amount}
          aria-invalid={amountError ? true : undefined}
          aria-describedby={amountError ? "amount-error" : "amount-range"}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <AmountChips amounts={QUICK} value={amount} currency="XOF" onPick={setAmount} />
        <FieldError id="amount-error" message={amountError} />
        {!amountError && <span id="amount-range" className="hint">{t.range(...rangeText)}</span>}
      </div>

      {inRange && (
        <dl className="rows quote" aria-live="polite">
          <div>
            <dt>{t.electricityCredit}</dt>
            <dd className="money">{money(amountXof, "XOF", lang)}</dd>
          </div>
          <div>
            <dt>{t.providerFee}</dt>
            <dd className="money">{quote ? money(quote.fee, "XOF", lang) : "…"}</dd>
          </div>
          <div>
            <dt>{t.inBitcoin}</dt>
            <dd className="money">{quote ? `≈ ${sats(quote.amountSats, lang)}` : "…"}</dd>
          </div>
        </dl>
      )}
      <SubmitBar canSubmit={canSubmit} isBusy={isBusy} error={error} missing={missing} />
    </form>
  );
}
