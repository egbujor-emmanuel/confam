import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Country, type MeterInfo } from "../../api.ts";
import { money, sats } from "../../format.ts";
import { navigate } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { AmountChips, SubmitBar } from "./shared.tsx";

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
  const [meter, setMeter] = useState<MeterInfo | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ fee: number; amountSats: number } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountXof = Number(amount);
  const inRange = Number.isInteger(amountXof) && amountXof >= MIN_XOF && amountXof <= MAX_XOF;

  // A different meter number needs a new check.
  useEffect(() => setMeter(null), [meterNumber]);

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

  async function handleVerifyMeter(): Promise<void> {
    setError(null);
    setIsVerifying(true);
    try {
      setMeter(await api.verifyWoyofal(meterNumber));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check that meter.");
    } finally {
      setIsVerifying(false);
    }
  }

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

  const canSubmit = meter !== null && inRange && phone.replace(/\D/g, "").length >= 7;

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
          onChange={(e) => setMeterNumber(e.target.value.replace(/\D/g, "").slice(0, 20))}
        />
        {sandbox && <span className="hint">{t.sandboxWoyofal}</span>}
      </div>
      {meter ? (
        <p className="notice info" role="status">
          ✓ <strong>{meter.customerName ?? t.meterFound}</strong>
          {meter.address ? ` · ${meter.address}` : ""}
        </p>
      ) : (
        <button type="button" className="btn ghost" disabled={meterNumber.length < 6 || isVerifying} onClick={handleVerifyMeter}>
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
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <AmountChips amounts={QUICK} value={amount} currency="XOF" onPick={setAmount} />
        <span className="hint">{t.range(money(MIN_XOF, "XOF", lang), money(MAX_XOF, "XOF", lang))}</span>
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
      <SubmitBar canSubmit={canSubmit} isBusy={isBusy} error={error} />
    </form>
  );
}
