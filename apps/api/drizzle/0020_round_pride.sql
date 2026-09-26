CREATE TABLE IF NOT EXISTS "advance_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"applied_on" date NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reverse_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advance_applications_amount_positive_check" CHECK ("advance_applications"."amount" > 0),
	CONSTRAINT "advance_applications_status_check" CHECK ("advance_applications"."status" IN ('ACTIVE', 'REVERSED')),
	CONSTRAINT "advance_applications_reversed_at_check" CHECK (("advance_applications"."status" = 'REVERSED') = ("advance_applications"."reversed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bill_work_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"outcome" text DEFAULT 'DONE' NOT NULL,
	"completed_on" date NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_work_stages_bill_stage_uk" UNIQUE("tenant_id","bill_id","stage"),
	CONSTRAINT "bill_work_stages_stage_check" CHECK ("bill_work_stages"."stage" IN ('SELECTION', 'EDITING', 'WHATSAPP', 'DELIVERY')),
	CONSTRAINT "bill_work_stages_outcome_check" CHECK ("bill_work_stages"."outcome" IN ('DONE', 'SKIPPED'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_receipt_tenant_fk" FOREIGN KEY ("receipt_id","tenant_id") REFERENCES "public"."receipts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_bill_tenant_fk" FOREIGN KEY ("bill_id","tenant_id") REFERENCES "public"."bills"("id","tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_work_stages" ADD CONSTRAINT "bill_work_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_work_stages" ADD CONSTRAINT "bill_work_stages_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_work_stages" ADD CONSTRAINT "bill_work_stages_bill_tenant_fk" FOREIGN KEY ("bill_id","tenant_id") REFERENCES "public"."bills"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advance_applications_tenant_bill_idx" ON "advance_applications" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advance_applications_tenant_receipt_idx" ON "advance_applications" USING btree ("tenant_id","receipt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_work_stages_tenant_stage_idx" ON "bill_work_stages" USING btree ("tenant_id","stage","completed_on");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_tenant_completed_idx" ON "appointments" USING btree ("tenant_id","completed_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_completed_by_check" CHECK ("appointments"."completed_by" IS NULL OR "appointments"."completed_at" IS NOT NULL);