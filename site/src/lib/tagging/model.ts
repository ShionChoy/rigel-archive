// Tag sets of the site: a track row sets tags over what its file carries (文件原值). A row's tags are
// overrides: a name with values replaces the file's own, a name with an empty list removes it, other names
// keep what the file has. Track and disc numbers come from the track list's order.

import { NUMBER_TAGS, PERFORMER, TAG_DEF, cleanTagName, type Tags } from './names';

export type { Tags };

const MAX_VALUES = 50;
const MAX_VALUE = 20000;

/** A tag set from stored JSON (anything malformed is dropped). */
export function parseTags(raw: string | null | undefined): Tags {
  try {
    const v = JSON.parse(raw || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Tags = {};
    for (const [k, list] of Object.entries(v)) {
      const name = cleanTagName(k);
      if (!name || !Array.isArray(list)) continue;
      out[name] = list.filter((x) => typeof x === 'string').slice(0, MAX_VALUES);
    }
    return out;
  } catch {
    return {};
  }
}

/** A tag set checked for storing: names cleaned, values trimmed, no repeats; [] kept (it removes the tag). */
export function cleanTags(tags: Record<string, unknown>): Tags {
  const out: Tags = {};
  for (const [k, list] of Object.entries(tags)) {
    const name = cleanTagName(k);
    if (!name || NUMBER_TAGS.includes(name) || !Array.isArray(list)) continue;
    const values: string[] = [];
    for (const x of list) {
      const v = String(x ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_VALUE);
      if (v && !values.includes(v)) values.push(v);
    }
    out[name] = values.slice(0, MAX_VALUES);
  }
  return out;
}

/** What a file ends up with: its own tags, with the row's overrides applied. */
export function effectiveTags(original: Tags, overrides: Tags): Tags {
  const out: Tags = { ...original };
  for (const [k, v] of Object.entries(overrides)) {
    if (v.length) out[k] = v;
    else delete out[k];
  }
  return out;
}

/** The number tags of a row: its position on its disc, how many on that disc, the disc when there are several. */
export function numberTags(position: number | null, disc: number, discTotal: number, trackTotal: number): Tags {
  if (!position) return {};
  const out: Tags = { tracknumber: [String(position)], totaltracks: [String(trackTotal)] };
  if (discTotal > 1) {
    out.discnumber = [String(disc)];
    out.totaldiscs = [String(discTotal)];
  }
  return out;
}

/** Tags in display order: the table's order, then performers, then other names alphabetically. */
export function tagOrder(names: Iterable<string>): string[] {
  const index = new Map([...TAG_DEF.keys()].map((k, i) => [k, i]));
  const rank = (n: string) => index.get(n) ?? (n.startsWith(PERFORMER) ? 10_000 : 20_000);
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Whether two value lists say the same. */
export function sameValues(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
