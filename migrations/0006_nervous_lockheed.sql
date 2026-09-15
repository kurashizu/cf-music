-- D1 rejects ADD COLUMN with a non-constant default (`current_timestamp`),
-- unlike plain SQLite which allows it as a special case — so the column is
-- added with a fixed placeholder default, then backfilled from created_at
-- for existing rows (a job's first "update" is effectively its creation).
-- New rows always pass an explicit value or hit application-level updates,
-- so the placeholder default only ever matters for this one-time backfill.
ALTER TABLE `import_jobs` ADD `updated_at` text DEFAULT '1970-01-01 00:00:00' NOT NULL;
--> statement-breakpoint
UPDATE `import_jobs` SET `updated_at` = `created_at`;
