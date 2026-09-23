CREATE TABLE IF NOT EXISTS "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_number" integer NOT NULL,
	"appointment_date" date NOT NULL,
	"appointment_time" time,
	"customer_name" text NOT NULL,
	"mobile_number" text NOT NULL,
	"mobile_search" text NOT NULL,
	"baby_name" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_number_uk" UNIQUE("tenant_id","appointment_number"),
	CONSTRAINT "appointments_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "appointments_appointment_number_positive_check" CHECK ("appointments"."appointment_number" >= 1),
	CONSTRAINT "appointments_customer_name_not_blank_check" CHECK (length(btrim("appointments"."customer_name")) > 0),
	CONSTRAINT "appointments_mobile_number_not_blank_check" CHECK (length(btrim("appointments"."mobile_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_counters" (
	"tenant_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_counters_pk" PRIMARY KEY("tenant_id","document_type"),
	CONSTRAINT "document_counters_next_number_check" CHECK ("document_counters"."next_number" >= 1),
	CONSTRAINT "document_counters_document_type_not_blank_check" CHECK (length(btrim("document_counters"."document_type")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_tenant_date_idx" ON "appointments" USING btree ("tenant_id","appointment_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_tenant_mobile_idx" ON "appointments" USING btree ("tenant_id","mobile_search");