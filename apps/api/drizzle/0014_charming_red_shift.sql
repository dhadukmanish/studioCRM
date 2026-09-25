CREATE TABLE IF NOT EXISTS "invoice_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"description" text,
	"supported_mode" text DEFAULT 'BOTH' NOT NULL,
	"layout_preset" text DEFAULT 'CLASSIC' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_templates_supported_mode_check" CHECK ("invoice_templates"."supported_mode" in ('BOTH', 'WITH_GST', 'WITHOUT_GST')),
	CONSTRAINT "invoice_templates_layout_preset_check" CHECK ("invoice_templates"."layout_preset" in ('CLASSIC', 'COMPACT', 'DETAILED')),
	CONSTRAINT "invoice_templates_name_not_blank_check" CHECK (length(btrim("invoice_templates"."template_name")) > 0),
	CONSTRAINT "invoice_templates_default_is_active_check" CHECK (not "invoice_templates"."is_default" or "invoice_templates"."is_active")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_templates_tenant_name_lower_idx" ON "invoice_templates" USING btree ("tenant_id",lower("template_name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_templates_one_default_idx" ON "invoice_templates" USING btree ("tenant_id") WHERE "invoice_templates"."is_default";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_templates_tenant_updated_idx" ON "invoice_templates" USING btree ("tenant_id","updated_at");