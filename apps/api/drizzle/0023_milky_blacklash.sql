CREATE TABLE IF NOT EXISTS "company_print_assets" (
	"company_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_print_assets_pk" PRIMARY KEY("company_id","kind"),
	CONSTRAINT "company_print_assets_kind_check" CHECK ("company_print_assets"."kind" in ('SIGNATURE', 'FOOTER')),
	CONSTRAINT "company_print_assets_content_type_check" CHECK ("company_print_assets"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "company_print_assets_byte_size_check" CHECK ("company_print_assets"."byte_size" > 0 and "company_print_assets"."byte_size" = octet_length("company_print_assets"."data"))
);
--> statement-breakpoint
ALTER TABLE "invoice_templates" DROP CONSTRAINT "invoice_templates_layout_preset_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_print_assets" ADD CONSTRAINT "company_print_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_print_assets" ADD CONSTRAINT "company_print_assets_company_tenant_fk" FOREIGN KEY ("company_id","tenant_id") REFERENCES "public"."companies"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_layout_preset_check" CHECK ("invoice_templates"."layout_preset" in ('CLASSIC', 'COMPACT', 'DETAILED', 'STUDIO'));