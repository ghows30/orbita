// Categorie dei canali a due livelli, ricavate dai nomi dei gruppi del provider.
// I provider scrivono quasi sempre "PREFISSO | Nome" ("IT | Sport", "UK: News", "[DE] Kino", "IT-Rai"):
// il prefisso diventa la categoria principale e il resto la sottocategoria.

export interface GroupLeaf { group: string; label: string; count: number }
export interface GroupNode { key: string; label: string; count: number; children: GroupLeaf[] }
/** voce di primo livello: una categoria con sottocategorie, oppure un gruppo singolo */
export type TreeItem = GroupNode | GroupLeaf;
export const isNode = (x: TreeItem): x is GroupNode => 'children' in x;

const SEP = /\s*(?:\||┃|▎|│|•|»|:|\/|–|—|\s-\s)\s*/;

/** divide "IT | Sport | Calcio" in ["IT", "Sport", "Calcio"]; "[IT] Rai" in ["IT", "Rai"]; "IT-Rai" in ["IT", "Rai"] */
export function splitGroup(name: string): string[] {
  const s = name.trim();
  const br = /^[[(]([^\])]{1,12})[\])]\s*(.+)$/.exec(s);
  if (br) return [br[1].trim(), ...splitGroup(br[2])];
  const parts = s.split(SEP).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].length <= 24) return parts;
  // trattino senza spazi solo dopo una sigla corta: "IT-Rai" sì, "Sky Sport-Uno" no
  const dash = /^([A-Za-z0-9]{2,4})-(.+)$/.exec(s);
  if (dash) return [dash[1], dash[2].trim()];
  return [s];
}

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ');

/**
 * Costruisce l'albero mantenendo l'ordine del provider.
 * Se tutti i gruppi condividono lo stesso prefisso (es. tutti "IT | …"), il livello si sposta avanti di uno.
 */
export function buildTree(groups: { name: string; count: number }[]): TreeItem[] {
  const split = groups.map((g) => ({ ...g, parts: splitGroup(g.name) }));
  // prefissi comuni a tutti i gruppi con almeno due parti: non distinguono nulla, si saltano
  let skip = 0;
  while (split.length > 1 && split.every((g) => g.parts.length > skip + 1 && norm(g.parts[skip]) === norm(split[0].parts[skip]))) skip++;

  const out: TreeItem[] = [];
  const nodes = new Map<string, GroupNode>();
  const tops = split.map((g) => (g.parts.length > skip + 1 ? norm(g.parts[skip]) : ''));
  const size = new Map<string, number>();
  for (const k of tops) if (k) size.set(k, (size.get(k) || 0) + 1);

  split.forEach((g, i) => {
    const k = tops[i];
    // un prefisso usato da un solo gruppo non merita una categoria: il gruppo resta da solo
    if (!k || size.get(k)! < 2) {
      out.push({ group: g.name, label: g.parts.slice(skip).join(' · ') || g.name, count: g.count });
      return;
    }
    let n = nodes.get(k);
    if (!n) {
      n = { key: k, label: g.parts[skip], count: 0, children: [] };
      nodes.set(k, n);
      out.push(n);
    }
    n.count += g.count;
    n.children.push({ group: g.name, label: g.parts.slice(skip + 1).join(' · '), count: g.count });
  });
  return out;
}
