import type { Country } from "../api.ts";
import { useT } from "../i18n.ts";

type Props = {
  countries: Country[];
  value: string;
  onChange: (iso: string) => void;
  id?: string;
};

/** Native select (best on low-end phones and screen readers), styled as a pill. */
export function CountryPicker({ countries, value, onChange, id = "country" }: Props) {
  const { lang, t } = useT();
  const current = countries.find((c) => c.iso === value);
  return (
    <label className="country-pill" htmlFor={id}>
      <span className="sr-only">{t.country}</span>
      <span className="country-pill__flag" aria-hidden="true">
        {current?.iso ?? "··"}
      </span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {countries.map((c) => (
          <option key={c.iso} value={c.iso}>
            {`${lang === "fr" ? c.nameFr : c.name} · ${c.currency}`}
          </option>
        ))}
      </select>
      <span className="country-pill__chev" aria-hidden="true">
        ▾
      </span>
    </label>
  );
}
