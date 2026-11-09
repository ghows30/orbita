import { describe, expect, it } from 'vitest';
import { bestRating, searchTitle } from '../src/core/meta';

describe('searchTitle', () => {
  it('toglie anno, qualità e tag di lingua', () => {
    expect(searchTitle('|IT| The Quiet Harbor (2021) 4K')).toEqual({ title: 'The Quiet Harbor', year: 2021 });
    expect(searchTitle('Northern Lights - 2019 [MULTI]')).toEqual({ title: 'Northern Lights', year: 2019 });
    expect(searchTitle('Paper Moons 2023')).toEqual({ title: 'Paper Moons', year: 2023 });
  });
  it('lascia intatti i titoli senza anno', () => {
    expect(searchTitle('Blade Runner')).toEqual({ title: 'Blade Runner', year: undefined });
  });
});

describe('bestRating', () => {
  it('preferisce IMDb, poi TMDB, poi il provider', () => {
    expect(bestRating({ rating: 6 }, { imdb: 7.8, tmdb: 7.1 })).toEqual({ value: 7.8, src: 'imdb' });
    expect(bestRating({ rating: 6 }, { tmdb: 7.1 })).toEqual({ value: 7.1, src: 'tmdb' });
    expect(bestRating({ rating: 6 })).toEqual({ value: 6, src: 'provider' });
    expect(bestRating({})).toBeUndefined();
  });
  it('riporta su 10 i voti del provider espressi in centesimi', () => {
    expect(bestRating({ rating: 72 })).toEqual({ value: 7.2, src: 'provider' });
  });
});
