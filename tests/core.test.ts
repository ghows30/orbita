import { describe, expect, it } from 'vitest';
import { parseExtInf, parseM3u } from '../src/core/m3u';
import { cleanTitle, fold } from '../src/core/util';
import { liveUrl, normalizeHost, parseXtreamLink, timeshiftUrl } from '../src/core/xtream';
import type { XtreamSource } from '../src/core/types';
// @ts-expect-error modulo JS del server
import { isBlockedIp, validateUrl, sanitizeUa, redact } from '../server/net-guard.mjs';
// @ts-expect-error modulo JS del server
import { xmltvTime } from '../server/xmltv.mjs';

const M3U = `#EXTM3U url-tvg="http://epg.example/guide.xml.gz"
#EXTINF:-1 tvg-id="rai1.it" tvg-logo="http://x/logo.png" group-title="Italia, HD" catchup-days="3",Rai 1, HD
http://srv.example:8080/live/u/p/101.ts
#EXTINF:-1 group-title="VOD Film",|IT| Il Padrino (1972)
http://srv.example:8080/movie/u/p/5.mkv
#EXTINF:-1 group-title="Serie",Dark S01E02
http://srv.example:8080/series/u/p/77.mp4
#EXTINF:-1 group-title="Serie",Dark S01 E01
http://srv.example:8080/series/u/p/76.mp4
#EXTINF:-1 group-title="Sep",***** ITALIA *****
http://srv.example/x
#EXTINF:-1,<img src=x onerror=alert(1)>
javascript:alert(1)
`;

describe('m3u', () => {
  it('separa attributi e titolo anche con virgole nelle virgolette', () => {
    const e = parseExtInf('#EXTINF:-1 tvg-id="a" group-title="Italia, HD",Rai 1, HD');
    expect(e.attrs['group-title']).toBe('Italia, HD');
    expect(e.name).toBe('Rai 1, HD');
  });
  it('classifica live / film / serie e ordina episodi', () => {
    const lib = parseM3u(M3U);
    expect(lib.live).toHaveLength(1);
    expect(lib.live[0]).toMatchObject({ name: 'Rai 1, HD', tvgId: 'rai1.it', group: 'Italia, HD', archive: 3 });
    expect(lib.movies[0]).toMatchObject({ name: 'Il Padrino (1972)', year: 1972 });
    expect(lib.series).toHaveLength(1);
    expect(lib.series[0].episodes!.map((e) => e.episode)).toEqual([1, 2]);
    expect(lib.epgUrls).toEqual(['http://epg.example/guide.xml.gz']);
  });
  it('scarta separatori e URL non http (es. javascript:)', () => {
    const lib = parseM3u(M3U);
    const all = [...lib.live, ...lib.movies].map((x) => x.url);
    expect(all.some((u) => u?.startsWith('javascript'))).toBe(false);
    expect(lib.live.some((c) => c.name.includes('*****'))).toBe(false);
  });
});

describe('util', () => {
  it('pulisce prefissi lingua ed entità', () => {
    expect(cleanTitle('|IT| Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(cleanTitle('[EN] Dune')).toBe('Dune');
    expect(fold('Perché')).toBe('perche');
  });
});

describe('xtream', () => {
  const s: XtreamSource = { id: '1', name: 'x', type: 'xtream', host: 'http://h.tld:8080', user: 'mario@x', pass: 'p&s/s#1', format: 'm3u8' };
  it('codifica sempre le credenziali negli URL', () => {
    expect(liveUrl(s, 10)).toBe('http://h.tld:8080/live/mario%40x/p%26s%2Fs%231/10.m3u8');
  });
  it('normalizza host e riconosce link get.php', () => {
    expect(normalizeHost('h.tld:8080/')).toBe('http://h.tld:8080');
    expect(parseXtreamLink('http://h.tld:8080/get.php?username=a&password=b&type=m3u_plus')).toEqual({ host: 'http://h.tld:8080', user: 'a', pass: 'b' });
  });
  it('timeshift nel fuso del server', () => {
    const start = Date.UTC(2026, 4, 1, 18, 15) / 1000;
    const u = timeshiftUrl(s, 9, start, start + 3600, 'Europe/Rome');
    expect(u).toBe('http://h.tld:8080/timeshift/mario%40x/p%26s%2Fs%231/60/2026-05-01:20-15/9.ts');
  });
});

describe('server: protezione SSRF', () => {
  it('blocca loopback, link-local, metadata cloud e reti private', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '10.1.2.3', '192.168.1.1', '172.16.5.4', '::1', 'fe80::1', '::ffff:127.0.0.1', 'fd00::1'])
      expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) expect(isBlockedIp(ip), ip).toBe(false);
  });
  it('accetta solo http/https pubblici', () => {
    expect(validateUrl('file:///etc/passwd')).toBeNull();
    expect(validateUrl('http://localhost:7878/api')).toBeNull();
    expect(validateUrl('http://127.0.0.1/')).toBeNull();
    expect(validateUrl('http://[::1]/')).toBeNull();
    expect(validateUrl('gopher://x')).toBeNull();
    expect(validateUrl('https://example.com/a.m3u8')?.host).toBe('example.com');
  });
  it('sanifica User-Agent e oscura credenziali nei log', () => {
    expect(sanitizeUa('evil\r\nX-Injected: 1')).toBe('evilX-Injected: 1');
    expect(redact('http://h.tld/live/user/pass/1.ts')).toBe('http://h.tld/…');
  });
  it('legge orari XMLTV con fuso', () => {
    expect(xmltvTime('20260501201500 +0200')).toBe(Date.UTC(2026, 4, 1, 18, 15) / 1000);
    expect(xmltvTime('bad')).toBeNull();
  });
});
