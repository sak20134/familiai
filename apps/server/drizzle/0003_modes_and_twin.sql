ALTER TABLE "messages" ADD COLUMN "mode" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "twin_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_member_mode" ON "messages" USING btree ("member_id","mode");