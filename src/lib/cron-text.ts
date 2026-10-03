/** Plain-English descriptions for the cron schedules the UI produces (falls back to the raw expression). */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatTime(h: number, m: number) {
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function cronToText(cron: string | null | undefined): string {
  if (!cron) return "";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const every = /^\*\/(\d+)$/;
  if (every.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${every.exec(min)![1]} minutes`;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return min === "0" ? "Every hour" : `Every hour at :${min.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && every.test(hour) && dom === "*" && mon === "*" && dow === "*") return `Every ${every.exec(hour)![1]} hours`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== "*") return cron;
  const t = formatTime(Number(hour), Number(min));
  if (dom === "*" && dow === "*") return `Every day at ${t}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${t}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Weekends at ${t}`;
  if (dom === "*" && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow) % 7]} at ${t}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on day ${dom} at ${t}`;
  return cron;
}

export type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "minutes" | "custom";

export function buildCron(f: { frequency: Frequency; time: string; weekday: number; dayOfMonth: number; minutes: number; custom: string }) {
  const [h, m] = (f.time || "09:00").split(":").map(Number);
  switch (f.frequency) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${f.weekday}`;
    case "monthly":
      return `${m} ${h} ${f.dayOfMonth} * *`;
    case "hourly":
      return `0 * * * *`;
    case "minutes":
      return `*/${Math.max(5, f.minutes)} * * * *`;
    default:
      return f.custom;
  }
}

/** Best-effort reverse of buildCron so existing schedules open in the friendly editor. */
export function parseCron(cron: string | null | undefined) {
  const d = { frequency: "daily" as Frequency, time: "09:00", weekday: 1, dayOfMonth: 1, minutes: 15, custom: cron ?? "" };
  if (!cron) return d;
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : d.time;
  if (mon !== "*") return { ...d, frequency: "custom" as Frequency };
  if (/^\*\/\d+$/.test(min) && hour === "*") return { ...d, frequency: "minutes" as Frequency, minutes: Number(min.slice(2)) };
  if (min === "0" && hour === "*" && dom === "*" && dow === "*") return { ...d, frequency: "hourly" as Frequency };
  if (time === d.time && !(/^\d+$/.test(min) && /^\d+$/.test(hour))) return { ...d, frequency: "custom" as Frequency };
  if (dom === "*" && dow === "*") return { ...d, frequency: "daily" as Frequency, time };
  if (dom === "*" && dow === "1-5") return { ...d, frequency: "weekdays" as Frequency, time };
  if (dom === "*" && /^\d$/.test(dow)) return { ...d, frequency: "weekly" as Frequency, time, weekday: Number(dow) };
  if (/^\d+$/.test(dom) && dow === "*") return { ...d, frequency: "monthly" as Frequency, time, dayOfMonth: Number(dom) };
  return { ...d, frequency: "custom" as Frequency };
}
