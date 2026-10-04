CREATE TABLE IF NOT EXISTS "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"duration_days" integer,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_name_unique" UNIQUE("name"),
	CONSTRAINT "subscription_plans_kind_check" CHECK ("subscription_plans"."kind" IN ('TRIAL', 'DAYS', 'MONTHLY', 'YEARLY')),
	CONSTRAINT "subscription_plans_duration_check" CHECK (("subscription_plans"."kind" = 'DAYS') = ("subscription_plans"."duration_days" IS NULL) AND ("subscription_plans"."duration_days" IS NULL OR "subscription_plans"."duration_days" > 0)),
	CONSTRAINT "subscription_plans_price_check" CHECK ("subscription_plans"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"kind" text NOT NULL,
	"days" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"payment_mode" text,
	"payment_ref" text,
	"paid_on" date,
	"notes" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_kind_check" CHECK ("tenant_subscriptions"."kind" IN ('TRIAL', 'DAYS', 'MONTHLY', 'YEARLY')),
	CONSTRAINT "tenant_subscriptions_status_check" CHECK ("tenant_subscriptions"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "tenant_subscriptions_dates_check" CHECK ("tenant_subscriptions"."ends_on" >= "tenant_subscriptions"."starts_on" AND "tenant_subscriptions"."days" = "tenant_subscriptions"."ends_on" - "tenant_subscriptions"."starts_on" + 1),
	CONSTRAINT "tenant_subscriptions_amount_check" CHECK ("tenant_subscriptions"."amount" >= 0),
	CONSTRAINT "tenant_subscriptions_payment_mode_check" CHECK ("tenant_subscriptions"."payment_mode" IS NULL OR "tenant_subscriptions"."payment_mode" IN ('CASH', 'UPI', 'BANK', 'CHEQUE', 'OTHER')),
	CONSTRAINT "tenant_subscriptions_cancelled_check" CHECK (("tenant_subscriptions"."status" = 'CANCELLED') = ("tenant_subscriptions"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_created_by_platform_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_cancelled_by_platform_admins_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."platform_admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_subscriptions_tenant_idx" ON "tenant_subscriptions" USING btree ("tenant_id","status","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_subscriptions_one_trial_idx" ON "tenant_subscriptions" USING btree ("tenant_id") WHERE "tenant_subscriptions"."kind" = 'TRIAL' AND "tenant_subscriptions"."status" = 'ACTIVE';