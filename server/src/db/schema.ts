import { pgTable, serial, varchar, text, timestamp, integer, boolean, jsonb, uniqueIndex, bigint, bigserial, inet, index, date } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  displayName: varchar('display_name', { length: 100 }),
  googleId: varchar('google_id', { length: 255 }).unique(),
  apiToken: varchar('api_token', { length: 64 }).unique(),
  apiTokenHash: varchar('api_token_hash', { length: 64 }).unique(),
  resetToken: varchar('reset_token', { length: 64 }),
  resetTokenHash: varchar('reset_token_hash', { length: 64 }),
  resetTokenExpiry: timestamp('reset_token_expiry'),
  emailVerifiedAt: timestamp('email_verified_at'),
  grarecoModel: varchar('grareco_model', { length: 100 }).default('gemini-3.1-flash-image'),
  grarecoAutoModel: varchar('grareco_auto_model', { length: 100 }).default('gemini-3.1-flash-image'),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  researchSettings: jsonb('research_settings').notNull().default({
    main: true,
    web: true,
    fact: true,
    gap: true,
    tech: true,
  }),
  inviteVerified: boolean('invite_verified').notNull().default(false),
  inviteVerifiedAt: timestamp('invite_verified_at'),
  roomObservationConsentVersion: integer('room_observation_consent_version'),
  roomObservationConsentedAt: timestamp('room_observation_consented_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const inviteCodes = pgTable('invite_codes', {
  code: varchar('code', { length: 64 }).primaryKey(),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at'),
  note: text('note'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inviteRedemptions = pgTable('invite_redemptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  code: varchar('code', { length: 64 }).notNull(),
  redeemedAt: timestamp('redeemed_at').defaultNow().notNull(),
});

export const meetings = pgTable('meetings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull().default('無題の会議'),
  platform: varchar('platform', { length: 50 }).notNull().default('web-recorder'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  isTitleEdited: boolean('is_title_edited').notNull().default(false),
  participants: jsonb('participants').default([]),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  duration: integer('duration'),
  transcriptionStartedAt: timestamp('transcription_started_at'),
  pausedSeconds: integer('paused_seconds').notNull().default(0),
  pausedSince: timestamp('paused_since'),
  lastAudioAt: timestamp('last_audio_at'),
  emailSentAt: timestamp('email_sent_at'),
  meetingType: varchar('meeting_type', { length: 30 }).default('general'),
  initialProfilingDoneAt: timestamp('initial_profiling_done_at'),
  dismissedParticipantNames: jsonb('dismissed_participant_names').default([]),
  ngKeywords: jsonb('ng_keywords').default([]),
});

export const transcripts = pgTable('transcripts', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  speaker: text('speaker'),
  speakerId: integer('speaker_id'),
  content: text('content').notNull(),
  startTime: integer('start_time').notNull().default(0),
  endTime: integer('end_time').notNull().default(0),
  recordingMs: integer('recording_ms'),
  isFinal: boolean('is_final').notNull().default(true),
  confidence: text('confidence'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const structuredSummaries = pgTable('structured_summaries', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  previousContent: text('previous_content'),
  lastProcessedTime: integer('last_processed_time'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const analyses = pgTable('analyses', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meetingImages = pgTable('meeting_images', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  imageData: text('image_data').notNull(),
  mimeType: varchar('mime_type', { length: 50 }).notNull(),
  fileName: varchar('file_name', { length: 255 }),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  meetingElapsedMs: integer('meeting_elapsed_ms'),
  aiAnalysis: text('ai_analysis'),
  aiDiagram: text('ai_diagram'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meetingObservations = pgTable('meeting_observations', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  meetingElapsedMs: integer('meeting_elapsed_ms'),
  peopleCount: integer('people_count'),
  fiveW1h: jsonb('five_w1h'),
  people: jsonb('people'),
  location: jsonb('location'),
  rawSummary: text('raw_summary'),
  materialsText: text('materials_text'),
  materialsDiagram: text('materials_diagram'),
  consolidatedAt: timestamp('consolidated_at'),
  sourceType: varchar('source_type', { length: 20 }).notNull().default('camera'),
  viewCount: integer('view_count').notNull().default(1),
  linkedImageId: integer('linked_image_id').references(() => meetingImages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meetingMemos = pgTable('meeting_memos', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  meetingElapsedMs: integer('meeting_elapsed_ms'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const participantImages = pgTable('participant_images', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  imageData: text('image_data').notNull(),
  mimeType: varchar('mime_type', { length: 50 }).notNull(),
  fileName: varchar('file_name', { length: 255 }),
  aiExtractedParticipants: jsonb('ai_extracted_participants'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const participantTexts = pgTable('participant_texts', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  aiExtractedParticipants: jsonb('ai_extracted_participants'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const participantProfileCards = pgTable('participant_profile_cards', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  speakerId: integer('speaker_id').notNull(),
  utterance: text('utterance').notNull(),
  transcriptId: integer('transcript_id'),
  suggestedName: text('suggested_name').notNull(),
  finalName: text('final_name'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  origin: varchar('origin', { length: 20 }).notNull().default('initial'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
});

export const participantConversationExtractions = pgTable('participant_conversation_extractions', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  origin: varchar('origin', { length: 20 }).notNull().default('initial'),
  aiExtractedParticipants: jsonb('ai_extracted_participants'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userTermDictionary = pgTable('user_term_dictionary', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  termHash: varchar('term_hash', { length: 64 }).notNull(),
  term: varchar('term', { length: 200 }),
  reading: varchar('reading', { length: 200 }),
  explanation: text('explanation'),
  category: varchar('category', { length: 50 }),
  isSkip: boolean('is_skip').default(false).notNull(),
  skipReason: varchar('skip_reason', { length: 20 }),
  source: varchar('source', { length: 20 }).default('ai'),
  usageCount: integer('usage_count').default(1),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_term_dictionary_user_hash_idx').on(table.userId, table.termHash),
]);

export const meetingTermHits = pgTable('meeting_term_hits', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  termId: integer('term_id').references(() => userTermDictionary.id, { onDelete: 'cascade' }).notNull(),
  firstDetectedAt: integer('first_detected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('meeting_term_hits_meeting_term_idx').on(table.meetingId, table.termId),
]);

export const userTermExclusions = pgTable('user_term_exclusions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  termHash: varchar('term_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_term_exclusions_user_hash_idx').on(table.userId, table.termHash),
]);

export const topicShiftEmbeddings = pgTable('topic_shift_embeddings', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  recordedAtMs: bigint('recorded_at_ms', { mode: 'number' }).notNull(),
  textPreview: text('text_preview'),
  embedding: jsonb('embedding').notNull(),
  immediateSimilarity: text('immediate_similarity'),
  baselineSimilarity: text('baseline_similarity'),
  movingAvgSimilarity: text('moving_avg_similarity'),
  outcome: varchar('outcome', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const graphicRecordings = pgTable('graphic_recordings', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  sourceText: text('source_text').notNull(),
  imageUrl: text('image_url'),
  triggerType: varchar('trigger_type', { length: 30 }).notNull().default('manual'),
  stage: varchar('stage', { length: 20 }).notNull().default('image'),
  pinnedAt: timestamp('pinned_at'),
  draftJson: jsonb('draft_json'),
  researchInsightIds: jsonb('research_insight_ids'),
  visualStyle: varchar('visual_style', { length: 30 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const researchInsights = pgTable('research_insights', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  agentType: varchar('agent_type', { length: 30 }).notNull(),
  cardType: varchar('card_type', { length: 30 }).notNull(),
  keyword: varchar('keyword', { length: 200 }),
  content: text('content').notNull(),
  importance: integer('importance').default(50),
  status: varchar('status', { length: 20 }).default('active'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meetingShares = pgTable('meeting_shares', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  token: varchar('token', { length: 64 }).notNull().unique(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sharedContents: jsonb('shared_contents').default(['glossary', 'research', 'grareco', 'summary']),
  excludedItems: jsonb('excluded_items').default({}),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('meeting_shares_meeting_idx').on(table.meetingId),
]);

export const desktopExchangeCodes = pgTable('desktop_exchange_codes', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  apiTokenId: integer('api_token_id'),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const apiTokens = pgTable('api_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  deviceName: varchar('device_name', { length: 100 }),
  clientType: varchar('client_type', { length: 20 }).notNull().default('desktop'),
  clientVersion: varchar('client_version', { length: 40 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
  revokedReason: varchar('revoked_reason', { length: 40 }),
  sudoAt: timestamp('sudo_at'),
}, (table) => [
  index('api_tokens_user_idx').on(table.userId),
]);

export const researchGapItems = pgTable('research_gap_items', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }).notNull(),
  question: text('question').notNull(),
  detectedAtMs: integer('detected_at_ms').notNull(),
  resolvedAtMs: integer('resolved_at_ms'),
  alertedAt: timestamp('alerted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const announcements = pgTable('announcements', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  important: boolean('important').notNull().default(false),
  targetSegment: varchar('target_segment', { length: 20 }).notNull().default('all'),
  startsAt: timestamp('starts_at').defaultNow().notNull(),
  endsAt: timestamp('ends_at'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const announcementReads = pgTable('announcement_reads', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  announcementId: integer('announcement_id').references(() => announcements.id, { onDelete: 'cascade' }).notNull(),
  readAt: timestamp('read_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('announcement_reads_user_ann_idx').on(table.userId, table.announcementId),
]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  app: text('app').notNull(),
  event: text('event').notNull(),
  result: text('result').notNull(),
  actorId: text('actor_id'),
  actorEmail: text('actor_email'),
  actorRole: text('actor_role'),
  authMethod: text('auth_method'),
  tenantId: text('tenant_id'),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  detail: jsonb('detail'),
}, (table) => [
  index('audit_log_ts_idx').on(table.ts),
  index('audit_log_actor_ts_idx').on(table.actorId, table.ts),
  index('audit_log_target_ts_idx').on(table.targetType, table.targetId, table.ts),
  index('audit_log_event_ts_idx').on(table.event, table.ts),
]);

export const auditExportState = pgTable('audit_export_state', {
  day: date('day').primaryKey(),
  objectKey: text('object_key').notNull(),
  rowCount: integer('row_count').notNull(),
  sha256: text('sha256'),
  exportedAt: timestamp('exported_at', { withTimezone: true }).defaultNow().notNull(),
});
