CREATE TABLE IF NOT EXISTS "receipt_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_allocations_receipt_bill_uk" UNIQUE("receipt_id","bill_id"),
	CONSTRAINT "receipt_allocations_amount_positive_check" CHECK ("receipt_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_number" integer NOT NULL,
	"receipt_date" date NOT NULL,
	"customer_name" text NOT NULL,
	"mobile_number" text NOT NULL,
	"mobile_search" text NOT NULL,
	"payment_mode" text NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"remark" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_tenant_number_uk" UNIQUE("tenant_id","receipt_number"),
	CONSTRAINT "receipts_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "receipts_receipt_number_positive_check" CHECK ("receipts"."receipt_number" >= 1),
	CONSTRAINT "receipts_amount_positive_check" CHECK ("receipts"."amount" > 0),
	CONSTRAINT "receipts_payment_mode_check" CHECK ("receipts"."payment_mode" IN ('CASH', 'BANK')),
	CONSTRAINT "receipts_status_check" CHECK ("receipts"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "receipts_cancelled_at_check" CHECK (("receipts"."status" = 'CANCELLED') = ("receipts"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "receipts_customer_name_not_blank_check" CHECK (length(btrim("receipts"."customer_name")) > 0),
	CONSTRAINT "receipts_mobile_search_not_blank_check" CHECK (length(btrim("receipts"."mobile_search")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_tenant_fk" FOREIGN KEY ("receipt_id","tenant_id") REFERENCES "public"."receipts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_bill_tenant_fk" FOREIGN KEY ("bill_id","tenant_id") REFERENCES "public"."bills"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipt_allocations_tenant_bill_idx" ON "receipt_allocations" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipts_tenant_date_idx" ON "receipts" USING btree ("tenant_id","receipt_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipts_tenant_mobile_idx" ON "receipts" USING btree ("tenant_id","mobile_search");