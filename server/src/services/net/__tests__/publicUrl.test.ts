import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isBlockedIp } from '../publicUrl.js';

const publicLookup = async () => ['93.184.216.34'];

describe('assertPublicUrl', () => {
  it('公開されたホストの URL を受け付ける', async () => {
    await expect(assertPublicUrl('https://example.com/feed', publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it('http と https 以外のスキームを拒否する', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', publicLookup)).rejects.toThrow(/http/);
    await expect(assertPublicUrl('gopher://x/', publicLookup)).rejects.toThrow(/http/);
  });

  it('内部向けのホスト名を拒否する', async () => {
    for (const url of [
      'http://localhost/',
      'http://app.service.internal/',
      'http://metadata.google.internal/',
      'http://printer.local/',
    ]) {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow(/内部ホスト/);
    }
  });

  it('IPv4 のプライベート・ループバック・リンクローカルのアドレスを拒否する', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
      await expect(assertPublicUrl(`http://${ip}/`, publicLookup)).rejects.toThrow(/内部\/予約/);
    }
  });

  it('IPv6 のループバック・ユニークローカル・リンクローカルのアドレスを拒否する', async () => {
    for (const ip of ['[::1]', '[fc00::1]', '[fd00:ec2::254]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
      await expect(assertPublicUrl(`http://${ip}/`, publicLookup)).rejects.toThrow(/内部\/予約/);
    }
  });

  it('内部のアドレスに解決されるホスト名を拒否する', async () => {
    const internalLookup = async () => ['1.2.3.4', '10.1.2.3'];
    await expect(assertPublicUrl('https://evil.example.com/', internalLookup)).rejects.toThrow(/内部\/予約/);
  });

  it('名前解決の結果が空なら拒否する', async () => {
    await expect(assertPublicUrl('https://empty.example.com/', async () => [])).rejects.toThrow(/名前解決/);
  });

  it('公開されたアドレスを直接書いた URL を受け付ける', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/', publicLookup)).resolves.toBeInstanceOf(URL);
  });
});

describe('IPv4 を埋め込んだ IPv6 やマルチキャストのアドレス', () => {
  const blocked = [
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b:1::1]/',
    'http://[2002:a9fe:a9fe::1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[ff02::1]/',
    'http://[fec0::1]/',
  ];
  for (const url of blocked) {
    it(`${url} を拒否する`, async () => {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow();
    });
  }

  it('埋め込まれた IPv4 が公開アドレスなら受け付ける', async () => {
    await expect(assertPublicUrl('http://[64:ff9b::808:808]/', publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[2002:808:808::1]/', publicLookup)).resolves.toBeInstanceOf(URL);
  });
});

describe('isBlockedIp', () => {
  it('IP アドレスとして読めない文字列は拒否する', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
  it('公開された IPv4 と IPv6 のアドレスは拒否しない', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });
});
