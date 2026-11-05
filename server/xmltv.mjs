// Parser XMLTV in streaming (anche .gz): tiene solo i canali richiesti e una finestra temporale,
// così anche guide da centinaia di MB non finiscono in memoria.
import zlib from 'node:zlib';

const MAX_DECOMPRESSED = 600 * 1024 * 1024;

export function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se = '00', tz] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000;
  if (tz) {
    const sign = tz[0] === '-' ? -1 : 1;
    t -= sign * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(3, 5)) * 60);
  }
  return Number.isFinite(t) ? t : null;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, k) => {
      if (k[0] === '#') {
        const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENT[k] ?? all;
    })
    .trim();
}
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};

/**
 * @param {import('node:stream').Readable} input
 * @param {Set<string>} wanted id canali (tvg-id) in minuscolo
 */
export function parseXmltv(input, wanted, { fromSec, toSec, maxPerChannel = 200 }) {
  return new Promise((resolve, reject) => {
    const out = {};
    let buf = '';
    let total = 0;
    let decoder = null;
    let stream = input;
    let sniffed = false;

    const handle = (chunk) => {
      total += chunk.length;
      if (total > MAX_DECOMPRESSED) {
        input.destroy();
        return reject(Object.assign(new Error('Guida EPG troppo grande'), { code: 'ETOOBIG' }));
      }
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('</programme>')) !== -1) {
        const startIdx = buf.lastIndexOf('<programme', idx);
        const block = startIdx >= 0 ? buf.slice(startIdx, idx) : '';
        buf = buf.slice(idx + 12);
        if (!block) continue;
        const head = block.slice(0, block.indexOf('>') + 1);
        const ch = (attr(head, 'channel') || '').toLowerCase();
        if (!wanted.has(ch)) continue;
        const s = xmltvTime(attr(head, 'start'));
        const e = xmltvTime(attr(head, 'stop'));
        if (s == null || e == null || e <= s || e < fromSec || s > toSec) continue;
        const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block);
        const d = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(block);
        const list = (out[ch] ||= []);
        if (list.length < maxPerChannel) {
          list.push({ s, e, t: t ? decodeXml(t[1]).slice(0, 300) : '', d: d ? decodeXml(d[1]).slice(0, 1500) : '' });
        }
      }
      // evita che un file malformato faccia crescere il buffer all'infinito
      if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-64 * 1024);
    };

    input.once('data', function first(chunk) {
      sniffed = true;
      input.pause();
      if (chunk[0] === 0x1f && chunk[1] === 0x8b) {
        decoder = zlib.createGunzip();
        stream = decoder;
        decoder.on('data', handle);
        decoder.on('end', done);
        decoder.on('error', reject);
        decoder.write(chunk);
        input.pipe(decoder);
      } else {
        handle(chunk);
        input.on('data', handle);
        input.on('end', done);
      }
      input.resume();
    });
    input.on('error', reject);
    input.on('end', () => {
      if (!sniffed) done();
    });

    function done() {
      for (const k of Object.keys(out)) out[k].sort((a, b) => a.s - b.s);
      resolve(out);
    }
    void stream;
  });
}
