/**
 * Routine trigger types shared by the schema, server actions and UI (docs/plans/event-triggers.md).
 * "event" routines are fired by an integration provider (e.g. Slack) named in their trigger config.
 * Kept free of runtime imports so src/db/schema.ts can depend on it.
 */
export const TRIGGER_TYPES = ["cron", "webhook", "event"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Trigger types a user can pick in the routine editor today; "event" lands with its first provider. */
export const EDITABLE_TRIGGER_TYPES = ["cron", "webhook"] as const satisfies readonly TriggerType[];
export type EditableTriggerType = (typeof EDITABLE_TRIGGER_TYPES)[number];

/** What started a routine run (routine_runs.trigger). */
export type RoutineRunTrigger = "schedule" | "webhook" | "manual" | "event";

/** routines.trigger_config for event routines; match is validated by the provider's own schema. */
export type EventTriggerConfig = {
  kind: "event";
  provider: string;
  connectionId: string;
  version: number;
  match: unknown;
};
export type TriggerConfig = EventTriggerConfig;

export type TriggerConnectionStatus = "active" | "revoked" | "error";
export type TriggerEventStatus = "received" | "matched" | "no_match" | "skipped" | "rejected";
