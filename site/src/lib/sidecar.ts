// Files that belong to an audio file by sitting next to it under the same name, as music players read them:
// «01. Song.lrc» beside «01. Song.flac» holds its lyrics (lib/lyrics.ts). Next to it means in the same folder
// of the same edition; the name is compared without its extension, Unicode-normalised and case-folded, by
// the file's own name or the one it is downloaded as.
//
// Pure, so tests/sidecar.test.ts runs it under node.

export interface Named { edition_id: string | null; folder_id: string | null; name: string; download_name: string | null; ext: string }

const stem = (name: string) => name.replace(/\.[^.]*$/, '').normalize('NFC').toLowerCase();
const stems = (f: Named) => new Set([f.name, f.download_name].filter((n): n is string => !!n).map(stem));
const together = (a: Named, b: Named) => a.edition_id === b.edition_id && a.folder_id === b.folder_id;

/** An .lrc file: the lyrics of the audio file named like it. */
export const isLyricsFile = (f: Pick<Named, 'ext'>) => f.ext.toLowerCase() === 'lrc';

/** The lyrics file next to `audio` among `files`, if there is one. */
export function lyricsFileFor<T extends Named>(audio: Named, files: T[]): T | undefined {
  const names = stems(audio);
  return files.find((f) => isLyricsFile(f) && together(f, audio) && [...stems(f)].some((n) => names.has(n)));
}

/** Whether `file` is the lyrics of one of `audios` (and so goes with that track, not with the attachments). */
export function isLyricsOf(file: Named, audios: Named[]): boolean {
  if (!isLyricsFile(file)) return false;
  const names = stems(file);
  return audios.some((a) => together(file, a) && [...stems(a)].some((n) => names.has(n)));
}
