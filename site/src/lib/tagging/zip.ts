// A zip made while it downloads: entries are stored (audio does not compress), their CRC-32 is summed as
// the bytes pass, and sizes and CRC follow each entry in a data descriptor. ZIP64 records are written
// once offsets pass 4 GB, so large editions stay valid.

import { concat, u16le, u32le, u64le, utf8 } from './bytes';
import { crc32 } from './crc32';

export interface ZipEntry {
  name: string;
  size: number; // exact bytes the body will produce
  mtime: Date;
  body: () => Promise<ReadableStream<Uint8Array>>;
}

const MAX32 = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function zipSize(entries: Pick<ZipEntry, 'name' | 'size'>[]): number | null {
  // Only for small archives without ZIP64 records: 30 + name + data + 16 per entry, 46 + name in the directory, 22 at the end.
  let total = 22;
  let offset = 0;
  for (const e of entries) {
    const n = utf8(e.name).length;
    offset += 30 + n + e.size + 16;
    total += 30 + n + e.size + 16 + 46 + n;
  }
  return offset < MAX32 && entries.length < 0xffff ? total : null;
}

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  (async () => {
    const writer = writable.getWriter();
    const central: Uint8Array[] = [];
    let offset = 0;
    const write = async (b: Uint8Array) => {
      await writer.write(b);
      offset += b.length;
    };
    try {
      for (const e of entries) {
        const name = utf8(e.name);
        const { time, date } = dosTime(e.mtime);
        const start = offset;
        const zip64 = start >= MAX32 || e.size >= MAX32;
        // Local header: CRC and sizes come in the data descriptor (flag bit 3); names are UTF-8 (bit 11). A
        // ZIP64 entry announces 8-byte sizes in its descriptor with a ZIP64 extra field.
        const localExtra = zip64 ? concat([u16le(1), u16le(16), u64le(0), u64le(0)]) : new Uint8Array(0);
        await write(concat([
          u32le(0x04034b50), u16le(zip64 ? 45 : 20), u16le(0x0808), u16le(0), u16le(time), u16le(date),
          u32le(0), u32le(zip64 ? MAX32 : 0), u32le(zip64 ? MAX32 : 0), u16le(name.length), u16le(localExtra.length), name, localExtra,
        ]));
        let crc = 0;
        let written = 0;
        const reader = (await e.body()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(crc, value);
          written += value.length;
          await write(value);
        }
        if (written !== e.size) throw new Error(`${e.name}: expected ${e.size} bytes, got ${written}`);
        await write(zip64
          ? concat([u32le(0x08074b50), u32le(crc), u64le(written), u64le(written)])
          : concat([u32le(0x08074b50), u32le(crc), u32le(written), u32le(written)]));
        const extra = zip64 ? concat([u16le(1), u16le(24), u64le(written), u64le(written), u64le(start)]) : new Uint8Array(0);
        central.push(concat([
          u32le(0x02014b50), u16le(zip64 ? 45 : 20), u16le(zip64 ? 45 : 20), u16le(0x0808), u16le(0), u16le(time), u16le(date),
          u32le(crc), u32le(zip64 ? MAX32 : written), u32le(zip64 ? MAX32 : written), u16le(name.length), u16le(extra.length), u16le(0),
          u16le(0), u16le(0), u32le(0), u32le(zip64 ? MAX32 : start), name, extra,
        ]));
      }
      const dirStart = offset;
      for (const c of central) await write(c);
      const dirSize = offset - dirStart;
      const big = dirStart >= MAX32 || entries.length >= 0xffff;
      if (big) {
        const zip64End = offset;
        await write(concat([
          u32le(0x06064b50), u64le(44), u16le(45), u16le(45), u32le(0), u32le(0),
          u64le(entries.length), u64le(entries.length), u64le(dirSize), u64le(dirStart),
        ]));
        await write(concat([u32le(0x07064b50), u32le(0), u64le(zip64End), u32le(1)]));
      }
      const count = big ? 0xffff : entries.length;
      await write(concat([
        u32le(0x06054b50), u16le(0), u16le(0), u16le(count), u16le(count),
        u32le(big ? MAX32 : dirSize), u32le(big ? MAX32 : dirStart), u16le(0),
      ]));
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();
  return readable;
}
