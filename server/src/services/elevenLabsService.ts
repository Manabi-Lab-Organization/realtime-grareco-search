import WebSocket from 'ws';

export interface ElevenLabsWord {
  text: string;
  type: 'word' | 'spacing' | 'audio_event';
  start?: number;
  end?: number;
  speaker_id?: string;
  logprob?: number;
}

export interface ElevenLabsTranscriptEvent {
  text: string;
  type: 'partial' | 'final';
  isFinal: boolean;
  speaker_id?: string;
  words?: ElevenLabsWord[];
  confidence?: number;
  start?: number;
  end?: number;
}

export type TranscriptCallback = (event: ElevenLabsTranscriptEvent) => void;
export type ErrorCallback = (error: Error) => void;
export type CloseCallback = () => void;

export type MeetingMode = 'online' | 'real';

const VAD_PARAMS: Record<MeetingMode, Record<string, string>> = {
  online: {
    vad_threshold: '0.3',
    vad_silence_threshold_secs: '1.5',
    min_speech_duration_ms: '100',
    min_silence_duration_ms: '100',
  },
  real: {
    vad_threshold: '0.1',
    vad_silence_threshold_secs: '0.5',
    min_speech_duration_ms: '50',
    min_silence_duration_ms: '50',
  },
};

const JAPANESE_ALLOWED = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\u0000-\u007F\u200B-\u200D\uFEFF]/;

function containsNonJapaneseScript(text: string): boolean {
  for (const ch of text) {
    if (!JAPANESE_ALLOWED.test(ch) && ch.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function stripNonJapaneseSegments(text: string): string {
  return text.replace(/\S+/g, (word) => {
    if (containsNonJapaneseScript(word)) return '';
    return word;
  }).replace(/\s+/g, ' ').trim();
}

export function filterHallucinations(text: string): string {
  let filtered = text;
  filtered = stripNonJapaneseSegments(filtered);
  filtered = filtered.replace(/[（(][^）)]*(?:音|声|拍手|効果|笑い|笑|ため息|沈黙|BGM|SE)[^）)]*[）)]/g, '');
  filtered = filtered.replace(/\([^)]*(?:sound|noise|music|laughter|applause|silence|rain|explosion|car|message|beep|click|ring|buzz|chime|knock|cough|sigh)[^)]*\)/gi, '');
  filtered = filtered.replace(/[（(][^）)]{1,10}?(?:氏|さん|様)?[）)]/g, (match) => {
    if (/音|声|拍手|効果/.test(match)) return '';
    return '';
  });
  filtered = filtered.replace(/(?:拍手|効果|笑い|笑|ため息|沈黙|BGM|SE)\s*[）)]/g, '');
  filtered = filtered.replace(/[（(]\s*(?:拍手|効果|笑い|笑|ため息|沈黙|BGM|SE)/g, '');
  filtered = filtered.replace(/\s+/g, ' ').trim();
  return filtered;
}

function isHallucinationOnly(text: string): boolean {
  const filtered = filterHallucinations(text);
  if (filtered.length === 0) return true;
  if (/^[（()）\[\]【】\s。、．，.…！？!?、]+$/.test(filtered)) return true;
  return false;
}

const liveSessions = new Set<ElevenLabsSession>();

export function listLiveSessions(): ElevenLabsSession[] {
  return [...liveSessions];
}

export function closeAllSessions(reason: string): number {
  const sessions = [...liveSessions];
  for (const s of sessions) s.close();
  if (sessions.length > 0) {
    console.log(`[ElevenLabs] closeAllSessions(${reason}): ${sessions.length} 件を閉じた`);
  }
  return sessions.length;
}

export class ElevenLabsSession {
  private ws: WebSocket | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private partialCheckInterval: NodeJS.Timeout | null = null;
  private isClosing = false;
  private reconnectDelay = 1000;
  private reconnectAttempts = 0;
  private interruptionNotified = false;
  private stableTimer: NodeJS.Timeout | null = null;
  private static readonly STABILITY_MS = 10000;
  private meetingMode: MeetingMode;
  private currentKeyterms: string[] = [];

  private partialBuffer = '';
  private lastPartialTime = 0;
  private static readonly PARTIAL_TIMEOUT_MS = 2500;

  private audioBuffer: Buffer[] = [];
  private isBuffering = false;
  private static readonly MAX_BUFFER_SIZE = 50;
  private static readonly MAX_RECONNECT_ATTEMPTS = 100;

  private static readonly MAX_RECONNECT_WINDOW_MS = 10 * 60 * 1000;
  private firstReconnectAt = 0;

  readonly sessionId: string;
  readonly createdAt: number;
  private static sessionCounter = 0;

  private static readonly KEEPALIVE_INTERVAL_MS = 10000;
  private static readonly WATCHDOG_MS = 3 * 60 * 1000;

  constructor(
    private apiKey: string,
    private onTranscript: TranscriptCallback,
    private onError: ErrorCallback,
    private onClose: CloseCallback,
    mode: MeetingMode = 'online',
    keyterms: string[] = []
  ) {
    this.meetingMode = mode;
    this.currentKeyterms = keyterms;
    this.sessionId = `els-${++ElevenLabsSession.sessionCounter}`;
    this.createdAt = Date.now();
    liveSessions.add(this);
  }

  setOnTranscript(cb: TranscriptCallback): void { this.onTranscript = cb; }
  setOnError(cb: ErrorCallback): void { this.onError = cb; }
  setOnClose(cb: CloseCallback): void { this.onClose = cb; }

  setKeyterms(terms: string[]): void {
    const next = terms.slice(0, 50);
    const prevKey = this.currentKeyterms.join('|');
    const nextKey = next.join('|');
    if (prevKey === nextKey) return;
    this.currentKeyterms = next;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[ElevenLabs] Reconnecting to apply ${next.length} keyterms`);
      this.ws.close();
    }
  }

  forceReconnect(): void {
    this.audioBuffer = [];
    this.partialBuffer = '';
    this.lastPartialTime = 0;
    console.log('[ElevenLabs] Force reconnect (transcription reset)');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    } else if (!this.ws) {
      this.connect();
    }
  }

  connect(): void {
    if (this.ws) return;

    this.isClosing = false;

    const vadParams = VAD_PARAMS[this.meetingMode];
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      language_code: 'ja',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      no_verbatim: 'true',
      ...vadParams,
    });
    for (const t of this.currentKeyterms) params.append('keyterms', t);
    const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;

    console.log(`[ElevenLabs] Connecting (mode: ${this.meetingMode}, keyterms: ${this.currentKeyterms.length})`);

    this.ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    this.ws.on('open', () => {
      console.log('[ElevenLabs] WebSocket connected ✓');
      this.startKeepAlive();
      this.resetWatchdog();
      this.startPartialBufferCheck();
      this.flushAudioBuffer();
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.firstReconnectAt = 0;
        this.interruptionNotified = false;
      }, ElevenLabsSession.STABILITY_MS);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
      }
    });

    this.ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        console.error(`[ElevenLabs] HTTP ${res.statusCode} error body:`, body);
        this.onError(new Error(`ElevenLabs HTTP ${res.statusCode}: ${body}`));
      });
    });

    this.ws.on('error', (err) => {
      console.error('[ElevenLabs] WebSocket error:', err.message);
      this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || '';
      console.log(`[ElevenLabs] WebSocket closed: ${code} ${reasonStr}`);
      this.stopKeepAlive();
      this.clearWatchdog();
      this.stopPartialBufferCheck();
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      this.ws = null;
      if (!this.isClosing) {
        this.scheduleReconnect(reasonStr.includes('resource_exhausted'));
      } else {
        this.onClose();
      }
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const audioBase64 = chunk.toString('base64');
      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: audioBase64,
      }));
      this.resetWatchdog();
    } else if (!this.isClosing) {
      this.audioBuffer.push(Buffer.from(chunk));
      if (this.audioBuffer.length > ElevenLabsSession.MAX_BUFFER_SIZE) {
        this.audioBuffer.shift();
      }
    }
  }

  private flushAudioBuffer(): void {
    if (this.audioBuffer.length === 0) return;
    console.log(`[ElevenLabs] Flushing ${this.audioBuffer.length} buffered audio chunks`);
    for (const chunk of this.audioBuffer) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const audioBase64 = chunk.toString('base64');
        this.ws.send(JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: audioBase64,
        }));
      }
    }
    this.audioBuffer = [];
  }

  finalize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
      }));
    }
  }

  close(): void {
    liveSessions.delete(this);
    this.isClosing = true;
    this.stopKeepAlive();
    this.clearWatchdog();
    this.stopPartialBufferCheck();
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.audioBuffer = [];
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {  }
      this.ws = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const msgType = msg.message_type as string;

    if (msgType === 'session_started') {
      console.log('[ElevenLabs] Session started, session_id:', msg.session_id);
      return;
    }

    if (msgType === 'auth_error') {
      console.error('[ElevenLabs] Auth error:', msg);
      this.onError(new Error(`ElevenLabs auth error: ${JSON.stringify(msg)}`));
      return;
    }
    if (msgType === 'quota_exceeded' || msgType === 'rate_limited') {
      console.error('[ElevenLabs] Throttled:', msg);
      if (!this.interruptionNotified) {
        this.interruptionNotified = true;
        this.onError(new Error('文字起こしが混雑または利用上限により一時停止しています。自動的に再開を試みています。'));
      }
      return;
    }
    if (msgType === 'error') {
      console.error('[ElevenLabs] Error message:', msg);
      if (!this.interruptionNotified) {
        this.interruptionNotified = true;
        const detail = (msg.message as string) || (msg.error as string) || '';
        this.onError(new Error(`文字起こしでエラーが発生しました。自動的に再開を試みています。${detail}`.trim()));
      }
      return;
    }

    if (msgType === 'partial_transcript') {
      const text = (msg.text as string) || '';
      if (text.trim()) {
        this.partialBuffer = text;
        this.lastPartialTime = Date.now();

        this.onTranscript({
          text,
          type: 'partial',
          isFinal: false,
        });
      }
      return;
    }

    if (msgType === 'committed_transcript' || msgType === 'committed_transcript_with_timestamps') {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.firstReconnectAt = 0;
      this.interruptionNotified = false;

      const rawText = (msg.text as string) || '';
      const text = filterHallucinations(rawText);

      this.partialBuffer = '';
      this.lastPartialTime = 0;

      if (text.trim() && !isHallucinationOnly(text)) {
        let speakerId: string | undefined;
        const words = msg.words as ElevenLabsWord[] | undefined;
        if (words && words.length > 0) {
          const speakerWord = words.find(w => w.speaker_id);
          speakerId = speakerWord?.speaker_id;
        }

        this.onTranscript({
          text,
          type: 'final',
          isFinal: true,
          words,
          speaker_id: speakerId,
          start: msg.start as number | undefined,
          end: msg.end as number | undefined,
        });
      }
      return;
    }
  }

  private startKeepAlive(): void {
    this.keepAliveInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          console.log('[ElevenLabs] Keepalive ping failed, will reconnect');
          this.ws?.close();
        }
      }
    }, ElevenLabsSession.KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      console.log('[ElevenLabs] Watchdog timeout – reconnecting');
      this.ws?.close();
    }, ElevenLabsSession.WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private startPartialBufferCheck(): void {
    this.partialCheckInterval = setInterval(() => {
      if (this.isClosing) return;
      if (this.partialBuffer && this.lastPartialTime > 0) {
        const elapsed = Date.now() - this.lastPartialTime;
        if (elapsed > ElevenLabsSession.PARTIAL_TIMEOUT_MS) {
          const recoveredText = filterHallucinations(this.partialBuffer);
          if (recoveredText.trim() && !isHallucinationOnly(recoveredText)) {
            console.log(`[ElevenLabs] Recovering stale partial (${elapsed}ms): ${recoveredText.length} chars`);
            this.onTranscript({
              text: recoveredText,
              type: 'final',
              isFinal: true,
            });
          }
          this.partialBuffer = '';
          this.lastPartialTime = 0;
          console.log('[ElevenLabs] Watchdog: stale partial detected – forcing reconnect');
          this.ws?.close();
        }
      }
    }, 1000);
  }

  private stopPartialBufferCheck(): void {
    if (this.partialCheckInterval) {
      clearInterval(this.partialCheckInterval);
      this.partialCheckInterval = null;
    }
  }

  private scheduleReconnect(exhausted = false): void {
    this.reconnectAttempts++;
    if (!this.interruptionNotified && (exhausted || this.reconnectAttempts >= 3)) {
      this.interruptionNotified = true;
      this.onError(new Error('文字起こしの接続が不安定になっています。再接続を試みています。'));
    }
    if (this.reconnectAttempts > ElevenLabsSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[ElevenLabs] Max reconnect attempts (${ElevenLabsSession.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      this.onError(new Error('ElevenLabs: 最大再接続回数を超えました'));
      this.close();
      this.onClose();
      return;
    }

    if (this.firstReconnectAt === 0) this.firstReconnectAt = Date.now();
    const elapsed = Date.now() - this.firstReconnectAt;
    if (elapsed > ElevenLabsSession.MAX_RECONNECT_WINDOW_MS) {
      console.error(
        `[ElevenLabs] ${this.sessionId}: 再接続の累積時間 ${Math.round(elapsed / 1000)}秒が上限` +
          `（${ElevenLabsSession.MAX_RECONNECT_WINDOW_MS / 1000}秒）を超えたため中止する`
      );
      this.onError(new Error('ElevenLabs: 再接続を試みた時間が上限を超えました'));
      this.close();
      this.onClose();
      return;
    }

    if (exhausted && this.reconnectDelay < 5000) {
      this.reconnectDelay = 5000;
    }

    const jitter = 1 + Math.random() * 0.2;
    const delay = Math.min(this.reconnectDelay * jitter, 30000);
    console.log(`[ElevenLabs] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${ElevenLabsSession.MAX_RECONNECT_ATTEMPTS}${exhausted ? ', resource_exhausted' : ''})`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}
