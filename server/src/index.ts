import './env.js';
import { createServer } from 'http';
import { createApp } from './app.js';
import { setupSocketIO } from './websocket/socketIO.js';
import { setupNativeWebSocket } from './websocket/nativeWs.js';
import { setupBrowserAudioWebSocket } from './websocket/browserAudioWs.js';
import { ensureTables, pool } from './db/index.js';
import { auditSchemaDrift, shouldBlockStartup, blockingDriftMessage } from './db/schemaAudit.js';
import { logFeatureSummary } from './services/features.js';
import { initializeTokenizer } from './services/termGlossaryService.js';
import { initializeResearchAgent } from './services/research/managedAgent.js';
import { ensureSilenceDetectorStarted } from './services/grareco/autoGrarecoOrchestrator.js';
import { startOrphanSweeper, stopOrphanSweeper } from './websocket/meetingRegistry.js';
import { closeAllSessions } from './services/elevenLabsService.js';
import { startAuditExportScheduler, stopAuditExportScheduler } from './services/audit/auditExport.js';
import { isAwaitingFirstAdmin } from './services/authService.js';
import { issueInitialSetupCode } from './services/initialSetupCode.js';

const app = createApp();
const httpServer = createServer(app);
setupSocketIO(httpServer);
setupNativeWebSocket(httpServer);
setupBrowserAudioWebSocket(httpServer);

const PORT = Number(process.env.PORT) || 3000;

logFeatureSummary();

initializeTokenizer().catch(err => console.error('[Startup] kuromoji init failed:', err));

initializeResearchAgent().catch(err => console.error('[Startup] research agent init failed:', err));

ensureSilenceDetectorStarted();

startOrphanSweeper();

function shutdownElevenLabs(signal: string): void {
  stopOrphanSweeper();
  closeAllSessions(signal);
}
process.on('SIGTERM', () => shutdownElevenLabs('SIGTERM'));
process.on('SIGINT', () => shutdownElevenLabs('SIGINT'));

ensureTables().then(async () => {
  const client = await pool.connect();
  let drift = null;
  try {
    drift = await auditSchemaDrift(client);
  } finally {
    client.release();
  }
  if (shouldBlockStartup(drift)) {
    for (const line of blockingDriftMessage(drift!)) console.error(line);
    process.exit(1);
  }
  startAuditExportScheduler();
  process.on('SIGTERM', () => stopAuditExportScheduler());
  process.on('SIGINT', () => stopAuditExportScheduler());
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    isAwaitingFirstAdmin()
      .then((awaiting) => { if (awaiting) issueInitialSetupCode(); })
      .catch((err) => console.error('[Setup] 管理者の有無を確かめられませんでした:', err));
  });
}).catch((err) => {
  console.error('[DB] ensureTables failed:', err);
  if (process.env.NODE_ENV === 'production') {
    console.error('[DB] データベースに繋がらない（または表を作れない）ため、起動を止めます。');
    console.error('[DB] .env の POSTGRES_PASSWORD（英数字だけにする。最初に決めたら変えない）と、DATABASE_URL を確かめてください。');
    process.exit(1);
  }
  console.error('[DB] 開発環境なので、このまま起動を続けます。');
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
});
