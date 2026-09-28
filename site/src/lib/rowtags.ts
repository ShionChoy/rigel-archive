// The tags a new track row starts with: the album-level values the edition's other rows agree on, else
// what the catalog says (album, album artist, date, catalog number, label), plus its title.

import type { EditionRow, ReleaseRow } from './db';
import { ALBUM_TAGS } from './tagging/names';
import { parseTags, type Tags } from './tagging/model';

/** The album artist when a release names none: the era's name (DEZAEMON entries were Inoue⊿'s own). */
const ERA_ARTIST: Record<string, string> = { dezaemon: '井上⊿' };

export function albumArtist(release: Pick<ReleaseRow, 'artist' | 'era_id'>, eraName: string): string {
  return release.artist || ERA_ARTIST[release.era_id] || eraName;
}

/** The tags an edition's catalog gives when it has no track list to take them from. */
export function catalogTags(release: Pick<ReleaseRow, 'artist' | 'era_id' | 'title' | 'release_date' | 'catalog_no'> & { era_name: string },
  edition: Pick<EditionRow, 'album_title' | 'release_date' | 'catalog_no'>): Tags {
  const artist = albumArtist(release, release.era_name);
  const out: Tags = { album: [edition.album_title || release.title], albumartist: [artist], label: [artist] };
  const date = edition.release_date || release.release_date;
  const catalog = edition.catalog_no || release.catalog_no;
  if (date) out.date = [date];
  if (catalog) out.catalognumber = [catalog];
  return out;
}

/** The album-level values every row agrees on (none when there are no rows). */
export function commonAlbumTags(rowTags: string[]): Tags {
  if (rowTags.length === 0) return {};
  const sets = rowTags.map((r) => parseTags(r));
  const out: Tags = {};
  for (const name of ALBUM_TAGS) {
    const first = sets[0][name];
    if (first?.length && sets.every((s) => JSON.stringify(s[name] ?? null) === JSON.stringify(first))) out[name] = first;
  }
  return out;
}

/** A new row's tags. */
export function newRowTags(rowTags: string[], release: Parameters<typeof catalogTags>[0], edition: Parameters<typeof catalogTags>[1], title: string): Tags {
  const album = rowTags.length ? commonAlbumTags(rowTags) : catalogTags(release, edition);
  return { title: [title], ...album };
}
