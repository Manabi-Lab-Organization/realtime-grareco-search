import { Router } from 'express';
import { z } from 'zod';
import { db, pool } from '../db/index.js';
import { meetings, meetingObservations, users } from '../db/schema.js';
import { eq, desc, and, sql } from 'drizzle-orm';
import { DEFAULT_AUTO_GRARECO_SETTINGS } from '../services/grareco/types.js';
import { requireTokenAuth } from '../middleware/tokenAuth.js';
import { inviteLimiter, imageAnalysisLimiter, roomObservationLimiter } from '../middleware/rateLimit.js';
import { imageJsonBody } from '../middleware/bodyLimits.js';
import { uploadImageData, uploadImageMimeType } from '../services/uploadImageTypes.js';
import { DEFAULT_RESEARCH_SETTINGS, type ResearchSettings } from './user.js';
import { broadcastToUser } from '../services/research/connectionRegistry.js';
import { updateResearchSettingsForUser } from '../services/research/managedAgent.js';
import { processMeetingImageUpload } from '../services/meetingImageService.js';
import { processObservation, listObservations } from '../services/observationService.js';
import { recordedSecondsAt } from '../services/recordingMeter.js';
import { authUserId } from '../middleware/authContext.js';
import { INVITE_VERIFIED_FOR_CLIENTS } from '../middleware/inviteVerified.js';
import {
  ROOM_OBSERVATION_CONSENT_VERSION,
  roomObservationEnabled,
  hasCurrentRoomObservationConsent,
  roomObservationConsentEnforced,
} from '../middleware/roomObservationGate.js';
import { audit } from '../services/audit/audit.js';

const router = Router();

router.use(requireTokenAuth);

router.get('/auth-me', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        roomObservationConsentVersion: users.roomObservationConsentVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      ...user,
      inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
      roomObservationEnabled: roomObservationEnabled(),
      roomObservationConsentRequiredVersion: ROOM_OBSERVATION_CONSENT_VERSION,
    });
  } catch (err) {
    next(err);
  }
});

const verifyInviteSchema = z.object({
  code: z.string().trim().min(1, '招待コードを入力してください').max(64),
});

router.post('/verify-invite', inviteLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { code } = verifyInviteSchema.parse(req.body);
    const normalized = code.toUpperCase();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meRows } = await client.query<{ invite_verified: boolean }>(
        'SELECT invite_verified FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (meRows[0]?.invite_verified) {
        await client.query('COMMIT');
        res.json({ ok: true, alreadyVerified: true });
        return;
      }

      const { rows: codeRows } = await client.query<{
        max_uses: number | null;
        used_count: number;
        expires_at: Date | null;
        is_active: boolean;
      }>(
        'SELECT max_uses, used_count, expires_at, is_active FROM invite_codes WHERE code = $1 FOR UPDATE',
        [normalized]
      );
      const row = codeRows[0];
      if (!row || !row.is_active) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'invalid_code', message: '招待コードが無効です' });
        return;
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'expired_code', message: '招待コードの有効期限が切れています' });
        return;
      }
      if (row.max_uses !== null && row.used_count >= row.max_uses) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'exhausted_code', message: '招待コードの利用上限に達しています' });
        return;
      }

      await client.query(
        `UPDATE users
         SET invite_verified = true, invite_verified_at = now(), updated_at = now()
         WHERE id = $1`,
        [userId]
      );
      await client.query(
        'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = $1',
        [normalized]
      );
      await client.query(
        `INSERT INTO invite_redemptions (user_id, code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, normalized]
      );

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.get('/meetings', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const rows = await db
      .select()
      .from(meetings)
      .where(eq(meetings.userId, userId))
      .orderBy(desc(meetings.startedAt))
      .limit(20);

    res.json(
      rows.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        platform: m.platform,
        startedAt: m.startedAt?.toISOString() ?? '',
        endedAt: m.endedAt?.toISOString() ?? null,
        duration: m.duration,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const meetingId = Number(req.params.id);
    if (!meetingId || Number.isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting id' });
      return;
    }
    const [row] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
    if (!row) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const recordedSeconds =
      row.status === 'completed'
        ? row.duration ?? 0
        : recordedSecondsAt(row.transcriptionStartedAt, Date.now(), row.pausedSeconds, row.pausedSince);

    res.json({
      id: row.id,
      title: row.title,
      status: row.status,
      platform: row.platform,
      startedAt: row.startedAt?.toISOString() ?? '',
      endedAt: row.endedAt?.toISOString() ?? null,
      duration: row.duration,
      isTitleEdited: row.isTitleEdited,
      recordedSeconds,
      transcriptionStartedAt: row.transcriptionStartedAt?.toISOString() ?? null,
      pausedSeconds: row.pausedSeconds,
      pausedSince: row.pausedSince?.toISOString() ?? null,
      participantCount: Array.isArray(row.participants) ? row.participants.length : 0,
    });
  } catch (err) {
    next(err);
  }
});

const extUpdateMeetingSchema = z.object({
  title: z.string().min(1).max(200),
});

router.patch('/meetings/:id', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const meetingId = Number(req.params.id);
    if (!meetingId || Number.isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting id' });
      return;
    }
    const body = extUpdateMeetingSchema.parse(req.body);
    const [updated] = await db
      .update(meetings)
      .set({ title: body.title, isTitleEdited: true })
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ id: updated.id, title: updated.title });
  } catch (err) {
    next(err);
  }
});

const extImageSchema = z.object({
  data: uploadImageData,
  mimeType: uploadImageMimeType,
  fileName: z.string().optional(),
  originalData: uploadImageData.optional(),
  originalMimeType: uploadImageMimeType.optional(),
});

router.post('/meetings/:id/images', imageAnalysisLimiter, imageJsonBody, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const meetingId = Number(req.params.id);
    if (!meetingId || Number.isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting id' });
      return;
    }
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const body = extImageSchema.parse(req.body);
    const image = await processMeetingImageUpload(meetingId, meeting.startedAt, body);
    res.status(201).json(image);
  } catch (err) {
    next(err);
  }
});

const extObservationSchema = z.object({
  data: uploadImageData,
  mimeType: uploadImageMimeType,
  fileName: z.string().optional(),
  sourceType: z.enum(['camera', 'window', 'display']).optional(),
  location: z
    .object({ lat: z.number(), lng: z.number(), source: z.string().optional() })
    .optional(),
});

const roomObservationConsentSchema = z.object({
  version: z.literal(ROOM_OBSERVATION_CONSENT_VERSION),
});

router.post('/room-observation/consent', async (req, res, next) => {
  try {
    if (!roomObservationEnabled()) {
      res.status(403).json({ error: 'room_observation_disabled' });
      return;
    }
    const userId = authUserId(req);
    const parsed = roomObservationConsentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_consent_version',
        requiredVersion: ROOM_OBSERVATION_CONSENT_VERSION,
      });
      return;
    }
    const consentedAt = new Date();
    await db
      .update(users)
      .set({
        roomObservationConsentVersion: parsed.data.version,
        roomObservationConsentedAt: consentedAt,
      })
      .where(eq(users.id, userId));
    await audit(
      'room_observation.consent',
      { target: { type: 'user', id: userId }, detail: { version: parsed.data.version } },
      req,
    );
    res.json({ version: parsed.data.version, consentedAt: consentedAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

router.post('/meetings/:id/observations', roomObservationLimiter, imageJsonBody, async (req, res, next) => {
  try {
    if (!roomObservationEnabled()) {
      res.status(403).json({ error: 'room_observation_disabled' });
      return;
    }
    const userId = authUserId(req);
    const [consent] = await db
      .select({ version: users.roomObservationConsentVersion })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (roomObservationConsentEnforced() && !hasCurrentRoomObservationConsent(consent?.version)) {
      res.status(403).json({
        error: 'room_observation_consent_required',
        requiredVersion: ROOM_OBSERVATION_CONSENT_VERSION,
      });
      return;
    }
    const meetingId = Number(req.params.id);
    if (!meetingId || Number.isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting id' });
      return;
    }
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const body = extObservationSchema.parse(req.body);

    const observation = await processObservation(meetingId, meeting.startedAt, body);

    res.status(201).json(observation);
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id/observations', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const meetingId = Number(req.params.id);
    if (!meetingId || Number.isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting id' });
      return;
    }
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const observations = await listObservations(meetingId);
    res.json(observations);
  } catch (err) {
    next(err);
  }
});

const researchSettingsPartialSchema = z.object({
  main: z.boolean(),
  web: z.boolean(),
  fact: z.boolean(),
  gap: z.boolean(),
  tech: z.boolean(),
}).partial();

router.get('/research-settings', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const [user] = await db
      .select({ researchSettings: users.researchSettings })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const settings: ResearchSettings = {
      ...DEFAULT_RESEARCH_SETTINGS,
      ...((user.researchSettings as Partial<ResearchSettings>) ?? {}),
    };
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put('/research-settings', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const patch = researchSettingsPartialSchema.parse(req.body);

    const [user] = await db
      .select({ researchSettings: users.researchSettings })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const merged: ResearchSettings = {
      ...DEFAULT_RESEARCH_SETTINGS,
      ...((user.researchSettings as Partial<ResearchSettings>) ?? {}),
      ...patch,
    };

    await db
      .update(users)
      .set({
        researchSettings: merged,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    const affected = updateResearchSettingsForUser(userId, merged);
    broadcastToUser(userId, 'research_settings_updated', merged);

    res.json({ ...merged, _affectedSessions: affected });
  } catch (err) {
    next(err);
  }
});

export default router;
