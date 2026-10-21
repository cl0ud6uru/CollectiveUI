import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { routineRuns, routines, triggerConnections, triggerEvents } from "@/db/schema";
import { EDITABLE_TRIGGER_TYPES, TRIGGER_TYPES } from "@/lib/triggers/types";

describe("routine trigger types", () => {
  it("adds event without exposing it in the editor yet", () => {
    expect(TRIGGER_TYPES).toEqual(["cron", "webhook", "event"]);
    expect(EDITABLE_TRIGGER_TYPES).toEqual(["cron", "webhook"]);
  });

  it("keeps event trigger columns optional so cron/webhook rows are unaffected", () => {
    const cols = getTableConfig(routines).columns;
    for (const name of ["trigger_config", "trigger_provider", "trigger_connection_id"])
      expect(cols.find((c) => c.name === name)?.notNull).toBe(false);
    expect(getTableConfig(routineRuns).columns.find((c) => c.name === "trigger_event_id")?.notNull).toBe(false);
  });

  it("dedupes inbound events and runs per event", () => {
    const unique = (t: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(t).indexes.filter((i) => i.config.unique).map((i) => i.config.name);
    expect(unique(triggerEvents)).toContain("trigger_events_provider_external_idx");
    expect(unique(triggerConnections)).toContain("trigger_connections_provider_external_idx");
    expect(unique(routineRuns)).toContain("routine_runs_trigger_event_idx");
  });
});
