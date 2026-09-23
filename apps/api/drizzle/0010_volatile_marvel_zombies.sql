ALTER TABLE "bill_items" ALTER COLUMN "taxable_amount" SET DATA TYPE numeric(16, 2);--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "gst_amount" SET DATA TYPE numeric(16, 2);--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "line_total" SET DATA TYPE numeric(16, 2);