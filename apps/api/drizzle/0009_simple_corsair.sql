CREATE TABLE IF NOT EXISTS "bill_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"sub_item_id" uuid NOT NULL,
	"item_name_snapshot" text NOT NULL,
	"sub_item_name_snapshot" text NOT NULL,
	"hsn_code_snapshot" text NOT NULL,
	"gst_rate_snapshot" numeric(5, 2) NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	"taxable_amount" numeric(14, 2) NOT NULL,
	"gst_amount" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_items_bill_line_uk" UNIQUE("bill_id","line_number"),
	CONSTRAINT "bill_items_line_number_positive_check" CHECK ("bill_items"."line_number" >= 1),
	CONSTRAINT "bill_items_quantity_positive_check" CHECK ("bill_items"."quantity" > 0),
	CONSTRAINT "bill_items_rate_non_negative_check" CHECK ("bill_items"."rate" >= 0),
	CONSTRAINT "bill_items_gst_rate_range_check" CHECK ("bill_items"."gst_rate_snapshot" >= 0 AND "bill_items"."gst_rate_snapshot" <= 100),
	CONSTRAINT "bill_items_taxable_amount_non_negative_check" CHECK ("bill_items"."taxable_amount" >= 0),
	CONSTRAINT "bill_items_gst_amount_non_negative_check" CHECK ("bill_items"."gst_amount" >= 0),
	CONSTRAINT "bill_items_line_total_non_negative_check" CHECK ("bill_items"."line_total" >= 0),
	CONSTRAINT "bill_items_item_name_not_blank_check" CHECK (length(btrim("bill_items"."item_name_snapshot")) > 0),
	CONSTRAINT "bill_items_sub_item_name_not_blank_check" CHECK (length(btrim("bill_items"."sub_item_name_snapshot")) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"bill_number" integer NOT NULL,
	"appointment_id" uuid,
	"bill_date" date NOT NULL,
	"delivery_date" date,
	"customer_name" text NOT NULL,
	"mobile_number" text NOT NULL,
	"mobile_search" text NOT NULL,
	"baby_name" text,
	"has_birth_date" boolean DEFAULT false NOT NULL,
	"birth_date" date,
	"remark" text,
	"tax_mode" text DEFAULT 'WITH_GST' NOT NULL,
	"sub_total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"gst_amount" numeric(16, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_tenant_book_number_uk" UNIQUE("tenant_id","book_id","bill_number"),
	CONSTRAINT "bills_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "bills_bill_number_positive_check" CHECK ("bills"."bill_number" >= 1),
	CONSTRAINT "bills_customer_name_not_blank_check" CHECK (length(btrim("bills"."customer_name")) > 0),
	CONSTRAINT "bills_mobile_number_not_blank_check" CHECK (length(btrim("bills"."mobile_number")) > 0),
	CONSTRAINT "bills_tax_mode_check" CHECK ("bills"."tax_mode" IN ('WITH_GST', 'WITHOUT_GST')),
	CONSTRAINT "bills_birth_date_check" CHECK ("bills"."has_birth_date" OR "bills"."birth_date" IS NULL),
	CONSTRAINT "bills_sub_total_non_negative_check" CHECK ("bills"."sub_total" >= 0),
	CONSTRAINT "bills_gst_amount_non_negative_check" CHECK ("bills"."gst_amount" >= 0),
	CONSTRAINT "bills_grand_total_non_negative_check" CHECK ("bills"."grand_total" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_tenant_fk" FOREIGN KEY ("bill_id","tenant_id") REFERENCES "public"."bills"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_item_tenant_fk" FOREIGN KEY ("item_id","tenant_id") REFERENCES "public"."items"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_sub_item_tenant_fk" FOREIGN KEY ("sub_item_id","tenant_id") REFERENCES "public"."sub_items"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_book_tenant_fk" FOREIGN KEY ("book_id","tenant_id") REFERENCES "public"."books"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_appointment_tenant_fk" FOREIGN KEY ("appointment_id","tenant_id") REFERENCES "public"."appointments"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_items_tenant_bill_idx" ON "bill_items" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_tenant_date_idx" ON "bills" USING btree ("tenant_id","bill_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_tenant_mobile_idx" ON "bills" USING btree ("tenant_id","mobile_search");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_tenant_updated_idx" ON "bills" USING btree ("tenant_id","updated_at");