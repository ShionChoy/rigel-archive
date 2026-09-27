// CRC-32 (zip), slicing by 8 so a whole album can be summed while it streams.

const TABLES: Uint32Array[] = (() => {
  const base = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    base[i] = c >>> 0;
  }
  const tables = [base];
  for (let t = 1; t < 8; t += 1) {
    const prev = tables[t - 1];
    const next = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) next[i] = (prev[i] >>> 8) ^ base[prev[i] & 255];
    tables.push(next);
  }
  return tables;
})();

/** Continue a CRC-32 (start with 0) over more bytes. */
export function crc32(crc: number, b: Uint8Array): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const n = b.length;
  for (; i + 8 <= n; i += 8) {
    c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    c = t7[c & 255] ^ t6[(c >>> 8) & 255] ^ t5[(c >>> 16) & 255] ^ t4[c >>> 24] ^ t3[b[i + 4]] ^ t2[b[i + 5]] ^ t1[b[i + 6]] ^ t0[b[i + 7]];
  }
  for (; i < n; i += 1) c = t0[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
