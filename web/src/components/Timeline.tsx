import type { Order, OrderState } from "../api.ts";

type StepStatus = "done" | "active" | "todo" | "stopped";
interface Step {
  key: string;
  title: string;
  note: string;
  status: StepStatus;
}

const RANK: Partial<Record<OrderState, number>> = { awaiting_payment: 0, locked: 1, vending: 2, delivered: 3, completed: 5 };
const ICON: Record<StepStatus, string> = { done: "✓", active: "•", todo: "", stopped: "✕" };

function buildSteps(order: Order): Step[] {
  const base = [
    { key: "pay", title: "Pay the invoice", note: "Your sats get locked, not sent" },
    { key: "locked", title: "Payment locked", note: "Held safely. Not sent yet" },
    { key: "buying", title: "Buying it for you", note: order.product },
    { key: "delivered", title: "Provider confirmed delivery", note: "Only now can your payment complete" },
    { key: "paid", title: "Payment completed", note: "Delivered first, paid second" },
  ];

  if (order.state === "released" || order.state === "expired") {
    const reached = new Set(order.timeline.map((t) => t.state));
    const progress = reached.has("vending") ? 3 : reached.has("locked") ? 2 : 1;
    const done = base.slice(0, progress).map((s, i) => ({ ...s, status: (i === 0 && order.state === "expired" ? "stopped" : "done") as StepStatus }));
    if (order.state === "expired") return [{ ...base[0]!, note: "Invoice expired. Nothing was charged", status: "stopped" }];
    return [
      ...done,
      { key: "released", title: "Lock released: not charged", note: "Your sats never left your wallet", status: "stopped" },
    ];
  }

  const rank = RANK[order.state] ?? 0;
  return base.map((s, i) => ({ ...s, status: i < rank ? "done" : i === rank ? "active" : "todo" }));
}

type Props = {
  order: Order;
};

export function Timeline({ order }: Props) {
  const steps = buildSteps(order);
  return (
    <ol className="timeline" aria-label="Payment progress">
      {steps.map((s) => (
        <li key={s.key} className="tl-step" data-status={s.status} aria-current={s.status === "active" ? "step" : undefined}>
          <span className="tl-dot" aria-hidden="true">
            {ICON[s.status]}
          </span>
          <span>
            <span className="tl-title">{s.title}</span>
            <br />
            <span className="tl-note">{s.note}</span>
            <span className="sr-only">{` (${s.status})`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
