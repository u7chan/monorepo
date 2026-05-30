CREATE TABLE "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"input_type" text NOT NULL,
	"title" text NOT NULL,
	"placeholder" text NOT NULL,
	"prompt" text NOT NULL,
	"display_order" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
