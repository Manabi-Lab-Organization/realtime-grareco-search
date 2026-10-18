import { fetchWithReauth } from './reauth';

const BASE_URL = '/api';

export interface AgentToolLogEntry {
  name: string;
  displayLabel: string;
  isError?: boolean;
  clientAction?:
    | { type: 'copy_clipboard'; text: string; label: string }
    | { type: 'show_grareco'; recordingId: number };
}

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; entry: AgentToolLogEntry }
  | { type: 'done'; iterations: number; stopReason: string | null }
  | { type: 'error'; error: string };

export type AnnouncementSegment = 'all' | 'admin' | 'invite_verified';

export interface Announcement {
  id: number;
  title: string;
  body: string;
  important: boolean;
  targetSegment: AnnouncementSegment;
  startsAt: string;
  endsAt: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserAnnouncement {
  id: number;
  title: string;
  body: string;
  important: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface LoginDevice {
  id: number;
  deviceName: string | null;
  clientType: 'desktop' | 'mobile' | 'api' | 'legacy' | string;
  clientVersion: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithReauth(`${BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (body.code && body.message) throw new Error(body.message);
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string, displayName: string | undefined, code?: string) =>
      request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, code }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
    forgotPassword: (email: string) =>
      request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
    resetPassword: (token: string, newPassword: string) =>
      request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    googleLogin: (credential: string, code?: string, confirmRegistration?: boolean) =>
      request('/auth/google', { method: 'POST', body: JSON.stringify({ credential, code, confirmRegistration }) }),
    googleClientId: () => request<{ clientId: string }>('/auth/google/client-id'),
    signupStatus: () => request<{ mode?: 'first_admin' | 'invite_only' }>('/auth/signup-status'),
    devices: () => request<{ devices: LoginDevice[] }>('/auth/devices'),
    revokeDevice: (id: number) => request<{ ok: boolean }>(`/auth/devices/${id}`, { method: 'DELETE' }),
    logoutOthers: () =>
      request<{ ok: boolean; revokedTokens: number; deletedSessions: number }>('/auth/logout-others', { method: 'POST' }),
    checkInvite: (code: string) =>
      request<{ ok: boolean }>('/auth/check-invite', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    verifyInvite: (code: string) =>
      request<{ ok: boolean; alreadyVerified?: boolean }>('/auth/verify-invite', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
  },

  user: {
    updateProfile: (displayName: string) =>
      request<{ ok: boolean; displayName: string }>('/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      }),
    deleteAccount: (confirm: string) =>
      request<{ ok: boolean; deleted: boolean }>('/user/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirm }),
      }),
    exportAccountData: async (): Promise<Blob> => {
      const res = await fetchWithReauth(`${BASE_URL}/user/account/export`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      return res.blob();
    },
  },

  admin: {
    users: () =>
      request<Array<{
        id: number;
        email: string;
        displayName: string | null;
        role: string;
        inviteVerified: boolean;
        inviteVerifiedAt: string | null;
        createdAt: string;
        meetingCount: number;
      }>>('/admin/users'),
    updateUser: (id: number, data: Record<string, unknown>) =>
      request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    resetPassword: (id: number) =>
      request<{ temporaryPassword: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }),
    deleteUser: (id: number, confirm: string) =>
      request<{ ok: true; alreadyDeleted?: boolean }>(`/admin/users/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm }),
      }),
    overview: () =>
      request<{
        totalUsers: number;
        verifiedUsers: number;
        newUsers7d: number;
        newUsers30d: number;
        totalMeetings: number;
        meetings7d: number;
        meetings30d: number;
      }>('/admin/analytics/overview'),
    inviteCodes: {
      list: () =>
        request<Array<{
          code: string;
          maxUses: number | null;
          usedCount: number;
          expiresAt: string | null;
          note: string | null;
          isActive: boolean;
          createdBy: number | null;
          createdAt: string;
        }>>('/admin/invite-codes'),
      create: (data: { code?: string; maxUses?: number | null; expiresAt?: string | null; note?: string | null }) =>
        request('/admin/invite-codes', { method: 'POST', body: JSON.stringify(data) }),
      update: (code: string, data: Record<string, unknown>) =>
        request(`/admin/invite-codes/${encodeURIComponent(code)}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        }),
      delete: (code: string) =>
        request(`/admin/invite-codes/${encodeURIComponent(code)}`, { method: 'DELETE' }),
      redemptions: (code: string) =>
        request<Array<{ userId: number; email: string; displayName: string | null; redeemedAt: string }>>(
          `/admin/invite-codes/${encodeURIComponent(code)}/redemptions`
        ),
    },
    announcements: {
      list: () => request<Announcement[]>('/admin/announcements'),
      create: (data: {
        title: string;
        body: string;
        important?: boolean;
        targetSegment?: AnnouncementSegment;
        startsAt?: string;
        endsAt?: string | null;
        isPublished?: boolean;
      }) => request<Announcement>('/admin/announcements', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: number, data: Record<string, unknown>) =>
        request<Announcement>(`/admin/announcements/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (id: number) =>
        request(`/admin/announcements/${id}`, { method: 'DELETE' }),
    },
  },

  meetings: {
    list: () => request('/meetings'),
    create: (data?: { title?: string; platform?: string }) =>
      request('/meetings', { method: 'POST', body: JSON.stringify(data || {}) }),
    get: (id: number) => request(`/meetings/${id}`),
    update: (id: number, data: Record<string, unknown>) =>
      request(`/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/meetings/${id}`, { method: 'DELETE' }),
    bulkDelete: (ids: number[]) =>
      request('/meetings/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
    stop: (id: number) =>
      request(`/meetings/${id}/stop`, { method: 'PATCH' }),
    transcripts: (id: number) => request(`/meetings/${id}/transcripts`),
    partialTranscript: (id: number) => request<{ partial: string | null }>(`/meetings/${id}/partial-transcript`),
    generateAllTitles: () =>
      request('/meetings/generate-all-titles', { method: 'POST' }),
    rebuildSummary: (id: number) =>
      request(`/meetings/${id}/rebuild-summary`, { method: 'POST' }),
    updateNgKeywords: (id: number, keywords: string[]) =>
      request<string[]>(`/meetings/${id}/ng-keywords`, { method: 'PUT', body: JSON.stringify({ keywords }) }),
    structuredSummary: (id: number) => request(`/meetings/${id}/structured-summary`),
    participants: {
      get: (id: number) => request(`/meetings/${id}/participants`),
      update: (id: number, participants: unknown[]) =>
        request(`/meetings/${id}/participants`, { method: 'PUT', body: JSON.stringify({ participants }) }),
    },
    analyses: (id: number) => request(`/meetings/${id}/analyses`),
    analyze: (id: number, data: Record<string, unknown>) =>
      request(`/meetings/${id}/analyze`, { method: 'POST', body: JSON.stringify(data) }),
    graphicRecordings: (id: number) => request(`/meetings/${id}/graphic-recordings`),
    reviseGraphicRecording: (id: number, recordingId: number, instruction: string) =>
      request(`/meetings/${id}/graphic-recording/${recordingId}/revise`, {
        method: 'POST',
        body: JSON.stringify({ instruction }),
      }),
    triggerAutoGrareco: (id: number, type: 'reflect' | 'discover') =>
      request<{ ok: boolean; accepted: boolean }>(`/meetings/${id}/grareco/manual-trigger`, {
        method: 'POST',
        body: JSON.stringify({ type }),
      }),
    cancelGrarecoPromote: (id: number, recordingId: number) =>
      request<{ ok: boolean; cancelled: boolean }>(
        `/meetings/${id}/grareco/${recordingId}/cancel-promote`,
        { method: 'POST' },
      ),
    promoteGrarecoNow: (id: number, recordingId: number) =>
      request<{ ok: boolean; accepted: boolean }>(
        `/meetings/${id}/grareco/${recordingId}/promote-now`,
        { method: 'POST' },
      ),
    promoteGrarecoPending: (id: number) =>
      request<{ ok: boolean; accepted: boolean }>(
        `/meetings/${id}/grareco/promote-pending`,
        { method: 'POST' },
      ),
    pinGrareco: (id: number, recordingId: number, pinned: boolean) =>
      request<{ ok: boolean; pinned: boolean }>(`/meetings/${id}/grareco/${recordingId}/pin`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned }),
      }),
    dismissTopicShiftCandidate: (id: number) =>
      request<{ ok: boolean; wasActive: boolean }>(
        `/meetings/${id}/grareco/dismiss-topic-shift-candidate`,
        { method: 'POST' },
      ),
    confirmTopicShiftCandidate: (id: number) =>
      request<{ ok: boolean; accepted: boolean }>(
        `/meetings/${id}/grareco/confirm-topic-shift-candidate`,
        { method: 'POST' },
      ),
    topicShiftHistory: (id: number, sinceMs?: number) =>
      request<Array<{
        id: number;
        recordedAtMs: number;
        textPreview: string | null;
        immediateSimilarity: number | null;
        baselineSimilarity: number | null;
        movingAvgSimilarity: number | null;
        outcome: string | null;
      }>>(`/meetings/${id}/topic-shift-history${sinceMs ? `?sinceMs=${sinceMs}` : ''}`),
  },

  analyses: {
    list: (meetingId: number) => request(`/analyses/${meetingId}`),
    delete: (id: number) =>
      request(`/analyses/item/${id}`, { method: 'DELETE' }),
  },

  summaries: {
    get: (meetingId: number) => request(`/summaries/${meetingId}`),
    generate: (meetingId: number) =>
      request(`/summaries/${meetingId}/generate`, { method: 'POST' }),
  },

  agent: {
    availability: () =>
      request<{ enabled: boolean }>('/agent/availability').catch(() => ({ enabled: false })),
    chat: (
      meetingId: number,
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
    ) =>
      request<{
        assistantText: string;
        toolLog: Array<AgentToolLogEntry>;
        iterations: number;
        stopReason: string | null;
      }>(`/agent/meetings/${meetingId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ messages }),
      }),
    attachImage: (
      meetingId: number,
      body: {
        data: string;
        mimeType: string;
        fileName?: string;
        originalData?: string;
        originalMimeType?: string;
      }
    ) =>
      request<{
        imageId: number;
        fileName: string | null;
        aiAnalysis: string | null;
        aiDiagram: string | null;
        analysisFailed: boolean;
      }>(`/agent/meetings/${meetingId}/attach-image`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    chatStream: async function* (
      meetingId: number,
      messages: Array<{ role: 'user' | 'assistant'; content: string }>,
      options?: { signal?: AbortSignal }
    ): AsyncGenerator<AgentStreamEvent, void, void> {
      const res = await fetch(`${BASE_URL}/agent/meetings/${meetingId}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ messages }),
        signal: options?.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = chunk
              .split('\n')
              .find((l) => l.startsWith('data: '));
            if (dataLine) {
              const raw = dataLine.slice(6);
              try {
                yield JSON.parse(raw) as AgentStreamEvent;
              } catch {
              }
            }
            sep = buffer.indexOf('\n\n');
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
        }
      }
    },
  },

  announcements: {
    list: () => request<UserAnnouncement[]>('/announcements'),
    markRead: (id: number) => request(`/announcements/${id}/read`, { method: 'POST' }),
  },
};
