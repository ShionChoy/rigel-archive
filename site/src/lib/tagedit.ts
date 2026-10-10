// The 整理台's side of the tag editor: what one audio file will be written with (for the inspector), and
// 「设为封面」, which makes a picture, or the cover an audio file carries, the cover of every track of its
// edition. The 「编辑标签与封面」 dialog itself edits the edition's track list (lib/edition-editor.ts).

import { ChangeSet } from './changes';
import { db, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { embeddedFor, pictureUrl } from './embedded';
import { N_, summary, UserError } from './i18n';
import { effectiveTags, parseTags, type Tags } from './tagging/model';
import { COVER_MAX, parseCover } from './tags';

/** Pictures a download can embed: as they are, or (the largest) as their copy. */
export const COVER_SQL = `kind = 'image' AND lower(ext) IN ('jpg', 'jpeg', 'png') AND sealed_in IS NULL
  AND (size < ${COVER_MAX} OR EXISTS (SELECT 1 FROM derived d WHERE d.sha256 = files.sha256 AND d.kind = 'embed'))`;

export interface FileTagView {
  file: { id: string; name: string; edition_id: string | null };
  row: { id: string; position: number; disc: number } | null;
  tags: Tags; // what the file downloads with (its own, with the row's over them)
  changed: number; // how many tags the row sets over the file's own
  cover: { src: string; chosen: boolean } | null;
  read: boolean;
}

export async function fileTagView(fileId: string): Promise<FileTagView> {
  const database = db();
  const file = await database.prepare('SELECT id, name, download_name, kind, sha256, edition_id, track_id FROM files WHERE id = ?').bind(fileId)
    .first<Pick<FileRow, 'id' | 'name' | 'download_name' | 'kind' | 'sha256' | 'edition_id' | 'track_id'>>();
  if (!file) throw new UserError('找不到文件');
  const own = file.sha256 ? (await embeddedFor([file.sha256])).get(file.sha256) : undefined;
  const row = file.edition_id && file.track_id
    ? await database.prepare('SELECT id, position, disc, tags, cover FROM edition_tracks WHERE edition_id = ? AND track_id = ?').bind(file.edition_id, file.track_id)
      .first<{ id: string; position: number; disc: number; tags: string; cover: string | null }>()
    : null;
  const overrides = parseTags(row?.tags);
  const chosen = parseCover(row?.cover);
  let cover: FileTagView['cover'] = own?.cover ? { src: pictureUrl(own.cover), chosen: false } : null;
  if (chosen?.picture) cover = { src: pictureUrl(chosen.picture), chosen: true };
  if (chosen?.file) {
    const f = await database.prepare('SELECT blob_key FROM files WHERE id = ?').bind(chosen.file).first<{ blob_key: string | null }>();
    if (f?.blob_key) cover = { src: `/admin/media/${f.blob_key}`, chosen: true };
  }
  return {
    file: { id: file.id, name: file.download_name || file.name, edition_id: file.edition_id },
    row: row ? { id: row.id, position: row.position, disc: row.disc } : null,
    tags: effectiveTags(own?.tags ?? {}, overrides),
    changed: Object.keys(overrides).length,
    cover,
    read: !!own,
  };
}

async function editionOf(id: string): Promise<{ edition: EditionRow; release: ReleaseRow }> {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(id).first<EditionRow>();
  if (!edition) throw new UserError('找不到版本');
  const release = (await database.prepare('SELECT * FROM releases WHERE id = ?').bind(edition.release_id).first<ReleaseRow>())!;
  return { edition, release };
}

/**
 * 「设为封面」: a picture (JPEG / PNG, or a large scan with its 1600 px copy), or the cover an audio file
 * carries, becomes the cover of every track of its edition; an edition without a track list takes the
 * picture as its own cover.
 */
export async function setCover(actor: string, fileId: string): Promise<{ changed: number; batchId: string; summary: string }> {
  const database = db();
  const f = await database.prepare('SELECT id, name, download_name, kind, ext, size, sha256, edition_id FROM files WHERE id = ?').bind(fileId)
    .first<Pick<FileRow, 'id' | 'name' | 'download_name' | 'kind' | 'ext' | 'size' | 'sha256' | 'edition_id'>>();
  if (!f) throw new UserError('找不到文件');
  if (!f.edition_id) throw new UserError('先把文件放进某个版本，再设为封面');
  const { edition, release } = await editionOf(f.edition_id);
  const label = `${release.catalog_no ?? release.title} ${edition.name}`.trim();
  const name = f.download_name || f.name;
  let cover: { file?: string; picture?: string; mode: 'replace' };
  if (f.kind === 'image') {
    const large = f.size >= COVER_MAX
      ? await database.prepare("SELECT 1 FROM derived WHERE sha256 = ? AND kind = 'embed'").bind(f.sha256 ?? '').first()
      : null;
    if (!(/^(jpe?g|png)$/i.test(f.ext) && (f.size < COVER_MAX || large))) throw new UserError('下载时只能嵌入 JPEG 或 PNG（超过 16 MB 的要等处理程序生成缩小副本）');
    cover = { file: f.id, mode: 'replace' };
  } else if (f.kind === 'audio') {
    const own = f.sha256 ? (await embeddedFor([f.sha256])).get(f.sha256) : undefined;
    if (!own?.cover) throw new UserError('这个文件没有自带封面');
    cover = { picture: own.cover, mode: 'replace' };
  } else throw new UserError('只有图片和带封面的音频可以设为封面');
  const { results: rows } = await database.prepare('SELECT id, cover FROM edition_tracks WHERE edition_id = ?').bind(edition.id).all<{ id: string; cover: string | null }>();
  const cs = new ChangeSet(database, actor, summary(N_('版本 {edition}：封面设为 {name}'), { edition: label, name }));
  if (rows.length === 0) {
    if (!cover.file) throw new UserError('这个版本还没有曲目表：先生成曲目表，再用曲目自带的封面');
    cs.updateKnown('edition', { id: edition.id }, { cover_file_id: edition.cover_file_id }, { cover_file_id: cover.file });
  } else {
    for (const r of rows) cs.updateKnown('edition_track', { id: r.id }, { cover: r.cover }, { cover: JSON.stringify(cover) });
  }
  return { changed: await cs.commit(), batchId: cs.batchId, summary: cs.summary };
}
