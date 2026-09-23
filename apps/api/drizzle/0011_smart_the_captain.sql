ALTER TABLE "bill_items" ADD COLUMN "discount_allocated" numeric(16, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_type" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_value" numeric(16, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_amount" numeric(16, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_discount_allocated_non_negative_check" CHECK ("bill_items"."discount_allocated" >= 0);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_type_check" CHECK ("bills"."discount_type" IN ('NONE', 'AMOUNT', 'PERCENT'));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_value_non_negative_check" CHECK ("bills"."discount_value" >= 0);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_amount_non_negative_check" CHECK ("bills"."discount_amount" >= 0);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_none_check" CHECK ("bills"."discount_type" <> 'NONE' OR ("bills"."discount_value" = 0 AND "bills"."discount_amount" = 0));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_percent_check" CHECK ("bills"."discount_type" <> 'PERCENT' OR "bills"."discount_value" <= 100);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_discount_within_sub_total_check" CHECK ("bills"."discount_amount" <= "bills"."sub_total");