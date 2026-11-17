import type { AppConfig } from "../api.ts";
import { navigate } from "../hooks.ts";

type Props = {
  config: AppConfig | null;
};

export function Home({ config }: Props) {
  const providerReady = config?.provider.configured ?? true;
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">
          E no land?
          <br />
          <em>You no pay.</em>
        </h1>
        <p>Buy airtime, data and electricity with Bitcoin. Your payment only completes after delivery is confirmed.</p>
      </section>

      <section className="receipt" aria-labelledby="buy-title">
        <p className="eyebrow" id="buy-title">
          What do you want to buy?
        </p>
        {!providerReady && <p className="notice warn">Bill payments are being set up. You can still explore the app.</p>}
        <div className="tiles">
          <button type="button" className="tile primary" onClick={() => navigate("#/buy/electricity")}>
            <span className="tile-icon" aria-hidden="true">
              ⚡
            </span>
            <span>
              <span className="tile-title">Electricity token</span>
              <br />
              <span className="tile-sub">IKEDC, EKEDC, AEDC and more. Token shows on screen.</span>
            </span>
          </button>
          <button type="button" className="tile" onClick={() => navigate("#/buy/airtime")}>
            <span className="tile-icon" aria-hidden="true">
              📱
            </span>
            <span>
              <span className="tile-title">Airtime</span>
              <br />
              <span className="tile-sub">MTN, Airtel, Glo, 9mobile</span>
            </span>
          </button>
          <button type="button" className="tile" onClick={() => navigate("#/buy/data")}>
            <span className="tile-icon" aria-hidden="true">
              📶
            </span>
            <span>
              <span className="tile-title">Data</span>
              <br />
              <span className="tile-sub">All bundles</span>
            </span>
          </button>
        </div>
      </section>

      <section className="receipt" aria-labelledby="how-title">
        <p className="eyebrow" id="how-title">
          Why Confam is different
        </p>
        <h2>No more “debited but nothing came”.</h2>
        <hr className="dash" />
        <ol className="steps">
          <li>
            <span>
              <strong>You pay, but your sats are only locked.</strong> They don't move yet.
            </span>
          </li>
          <li>
            <span>
              <strong>We buy your airtime, data or token.</strong> We wait for the provider to confirm it landed.
            </span>
          </li>
          <li>
            <span>
              <strong>Delivered? Payment completes.</strong> Failed? The lock is released and your sats never left your
              wallet. No refund to chase, no customer care.
            </span>
          </li>
        </ol>
      </section>
    </>
  );
}
