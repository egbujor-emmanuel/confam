import type { Order, OrderState } from "../api.ts";
import { useT } from "../i18n.ts";

type StepStatus = "done" | "active" | "todo" | "stopped";
interface Step {
  key: string;
  title: string;
  note: string;
  status: StepStatus;
}

const RANK: Partial<Record<OrderState, number>> = { awaiting_payment: 0, locked: 1, vending: 2, delivered: 3, completed: 5 };
const ICON: Record<StepStatus, string> = { done: "✓", active: "•", todo: "", stopped: "✕" };

type Props = {
  order: Order;
};

export function Timeline({ order }: Props) {
  const { t } = useT();
  const step = (key: string, status: StepStatus, note?: string): Step => {
    const [title, defaultNote] = t.tl[key] ?? [key, ""];
    return { key, title, note: note ?? defaultNote, status };
  };

  let steps: Step[];
  if (order.state === "expired") {
    steps = [step("expired", "stopped")];
  } else if (order.state === "released") {
    const reached = new Set(order.timeline.map((e) => e.state));
    const progress = reached.has("vending") ? 3 : reached.has("locked") ? 2 : 1;
    const keys = ["pay", "locked", "buying"].slice(0, progress);
    steps = [...keys.map((k) => step(k, "done", k === "buying" ? order.product : undefined)), step("released", "stopped")];
  } else {
    const rank = RANK[order.state] ?? 0;
    steps = ["pay", "locked", "buying", "delivered", "paid"].map((k, i) =>
      step(k, i < rank ? "done" : i === rank ? "active" : "todo", k === "buying" ? order.product : undefined),
    );
  }

  return (
    <ol className="timeline" aria-label={t.progress}>
      {steps.map((s) => (
        <li key={s.key} className="tl-step" data-status={s.status} aria-current={s.status === "active" ? "step" : undefined}>
          <span className="tl-dot" aria-hidden="true">
            {ICON[s.status]}
          </span>
          <span>
            <span className="tl-title">{s.title}</span>
            {s.note && (
              <>
                <br />
                <span className="tl-note">{s.note}</span>
              </>
            )}
            <span className="sr-only">{` (${s.status})`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
