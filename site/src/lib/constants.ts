// Enumerations shared with migrations/0001_init.sql and tools/ra/src/ra/model.py. Labels are Chinese,
// marked with N_ and translated where they are shown (t(RIGHTS_LABELS[rights])). Release forms and edition
// types are not here: the admins keep them in the database (lib/forms.ts, lib/types.ts).

import { N_ } from './i18n';

export const RIGHTS = ['own', 'third_party', 'licensed', 'unknown'] as const;
export type Rights = (typeof RIGHTS)[number];
export const RIGHTS_LABELS: Record<Rights, string> = {
  own: N_('社团自有'),
  third_party: N_('第三方（只列条目）'),
  licensed: N_('已获授权'),
  unknown: N_('未定'),
};

export const FILE_STATES = ['inbox', 'classified', 'published', 'ignored'] as const;
export type FileState = (typeof FILE_STATES)[number];
export const FILE_STATE_LABELS: Record<FileState, string> = {
  inbox: N_('待整理'),
  classified: N_('已归档'),
  published: N_('已发布'),
  ignored: N_('已忽略'),
};

export const FILE_KIND_LABELS: Record<string, string> = {
  audio: N_('音频'),
  image: N_('图片'),
  video: N_('视频'),
  archive: N_('压缩包'),
  disc_image: N_('光盘镜像'),
  text: N_('文本'),
  playlist: N_('播放列表'),
  web: N_('网页'),
  score: N_('乐谱'),
  midi: 'MIDI',
  chart: N_('谱面'),
  program: N_('程序'),
  save: N_('存档'),
  fragment: N_('残片'),
  other: N_('其他'),
};

export const ARCHIVE_STATUS_LABELS: Record<string, string> = {
  ok: N_('已解开'),
  encrypted: N_('加密，未解开'),
  error: N_('解开时出错'),
};

export const NAME_ENCODING_LABELS: Record<string, string> = {
  'utf-8': 'UTF-8',
  cp932: 'Shift-JIS',
  gbk: 'GBK',
  big5: 'Big5',
  cp949: N_('CP949（韩文）'),
};

/** Suggested/known file roles; free text is allowed, these get a readable label. */
export const ROLE_LABELS: Record<string, string> = {
  master: N_('母带'),
  package: N_('原始包'),
  web_archive: N_('网页存档'),
  illustration: N_('插画'),
  bms: 'BMS',
  score: N_('乐谱'),
};

/** Folder-tree nodes with these endings are archives opened by `ra extract`. */
export const ARCHIVE_NAME = /\.(zip|rar|7z|lzh|lha|iso|exe)$/i;

// File kind by extension. Must match _EXT_KINDS in tools/ra/src/ra/model.py (a test there compares them).
// ext-kinds:start
const EXT_KINDS: Record<string, string> = {
  audio: 'flac wav mp3 m4a ogg opus aac wma vqf aif aiff',
  image: 'jpg jpeg png gif bmp webp ico tif tiff',
  video: 'mkv mp4 webm wmv avi mov flv',
  archive: 'zip rar 7z lzh lha gz tar',
  disc_image: 'iso bin img mdf',
  text: 'txt md log cue nfo ini',
  playlist: 'm3u m3u8',
  web: 'html htm css js jsp php xml json',
  score: 'pdf mscz musicxml ove',
  midi: 'mid midi',
  chart: 'bms bme bml pms vos vow ojn ojm',
  program: 'exe dll',
  save: 'psv vmp mcr',
  fragment: 'download',
};
// ext-kinds:end
const EXT_KIND = new Map(Object.entries(EXT_KINDS).flatMap(([kind, exts]) => exts.split(' ').map((e) => [e, kind] as const)));

export function kindFor(ext: string): string {
  return EXT_KIND.get(ext.toLowerCase()) ?? 'other';
}

const MIME: Record<string, string> = {
  flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg',
  aac: 'audio/aac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', mkv: 'video/x-matroska', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', zip: 'application/zip',
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

export const ORIGIN_LABELS: Record<string, string> = { nas: N_('合辑'), upload: N_('后台上传') };

/** Top folder of uploaded files in the 整理台 tree. */
export const UPLOAD_ROOT = '后台上传';

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
