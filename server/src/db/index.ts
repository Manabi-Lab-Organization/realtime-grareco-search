import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema.js';

export function parsePgTimestampUTC(val: string): Date {
  return new Date(val.replace(' ', 'T') + 'Z');
}
types.setTypeParser(types.builtins.TIMESTAMP, parsePgTimestampUTC);

const useSsl = process.env.DATABASE_SSL === 'true' || /[?&]sslmode=(require|verify-ca|verify-full)/.test(process.env.DATABASE_URL ?? '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSsl && {
    ssl: { rejectUnauthorized: false },
  }),
});

export const db = drizzle(pool, { schema });
export { pool };

export async function ensureTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" serial PRIMARY KEY,
        "email" varchar(255) NOT NULL UNIQUE,
        "password_hash" varchar(255),
        "display_name" varchar(100),
        "google_id" varchar(255) UNIQUE,
        "api_token" varchar(64) UNIQUE,
        "reset_token" varchar(64),
        "reset_token_expiry" timestamp,
        "grareco_model" varchar(100) DEFAULT 'gemini-3.1-flash-image',
        "grareco_auto_model" varchar(100) DEFAULT 'gemini-3.1-flash-image',
        "role" varchar(20) NOT NULL DEFAULT 'user',
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "meetings" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "title" text NOT NULL DEFAULT '無題の会議',
        "platform" varchar(50) NOT NULL DEFAULT 'web-recorder',
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "is_title_edited" boolean NOT NULL DEFAULT false,
        "participants" jsonb DEFAULT '[]',
        "started_at" timestamp DEFAULT now() NOT NULL,
        "ended_at" timestamp,
        "duration" integer,
        "email_sent_at" timestamp,
        "meeting_type" varchar(30) DEFAULT 'general'
      );
    `);

    await client.query(`ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "transcription_started_at" timestamp;`);
    await client.query(`ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "paused_seconds" integer NOT NULL DEFAULT 0;`);
    await client.query(`ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "paused_since" timestamp;`);
    await client.query(`ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "last_audio_at" timestamp;`);
    await client.query(`UPDATE "meetings" SET "transcription_started_at" = "started_at" WHERE "status" IN ('active','paused') AND "transcription_started_at" IS NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "transcripts" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "speaker" text,
        "speaker_id" integer,
        "content" text NOT NULL,
        "start_time" integer NOT NULL DEFAULT 0,
        "end_time" integer NOT NULL DEFAULT 0,
        "is_final" boolean NOT NULL DEFAULT true,
        "confidence" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "structured_summaries" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "previous_content" text,
        "last_processed_time" integer,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "analyses" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "type" varchar(50) NOT NULL,
        "content" text NOT NULL,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "graphic_recordings" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "source_text" text NOT NULL,
        "image_url" text NOT NULL,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "user_term_dictionary" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "term_hash" varchar(64) NOT NULL,
        "term" varchar(200),
        "reading" varchar(200),
        "explanation" text,
        "category" varchar(50),
        "is_skip" boolean DEFAULT false NOT NULL,
        "skip_reason" varchar(20),
        "source" varchar(20) DEFAULT 'ai',
        "usage_count" integer DEFAULT 1,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "user_term_dictionary_sensitive_no_plaintext" CHECK (
          ("skip_reason" = 'sensitive' AND "term" IS NULL)
          OR ("skip_reason" IS DISTINCT FROM 'sensitive' AND "term" IS NOT NULL)
        )
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "user_term_dictionary_user_hash_idx"
      ON "user_term_dictionary" ("user_id", "term_hash");
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "meeting_term_hits" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "term_id" integer NOT NULL REFERENCES "user_term_dictionary"("id") ON DELETE CASCADE,
        "first_detected_at" integer,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "meeting_term_hits_meeting_term_idx"
      ON "meeting_term_hits" ("meeting_id", "term_id");
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_term_exclusions' AND column_name = 'term'
        ) THEN
          DROP TABLE "user_term_exclusions";
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "user_term_exclusions" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "term_hash" varchar(64) NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "user_term_exclusions_user_hash_idx"
      ON "user_term_exclusions" ("user_id", "term_hash");
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "research_insights" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "agent_type" varchar(30) NOT NULL,
        "card_type" varchar(30) NOT NULL,
        "keyword" varchar(200),
        "content" text NOT NULL,
        "importance" integer DEFAULT 50,
        "status" varchar(20) DEFAULT 'active',
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "research_gap_items" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "question" text NOT NULL,
        "detected_at_ms" integer NOT NULL,
        "resolved_at_ms" integer,
        "alerted_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);


    await client.query(`
      CREATE TABLE IF NOT EXISTS "meeting_images" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "image_data" text NOT NULL,
        "mime_type" varchar(50) NOT NULL,
        "file_name" varchar(255),
        "uploaded_at" timestamp DEFAULT now() NOT NULL,
        "meeting_elapsed_ms" integer,
        "ai_analysis" text,
        "ai_diagram" text,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "meeting_memos" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "meeting_elapsed_ms" integer,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);


    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(20) NOT NULL DEFAULT 'user';`);

    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" varchar(255) UNIQUE;`);
    await client.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "participant_images" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "image_data" text NOT NULL,
        "mime_type" varchar(50) NOT NULL,
        "file_name" varchar(255),
        "ai_extracted_participants" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "participant_texts" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "ai_extracted_participants" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);


    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "api_token_hash" varchar(64) UNIQUE;`);
    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reset_token_hash" varchar(64);`);

    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp;`);
    await client.query(`CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));`);

    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "room_observation_consent_version" integer;`);
    await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "room_observation_consented_at" timestamptz;`);

    const cryptoModule = await import('node:crypto');
    const sha256 = (v: string) => cryptoModule.createHash('sha256').update(v).digest('hex');

    const { rows: needApiHash } = await client.query<{ id: number; api_token: string }>(
      `SELECT id, api_token FROM "users" WHERE api_token IS NOT NULL AND api_token_hash IS NULL;`
    );
    for (const row of needApiHash) {
      await client.query(`UPDATE "users" SET api_token_hash = $1 WHERE id = $2;`, [sha256(row.api_token), row.id]);
    }
    if (needApiHash.length > 0) {
      console.log(`[DB] api_token_hash backfilled for ${needApiHash.length} users`);
    }

    const { rows: needResetHash } = await client.query<{ id: number; reset_token: string }>(
      `SELECT id, reset_token FROM "users" WHERE reset_token IS NOT NULL AND reset_token_hash IS NULL;`
    );
    for (const row of needResetHash) {
      await client.query(`UPDATE "users" SET reset_token_hash = $1 WHERE id = $2;`, [sha256(row.reset_token), row.id]);
    }
    if (needResetHash.length > 0) {
      console.log(`[DB] reset_token_hash backfilled for ${needResetHash.length} users`);
    }

    const nulledApi = await client.query(
      `UPDATE "users" SET api_token = NULL WHERE api_token IS NOT NULL AND api_token_hash IS NOT NULL;`
    );
    if (nulledApi.rowCount) {
      console.log(`[DB] api_token 平文を ${nulledApi.rowCount} 件 NULL 化（ハッシュ保持済み）`);
    }
    const nulledReset = await client.query(
      `UPDATE "users" SET reset_token = NULL WHERE reset_token IS NOT NULL AND reset_token_hash IS NOT NULL;`
    );
    if (nulledReset.rowCount) {
      console.log(`[DB] reset_token 平文を ${nulledReset.rowCount} 件 NULL 化（ハッシュ保持済み）`);
    }


    await client.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "research_settings" jsonb NOT NULL DEFAULT '{
        "main": true,
        "web": true,
        "fact": true,
        "gap": true,
        "tech": true
      }'::jsonb;
    `);
    await client.query(`
      ALTER TABLE "users" ALTER COLUMN "research_settings" SET DEFAULT '{
        "main": true,
        "web": true,
        "fact": true,
        "gap": true,
        "tech": true
      }'::jsonb;
    `);

    await client.query(`
      ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "meeting_type" varchar(30) DEFAULT 'general';
    `);

    await client.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "invite_verified" boolean NOT NULL DEFAULT false;
    `);
    await client.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "invite_verified_at" timestamp;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "invite_codes" (
        "code"        varchar(64) PRIMARY KEY,
        "max_uses"    integer,
        "used_count"  integer NOT NULL DEFAULT 0,
        "expires_at"  timestamp,
        "note"        text,
        "is_active"   boolean NOT NULL DEFAULT true,
        "created_by"  integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at"  timestamp NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "invite_redemptions" (
        "id"          serial PRIMARY KEY,
        "user_id"     integer NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
        "code"        varchar(64) NOT NULL,
        "redeemed_at" timestamp NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      UPDATE "users"
      SET "invite_verified" = true,
          "invite_verified_at" = COALESCE("invite_verified_at", now())
      WHERE "role" = 'admin' AND "invite_verified" = false;
    `);

    await client.query(`ALTER TABLE "graphic_recordings" ALTER COLUMN "image_url" DROP NOT NULL;`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "trigger_type" varchar(30) NOT NULL DEFAULT 'manual';`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "stage" varchar(20) NOT NULL DEFAULT 'image';`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp;`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "draft_json" jsonb;`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "research_insight_ids" jsonb;`);
    await client.query(`ALTER TABLE "graphic_recordings" ADD COLUMN IF NOT EXISTS "visual_style" varchar(30);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "topic_shift_embeddings" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "recorded_at_ms" bigint NOT NULL,
        "text_preview" text,
        "embedding" jsonb NOT NULL,
        "immediate_similarity" text,
        "baseline_similarity" text,
        "moving_avg_similarity" text,
        "outcome" varchar(20),
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      ALTER TABLE "topic_shift_embeddings"
      ALTER COLUMN "recorded_at_ms" TYPE bigint USING "recorded_at_ms"::bigint;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "topic_shift_embeddings_meeting_idx"
      ON "topic_shift_embeddings"("meeting_id", "recorded_at_ms");
    `);

    await client.query(`ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "initial_profiling_done_at" timestamp;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "participant_profile_cards" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "speaker_id" integer NOT NULL,
        "utterance" text NOT NULL,
        "transcript_id" integer,
        "suggested_name" text NOT NULL,
        "final_name" text,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "origin" varchar(20) NOT NULL DEFAULT 'initial',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "resolved_at" timestamp
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "idx_profile_cards_meeting" ON "participant_profile_cards"("meeting_id");`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "participant_conversation_extractions" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "origin" varchar(20) NOT NULL DEFAULT 'initial',
        "ai_extracted_participants" jsonb,
        "created_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS "idx_pcext_meeting" ON "participant_conversation_extractions"("meeting_id");`
    );

    await client.query(
      `ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "dismissed_participant_names" jsonb DEFAULT '[]'::jsonb;`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS "announcements" (
        "id" serial PRIMARY KEY,
        "title" varchar(200) NOT NULL,
        "body" text NOT NULL,
        "important" boolean NOT NULL DEFAULT false,
        "target_segment" varchar(20) NOT NULL DEFAULT 'all',
        "starts_at" timestamp NOT NULL DEFAULT now(),
        "ends_at" timestamp,
        "is_published" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "announcement_reads" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "announcement_id" integer NOT NULL REFERENCES "announcements"("id") ON DELETE CASCADE,
        "read_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "announcement_reads_user_ann_idx" ON "announcement_reads"("user_id", "announcement_id");`
    );

    await client.query(
      `ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "ng_keywords" jsonb DEFAULT '[]'::jsonb;`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS "meeting_observations" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "captured_at" timestamp DEFAULT now() NOT NULL,
        "meeting_elapsed_ms" integer,
        "people_count" integer,
        "five_w1h" jsonb,
        "people" jsonb,
        "location" jsonb,
        "raw_summary" text,
        "source_type" varchar(20) NOT NULL DEFAULT 'camera',
        "linked_image_id" integer REFERENCES "meeting_images"("id") ON DELETE SET NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "meeting_observations_meeting_idx"
      ON "meeting_observations"("meeting_id", "captured_at");
    `);
    await client.query(`ALTER TABLE "meeting_observations" ADD COLUMN IF NOT EXISTS "materials_text" text;`);
    await client.query(`ALTER TABLE "meeting_observations" ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 1;`);
    await client.query(`ALTER TABLE "meeting_observations" ADD COLUMN IF NOT EXISTS "materials_diagram" text;`);
    await client.query(`ALTER TABLE "meeting_observations" ADD COLUMN IF NOT EXISTS "consolidated_at" timestamp;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "meeting_shares" (
        "id" serial PRIMARY KEY,
        "meeting_id" integer NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
        "token" varchar(64) NOT NULL UNIQUE,
        "created_by" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "is_active" boolean NOT NULL DEFAULT true,
        "shared_contents" jsonb DEFAULT '["glossary","research","grareco","summary"]'::jsonb,
        "revoked_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "meeting_shares_meeting_idx"
      ON "meeting_shares"("meeting_id");
    `);
    await client.query(
      `ALTER TABLE "meeting_shares" ADD COLUMN IF NOT EXISTS "excluded_items" jsonb DEFAULT '{}'::jsonb;`
    );

    await client.query(
      `ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "recording_ms" integer;`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS "desktop_exchange_codes" (
        "id" serial PRIMARY KEY,
        "code" varchar(64) NOT NULL UNIQUE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "expires_at" timestamp NOT NULL,
        "used_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`ALTER TABLE "desktop_exchange_codes" ADD COLUMN IF NOT EXISTS "api_token_id" integer;`);
    await client.query(`DELETE FROM "desktop_exchange_codes" WHERE expires_at < now() OR used_at IS NOT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "api_tokens" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "token_hash" varchar(64) NOT NULL UNIQUE,
        "device_name" varchar(100),
        "client_type" varchar(20) NOT NULL DEFAULT 'desktop',
        "client_version" varchar(40),
        "created_at" timestamp DEFAULT now() NOT NULL,
        "last_used_at" timestamp DEFAULT now() NOT NULL,
        "revoked_at" timestamp,
        "revoked_reason" varchar(40),
        "sudo_at" timestamp
      );
    `);
    await client.query(`ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "sudo_at" timestamp;`);
    await client.query(`CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" ("user_id");`);
    try {
      await client.query('BEGIN');
      const migrated = await client.query(`
        INSERT INTO "api_tokens" (user_id, token_hash, device_name, client_type, created_at, last_used_at)
        SELECT id, api_token_hash, '以前のログイン', 'legacy', now(), now()
        FROM "users" WHERE api_token_hash IS NOT NULL
        ON CONFLICT (token_hash) DO NOTHING;
      `);
      const cleared = await client.query(`
        UPDATE "users" u SET api_token_hash = NULL
        WHERE u.api_token_hash IS NOT NULL
          AND EXISTS (SELECT 1 FROM "api_tokens" t WHERE t.token_hash = u.api_token_hash AND t.user_id = u.id);
      `);
      await client.query('COMMIT');
      if (migrated.rowCount || cleared.rowCount) {
        console.log(`[DB] 旧 API トークンを api_tokens へ移行: ${migrated.rowCount ?? 0} 件コピー / ${cleared.rowCount ?? 0} 件 users 側を NULL 化`);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[DB] api_tokens への移行に失敗（旧列の照合で動作を継続）:', err);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id" bigserial PRIMARY KEY,
        "ts" timestamptz NOT NULL DEFAULT now(),
        "app" text NOT NULL,
        "event" text NOT NULL,
        "result" text NOT NULL,
        "actor_id" text,
        "actor_email" text,
        "actor_role" text,
        "auth_method" text,
        "tenant_id" text,
        "target_type" text,
        "target_id" text,
        "ip" inet,
        "user_agent" text,
        "request_id" text,
        "detail" jsonb
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_ts_idx" ON "audit_log" ("ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_actor_ts_idx" ON "audit_log" ("actor_id", "ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_target_ts_idx" ON "audit_log" ("target_type", "target_id", "ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_event_ts_idx" ON "audit_log" ("event", "ts");`);
    await client.query(`
      CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_retention', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_log is append-only (% is not allowed)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS "audit_log_no_modify" ON "audit_log";`);
    await client.query(`
      CREATE TRIGGER "audit_log_no_modify" BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
    `);
    await client.query(`DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON "audit_log";`);
    await client.query(`
      CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log"
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "audit_export_state" (
        "day" date PRIMARY KEY,
        "object_key" text NOT NULL,
        "row_count" integer NOT NULL,
        "sha256" text,
        "exported_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    console.log('[DB] データベースの表と列を確かめました。');
  } catch (err) {
    console.error('[DB] テーブル作成エラー:', err);
  } finally {
    client.release();
  }
}
