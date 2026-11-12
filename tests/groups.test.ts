import { describe, expect, it } from 'vitest';
import { buildTree, isNode, splitGroup } from '../src/core/groups';

const g = (...names: string[]) => names.map((name) => ({ name, count: 3 }));

describe('splitGroup', () => {
  it('riconosce i separatori più comuni', () => {
    expect(splitGroup('IT | Sport')).toEqual(['IT', 'Sport']);
    expect(splitGroup('UK: News')).toEqual(['UK', 'News']);
    expect(splitGroup('[DE] Kino')).toEqual(['DE', 'Kino']);
    expect(splitGroup('IT-Rai')).toEqual(['IT', 'Rai']);
    expect(splitGroup('IT | Sport | Calcio')).toEqual(['IT', 'Sport', 'Calcio']);
  });
  it('non spezza nomi normali col trattino', () => {
    expect(splitGroup('Sky Sport-Uno')).toEqual(['Sky Sport-Uno']);
    expect(splitGroup('Documentari')).toEqual(['Documentari']);
  });
});

describe('buildTree', () => {
  it('raggruppa per prefisso mantenendo l’ordine', () => {
    const t = buildTree(g('IT | Rai', 'IT | Sport', 'UK | News', 'UK | Movies', 'Adulti'));
    expect(t.map((x) => x.label)).toEqual(['IT', 'UK', 'Adulti']);
    const it0 = t[0];
    expect(isNode(it0) && it0.children.map((c) => c.label)).toEqual(['Rai', 'Sport']);
    expect(it0.count).toBe(6);
  });
  it('un prefisso usato una sola volta non crea una categoria', () => {
    const t = buildTree(g('IT | Rai', 'IT | Sport', 'FR | Info'));
    expect(t.map((x) => [x.label, isNode(x)])).toEqual([['IT', true], ['FR · Info', false]]);
  });
  it('salta il prefisso comune a tutti e usa il livello successivo', () => {
    const t = buildTree(g('IT | Sport | DAZN', 'IT | Sport | Sky', 'IT | Cinema | Sky', 'IT | Cinema | Prime'));
    expect(t.map((x) => x.label)).toEqual(['Sport', 'Cinema']);
    const sport = t[0];
    expect(isNode(sport) && sport.children.map((c) => c.group)).toEqual(['IT | Sport | DAZN', 'IT | Sport | Sky']);
  });
  it('senza prefissi resta una lista semplice', () => {
    const t = buildTree(g('Sport', 'News', 'Kids'));
    expect(t.every((x) => !isNode(x))).toBe(true);
  });
});
