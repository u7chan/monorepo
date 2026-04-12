UPDATE "messages" SET "metadata" = '{}'::jsonb WHERE "metadata" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "metadata" SET NOT NULL;