
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const addrs = await lookup(hostname, { all: true });
  return addrs.map((a) => a.address);
};

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function inV4Range(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return (
    inV4Range(n, '0.0.0.0', 8) ||
    inV4Range(n, '10.0.0.0', 8) ||
    inV4Range(n, '100.64.0.0', 10) ||
    inV4Range(n, '127.0.0.0', 8) ||
    inV4Range(n, '169.254.0.0', 16) ||
    inV4Range(n, '172.16.0.0', 12) ||
    inV4Range(n, '192.0.0.0', 24) ||
    inV4Range(n, '192.0.2.0', 24) ||
    inV4Range(n, '192.168.0.0', 16) ||
    inV4Range(n, '198.18.0.0', 15) ||
    inV4Range(n, '224.0.0.0', 4) ||
    inV4Range(n, '240.0.0.0', 4)
  );
}

function expandV6(input: string): number[] | null {
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const halves = input.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const left = toGroups(halves[0]);
    const right = toGroups(halves[1]);
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    return [...left, ...Array(missing).fill(0), ...right];
  }
  const all = toGroups(input);
  return all && all.length === 8 ? all : null;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip.toLowerCase());
  if (h === null) return true;
  const low32AsV4 = () => `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
  const topZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (h.every((x) => x === 0)) return true;
  if (topZero && h[5] === 0 && h[6] === 0 && h[7] === 1) return true;
  if (topZero && h[5] === 0xffff) return isBlockedV4(low32AsV4());
  if (topZero && h[5] === 0 && (h[6] !== 0 || h[7] !== 0)) return isBlockedV4(low32AsV4());
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) {
    return isBlockedV4(low32AsV4());
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isBlockedV4(low32AsV4());
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0x0001) return true;
  if (h[0] === 0x2002) {
    return isBlockedV4(`${(h[1] >> 8) & 0xff}.${h[1] & 0xff}.${(h[2] >> 8) & 0xff}.${h[2] & 0xff}`);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

export async function assertPublicUrl(rawUrl: string, lookupFn: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('無効なURLです');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('http(s) のURLのみ許可されています');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local')
  ) {
    throw new Error('内部ホストへのアクセスは許可されていません');
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('内部/予約アドレスへのアクセスは許可されていません');
  } else {
    const ips = await lookupFn(host);
    if (ips.length === 0) throw new Error('名前解決に失敗しました');
    for (const ip of ips) {
      if (isBlockedIp(ip)) throw new Error('内部/予約アドレスへのアクセスは許可されていません');
    }
  }
  return u;
}
