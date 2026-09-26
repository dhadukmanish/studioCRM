ALTER TABLE "appointments" ADD COLUMN "source_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "next_visit_date" date;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "series_type" text DEFAULT 'WITH_GST' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_source_bill_fk" FOREIGN KEY ("source_bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_tenant_source_bill_uk" ON "appointments" USING btree ("tenant_id","source_bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_tenant_created_idx" ON "bills" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_series_type_check" CHECK ("books"."series_type" in ('WITH_GST', 'WITHOUT_GST'));