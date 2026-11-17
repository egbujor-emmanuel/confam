import { randomBytes } from "node:crypto";

/**
 * VTpass request_id rules (https://www.vtpass.com/documentation/how-to-generate-request-id/):
 * - 12+ characters; first 12 numeric = today's date + hour + minute (YYYYMMDDHHII)
 * - Date/time in Africa/Lagos (GMT+1)
 */
export function lagosStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}`;
}

export function newRequestId(now: Date = new Date()): string {
  return `${lagosStamp(now)}${randomBytes(8).toString("hex")}`;
}
