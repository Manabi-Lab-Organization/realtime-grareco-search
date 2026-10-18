import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from '../db/index.js';
import { webSessionIdleMs } from './sessionLifetime.js';

const PgSession = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  proxy: process.env.NODE_ENV === 'production',
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.ALLOW_HTTP !== 'true',
    httpOnly: true,
    maxAge: webSessionIdleMs(),
    sameSite: 'lax',
  },
});
