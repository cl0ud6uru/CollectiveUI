ALTER TABLE "hermes_team_run_attribution" ADD COLUMN "admission" jsonb;--> statement-breakpoint
ALTER TABLE "hermes_team_run_attribution" ADD CONSTRAINT "hermes_team_run_admission_check" CHECK ("hermes_team_run_attribution"."admission" is null or (
  jsonb_typeof("hermes_team_run_attribution"."admission") = 'object' and octet_length("hermes_team_run_attribution"."admission"::text) <= 8192
  and "hermes_team_run_attribution"."admission" ?& array['version','routeId','adapterId','integration','model','billing','connectionId','gatewayGrantId','evidence','purposes']
  and "hermes_team_run_attribution"."admission"->>'version' = '1' and "hermes_team_run_attribution"."admission"->>'billing' = "hermes_team_run_attribution"."model_source"
  and jsonb_typeof("hermes_team_run_attribution"."admission"->'purposes') = 'object' and "hermes_team_run_attribution"."admission"->'purposes' <> '{}'::jsonb
  and (("hermes_team_run_attribution"."admission"->'purposes') - array['reply','learning','utility','subagent']) = '{}'::jsonb
  and ("hermes_team_run_attribution"."admission" - array['version','routeId','adapterId','integration','model','billing','connectionId','gatewayGrantId','evidence','purposes']) = '{}'::jsonb
) is true);