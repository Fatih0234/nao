CREATE TABLE "web_robot_configuration" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recipe" jsonb NOT NULL,
	"recipe_version" integer NOT NULL,
	"recipe_hash" text NOT NULL,
	"scope" jsonb NOT NULL,
	"contract" jsonb NOT NULL,
	"verification_plan" jsonb NOT NULL,
	"source_assessment" jsonb NOT NULL,
	"scope_evidence" jsonb NOT NULL,
	"count_signals" jsonb NOT NULL,
	"configuration_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "web_robot_configuration_robot_hash_unique" UNIQUE("robot_id","configuration_hash")
);
--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "active_configuration_id" text;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "pending_configuration_id" text;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_verified_run_id" text;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_verified_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_published_run_id" text;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_published_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_published_entity_count" integer;--> statement-breakpoint
ALTER TABLE "web_robot" ADD COLUMN "last_published_entity_unit" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "configuration_id" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "configuration_hash" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "scope_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "contract_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "verification_plan_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "execution_status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "trust_status" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "trust_basis" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "trust_summary" jsonb;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "publication_status" text DEFAULT 'not_evaluated' NOT NULL;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "trust_report_path" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "trust_report_hash" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "execution_error_message" text;--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD COLUMN "publication_error_message" text;--> statement-breakpoint
ALTER TABLE "web_robot_configuration" ADD CONSTRAINT "web_robot_configuration_robot_id_web_robot_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."web_robot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_robot_configuration" ADD CONSTRAINT "web_robot_configuration_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_robot_configuration_robotId_idx" ON "web_robot_configuration" USING btree ("robot_id");--> statement-breakpoint
CREATE INDEX "web_robot_configuration_status_idx" ON "web_robot_configuration" USING btree ("status");--> statement-breakpoint
ALTER TABLE "web_robot_run" ADD CONSTRAINT "web_robot_run_configuration_id_web_robot_configuration_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."web_robot_configuration"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_robot_activeConfigurationId_idx" ON "web_robot" USING btree ("active_configuration_id");--> statement-breakpoint
CREATE INDEX "web_robot_pendingConfigurationId_idx" ON "web_robot" USING btree ("pending_configuration_id");--> statement-breakpoint
CREATE INDEX "web_robot_lastPublishedRunId_idx" ON "web_robot" USING btree ("last_published_run_id");--> statement-breakpoint
CREATE INDEX "web_robot_run_configurationId_idx" ON "web_robot_run" USING btree ("configuration_id");--> statement-breakpoint
CREATE INDEX "web_robot_run_executionStatus_idx" ON "web_robot_run" USING btree ("execution_status");--> statement-breakpoint
CREATE INDEX "web_robot_run_trustStatus_idx" ON "web_robot_run" USING btree ("trust_status");--> statement-breakpoint
CREATE INDEX "web_robot_run_publicationStatus_idx" ON "web_robot_run" USING btree ("publication_status");
--> statement-breakpoint
UPDATE "web_robot_run" SET "execution_status" = 'succeeded' WHERE "status" IN ('completed', 'partial');--> statement-breakpoint
UPDATE "web_robot_run" SET "execution_status" = 'running' WHERE "status" = 'running';--> statement-breakpoint
UPDATE "web_robot_run" SET "execution_status" = 'failed' WHERE "status" = 'failed';--> statement-breakpoint
UPDATE "web_robot_run" SET "execution_status" = 'cancelled' WHERE "status" = 'cancelled';--> statement-breakpoint
UPDATE "scheduled_job" SET "status" = 'paused', "locked_at" = NULL, "locked_by" = NULL
	WHERE "id" IN (SELECT "scheduled_job_id" FROM "web_robot" WHERE "scheduled_job_id" IS NOT NULL);
