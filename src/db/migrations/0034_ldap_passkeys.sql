ALTER TABLE "auth_flows" DROP CONSTRAINT "auth_flows_user_id_local_credentials_user_id_fk";
--> statement-breakpoint
ALTER TABLE "local_security" DROP CONSTRAINT "local_security_user_id_local_credentials_user_id_fk";
--> statement-breakpoint
ALTER TABLE "local_security" ADD COLUMN "ldap_dn" text;--> statement-breakpoint
ALTER TABLE "local_security" ADD COLUMN "ldap_identity" text;--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_security" ADD CONSTRAINT "local_security_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;