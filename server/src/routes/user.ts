import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcastToUser } from '../services/research/connectionRegistry.js';
import { updateResearchSettingsForUser } from '../services/research/managedAgent.js';
import { deleteUserAccount } from '../services/accountDeletionService.js';
import { buildAccountExportZip } from '../services/accountExportService.js';
import { audit } from '../services/audit/audit.js';
import {
  DEFAULT_AUTO_GRARECO_SETTINGS,
  type AutoGrarecoSettings,
} from '../services/grareco/types.js';
import { authUserId } from '../middleware/authContext.js';
import { requireRecentAuth } from '../middleware/recentAuth.js';

const router = Router();

export interface ResearchSettings {
  main: boolean;
  web: boolean;
  fact: boolean;
  gap: boolean;
  tech: boolean;
  autoGrareco: AutoGrarecoSettings;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  main: true,
  web: true,
  fact: true,
  gap: true,
  tech: true,
  autoGrareco: DEFAULT_AUTO_GRARECO_SETTINGS,
};

const autoGrarecoSchema = z.object({
  enabled: z.boolean(),
  reflect: z.boolean(),
  discover: z.boolean(),
  maxImagesPerHour: z.number().int().min(0).max(60),
  autoPromoteMode: z.enum(['auto', 'manual']),
  includeResearchRefs: z.boolean(),
});

const researchSettingsSchema = z.object({
  main: z.boolean(),
  web: z.boolean(),
  fact: z.boolean(),
  gap: z.boolean(),
  tech: z.boolean(),
  autoGrareco: autoGrarecoSchema,
});

const researchSettingsPartialSchema = researchSettingsSchema.partial().extend({
  autoGrareco: autoGrarecoSchema.partial().optional(),
});

router.get('/research-settings', requireAuth, async (req, res, next) => {
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

    const stored = (user.researchSettings as Partial<ResearchSettings>) ?? {};
    const settings: ResearchSettings = {
      ...DEFAULT_RESEARCH_SETTINGS,
      ...stored,
      autoGrareco: { ...DEFAULT_AUTO_GRARECO_SETTINGS, ...(stored.autoGrareco ?? {}) },
    };
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put('/research-settings', requireAuth, async (req, res, next) => {
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
    const stored = (user.researchSettings as Partial<ResearchSettings>) ?? {};
    const currentAuto = { ...DEFAULT_AUTO_GRARECO_SETTINGS, ...(stored.autoGrareco ?? {}) };
    const patchedAuto = patch.autoGrareco ? { ...currentAuto, ...patch.autoGrareco } : currentAuto;
    const { autoGrareco: _ignored, ...patchRest } = patch;
    void _ignored;
    const merged: ResearchSettings = {
      ...DEFAULT_RESEARCH_SETTINGS,
      ...stored,
      ...patchRest,
      autoGrareco: patchedAuto,
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

const updateProfileSchema = z.object({ displayName: z.string().min(1).max(100) });
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { displayName } = updateProfileSchema.parse(req.body);
    const trimmed = displayName.trim();
    if (!trimmed) {
      res.status(400).json({ error: '表示名を入力してください' });
      return;
    }
    await db
      .update(users)
      .set({ displayName: trimmed, updatedAt: new Date() })
      .where(eq(users.id, userId));
    if (req.session?.userId) req.session.displayName = trimmed;
    res.json({ ok: true, displayName: trimmed });
  } catch (err) {
    next(err);
  }
});

router.get('/account/export', requireAuth, requireRecentAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const zip = await buildAccountExportZip(userId);
    await audit('account.export', { target: { type: 'user', id: userId }, detail: { scope: 'all_meetings', bytes: zip.length } }, req);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="grareco-export-${stamp}.zip"`);
    res.setHeader('Content-Length', String(zip.length));
    res.send(zip);
  } catch (err) {
    next(err);
  }
});

const deleteAccountSchema = z.object({ confirm: z.string() });
router.delete('/account', requireAuth, requireRecentAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { confirm } = deleteAccountSchema.parse(req.body);

    const [me] = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (!me) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (me.role === 'admin') {
      res.status(403).json({ error: 'admin_self_delete', message: '管理者アカウントはこの画面から退会できません' });
      return;
    }

    if (confirm.trim() !== me.email) {
      res.status(400).json({ error: 'confirm_mismatch', message: '確認用メールアドレスが一致しません' });
      return;
    }

    await deleteUserAccount(userId);
    await audit('account.delete', { actor: { id: userId, email: me.email }, target: { type: 'user', id: userId }, detail: { mode: 'immediate' } }, req);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.json({ ok: true, deleted: true });
    });
  } catch (err) {
    next(err);
  }
});

export default router;
