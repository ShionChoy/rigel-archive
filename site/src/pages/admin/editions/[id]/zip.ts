import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SLOT_LABELS } from '../../../../lib/constants';
import { db, type FileRow } from '../../../../lib/db';
import { Places } from '../../../../lib/locations';
import { editionContext, taggedEntry, taggedSource } from '../../../../lib/tags';
import { zipSize, zipStream, type ZipEntry } from '../../../../lib/tagging/zip';

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

/**
 * The whole edition as a zip, made while it downloads: audio as 整理版 (tagged, named by track), every
 * other file (scans, logs, cue sheets) as collected, in the edition's folders.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const { t } = locals;
  const ctx = await editionContext(String(params.id));
  if (!ctx) return new Response(t('找不到版本'), { status: 404 });
  const { results: files } = await db()
    .prepare(
      `SELECT * FROM files f WHERE edition_id = ? AND blob_key IS NOT NULL AND state != 'ignored' AND dup_of IS NULL AND sealed_in IS NULL
         AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)
       ORDER BY CASE lower(ext) WHEN 'flac' THEN 0 WHEN 'mp3' THEN 1 ELSE 2 END, dir, name`,
    )
    .bind(ctx.edition.id)
    .all<FileRow>();
  const places = await Places.load();
  const label = `${ctx.release.title} [${t(SLOT_LABELS[ctx.edition.slot])}${ctx.edition.name ? ` ${ctx.edition.name}` : ''}]`;
  const root = `${safe(label)}/`;
  // Folders below the edition's own folder become folders in the zip.
  const home = places.editionFolder(ctx.edition.id);
  const folderPath = (id: string | null) => {
    if (!id) return '';
    const chain = places.chain(`fd:${id}`);
    const below = home ? chain.slice(chain.indexOf(`fd:${home.id}`) + 1) : chain;
    return below.map((k) => `${safe(places.name(k, t))}/`).join('');
  };
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const skipped: string[] = [];
  for (const f of files) {
    const src = await taggedSource(f, ctx);
    const folder = root + folderPath(f.folder_id);
    if (src) {
      const name = `${folder}${src.name}`;
      if (names.has(name)) continue; // a WAV next to its FLAC gives the same 整理版
      try {
        entries.push(await taggedEntry(env.MEDIA, src, folder));
        names.add(name);
        continue;
      } catch {
        // not a readable FLAC / MP3 after all: the original goes in instead
      }
    }
    // A zip cannot change its mind once it has started: only contents that are there go in.
    const stored = await env.MEDIA.head(f.blob_key!);
    if (!stored || stored.size !== f.size) {
      skipped.push(f.name);
      continue;
    }
    let name = `${folder}${safe(f.download_name ?? f.name)}`;
    for (let i = 2; names.has(name); i += 1) name = `${folder}${i} ${safe(f.download_name ?? f.name)}`;
    names.add(name);
    const key = f.blob_key!;
    entries.push({
      name, size: f.size, mtime: f.mtime ? new Date(f.mtime) : new Date(),
      body: async () => {
        const object = await env.MEDIA.get(key);
        if (!object) throw new Error(`missing ${key}`);
        return object.body;
      },
    });
  }
  if (entries.length === 0) return new Response(t('这个版本里还没有可下载的文件'), { status: 404 });
  const size = zipSize(entries);
  const body = zipStream(entries);
  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    ...(skipped.length ? { 'x-skipped-files': encodeURIComponent(skipped.join(', ')).slice(0, 2000) } : {}),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safe(label)}.zip`)}`,
  };
  if (size !== null) {
    const { readable, writable } = new FixedLengthStream(size);
    body.pipeTo(writable).catch(() => undefined);
    return new Response(readable, { headers: { ...headers, 'content-length': String(size) } });
  }
  return new Response(body, { headers });
};
