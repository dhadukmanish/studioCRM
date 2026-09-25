CREATE TABLE IF NOT EXISTS "public_invoice_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"template_id" uuid,
	"token_hash" text NOT NULL,
	"bill_revision" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "public_invoice_links_token_hash_check" CHECK ("public_invoice_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_invoice_links_revoke_reason_check" CHECK ("public_invoice_links"."revoke_reason" in ('BILL_UPDATED', 'TEMPLATE_CHANGED', 'REPLACED', 'MANUAL', 'STALE')),
	CONSTRAINT "public_invoice_links_revoked_pair_check" CHECK (("public_invoice_links"."revoked_at" is null) = ("public_invoice_links"."revoke_reason" is null))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_invoice_links" ADD CONSTRAINT "public_invoice_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_invoice_links" ADD CONSTRAINT "public_invoice_links_bill_tenant_fk" FOREIGN KEY ("bill_id","tenant_id") REFERENCES "public"."bills"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_invoice_links" ADD CONSTRAINT "public_invoice_links_template_tenant_fk" FOREIGN KEY ("template_id","tenant_id") REFERENCES "public"."invoice_templates"("id","tenant_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_invoice_links_token_hash_idx" ON "public_invoice_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_invoice_links_one_active_idx" ON "public_invoice_links" USING btree ("tenant_id","bill_id") WHERE "public_invoice_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_invoice_links_tenant_template_idx" ON "public_invoice_links" USING btree ("tenant_id","template_id");