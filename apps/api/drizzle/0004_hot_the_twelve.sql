CREATE TABLE IF NOT EXISTS "account_bank_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_name" text,
	"account_type" text,
	"branch" text,
	"account_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_employee_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_name" text,
	"address" text,
	"contact_number" text,
	"salary_type" text,
	"salary" numeric(14, 2),
	"designation" text,
	"commission" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_employee_details_salary_non_negative_check" CHECK ("account_employee_details"."salary" IS NULL OR "account_employee_details"."salary" >= 0),
	CONSTRAINT "account_employee_details_commission_non_negative_check" CHECK ("account_employee_details"."commission" IS NULL OR "account_employee_details"."commission" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_loan_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interest_rate" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_loan_details_interest_rate_range_check" CHECK ("account_loan_details"."interest_rate" IS NULL OR ("account_loan_details"."interest_rate" >= 0 AND "account_loan_details"."interest_rate" <= 100))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_partner_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mobile_number" text,
	"profit_percent" numeric(5, 2),
	"loss_percent" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_partner_details_profit_percent_range_check" CHECK ("account_partner_details"."profit_percent" IS NULL OR ("account_partner_details"."profit_percent" >= 0 AND "account_partner_details"."profit_percent" <= 100)),
	CONSTRAINT "account_partner_details_loss_percent_range_check" CHECK ("account_partner_details"."loss_percent" IS NULL OR ("account_partner_details"."loss_percent" >= 0 AND "account_partner_details"."loss_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_party_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_name" text,
	"address" text,
	"contact_number" text,
	"gst" text,
	"pan_no" text,
	"rate" numeric(14, 2),
	"email" text,
	"item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_party_details_rate_non_negative_check" CHECK ("account_party_details"."rate" IS NULL OR "account_party_details"."rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_group_id" uuid NOT NULL,
	"account_name" text NOT NULL,
	"opening_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"opening_side" text DEFAULT 'DEBIT' NOT NULL,
	"remark" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "accounts_opening_side_check" CHECK ("accounts"."opening_side" IN ('DEBIT', 'CREDIT')),
	CONSTRAINT "accounts_opening_amount_non_negative_check" CHECK ("accounts"."opening_amount" >= 0),
	CONSTRAINT "accounts_account_name_not_blank_check" CHECK (length(btrim("accounts"."account_name")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_bank_details" ADD CONSTRAINT "account_bank_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_bank_details" ADD CONSTRAINT "account_bank_details_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_employee_details" ADD CONSTRAINT "account_employee_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_employee_details" ADD CONSTRAINT "account_employee_details_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_loan_details" ADD CONSTRAINT "account_loan_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_loan_details" ADD CONSTRAINT "account_loan_details_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_partner_details" ADD CONSTRAINT "account_partner_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_partner_details" ADD CONSTRAINT "account_partner_details_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_party_details" ADD CONSTRAINT "account_party_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_party_details" ADD CONSTRAINT "account_party_details_account_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_party_details" ADD CONSTRAINT "account_party_details_item_tenant_fk" FOREIGN KEY ("item_id","tenant_id") REFERENCES "public"."items"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_group_tenant_fk" FOREIGN KEY ("account_group_id","tenant_id") REFERENCES "public"."account_groups"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_party_details_item_idx" ON "account_party_details" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_tenant_name_lower_idx" ON "accounts" USING btree ("tenant_id",lower("account_name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_tenant_updated_idx" ON "accounts" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_tenant_group_idx" ON "accounts" USING btree ("tenant_id","account_group_id");