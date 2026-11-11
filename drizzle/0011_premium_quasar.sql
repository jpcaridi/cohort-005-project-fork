ALTER TABLE `refunds` ADD `raised_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `refunds` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_status` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_failure_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_updated_at` text;