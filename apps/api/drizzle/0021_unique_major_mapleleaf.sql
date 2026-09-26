ALTER TABLE "bills" ADD COLUMN "create_request_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_create_request_uk" UNIQUE("tenant_id","create_request_id");