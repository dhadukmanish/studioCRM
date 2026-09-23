CREATE TABLE IF NOT EXISTS "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"book_number" text NOT NULL,
	"series_starts_at" integer DEFAULT 1 NOT NULL,
	"next_bill_number" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_id_tenant_uk" UNIQUE("id","tenant_id"),
	CONSTRAINT "books_book_number_not_blank_check" CHECK (length(btrim("books"."book_number")) > 0),
	CONSTRAINT "books_series_starts_at_positive_check" CHECK ("books"."series_starts_at" >= 1),
	CONSTRAINT "books_next_bill_number_check" CHECK ("books"."next_bill_number" >= "books"."series_starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "books" ADD CONSTRAINT "books_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "books_tenant_number_lower_idx" ON "books" USING btree ("tenant_id",lower("book_number"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "books_tenant_updated_idx" ON "books" USING btree ("tenant_id","updated_at");