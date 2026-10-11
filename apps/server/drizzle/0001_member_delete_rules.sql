ALTER TABLE "ledger" DROP CONSTRAINT "ledger_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_access" DROP CONSTRAINT "vault_access_viewer_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access" ADD CONSTRAINT "vault_access_viewer_id_members_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;