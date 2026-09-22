ALTER TABLE "items" ADD CONSTRAINT "items_id_tenant_uk" UNIQUE("id","tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sub_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	"remark" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_items_rate_non_negative_check" CHECK ("sub_items"."rate" >= 0),
	CONSTRAINT "sub_items_product_name_not_blank_check" CHECK (length(btrim("sub_items"."product_name")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sub_items" ADD CONSTRAINT "sub_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sub_items" ADD CONSTRAINT "sub_items_item_tenant_fk" FOREIGN KEY ("item_id","tenant_id") REFERENCES "public"."items"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sub_items_item_product_lower_idx" ON "sub_items" USING btree ("tenant_id","item_id",lower("product_name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_items_tenant_updated_idx" ON "sub_items" USING btree ("tenant_id","updated_at");
