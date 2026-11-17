import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type AppConfig, type Category, type CreateOrderInput, type MeterInfo, type Service, type Variation } from "../api.ts";
import { NETWORK_LABEL, dataServiceFor, guessNetwork, naira, sats } from "../format.ts";
import { navigate } from "../hooks.ts";

type Props = {
  category: Category;
  config: AppConfig | null;
};

const TITLES: Record<Category, string> = { airtime: "Buy airtime", data: "Buy data", electricity: "Buy electricity" };
const QUICK_AMOUNTS: Record<"airtime" | "electricity", number[]> = {
  airtime: [100, 200, 500, 1000, 2000],
  electricity: [1000, 2000, 5000, 10000],
};

export function BuyForm({ category, config }: Props) {
  const [services, setServices] = useState<Service[]>([]);
  const [serviceID, setServiceID] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [variations, setVariations] = useState<Variation[]>([]);
  const [variationCode, setVariationCode] = useState("");
  const [meterNumber, setMeterNumber] = useState("");
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [meter, setMeter] = useState<MeterInfo | null>(null);
  const [quote, setQuote] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  useEffect(() => {
    let alive = true;
    setServices([]);
    setServiceID("");
    api
      .services(category)
      .then((list) => alive && setServices(list))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Could not load services."));
    return () => {
      alive = false;
    };
  }, [category]);

  // Auto-pick the network from the phone prefix (user can still change it: numbers get ported).
  useEffect(() => {
    if (category === "electricity" || serviceID) return;
    const net = guessNetwork(phone);
    if (!net) return;
    const wanted = category === "data" ? dataServiceFor(net) : net;
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

  const amountNgn = useMemo(() => {
    if (category === "data") return variations.find((v) => v.code === variationCode)?.amountNgn ?? 0;
    const n = Number(amount);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }, [category, amount, variations, variationCode]);

  useEffect(() => {
    if (!amountNgn) {
      setQuote(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .quote(amountNgn)
        .then((q) => alive && setQuote(q.amountSats))
        .catch(() => alive && setQuote(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [amountNgn]);

  useEffect(() => setMeter(null), [meterNumber, meterType, serviceID]);

  async function handleVerifyMeter(): Promise<void> {
    setError(null);
    setIsVerifying(true);
    try {
      setMeter(await api.verifyMeter(serviceID, meterNumber.trim(), meterType));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not verify the meter.");
    } finally {
      setIsVerifying(false);
    }
  }

  function buildInput(): CreateOrderInput {
    if (category === "airtime") return { category, serviceID, phone, amountNgn };
    if (category === "data") return { category, serviceID, phone, variationCode };
    return { category, serviceID, meterNumber: meterNumber.trim(), meterType, phone, amountNgn };
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
  const canSubmit =
    Boolean(serviceID) && phone.trim().length >= 10 && amountNgn > 0 && (!needsMeter || Boolean(meter)) && !isBusy;
  const sandbox = config?.provider.sandbox;

  return (
    <form className="receipt" onSubmit={handleSubmit} noValidate>
      <button type="button" className="link-btn" onClick={() => navigate("#/")}>
        ← Back
      </button>
      <h2>{TITLES[category]}</h2>
      <p className="muted">Pay with Bitcoin. Nothing completes until it lands.</p>
      <hr className="dash" />

      {needsMeter ? (
        <>
          <div className="field">
            <label className="label" htmlFor="disco">
              Electricity company
            </label>
            <select id="disco" className="select" value={serviceID} onChange={(e) => setServiceID(e.target.value)} required>
              <option value="">Choose your DisCo…</option>
              {services.map((s) => (
                <option key={s.serviceID} value={s.serviceID}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="label" id="meter-type-label">
              Meter type
            </span>
            <div className="chips" role="group" aria-labelledby="meter-type-label">
              {(["prepaid", "postpaid"] as const).map((t) => (
                <button key={t} type="button" className="chip" aria-pressed={meterType === t} onClick={() => setMeterType(t)}>
                  {t === "prepaid" ? "Prepaid" : "Postpaid"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="meter">
              Meter number
            </label>
            <input
              id="meter"
              className="input mono"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 4512 3456 789"
              value={meterNumber}
              onChange={(e) => setMeterNumber(e.target.value.replace(/\D/g, "").slice(0, 13))}
            />
            {sandbox && <span className="hint">Sandbox test meter: 1111111111111 (prepaid)</span>}
          </div>
          {meter ? (
            <p className="notice info" role="status">
              ✓ <strong>{meter.customerName}</strong>
              {meter.address ? ` · ${meter.address}` : ""}
            </p>
          ) : (
            <button
              type="button"
              className="btn ghost"
              disabled={!serviceID || meterNumber.length < 6 || isVerifying}
              onClick={handleVerifyMeter}
            >
              {isVerifying ? <span className="spinner" aria-hidden="true" /> : null}
              {isVerifying ? "Checking meter…" : "Check meter name"}
            </button>
          )}
          <div className="field" style={{ marginTop: 14 }}>
            <label className="label" htmlFor="phone">
              Your phone number
            </label>
            <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <span className="hint">The provider sends a copy of your token here.</span>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="phone">
              Phone number
            </label>
            <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            {sandbox && <span className="hint">Sandbox: 08011111111 succeeds · any other number fails (watch your sats come back)</span>}
          </div>
          <div className="field">
            <span className="label" id="network-label">
              Network
            </span>
            <div className="chips" role="group" aria-labelledby="network-label">
              {services.map((s) => {
                const net = s.serviceID.replace(/-data$/, "");
                return (
                  <button key={s.serviceID} type="button" className="chip" aria-pressed={serviceID === s.serviceID} onClick={() => setServiceID(s.serviceID)}>
                    {NETWORK_LABEL[net] ?? s.name}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {category === "data" ? (
        <div className="field">
          <label className="label" htmlFor="plan">
            Data plan
          </label>
          <select id="plan" className="select" value={variationCode} onChange={(e) => setVariationCode(e.target.value)} disabled={!serviceID}>
            <option value="">{serviceID ? "Choose a plan…" : "Pick a network first"}</option>
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
            Amount (₦)
          </label>
          <input
            id="amount"
            className="input mono"
            inputMode="numeric"
            placeholder={category === "electricity" ? "2000" : "500"}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <div className="chips" aria-label="Quick amounts">
            {QUICK_AMOUNTS[category].map((a) => (
              <button key={a} type="button" className="chip" aria-pressed={amount === String(a)} onClick={() => setAmount(String(a))}>
                {naira(a)}
              </button>
            ))}
          </div>
        </div>
      )}

      {amountNgn > 0 && (
        <dl className="rows" aria-live="polite">
          <div>
            <dt>You pay</dt>
            <dd className="money">{naira(amountNgn)}</dd>
          </div>
          <div>
            <dt>In Bitcoin</dt>
            <dd className="money">{quote ? `≈ ${sats(quote)}` : "…"}</dd>
          </div>
        </dl>
      )}

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="btn-row">
        <button type="submit" className="btn lime" disabled={!canSubmit}>
          {isBusy ? <span className="spinner" aria-hidden="true" /> : null}
          {isBusy ? "Preparing your invoice…" : "Continue to pay"}
        </button>
      </div>
    </form>
  );
}
