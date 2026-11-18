import type { AppConfig, Category, Country } from "../api.ts";
import { navigate } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { CountryPicker } from "./CountryPicker.tsx";
import { LockCoin } from "./lock3d/LockCoin.tsx";

type Props = {
  config: AppConfig | null;
  countries: Country[];
  country: Country | null;
  onCountry: (iso: string) => void;
};

/** 3D category icons, rendered from the same model as the lock (see web/icon-studio). */
const TILES: readonly Category[] = ["airtime", "data", "electricity"];

export function Home({ config, countries, country, onCountry }: Props) {
  const { t } = useT();
  const anyProvider = config ? config.providers.reloadly.configured || config.providers.vtpass.configured : true;
  const sub: Record<Category, string> = { airtime: t.airtimeSub, data: t.dataSub, electricity: t.electricitySub };
  const label: Record<Category, string> = { airtime: t.airtime, data: t.data, electricity: t.electricity };

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__copy">
          <h1 id="hero-title">
            {t.tagline1}
            <br />
            <em>{t.tagline2}</em>
          </h1>
          <p>{t.heroSub}</p>
        </div>
        <LockCoin state="idle" label={t.lockLabel(t.tagline2)} className="hero__lock" />
      </section>

      <section className="receipt" aria-labelledby="buy-title">
        <div className="receipt__head">
          <p className="eyebrow" id="buy-title">
            {t.whatToBuy}
          </p>
          {countries.length > 0 && country && <CountryPicker countries={countries} value={country.iso} onChange={onCountry} />}
        </div>
        {!anyProvider && <p className="notice warn">{t.setupNotice}</p>}
        <div className="tiles">
          {TILES.map((category, i) => {
            const available = country ? Boolean(country.services[category]) : true;
            return (
              <button
                key={category}
                type="button"
                className={`tile${i === 0 ? " primary" : ""}`}
                disabled={!available}
                onClick={() => navigate(`#/buy/${category}`)}
              >
                <img className="tile-icon" src={`/icons/${category}.webp`} width="56" height="56" alt="" decoding="async" />
                <span>
                  <span className="tile-title">{label[category]}</span>
                  <br />
                  <span className="tile-sub">{available ? sub[category] : t.notAvailableHere}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="receipt" aria-labelledby="how-title">
        <p className="eyebrow" id="how-title">
          {t.whyEyebrow}
        </p>
        <h2>{t.whyTitle}</h2>
        <hr className="dash" />
        <ol className="steps">
          <li>
            <span>
              <strong>{t.step1}</strong> {t.step1b}
            </span>
          </li>
          <li>
            <span>
              <strong>{t.step2}</strong> {t.step2b}
            </span>
          </li>
          <li>
            <span>
              <strong>{t.step3}</strong> {t.step3b}
            </span>
          </li>
        </ol>
      </section>
    </>
  );
}
