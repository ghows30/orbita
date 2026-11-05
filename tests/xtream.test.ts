import { afterEach, describe, expect, it, vi } from 'vitest';
import type { XtreamSource } from '../src/core/types';
import { loadXtream, shortEpg } from '../src/core/xtream';

const src: XtreamSource = { id: '1', name: 'x', type: 'xtream', host: 'http://h.tld', user: 'u', pass: 'p w', format: 'm3u8' };
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function mockProvider(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/fetch');
    expect((init.headers as Record<string, string>)['x-orbita']).toBe('1');
    const { url } = JSON.parse(String(init.body));
    calls.push(url);
    const action = new URL(url).searchParams.get('action') || 'auth';
    return new Response(JSON.stringify(routes[action] ?? []), { status: 200 });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('loadXtream', () => {
  it('mappa categorie, canali, film e serie', async () => {
    const calls = mockProvider({
      auth: { user_info: { auth: 1, status: 'Active', exp_date: '1893456000' }, server_info: { timezone: 'Europe/Rome' } },
      get_live_categories: [{ category_id: '2', category_name: 'Sport' }, { category_id: '9', category_name: 'XXX Adult' }],
      get_live_streams: [{ stream_id: 7, name: 'Sky &amp; Sport', category_id: '2', epg_channel_id: 'sky.it', tv_archive: 1, tv_archive_duration: '5' },
        { stream_id: 8, name: 'Hot', category_id: '9' }],
      get_vod_categories: [{ category_id: '1', category_name: 'Azione' }],
      get_vod_streams: [{ stream_id: 3, name: '|IT| Heat (1995)', category_id: '1', container_extension: 'mkv', rating: '8.3', stream_icon: 'javascript:alert(1)' }],
      get_series_categories: [], get_series: [{ series_id: 4, name: 'Dark', cover: 'http://img/d.jpg' }],
    });
    const lib = await loadXtream(src);
    expect(calls[0]).toBe('http://h.tld/player_api.php?username=u&password=p%20w');
    expect(lib.live[0]).toMatchObject({ id: 'x7', xid: 7, name: 'Sky & Sport', group: 'Sport', tvgId: 'sky.it', archive: 5 });
    expect(lib.live[1].adult).toBe(true);
    expect(lib.movies[0]).toMatchObject({ name: 'Heat (1995)', ext: 'mkv', rating: 8.3, year: 1995, group: 'Azione' });
    expect(lib.movies[0].logo).toBeUndefined(); // URL non http scartato
    expect(lib.series[0]).toMatchObject({ id: 'r4', logo: 'http://img/d.jpg' });
    expect(lib.tz).toBe('Europe/Rome');
    expect(lib.epgUrls[0]).toBe('http://h.tld/xmltv.php?username=u&password=p%20w');
  });

  it('rifiuta login non valido', async () => {
    mockProvider({ auth: { user_info: { auth: 0 } } });
    await expect(loadXtream(src)).rejects.toThrow(/rifiutato/);
  });

  it('decodifica EPG in Base64 (anche UTF-8)', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockProvider({ get_simple_data_table: { epg_listings: [
      { title: b64('Telegiornale è'), description: b64('Notizie'), start_timestamp: String(now - 60), stop_timestamp: String(now + 600) }] } });
    const e = await shortEpg(src, 7);
    expect(e[0]).toMatchObject({ t: 'Telegiornale è', d: 'Notizie' });
  });
});
