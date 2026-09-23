CREATE TABLE IF NOT EXISTS "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"head_group" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "account_groups_head_group_check" CHECK ("account_groups"."head_group" IN ('LIABILITIES', 'ASSETS', 'EXPENSES', 'INCOME', 'CASH', 'OTHER')),
	CONSTRAINT "account_groups_group_name_not_blank_check" CHECK (length(btrim("account_groups"."group_name")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_groups_tenant_name_lower_idx" ON "account_groups" USING btree ("tenant_id",lower("group_name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_groups_tenant_updated_idx" ON "account_groups" USING btree ("tenant_id","updated_at");