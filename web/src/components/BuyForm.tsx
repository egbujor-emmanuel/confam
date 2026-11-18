import type { AppConfig, Category, Country } from "../api.ts";
import { navigate } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { IntlForm } from "./buy/IntlForm.tsx";
import { WoyofalForm } from "./buy/WoyofalForm.tsx";
import { VtpassForm } from "./buy/VtpassForm.tsx";
import { CountryPicker } from "./CountryPicker.tsx";

type Props = {
  category: Category;
  config: AppConfig | null;
  countries: Country[];
  country: Country | null;
  onCountry: (iso: string) => void;
};

/** Picks the right purchase flow for the selected country (the payment guarantee is identical for both). */
export function BuyForm({ category, config, countries, country, onCountry }: Props) {
  const { t } = useT();
  const provider = country?.services[category] ?? null;

  return (
    <section className="receipt" aria-labelledby="buy-heading">
      <button type="button" className="link-btn" onClick={() => navigate("#/")}>
        ← {t.back}
      </button>
      <div className="receipt__head">
        <h2 id="buy-heading">{t.buy[category]}</h2>
        {country && countries.length > 0 && <CountryPicker countries={countries} value={country.iso} onChange={onCountry} id="country-buy" />}
      </div>
      <p className="muted">{t.buySub}</p>
      <hr className="dash" />
      {!country ? (
        <p className="muted">…</p>
      ) : provider === "dexpay" && category === "electricity" ? (
        <WoyofalForm key={`${country.iso}-${category}`} country={country} sandbox={config?.providers.dexpay?.sandbox ?? false} />
      ) : provider === "vtpass" && country.iso === "NG" ? (
        <VtpassForm key={`${country.iso}-${category}`} category={category} sandbox={config?.providers.vtpass.sandbox ?? false} />
      ) : provider === "vtpass" && category !== "electricity" ? (
        <IntlForm key={`${country.iso}-${category}`} country={country} category={category} sandbox={config?.providers.vtpass.sandbox ?? false} />
      ) : (
        <p className="notice warn">{t.notAvailableHere}</p>
      )}
    </section>
  );
}
