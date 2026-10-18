
import { Server as HTTPServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_MAX_PAYLOAD_BYTES } from './wsLimits.js';
import { URL } from 'url';
import { randomUUID } from 'node:crypto';
import { getActiveRecording } from './meetingRegistry.js';
import { markAudioReceived } from '../services/audioWatchdog.js';

interface AudioTokenEntry {
  meetingId: number;
  userId: number;
  createdAt: number;
}

const audioTokens = new Map<string, AudioTokenEntry>();

const TOKEN_TTL_MS = 60_000;

export function issueAudioToken(meetingId: number, userId: number): string {
  const token = randomUUID();
  audioTokens.set(token, { meetingId, userId, createdAt: Date.now() });

  for (const [t, entry] of audioTokens) {
    if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
      audioTokens.delete(t);
    }
  }

  return token;
}

function consumeAudioToken(token: string): AudioTokenEntry | null {
  const entry = audioTokens.get(token);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    audioTokens.delete(token);
    return null;
  }

  audioTokens.delete(token);
  return entry;
}

export function setupBrowserAudioWebSocket(httpServer: HTTPServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);

    if (url.pathname !== '/ws/audio') return;

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = consumeAudioToken(token);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, auth);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, auth: AudioTokenEntry) => {
    const { meetingId, userId } = auth;
    console.log(`[BrowserAudioWS] Connected: meetingId=${meetingId}, userId=${userId}`);

    let audioChunkCount = 0;

    ws.on('message', (data, isBinary) => {
      if (!isBinary && !Buffer.isBuffer(data)) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      const recording = getActiveRecording(meetingId);
      if (!recording) {
        return;
      }

      recording.elevenlabs.sendAudio(buf);
      audioChunkCount++;
      markAudioReceived(meetingId);
    });

    ws.on('close', (code, reason) => {
      console.log(
        `[BrowserAudioWS] Disconnected: meetingId=${meetingId}, ` +
        `chunks=${audioChunkCount}, code=${code}, reason=${reason?.toString() || 'none'}`
      );
    });

    ws.on('error', (err) => {
      console.error(`[BrowserAudioWS] Error: meetingId=${meetingId}, ${err.message}`);
    });
  });

  console.log('[BrowserAudioWS] WebSocket server ready at /ws/audio');
}
