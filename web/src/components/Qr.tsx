import qrcode from "qrcode-generator";
import { useMemo } from "react";

interface QrProps {
  value: string;
  label: string;
}

/** Renders a QR as an <img> data URI (no innerHTML). Lightning invoices encode best uppercased (alphanumeric mode). */
export function Qr({ value, label }: QrProps) {
  const src = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value.toUpperCase(), "Alphanumeric");
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [value]);
  return (
    <div className="qr-wrap">
      <img src={src} alt={label} width={260} height={260} />
    </div>
  );
}
