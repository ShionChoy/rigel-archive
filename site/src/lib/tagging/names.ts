// The site's tag names and how each audio format stores them. The names are MusicBrainz Picard's
// internal ones (title, albumartist, catalognumber, musicbrainz_albumid …), so a value means the same
// thing whichever format it is read from or written to; the mapping follows Picard's tag mapping table
// (https://picard-docs.musicbrainz.org/en/appendices/tag_mapping.html).
//
// Tags are kept as { name: [values] }: a list, since many fields may hold several values (two artists).
// Names not in the table are allowed (a Vorbis field or an ID3 TXXX the site has no entry for keeps its
// own name, lower-cased) and are written back under that name. «performer:<role>» holds the players of
// one instrument or role (performer:vocals).

import { N_ } from '../i18n';

export type Tags = Record<string, string[]>;

export interface TagDef {
  name: string;
  label: string; // Chinese, translated where shown
  group: 'main' | 'people' | 'release' | 'sort' | 'ids' | 'other';
  vorbis?: string; // FLAC, Ogg Vorbis / Opus
  vorbisAlso?: string[]; // other field names read as this tag
  id3?: string; // TIT2, TXXX:<description>, TIPL:<role>, COMM, USLT, UFID:<owner>, W***
  id3Also?: string[];
  mp4?: string; // ©nam …, or ----:<name> (a com.apple.iTunes freeform atom)
  ape?: string;
  riff?: string; // a RIFF INFO chunk (WAV)
}

const MB = (s: string) => `TXXX:MusicBrainz ${s}`;
const FREE = (s: string) => `----:${s}`;

export const TAG_DEFS: TagDef[] = [
  // main
  { name: 'title', label: N_('标题'), group: 'main', vorbis: 'TITLE', id3: 'TIT2', mp4: '©nam', ape: 'Title', riff: 'INAM' },
  { name: 'artist', label: N_('艺术家'), group: 'main', vorbis: 'ARTIST', id3: 'TPE1', mp4: '©ART', ape: 'Artist', riff: 'IART' },
  { name: 'album', label: N_('专辑'), group: 'main', vorbis: 'ALBUM', id3: 'TALB', mp4: '©alb', ape: 'Album', riff: 'IPRD' },
  { name: 'albumartist', label: N_('专辑艺术家'), group: 'main', vorbis: 'ALBUMARTIST', vorbisAlso: ['ALBUM ARTIST', 'ALBUM_ARTIST'], id3: 'TPE2', mp4: 'aART', ape: 'Album Artist' },
  { name: 'date', label: N_('日期'), group: 'main', vorbis: 'DATE', vorbisAlso: ['YEAR'], id3: 'TDRC', id3Also: ['TYER'], mp4: '©day', ape: 'Year', riff: 'ICRD' },
  { name: 'genre', label: N_('流派'), group: 'main', vorbis: 'GENRE', id3: 'TCON', mp4: '©gen', ape: 'Genre', riff: 'IGNR' },
  { name: 'tracknumber', label: N_('音轨号'), group: 'main', vorbis: 'TRACKNUMBER', id3: 'TRCK', mp4: 'trkn', ape: 'Track', riff: 'ITRK' },
  { name: 'totaltracks', label: N_('总音轨数'), group: 'main', vorbis: 'TRACKTOTAL', vorbisAlso: ['TOTALTRACKS'] },
  { name: 'discnumber', label: N_('碟号'), group: 'main', vorbis: 'DISCNUMBER', id3: 'TPOS', mp4: 'disk', ape: 'Disc' },
  { name: 'totaldiscs', label: N_('总碟数'), group: 'main', vorbis: 'DISCTOTAL', vorbisAlso: ['TOTALDISCS'] },
  { name: 'comment', label: N_('注释'), group: 'main', vorbis: 'COMMENT', vorbisAlso: ['DESCRIPTION'], id3: 'COMM', mp4: '©cmt', ape: 'Comment', riff: 'ICMT' },
  { name: 'lyrics', label: N_('歌词'), group: 'main', vorbis: 'LYRICS', vorbisAlso: ['UNSYNCEDLYRICS'], id3: 'USLT', mp4: '©lyr', ape: 'Lyrics' },
  { name: 'subtitle', label: N_('副标题'), group: 'main', vorbis: 'SUBTITLE', id3: 'TIT3', mp4: FREE('SUBTITLE'), ape: 'Subtitle' },
  { name: 'discsubtitle', label: N_('碟片副标题'), group: 'main', vorbis: 'DISCSUBTITLE', id3: 'TSST', mp4: FREE('DISCSUBTITLE'), ape: 'DiscSubtitle' },
  { name: 'grouping', label: N_('分组'), group: 'main', vorbis: 'GROUPING', id3: 'TIT1', mp4: '©grp', ape: 'Grouping' },
  { name: 'work', label: N_('音乐作品'), group: 'main', vorbis: 'WORK', id3: 'TXXX:WORK', mp4: '©wrk', ape: 'Work' },
  { name: 'mood', label: N_('情绪'), group: 'main', vorbis: 'MOOD', id3: 'TMOO', mp4: FREE('MOOD'), ape: 'Mood' },
  { name: 'bpm', label: 'BPM', group: 'main', vorbis: 'BPM', id3: 'TBPM', mp4: 'tmpo', ape: 'BPM' },
  { name: 'key', label: N_('调性'), group: 'main', vorbis: 'KEY', id3: 'TKEY', mp4: FREE('initialkey'), ape: 'Key' },
  { name: 'language', label: N_('语言'), group: 'main', vorbis: 'LANGUAGE', id3: 'TLAN', mp4: FREE('LANGUAGE'), ape: 'Language', riff: 'ILNG' },
  { name: 'compilation', label: N_('合辑'), group: 'main', vorbis: 'COMPILATION', id3: 'TCMP', mp4: 'cpil', ape: 'Compilation' },
  // people
  { name: 'composer', label: N_('作曲'), group: 'people', vorbis: 'COMPOSER', id3: 'TCOM', mp4: '©wrt', ape: 'Composer', riff: 'IMUS' },
  { name: 'lyricist', label: N_('作词'), group: 'people', vorbis: 'LYRICIST', id3: 'TEXT', mp4: FREE('LYRICIST'), ape: 'Lyricist' },
  { name: 'arranger', label: N_('编曲'), group: 'people', vorbis: 'ARRANGER', id3: 'TIPL:arranger', mp4: FREE('ARRANGER'), ape: 'Arranger' },
  { name: 'writer', label: N_('词曲作者'), group: 'people', vorbis: 'WRITER', id3: 'TXXX:Writer', mp4: FREE('WRITER'), ape: 'Writer', riff: 'IWRI' },
  { name: 'conductor', label: N_('指挥'), group: 'people', vorbis: 'CONDUCTOR', id3: 'TPE3', mp4: FREE('CONDUCTOR'), ape: 'Conductor' },
  { name: 'remixer', label: N_('重混'), group: 'people', vorbis: 'REMIXER', id3: 'TPE4', mp4: FREE('REMIXER'), ape: 'MixArtist' },
  { name: 'producer', label: N_('制作人'), group: 'people', vorbis: 'PRODUCER', id3: 'TIPL:producer', mp4: FREE('PRODUCER'), ape: 'Producer' },
  { name: 'engineer', label: N_('录音师'), group: 'people', vorbis: 'ENGINEER', id3: 'TIPL:engineer', mp4: FREE('ENGINEER'), ape: 'Engineer', riff: 'IENG' },
  { name: 'mixer', label: N_('混音师'), group: 'people', vorbis: 'MIXER', id3: 'TIPL:mix', mp4: FREE('MIXER'), ape: 'Mixer' },
  { name: 'djmixer', label: N_('DJ 混音'), group: 'people', vorbis: 'DJMIXER', id3: 'TIPL:DJ-mix', mp4: FREE('DJMIXER'), ape: 'DJMixer' },
  { name: 'artists', label: N_('各位艺术家'), group: 'people', vorbis: 'ARTISTS', id3: 'TXXX:ARTISTS', mp4: FREE('ARTISTS'), ape: 'Artists' },
  { name: 'originalartist', label: N_('原艺术家'), group: 'people', vorbis: 'ORIGINALARTIST', id3: 'TOPE' },
  // release
  { name: 'label', label: N_('厂牌'), group: 'release', vorbis: 'LABEL', vorbisAlso: ['ORGANIZATION', 'PUBLISHER'], id3: 'TPUB', mp4: FREE('LABEL'), ape: 'Label' },
  { name: 'catalognumber', label: N_('编号'), group: 'release', vorbis: 'CATALOGNUMBER', vorbisAlso: ['CATALOG', 'LABELNO'], id3: 'TXXX:CATALOGNUMBER', mp4: FREE('CATALOGNUMBER'), ape: 'CatalogNumber' },
  { name: 'barcode', label: N_('条码'), group: 'release', vorbis: 'BARCODE', vorbisAlso: ['UPC', 'EAN'], id3: 'TXXX:BARCODE', mp4: FREE('BARCODE'), ape: 'Barcode' },
  { name: 'isrc', label: 'ISRC', group: 'release', vorbis: 'ISRC', id3: 'TSRC', mp4: FREE('ISRC'), ape: 'ISRC', riff: 'ISRC' },
  { name: 'asin', label: 'ASIN', group: 'release', vorbis: 'ASIN', id3: 'TXXX:ASIN', mp4: FREE('ASIN'), ape: 'ASIN' },
  { name: 'originaldate', label: N_('原始日期'), group: 'release', vorbis: 'ORIGINALDATE', id3: 'TDOR', id3Also: ['TORY'], mp4: FREE('ORIGINALDATE'), ape: 'ORIGINALDATE' },
  { name: 'originalyear', label: N_('原始年份'), group: 'release', vorbis: 'ORIGINALYEAR', id3: 'TXXX:originalyear', mp4: FREE('ORIGINALYEAR'), ape: 'ORIGINALYEAR' },
  { name: 'releasedate', label: N_('发行日期'), group: 'release', vorbis: 'RELEASEDATE', id3: 'TDRL', mp4: FREE('RELEASEDATE'), ape: 'RELEASEDATE' },
  { name: 'releasetype', label: N_('发行类型'), group: 'release', vorbis: 'RELEASETYPE', id3: MB('Album Type'), mp4: FREE('MusicBrainz Album Type'), ape: 'MUSICBRAINZ_ALBUMTYPE' },
  { name: 'releasestatus', label: N_('发行状态'), group: 'release', vorbis: 'RELEASESTATUS', id3: MB('Album Status'), mp4: FREE('MusicBrainz Album Status'), ape: 'MUSICBRAINZ_ALBUMSTATUS' },
  { name: 'releasecountry', label: N_('发行国家'), group: 'release', vorbis: 'RELEASECOUNTRY', id3: MB('Album Release Country'), mp4: FREE('MusicBrainz Album Release Country'), ape: 'RELEASECOUNTRY' },
  { name: 'media', label: N_('介质'), group: 'release', vorbis: 'MEDIA', id3: 'TMED', mp4: FREE('MEDIA'), ape: 'Media', riff: 'IMED' },
  { name: 'script', label: N_('文字'), group: 'release', vorbis: 'SCRIPT', id3: 'TXXX:SCRIPT', mp4: FREE('SCRIPT'), ape: 'Script' },
  { name: 'originalalbum', label: N_('原专辑'), group: 'release', vorbis: 'ORIGINALALBUM', id3: 'TOAL' },
  { name: 'copyright', label: N_('版权'), group: 'release', vorbis: 'COPYRIGHT', id3: 'TCOP', mp4: 'cprt', ape: 'Copyright', riff: 'ICOP' },
  { name: 'license', label: N_('许可'), group: 'release', vorbis: 'LICENSE', id3: 'TXXX:LICENSE', mp4: FREE('LICENSE'), ape: 'LICENSE' },
  { name: 'website', label: N_('网站'), group: 'release', vorbis: 'WEBSITE', id3: 'WOAR', mp4: FREE('WEBSITE'), ape: 'Weblink' },
  // sort names
  { name: 'titlesort', label: N_('标题（排序用）'), group: 'sort', vorbis: 'TITLESORT', id3: 'TSOT', mp4: 'sonm', ape: 'TITLESORT' },
  { name: 'artistsort', label: N_('艺术家（排序用）'), group: 'sort', vorbis: 'ARTISTSORT', id3: 'TSOP', mp4: 'soar', ape: 'ARTISTSORT' },
  { name: 'albumsort', label: N_('专辑（排序用）'), group: 'sort', vorbis: 'ALBUMSORT', id3: 'TSOA', mp4: 'soal', ape: 'ALBUMSORT' },
  { name: 'albumartistsort', label: N_('专辑艺术家（排序用）'), group: 'sort', vorbis: 'ALBUMARTISTSORT', id3: 'TSO2', mp4: 'soaa', ape: 'ALBUMARTISTSORT' },
  { name: 'composersort', label: N_('作曲（排序用）'), group: 'sort', vorbis: 'COMPOSERSORT', id3: 'TSOC', mp4: 'soco', ape: 'COMPOSERSORT' },
  // identifiers
  { name: 'musicbrainz_recordingid', label: N_('MusicBrainz 录音 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_TRACKID', id3: 'UFID:http://musicbrainz.org', mp4: FREE('MusicBrainz Track Id'), ape: 'MUSICBRAINZ_TRACKID' },
  { name: 'musicbrainz_trackid', label: N_('MusicBrainz 曲目 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_RELEASETRACKID', id3: MB('Release Track Id'), mp4: FREE('MusicBrainz Release Track Id'), ape: 'MUSICBRAINZ_RELEASETRACKID' },
  { name: 'musicbrainz_albumid', label: N_('MusicBrainz 发行 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_ALBUMID', id3: MB('Album Id'), mp4: FREE('MusicBrainz Album Id'), ape: 'MUSICBRAINZ_ALBUMID' },
  { name: 'musicbrainz_releasegroupid', label: N_('MusicBrainz 发行组 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_RELEASEGROUPID', id3: MB('Release Group Id'), mp4: FREE('MusicBrainz Release Group Id'), ape: 'MUSICBRAINZ_RELEASEGROUPID' },
  { name: 'musicbrainz_artistid', label: N_('MusicBrainz 艺术家 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_ARTISTID', id3: MB('Artist Id'), mp4: FREE('MusicBrainz Artist Id'), ape: 'MUSICBRAINZ_ARTISTID' },
  { name: 'musicbrainz_albumartistid', label: N_('MusicBrainz 专辑艺术家 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_ALBUMARTISTID', id3: MB('Album Artist Id'), mp4: FREE('MusicBrainz Album Artist Id'), ape: 'MUSICBRAINZ_ALBUMARTISTID' },
  { name: 'musicbrainz_workid', label: N_('MusicBrainz 作品 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_WORKID', id3: MB('Work Id'), mp4: FREE('MusicBrainz Work Id'), ape: 'MUSICBRAINZ_WORKID' },
  { name: 'musicbrainz_labelid', label: N_('MusicBrainz 厂牌 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_LABELID', id3: MB('Label Id'), mp4: FREE('MusicBrainz Label Id'), ape: 'MUSICBRAINZ_LABELID' },
  { name: 'musicbrainz_discid', label: N_('MusicBrainz 碟片 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_DISCID', id3: MB('Disc Id'), mp4: FREE('MusicBrainz Disc Id'), ape: 'MUSICBRAINZ_DISCID' },
  { name: 'musicbrainz_originalalbumid', label: N_('MusicBrainz 原发行 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_ORIGINALALBUMID', id3: MB('Original Album Id'), mp4: FREE('MusicBrainz Original Album Id') },
  { name: 'musicbrainz_originalartistid', label: N_('MusicBrainz 原艺术家 ID'), group: 'ids', vorbis: 'MUSICBRAINZ_ORIGINALARTISTID', id3: MB('Original Artist Id'), mp4: FREE('MusicBrainz Original Artist Id') },
  { name: 'acoustid_id', label: 'AcoustID', group: 'ids', vorbis: 'ACOUSTID_ID', id3: 'TXXX:Acoustid Id', mp4: FREE('Acoustid Id'), ape: 'ACOUSTID_ID' },
  { name: 'acoustid_fingerprint', label: N_('AcoustID 指纹'), group: 'ids', vorbis: 'ACOUSTID_FINGERPRINT', id3: 'TXXX:Acoustid Fingerprint', mp4: FREE('Acoustid Fingerprint'), ape: 'ACOUSTID_FINGERPRINT' },
  // other
  { name: 'encodedby', label: N_('编码者'), group: 'other', vorbis: 'ENCODEDBY', id3: 'TENC', mp4: '©too', ape: 'EncodedBy', riff: 'ITCH' },
  { name: 'encodersettings', label: N_('编码设置'), group: 'other', vorbis: 'ENCODERSETTINGS', id3: 'TSSE', mp4: FREE('ENCODERSETTINGS'), ape: 'EncoderSettings', riff: 'ISFT' },
  { name: 'originalfilename', label: N_('原文件名'), group: 'other', vorbis: 'ORIGINALFILENAME', id3: 'TOFN' },
  { name: 'replaygain_track_gain', label: N_('ReplayGain 音轨增益'), group: 'other', vorbis: 'REPLAYGAIN_TRACK_GAIN', id3: 'TXXX:REPLAYGAIN_TRACK_GAIN', mp4: FREE('REPLAYGAIN_TRACK_GAIN'), ape: 'REPLAYGAIN_TRACK_GAIN' },
  { name: 'replaygain_track_peak', label: N_('ReplayGain 音轨峰值'), group: 'other', vorbis: 'REPLAYGAIN_TRACK_PEAK', id3: 'TXXX:REPLAYGAIN_TRACK_PEAK', mp4: FREE('REPLAYGAIN_TRACK_PEAK'), ape: 'REPLAYGAIN_TRACK_PEAK' },
  { name: 'replaygain_track_range', label: N_('ReplayGain 音轨动态范围'), group: 'other', vorbis: 'REPLAYGAIN_TRACK_RANGE', id3: 'TXXX:REPLAYGAIN_TRACK_RANGE', mp4: FREE('REPLAYGAIN_TRACK_RANGE'), ape: 'REPLAYGAIN_TRACK_RANGE' },
  { name: 'replaygain_album_gain', label: N_('ReplayGain 专辑增益'), group: 'other', vorbis: 'REPLAYGAIN_ALBUM_GAIN', id3: 'TXXX:REPLAYGAIN_ALBUM_GAIN', mp4: FREE('REPLAYGAIN_ALBUM_GAIN'), ape: 'REPLAYGAIN_ALBUM_GAIN' },
  { name: 'replaygain_album_peak', label: N_('ReplayGain 专辑峰值'), group: 'other', vorbis: 'REPLAYGAIN_ALBUM_PEAK', id3: 'TXXX:REPLAYGAIN_ALBUM_PEAK', mp4: FREE('REPLAYGAIN_ALBUM_PEAK'), ape: 'REPLAYGAIN_ALBUM_PEAK' },
  { name: 'replaygain_album_range', label: N_('ReplayGain 专辑动态范围'), group: 'other', vorbis: 'REPLAYGAIN_ALBUM_RANGE', id3: 'TXXX:REPLAYGAIN_ALBUM_RANGE', mp4: FREE('REPLAYGAIN_ALBUM_RANGE'), ape: 'REPLAYGAIN_ALBUM_RANGE' },
  { name: 'replaygain_reference_loudness', label: N_('ReplayGain 参考响度'), group: 'other', vorbis: 'REPLAYGAIN_REFERENCE_LOUDNESS', id3: 'TXXX:REPLAYGAIN_REFERENCE_LOUDNESS', mp4: FREE('REPLAYGAIN_REFERENCE_LOUDNESS'), ape: 'REPLAYGAIN_REFERENCE_LOUDNESS' },
];

export const TAG_DEF = new Map(TAG_DEFS.map((d) => [d.name, d]));

/** Shown on the edition page even when empty (the team's display list adds to these). */
export const COMMON_TAGS = [
  'title', 'artist', 'album', 'albumartist', 'date', 'genre', 'composer', 'lyricist', 'arranger', 'label', 'catalognumber', 'comment',
];

/** Numbered from the track list's order, not edited as tags. */
export const NUMBER_TAGS = ['tracknumber', 'totaltracks', 'discnumber', 'totaldiscs'];

/** The same for the whole edition (版本信息 shows them first; a track list shows the per-track ones). */
export const ALBUM_TAGS = new Set([
  'album', 'albumartist', 'date', 'genre', 'label', 'catalognumber', 'barcode', 'originaldate', 'originalyear', 'releasedate', 'releasetype',
  'releasestatus', 'releasecountry', 'media', 'script', 'copyright', 'license', 'albumsort', 'albumartistsort', 'musicbrainz_albumid',
  'musicbrainz_releasegroupid', 'musicbrainz_albumartistid', 'musicbrainz_labelid', 'musicbrainz_discid', 'asin', 'compilation', 'totaldiscs',
  'replaygain_album_gain', 'replaygain_album_peak', 'replaygain_album_range', 'language', 'website',
]);

export const PERFORMER = 'performer:';

/** A tag name as typed by an admin: lower case, no spaces around, only sensible characters. */
export function cleanTagName(raw: string): string | null {
  const name = raw.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name || name.length > 60 || name.startsWith('~') || /[=\u0000-\u001f]/.test(name)) return null;
  return name;
}

/** The label of a tag (a text to translate; performer roles and unknown names come as they are). */
export function tagLabel(name: string): { text: string; role?: string } {
  const def = TAG_DEF.get(name);
  if (def) return { text: def.label };
  if (name.startsWith(PERFORMER)) return { text: N_('演奏者（{role}）'), role: name.slice(PERFORMER.length) };
  return { text: name };
}

// ------------------------------------------------------------------------------------------ lookups by format

const upper = (s: string) => s.toUpperCase();
const VORBIS = new Map<string, string>();
const ID3 = new Map<string, string>();
const MP4 = new Map<string, string>();
const APE = new Map<string, string>();
const RIFF = new Map<string, string>();
for (const d of TAG_DEFS) {
  for (const k of [d.vorbis, ...(d.vorbisAlso ?? [])]) if (k) VORBIS.set(upper(k), d.name);
  for (const k of [d.id3, ...(d.id3Also ?? [])]) if (k) ID3.set(k.startsWith('TXXX:') ? `TXXX:${k.slice(5).toLowerCase()}` : k, d.name);
  if (d.mp4) MP4.set(d.mp4.startsWith('----:') ? `----:${d.mp4.slice(5).toLowerCase()}` : d.mp4, d.name);
  if (d.ape) APE.set(d.ape.toLowerCase(), d.name);
  if (d.riff) RIFF.set(d.riff, d.name);
}

/** A Vorbis field name → tag name (unknown fields: the field name in lower case). */
export function vorbisTag(field: string): string {
  const key = upper(field.trim());
  if (key === 'PERFORMER') return 'performer';
  return VORBIS.get(key) ?? key.toLowerCase();
}

/** The Vorbis field a tag is written as. */
export function vorbisField(tag: string): string {
  return TAG_DEF.get(tag)?.vorbis ?? upper(tag);
}

/** An ID3v2 frame (id, and TXXX's description or TIPL's role) → tag name, or null for frames the site does not read as tags. */
export function id3Tag(id: string, description = ''): string | null {
  if (id === 'TXXX') return ID3.get(`TXXX:${description.toLowerCase()}`) ?? (description ? description.toLowerCase() : null);
  if (id === 'TIPL' || id === 'IPLS') return ID3.get(`TIPL:${description}`) ?? null;
  if (id === 'TMCL') return `${PERFORMER}${description}`;
  if (id === 'UFID') return ID3.get(`UFID:${description}`) ?? null;
  return ID3.get(id) ?? null;
}

/** An MP4 item atom (or ----:<name>) → tag name, or null. */
export function mp4Tag(atom: string): string | null {
  if (atom.startsWith('----:')) return MP4.get(`----:${atom.slice(5).toLowerCase()}`) ?? atom.slice(5).toLowerCase();
  return MP4.get(atom) ?? null;
}

export function apeTag(key: string): string {
  return APE.get(key.toLowerCase()) ?? key.toLowerCase();
}

export function riffTag(id: string): string | null {
  return RIFF.get(id) ?? null;
}

/** «Name (role)» of a Vorbis PERFORMER field → [role, name]. */
export function splitPerformer(value: string): [string, string] {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(value);
  return m ? [m[2].trim().toLowerCase(), m[1].trim()] : ['', value.trim()];
}

/** Add a value to a tag set (no empty values, no repeats). */
export function addValue(tags: Tags, name: string, value: string) {
  const v = value.replace(/\u0000+$/g, '').trim();
  if (!v) return;
  const list = tags[name] ?? (tags[name] = []);
  if (!list.includes(v)) list.push(v);
}

/** «3/12» → number and total. */
export function splitNumber(value: string): [string, string] {
  const [n, total] = value.split('/').map((s) => s.trim());
  return [n ?? '', total ?? ''];
}
