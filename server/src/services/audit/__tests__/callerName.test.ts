import { describe, it, expect } from 'vitest';
import { callerName } from '../callerName.js';

async function wrapper(): Promise<string> {
  const caller = callerName(2);
  await new Promise((r) => setTimeout(r, 0));
  return caller;
}

async function wrapperAfterAwait(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0));
  return callerName(2);
}

async function sampleCallerBeforeAwait(): Promise<string> {
  return wrapper();
}

async function sampleCallerAfterAwait(): Promise<string> {
  return wrapperAfterAwait();
}

describe('callerName', () => {
  it('await より前に呼べば呼び出し元の関数名を返す', async () => {
    expect(await sampleCallerBeforeAwait()).toBe('sampleCallerBeforeAwait');
  });

  it('await より後に呼ぶと呼び出し元の関数名は返らない', async () => {
    expect(await sampleCallerAfterAwait()).not.toBe('sampleCallerAfterAwait');
  });

  it('framesUp に 1 を渡すと自分自身の関数名を返す', () => {
    function selfName(): string { return callerName(1); }
    expect(selfName()).toBe('selfName');
  });
});
