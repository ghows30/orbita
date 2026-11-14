import { describe, expect, it } from 'vitest';
// @ts-expect-error modulo JS del server, senza tipi
import { isBlockedIp, validateUrl } from '../server/net-guard.mjs';

describe('protezione SSRF del server', () => {
  it('blocca loopback e link-local in ogni scrittura IPv4', () => {
    for (const u of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://169.254.169.254/latest', 'http://0.0.0.0/', 'http://localhost/', 'http://a.localhost/'])
      expect(validateUrl(u), u).toBeNull();
  });

  it('blocca gli IPv6 che contengono un IPv4 vietato', () => {
    for (const u of [
      'http://[::1]/', 'http://[::]/',
      'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', // mapped
      'http://[::ffff:a9fe:a9fe]/', // metadata cloud, mapped
      'http://[::7f00:1]/', // compatibile
      'http://[64:ff9b::7f00:1]/', // NAT64
      'http://[2002:7f00:1::]/', // 6to4
      'http://[fe80::1]/', 'http://[ff02::1]/', 'http://[fd00::1]/', 'http://[2001:0:1::1]/',
    ]) expect(validateUrl(u), u).toBeNull();
  });

  it('blocca le reti private (anche dentro un IPv6)', () => {
    for (const ip of ['10.1.2.3', '192.168.1.20', '172.16.0.1', '::ffff:192.168.1.20', '::ffff:c0a8:114', '64:ff9b::a00:1'])
      expect(isBlockedIp(ip), ip).toBe(true);
  });

  it('lascia passare gli indirizzi pubblici', () => {
    for (const u of ['http://provider.example:8080/get.php', 'https://8.8.8.8/', 'http://[2606:4700:4700::1111]/', 'http://[::ffff:8.8.8.8]/'])
      expect(validateUrl(u), u).not.toBeNull();
    expect(isBlockedIp('2a00:1450:4002:411::200e')).toBe(false);
  });

  it('rifiuta schemi diversi da http/https', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x/y', 'javascript:alert(1)', 'data:text/html,x', 'gopher://x/']) expect(validateUrl(u), u).toBeNull();
  });
});
