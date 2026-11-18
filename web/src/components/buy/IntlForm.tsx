import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Country, type IntlOffer, type IntlOperator } from "../../api.ts";
import { money } from "../../format.ts";
import { navigate } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { AmountChips, QuoteRows, SubmitBar } from "./shared.tsx";

type Props = {
  country: Country;
  category: "airtime" | "data";
  sandbox: boolean;
};

/** Up to five round quick amounts inside a top-up range (e.g. 500, 1,000, 2,000, 5,000 XOF). */
function quickAmounts(min: number, max: number): number[] {
  const steps = [1, 2, 5];
  const out: number[] = [];
  for (let mag = 10 ** Math.floor(Math.log10(Math.max(min, 1))); out.length < 5 && mag <= max; mag *= 10) {
    for (const s of steps) {
      const v = s * mag;
      if (v >= min && v <= max && out.length < 5) out.push(v);
    }
  }
  return out;
}

/** Airtime & data outside Nigeria (VTpass international): real networks and prices for the country. */
export function IntlForm({ country, category, sandbox }: Props) {
  const { lang, t } = useT();
  const [operators, setOperators] = useState<IntlOperator[] | null>(null);
  const [operatorId, setOperatorId] = useState("");
  const [offers, setOffers] = useState<IntlOffer[] | null>(null);
  const [variationCode, setVariationCode] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .intlOperators(country.iso, category)
      .then((ops) => {
        if (!alive) return;
        setOperators(ops);
        if (ops.length === 1 && ops[0]) setOperatorId(ops[0].operatorId);
      })
      .catch((e: unknown) => alive && (setOperators([]), setError(e instanceof ApiError ? e.message : t.notAvailableHere)));
    return () => {
      alive = false;
    };
  }, [country.iso, category, t.notAvailableHere]);

  useEffect(() => {
    setOffers(null);
    setVariationCode("");
    if (!operatorId) return;
    let alive = true;
    api
      .intlOffers(operatorId, category)
      .then((list) => {
        if (!alive) return;
        setOffers(list);
        // Airtime: one flexible range per network, selected automatically.
        if (category === "airtime" && list[0]) setVariationCode(list[0].variationCode);
      })
      .catch((e: unknown) => alive && (setOffers([]), setError(e instanceof ApiError ? e.message : t.noProducts)));
    return () => {
      alive = false;
    };
  }, [operatorId, category, t.noProducts]);

  const offer = offers?.find((o) => o.variationCode === variationCode) ?? null;
  const currency = offer?.currency ?? country.currency;
  const amountLocal = useMemo(() => {
    if (!offer) return 0;
    if (offer.isFixed) return offer.amountLocal ?? 0;
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [offer, amount]);
  const inRange = offer !== null && (offer.isFixed || (amountLocal >= (offer.minLocal ?? 0) && amountLocal <= (offer.maxLocal ?? 0)));
  const digits = phone.replace(/\D/g, "");
  const canSubmit = digits.length >= 7 && Boolean(operatorId) && inRange && amountLocal > 0;
  const quick = offer && !offer.isFixed && offer.minLocal !== null && offer.maxLocal !== null ? quickAmounts(offer.minLocal, offer.maxLocal) : [];

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!offer) return;
    setError(null);
    setIsBusy(true);
    try {
      const order = await api.createOrder({ category, countryCode: country.iso, phone, operatorId, variationCode: offer.variationCode, amountLocal });
      navigate(`#/order/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your order.");
      setIsBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="label" htmlFor="phone">
          {t.phone}
        </label>
        <div className="phone-input">
          <span className="phone-input__dial" aria-hidden="true">
            +{country.dial}
          </span>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel-national" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {sandbox && <span className="hint">{t.sandboxIntl}</span>}
      </div>

      <div className="field">
        <span className="label" id="network-label">
          {t.chooseNetwork}
        </span>
        {operators === null ? (
          <span className="hint">…</span>
        ) : (
          <div className="chips" role="group" aria-labelledby="network-label">
            {operators.map((o) => (
              <button key={o.operatorId} type="button" className="chip" aria-pressed={operatorId === o.operatorId} onClick={() => setOperatorId(o.operatorId)}>
                {o.name.replace(new RegExp(`^${country.name}\\s+`, "i"), "")}
              </button>
            ))}
          </div>
        )}
      </div>

      {operatorId && offers !== null && offers.length === 0 && <p className="notice warn">{t.noProducts}</p>}

      {category === "airtime" && offer && !offer.isFixed && (
        <div className="field">
          <label className="label" htmlFor="amount">
            {t.amount} ({currency})
          </label>
          <input
            id="amount"
            className="input mono"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 9))}
          />
          <AmountChips amounts={quick} value={amount} currency={currency} onPick={setAmount} />
          {offer.minLocal !== null && offer.maxLocal !== null && (
            <span className="hint">{t.range(money(offer.minLocal, currency, lang), money(offer.maxLocal, currency, lang))}</span>
          )}
        </div>
      )}

      {category === "data" && offers && offers.length > 0 && (
        <div className="field">
          <label className="label" htmlFor="plan">
            {t.plan}
          </label>
          <select id="plan" className="select" value={variationCode} onChange={(e) => setVariationCode(e.target.value)}>
            <option value="">{t.choosePlan}</option>
            {offers.map((o) => (
              <option key={o.variationCode} value={o.variationCode}>
                {`${o.name} · ${money(o.amountLocal ?? 0, o.currency, lang)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <QuoteRows amount={inRange ? amountLocal : 0} currency={currency} intl={offer ? { operatorId, category, variationCode: offer.variationCode } : null} />
      <SubmitBar canSubmit={canSubmit} isBusy={isBusy} error={error} />
    </form>
  );
}
