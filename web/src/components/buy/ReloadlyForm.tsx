import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Country, type DataPlan, type OperatorInfo } from "../../api.ts";
import { money } from "../../format.ts";
import { navigate } from "../../hooks.ts";
import { useT } from "../../i18n.ts";
import { AmountChips, QuoteRows, SubmitBar } from "./shared.tsx";

type Props = {
  country: Country;
  category: "airtime" | "data";
};

/** Airtime & data anywhere in Africa (Reloadly): the network is detected from the number. */
export function ReloadlyForm({ country, category }: Props) {
  const { lang, t } = useT();
  const [phone, setPhone] = useState("");
  const [operator, setOperator] = useState<OperatorInfo | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [amount, setAmount] = useState("");
  const [plans, setPlans] = useState<DataPlan[]>([]);
  const [planKey, setPlanKey] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "");

  // Detect the operator once the number looks complete (airtime).
  useEffect(() => {
    if (category !== "airtime") return;
    setOperator(null);
    if (digits.length < 8) return;
    let alive = true;
    const timer = setTimeout(() => {
      setIsDetecting(true);
      setError(null);
      api
        .detectOperator(country.iso, phone)
        .then((op) => alive && setOperator(op))
        .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Could not detect the network."))
        .finally(() => alive && setIsDetecting(false));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [digits, category, country.iso, phone]);

  useEffect(() => {
    if (category !== "data") return;
    let alive = true;
    api
      .dataPlans(country.iso)
      .then((p) => alive && setPlans(p))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Could not load data plans."));
    return () => {
      alive = false;
    };
  }, [category, country.iso]);

  const plan = plans.find((p) => `${p.operatorId}:${p.amountLocal}` === planKey) ?? null;
  const amountLocal = useMemo(() => {
    if (category === "data") return plan?.amountLocal ?? 0;
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [category, plan, amount]);

  const inRange =
    category === "data" ||
    (operator !== null &&
      (operator.fixedAmounts.length
        ? operator.fixedAmounts.includes(amountLocal)
        : (operator.minAmount === null || amountLocal >= operator.minAmount) && (operator.maxAmount === null || amountLocal <= operator.maxAmount)));

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      const order =
        category === "airtime"
          ? await api.createOrder({ category, countryCode: country.iso, phone, amountLocal, operatorId: operator?.operatorId })
          : await api.createOrder({ category, countryCode: country.iso, phone, operatorId: plan?.operatorId, amountLocal: plan?.amountLocal });
      navigate(`#/order/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your order.");
      setIsBusy(false);
    }
  }

  const currency = operator?.currency ?? country.currency;
  const quick = operator ? (operator.fixedAmounts.length ? operator.fixedAmounts.slice(0, 6) : operator.suggestedAmounts) : [];
  const canSubmit = digits.length >= 8 && amountLocal > 0 && inRange && (category === "data" ? Boolean(plan) : Boolean(operator));

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
        {category === "airtime" && (
          <span className="hint" aria-live="polite">
            {isDetecting ? t.detecting : operator ? `${t.network}: ${operator.name}` : " "}
          </span>
        )}
      </div>

      {category === "airtime" ? (
        <div className="field">
          <label className="label" htmlFor="amount">
            {t.amount} ({currency})
          </label>
          {operator && operator.fixedAmounts.length === 0 && (
            <input
              id="amount"
              className="input mono"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))}
            />
          )}
          <AmountChips amounts={quick} value={amount} currency={currency} onPick={setAmount} />
          {operator && operator.minAmount !== null && operator.maxAmount !== null && (
            <span className="hint">{t.range(money(operator.minAmount, currency, lang), money(operator.maxAmount, currency, lang))}</span>
          )}
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor="plan">
            {t.plan}
          </label>
          <select id="plan" className="select" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            <option value="">{t.choosePlan}</option>
            {plans.map((p) => (
              <option key={`${p.operatorId}:${p.amountLocal}`} value={`${p.operatorId}:${p.amountLocal}`}>
                {`${p.operatorName} · ${p.name} · ${money(p.amountLocal, country.currency, lang)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <QuoteRows amount={amountLocal} currency={currency} />
      <SubmitBar canSubmit={canSubmit} isBusy={isBusy} error={error} />
    </form>
  );
}
