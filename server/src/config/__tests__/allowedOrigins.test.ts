import { describe, it, expect } from 'vitest';
import { allowedBrowserOrigins } from '../allowedOrigins.js';

describe('allowedBrowserOrigins', () => {
  it('NODE_ENV=production では APP_URL だけを許可し、localhost を入れない', () => {
    const origins = allowedBrowserOrigins({ NODE_ENV: 'production', APP_URL: 'https://grareco.example.com/' });
    expect(origins).toEqual(['https://grareco.example.com']);
    expect(origins.some((o) => o.includes('localhost'))).toBe(false);
  });

  it('NODE_ENV=production でも CLIENT_URL を書いたときはそれも許可する', () => {
    expect(allowedBrowserOrigins({ NODE_ENV: 'production', APP_URL: 'https://a.example.com', CLIENT_URL: 'https://b.example.com' }))
      .toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('開発では、CLIENT_URL が無ければ開発用の画面のアドレスを許可する', () => {
    expect(allowedBrowserOrigins({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' }))
      .toEqual(['http://localhost:3000', 'http://localhost:5173']);
    expect(allowedBrowserOrigins({})).toEqual(['http://localhost:5173']);
  });
});
