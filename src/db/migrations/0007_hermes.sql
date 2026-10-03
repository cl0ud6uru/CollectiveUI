ALTER TABLE "ai_apps" DROP CONSTRAINT "ai_apps_provider_check";--> statement-breakpoint
ALTER TABLE "ai_apps" DROP CONSTRAINT "ai_apps_base_url_check";--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_provider_check" CHECK ("ai_apps"."provider" in ('openai-compatible', 'openai', 'azure', 'anthropic', 'bedrock', 'vertex-anthropic', 'chatgpt', 'hermes'));--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_base_url_check" CHECK ("ai_apps"."provider" not in ('openai-compatible', 'hermes') or "ai_apps"."base_url" is not null);