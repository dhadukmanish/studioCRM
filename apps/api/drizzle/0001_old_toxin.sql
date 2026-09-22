CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_name" text NOT NULL,
	"hsn_code" text NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_gst_rate_range_check" CHECK ("items"."gst_rate" >= 0 AND "items"."gst_rate" <= 100),
	CONSTRAINT "items_item_name_not_blank_check" CHECK (length(btrim("items"."item_name")) > 0),
	CONSTRAINT "items_hsn_code_not_blank_check" CHECK (length(btrim("items"."hsn_code")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_tenant_name_lower_idx" ON "items" USING btree ("tenant_id",lower("item_name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_tenant_updated_idx" ON "items" USING btree ("tenant_id","updated_at");