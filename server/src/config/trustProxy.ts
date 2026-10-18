
export function trustProxySetting(raw: string | undefined, isProd: boolean): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === '') return isProd ? 1 : false;
  if (v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
