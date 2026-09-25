CREATE TABLE IF NOT EXISTS "company_logos" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_logos_content_type_check" CHECK ("company_logos"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "company_logos_byte_size_check" CHECK ("company_logos"."byte_size" > 0 and "company_logos"."byte_size" = octet_length("company_logos"."data"))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_company_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."companies"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
