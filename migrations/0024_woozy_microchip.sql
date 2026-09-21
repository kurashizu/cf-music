ALTER TABLE `invite_codes` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `invite_codes` ADD `revoked_by` text REFERENCES users(id);