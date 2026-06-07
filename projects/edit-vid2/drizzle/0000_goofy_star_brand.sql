CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`snapshot` text,
	`preset` text,
	`output_path` text,
	`log_path` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`template_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `subtitle_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`video_asset_id` text NOT NULL,
	`name` text NOT NULL,
	`timeline_state` text,
	`timeline_state_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`video_asset_id`) REFERENCES `video_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subtitle_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`font_family_id` text DEFAULT 'default' NOT NULL,
	`font_size` integer DEFAULT 48 NOT NULL,
	`font_color` text DEFAULT '#FFFFFF' NOT NULL,
	`bold` integer DEFAULT false NOT NULL,
	`italic` integer DEFAULT false NOT NULL,
	`outline_color` text DEFAULT '#000000' NOT NULL,
	`outline_width` real DEFAULT 2 NOT NULL,
	`shadow_enabled` integer DEFAULT false NOT NULL,
	`shadow_color` text DEFAULT '#000000' NOT NULL,
	`shadow_offset_x` real DEFAULT 0 NOT NULL,
	`shadow_offset_y` real DEFAULT 0 NOT NULL,
	`shadow_blur` real DEFAULT 0 NOT NULL,
	`background_box_enabled` integer DEFAULT false NOT NULL,
	`background_box_color` text DEFAULT '#000000' NOT NULL,
	`background_box_opacity` real DEFAULT 0.6 NOT NULL,
	`background_box_padding` real DEFAULT 4 NOT NULL,
	`position` text DEFAULT 'bottom' NOT NULL,
	`margin_x` real DEFAULT 0 NOT NULL,
	`margin_y` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `video_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`original_filename` text NOT NULL,
	`display_name` text NOT NULL,
	`storage_path` text NOT NULL,
	`thumbnail_path` text,
	`duration` real,
	`width` integer,
	`height` integer,
	`fps` real,
	`codec` text,
	`has_audio` integer,
	`file_size` integer,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text
);
