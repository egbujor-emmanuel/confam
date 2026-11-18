import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Category, type CreateOrderInput, type Service, type Variation } from "../../api.ts";
import { NG_NETWORK_LABEL, guessNgNetwork, money } from "../../format.ts";
import { navigate } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { AmountChips, FieldError, QuoteRows, SubmitBar, TestFill, useMeterCheck } from "./shared.tsx";

type Props = {
  category: Category;
  sandbox: boolean;
};

const QUICK: Record<"airtime" | "electricity", number[]> = { airtime: [100, 200, 500, 1000, 2000], electricity: [1000, 2000, 5000, 10000] };
const MIN_NGN = 50;
const MAX_NGN = 50_000;
/** VTpass sandbox test values (https://www.vtpass.com/documentation/): delivered on success. */
const SANDBOX_PHONE = "08011111111";
const SANDBOX_METER = { serviceID: "ikeja-electric", number: "1111111111111" };

/** Nigeria (VTpass): airtime, data and prepaid/postpaid electricity with meter verification. */
export function VtpassForm({ category, sandbox }: Props) {
  const { lang, t } = useT();
  const [services, setServices] = useState<Service[]>([]);
  const [serviceID, setServiceID] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [variations, setVariations] = useState<Variation[]>([]);
  const [variationCode, setVariationCode] = useState("");
  const [meterNumber, setMeterNumber] = useState("");
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .services(category)
      .then((list) => alive && setServices(list))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Could not load services."));
    return () => {
      alive = false;
    };
  }, [category]);

  useEffect(() => {
    if (category === "electricity" || serviceID) return;
    const net = guessNgNetwork(phone);
    if (!net) return;
    const wanted = category === "data" ? `${net}-data` : net;
    if (services.some((s) => s.serviceID === wanted)) setServiceID(wanted);
  }, [phone, category, services, serviceID]);

  useEffect(() => {
    if (category !== "data" || !serviceID) return;
    let alive = true;
    setVariations([]);
    setVariationCode("");
    api
      .variations(serviceID)
      .then((v) => alive && setVariations(v.sort((a, b) => a.amountNgn - b.amountNgn)))
      .catch(() => alive && setError("Could not load data plans."));
    return () => {
      alive = false;
    };
  }, [category, serviceID]);

  const meterKey = `${serviceID}|${meterType}|${meterNumber}`;
  const verify = useCallback(() => api.verifyMeter(serviceID, meterNumber.trim(), meterType), [serviceID, meterNumber, meterType]);
  const { meter, error: meterError, isVerifying, check: handleVerifyMeter } = useMeterCheck(meterKey, verify, "Could not verify the meter.", Boolean(serviceID) && meterNumber.length >= 10);
  const canCheckMeter = Boolean(serviceID) && meterNumber.length >= 6 && !isVerifying;

  const amountLocal = useMemo(() => {
    if (category === "data") return variations.find((v) => v.code === variationCode)?.amountNgn ?? 0;
    const n = Number(amount);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }, [category, amount, variations, variationCode]);

  function buildInput(): CreateOrderInput {
    if (category === "airtime") return { category, countryCode: "NG", serviceID, phone, amountLocal };
    if (category === "data") return { category, countryCode: "NG", serviceID, phone, variationCode };
    return { category, countryCode: "NG", serviceID, meterNumber: meterNumber.trim(), meterType, phone, amountLocal };
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      const order = await api.createOrder(buildInput());
      navigate(`#/order/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your order.");
      setIsBusy(false);
    }
  }

  const needsMeter = category === "electricity";
  // Same rule as the server: Confam's limits, narrowed by the company's/network's own range and the meter's minimum.
  const svc = services.find((s) => s.serviceID === serviceID);
  const minNgn = Math.max(MIN_NGN, svc?.minAmount ?? 0, needsMeter ? (meter?.minAmount ?? 0) : 0);
  const maxNgn = Math.min(MAX_NGN, svc?.maxAmount ?? Number.POSITIVE_INFINITY);
  const rangeText = [money(minNgn, "NGN", lang), money(maxNgn, "NGN", lang)] as const;
  const amountOk = category === "data" ? amountLocal > 0 : amountLocal >= minNgn && amountLocal <= maxNgn;
  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const canSubmit = Boolean(serviceID) && phoneOk && amountOk && (!needsMeter || Boolean(meter));
  const amountError = category !== "data" && amount !== "" && !amountOk ? t.amountOutOfRange(...rangeText) : null;
  const missing = needsMeter
    ? !serviceID ? t.needCompany : !meter ? t.needMeter : !phoneOk ? t.needPhone : !amountOk ? t.needAmount(...rangeText) : null
    : !phoneOk ? t.needPhone : !serviceID ? t.needNetwork : category === "data" && !variationCode ? t.needPlan : !amountOk ? t.needAmount(...rangeText) : null;

  function fillTestMeter(): void {
    setServiceID(SANDBOX_METER.serviceID); // works even before the company list has loaded
    setMeterType("prepaid");
    setMeterNumber(SANDBOX_METER.number);
  }

  // The sandbox test number has no real network prefix, so pick MTN for it unless one is chosen.
  function fillTestPhone(): void {
    setPhone(SANDBOX_PHONE);
    if (!serviceID) setServiceID(category === "data" ? "mtn-data" : "mtn");
  }

  const phoneField = (labelText: string, hint?: string) => (
    <div className="field">
      <label className="label" htmlFor="phone">
        {labelText}
      </label>
      <div className="phone-input">
        <span className="phone-input__dial" aria-hidden="true">
          +234
        </span>
        <input id="phone" className="input" inputMode="tel" autoComplete="tel-national" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      {hint && <span className="hint">{hint}</span>}
      {sandbox && !needsMeter && phone !== SANDBOX_PHONE && <TestFill label={t.useTestNumber} onFill={fillTestPhone} />}
    </div>
  );

  return (
    <form onSubmit={handleSubmit} noValidate>
      {needsMeter ? (
        <>
          <div className="field">
            <label className="label" htmlFor="disco">
              {t.disco}
            </label>
            <select id="disco" className="select" value={serviceID} onChange={(e) => setServiceID(e.target.value)}>
              <option value="">{t.chooseDisco}</option>
              {services.map((s) => (
                <option key={s.serviceID} value={s.serviceID}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="label" id="meter-type-label">
              {t.meterType}
            </span>
            <div className="chips" role="group" aria-labelledby="meter-type-label">
              {(["prepaid", "postpaid"] as const).map((mt) => (
                <button key={mt} type="button" className="chip" aria-pressed={meterType === mt} onClick={() => setMeterType(mt)}>
                  {mt === "prepaid" ? t.prepaid : t.postpaid}
                </button>
              ))}
            </div>
          </div>
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
              onChange={(e) => setMeterNumber(e.target.value.replace(/\D/g, "").slice(0, 13))}
              onBlur={() => {
                if (!meter && canCheckMeter) void handleVerifyMeter();
              }}
            />
            <FieldError id="meter-error" message={meterError} />
            {sandbox && <span className="hint">{t.sandboxMeter}</span>}
            {sandbox && meterNumber !== SANDBOX_METER.number && <TestFill label={t.useTestMeter} onFill={fillTestMeter} />}
          </div>
          {meter ? (
            <p className="notice info" role="status">
              ✓ <strong>{meter.customerName}</strong>
              {meter.address ? ` · ${meter.address}` : ""}
            </p>
          ) : (
            <button type="button" className="btn ghost" disabled={!canCheckMeter} onClick={() => void handleVerifyMeter()}>
              {isVerifying ? <span className="spinner" aria-hidden="true" /> : null}
              {isVerifying ? t.checkingMeter : t.checkMeter}
            </button>
          )}
          <div className="spacer" />
          {phoneField(t.yourPhone, t.tokenCopyHint)}
        </>
      ) : (
        <>
          {phoneField(t.phone, sandbox ? t.sandboxAirtime : undefined)}
          <div className="field">
            <span className="label" id="network-label">
              {t.network}
            </span>
            <div className="chips" role="group" aria-labelledby="network-label">
              {services.map((s) => (
                <button key={s.serviceID} type="button" className="chip" aria-pressed={serviceID === s.serviceID} onClick={() => setServiceID(s.serviceID)}>
                  {NG_NETWORK_LABEL[s.serviceID.replace(/-data$/, "")] ?? s.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {category === "data" ? (
        <div className="field">
          <label className="label" htmlFor="plan">
            {t.plan}
          </label>
          <select id="plan" className="select" value={variationCode} onChange={(e) => setVariationCode(e.target.value)} disabled={!serviceID}>
            <option value="">{serviceID ? t.choosePlan : t.pickNetworkFirst}</option>
            {variations.map((v) => (
              <option key={v.code} value={v.code}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor="amount">
            {t.amount} (₦)
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
          <AmountChips amounts={QUICK[category]} value={amount} currency="NGN" onPick={setAmount} />
          <FieldError id="amount-error" message={amountError} />
          {!amountError && <span id="amount-range" className="hint">{t.range(...rangeText)}</span>}
        </div>
      )}

      <QuoteRows amount={amountOk ? amountLocal : 0} currency="NGN" />
      <SubmitBar canSubmit={canSubmit} isBusy={isBusy} error={error} missing={missing} />
    </form>
  );
}
