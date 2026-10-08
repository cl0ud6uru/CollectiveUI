-- Remove erroneous local dollar estimates from subscription and unverified Hermes activity; retain tokens and routing facts.
UPDATE usage_events SET cost_micros = NULL, search_tool_cost_estimate_micros = NULL WHERE billing_source <> 'org' OR provider_kind IN ('chatgpt', 'hermes');
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_api_cost_check" CHECK (("usage_events"."billing_source" = 'org' and "usage_events"."provider_kind" not in ('chatgpt', 'hermes')) or ("usage_events"."cost_micros" is null and "usage_events"."search_tool_cost_estimate_micros" is null));