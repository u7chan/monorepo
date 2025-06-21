ALTER TABLE "conversations" ADD COLUMN "updated_at" timestamp;

UPDATE "conversations"
SET
    "updated_at" = "created_at"
WHERE
    "updated_at" IS NULL;

ALTER TABLE "conversations" ALTER COLUMN "updated_at" SET NOT NULL;