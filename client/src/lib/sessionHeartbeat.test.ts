import { describe, it, expect, vi } from 'vitest';
import { startSessionHeartbeat, HEARTBEAT_INTERVAL_MS, type HeartbeatDeps } from './sessionHeartbeat';

function setup(visible = true, live = false) {
  let t = 0;
  let tick: (() => void) | null = null;
  let onVis: (() => void) | null = null;
  const env = { visible, live };
  const send = vi.fn(async () => undefined);
  const deps: HeartbeatDeps = {
    send,
    isVisible: () => env.visible,
    keepAliveWhenHidden: () => env.live,
    onVisibilityChange: (fn) => { onVis = fn; return () => { onVis = null; }; },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    now: () => t,
  };
  const stop = startSessionHeartbeat(deps);
  const advance = async (ms: number) => { t += ms; tick?.(); await Promise.resolve(); await Promise.resolve(); };
  const visibility = async (v: boolean) => { env.visible = v; onVis?.(); await Promise.resolve(); await Promise.resolve(); };
  const setLive = (v: boolean) => { env.live = v; };
  return { send, stop, advance, visibility, setLive, hasTimer: () => tick !== null };
}

describe('startSessionHeartbeat', () => {
  it('画面が表示されている間は一定間隔で送る', async () => {
    const h = setup(true);
    expect(h.send).not.toHaveBeenCalled();
    await h.advance(HEARTBEAT_INTERVAL_MS);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('画面が隠れている間は送らない', async () => {
    const h = setup(false);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('維持の指定がある間は画面が隠れていても一定間隔で送る', async () => {
    const h = setup(false, true);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('維持の指定が外れたら画面が隠れている間は送らない', async () => {
    const h = setup(false, true);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    h.setLive(false);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    await h.advance(HEARTBEAT_INTERVAL_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('画面が再び表示されたとき、間隔以上たっていれば 1 回送る', async () => {
    const h = setup(true);
    await h.visibility(false);
    await h.visibility(true);
    expect(h.send).not.toHaveBeenCalled();
    await h.visibility(false);
    await h.advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(h.send).not.toHaveBeenCalled();
    await h.visibility(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('停止するとタイマーを解除する', () => {
    const h = setup(true);
    h.stop();
    expect(h.hasTimer()).toBe(false);
  });
});
