import { describe, expect, it } from "vitest";
import { buildCron, cronToText, parseCron } from "@/lib/cron-text";
import { parseBlob, randomBlob } from "@/components/bots/bot-avatar";

describe("cron text", () => {
  it("describes common schedules in plain English", () => {
    expect(cronToText("30 2 * * *")).toBe("Every day at 2:30 AM");
    expect(cronToText("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(cronToText("0 17 * * 5")).toBe("Every Friday at 5:00 PM");
    expect(cronToText("0 9 1 * *")).toBe("Monthly on day 1 at 9:00 AM");
    expect(cronToText("0 * * * *")).toBe("Every hour");
    expect(cronToText("*/15 * * * *")).toBe("Every 15 minutes");
    expect(cronToText("0 0 12 12 *")).toBe("0 0 12 12 *");
  });
  it("round-trips between the friendly editor and cron", () => {
    for (const cron of ["30 7 * * *", "0 8 * * 1-5", "15 9 * * 3", "0 6 15 * *", "0 * * * *", "*/10 * * * *"]) {
      expect(buildCron(parseCron(cron))).toBe(cron);
    }
    expect(parseCron("0 0 12 12 *").frequency).toBe("custom");
  });
});

describe("blob avatars", () => {
  it("parses valid blobs and rejects others", () => {
    expect(parseBlob("blob:drop:blue")).toEqual({ shape: "drop", color: "blue" });
    expect(parseBlob("blob:star:blue")).toBeNull();
    expect(parseBlob("🤖")).toBeNull();
  });
  it("generates valid random blobs", () => {
    for (let i = 0; i < 20; i++) expect(parseBlob(randomBlob())).not.toBeNull();
  });
});
