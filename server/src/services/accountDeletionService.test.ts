import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';

const h = vi.hoisted(() => ({
  deletedTables: [] as any[],
  targetUser: { id: 42, email: 'user@example.com' },
}));

vi.mock('./authSessionService.js', () => ({ invalidateAllUserAccess: vi.fn(async () => {}) }));

vi.mock('../db/index.js', () => {
  const selectChain: any = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve([h.targetUser]),
  };
  const tx = {
    delete: (table: any) => {
      h.deletedTables.push(table);
      return { where: async () => {} };
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
    execute: async () => {},
  };
  return {
    db: { select: () => selectChain, transaction: async (cb: any) => cb(tx) },
    pool: {},
  };
});

import { deleteUserAccount } from './accountDeletionService.js';

const CLEANED_VIA_MEETING = new Set(['meeting_shares']);

let deletedNames: Set<string>;

beforeAll(async () => {
  await deleteUserAccount(42);
  deletedNames = new Set(h.deletedTables.map((t) => getTableConfig(t).name));
});

describe('deleteUserAccount', () => {
  it('利用者に結びつく会議やデータのテーブルを削除する', () => {
    const mustDelete = [
      'meetings',
      'user_term_dictionary',
      'user_term_exclusions',
      'announcement_reads',
      'invite_redemptions',
    ];
    for (const name of mustDelete) {
      expect(deletedNames.has(name), `${name} が削除されていない`).toBe(true);
    }
  });

  it('利用者のテーブルの行は削除せずに残す', () => {
    expect(deletedNames.has('users'), 'users が削除されている').toBe(false);
  });

  it('利用者を連鎖削除で参照するテーブルは、直接の削除か会議経由の削除のどちらかに含まれる', () => {
    const userCascadeTables: string[] = [];
    for (const val of Object.values(schema)) {
      let cfg;
      try {
        cfg = getTableConfig(val as any);
      } catch {
        continue;
      }
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        if (getTableConfig(ref.foreignTable).name === 'users' && fk.onDelete === 'cascade') {
          userCascadeTables.push(cfg.name);
        }
      }
    }
    expect(userCascadeTables.length).toBeGreaterThan(0);

    for (const name of userCascadeTables) {
      const handled = deletedNames.has(name) || CLEANED_VIA_MEETING.has(name);
      expect(
        handled,
        `テーブル "${name}" がどの扱いにも含まれていない`,
      ).toBe(true);
    }
  });
});
