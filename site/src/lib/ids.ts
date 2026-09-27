/** A new random id with a prefix: f_ files, fd_ folders, e_ editions, et_ edition tracks, t_ tracks, s_ songs. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
