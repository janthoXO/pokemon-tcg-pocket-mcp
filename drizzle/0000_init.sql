CREATE TABLE `card_texts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` text NOT NULL,
	`lang` text NOT NULL,
	`name` text NOT NULL,
	`effect` text,
	`attacks` text NOT NULL,
	`image` text,
	`hash` text NOT NULL,
	`embed_hash` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_texts_card_lang_idx` ON `card_texts` (`card_id`,`lang`);--> statement-breakpoint
CREATE INDEX `card_texts_lang_idx` ON `card_texts` (`lang`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`set_id` text NOT NULL,
	`category` text NOT NULL,
	`type` text,
	`stage` text,
	`rarity` text NOT NULL,
	`hp` integer,
	`hash` text NOT NULL,
	FOREIGN KEY (`set_id`) REFERENCES `sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cards_set_idx` ON `cards` (`set_id`);--> statement-breakpoint
CREATE INDEX `cards_filter_idx` ON `cards` (`type`,`stage`,`rarity`,`category`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`text_id` integer NOT NULL,
	`kind` text NOT NULL,
	`idx` integer NOT NULL,
	`embedding` blob NOT NULL,
	PRIMARY KEY(`text_id`, `kind`, `idx`),
	FOREIGN KEY (`text_id`) REFERENCES `card_texts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `set_names` (
	`set_id` text NOT NULL,
	`lang` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`set_id`, `lang`),
	FOREIGN KEY (`set_id`) REFERENCES `sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sets` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`fetched_at` integer NOT NULL
);
