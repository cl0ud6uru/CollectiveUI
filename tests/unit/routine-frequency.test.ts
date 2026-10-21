import { describe, expect, it } from "vitest";
import { isValidCron, nextCronRun } from "@/lib/routines";

describe("routine schedule frequency", () => {
  it.each(["* * * * * *", "0 */5 * * * *", "@hourly"])("rejects seconds and aliases: %s", cron => {
    expect(isValidCron(cron)).toBe(false);
  });
  it.each(["* * * * *", "*/4 * * * *", "*/7 * * * *", "0,1 * * * *", "0,59 * * * *", "0-1 9 * * 1", "0,59 0,23 * * 1"])("rejects every close pair regardless of the current time: %s", cron => {
    for (const anchor of ["2026-10-21T09:00:30Z", "2026-10-21T09:59:30Z", "2026-10-21T12:30:00Z"])
      expect(() => nextCronRun(cron, "UTC", new Date(anchor))).toThrow(/five minutes/);
  });
  it.each(["*/5 * * * *", "*/15 * * * *", "0 * * * *", "0,59 9 * * *", "0 9 * * 1-5", "0 9 1 * *"])("keeps supported schedules: %s", cron => {
    expect(nextCronRun(cron, "UTC", new Date("2026-10-21T09:00:30Z"))).toBeInstanceOf(Date);
  });
  it("keeps timezone and daylight-saving interpretation", () => {
    expect(nextCronRun("0 9 * * *", "Europe/London", new Date("2026-10-24T09:00:00Z")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(isValidCron("*/5 * * * *", "not/a/timezone")).toBe(false);
  });
});
