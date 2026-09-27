// Small helpers for building binary tags.

export const utf8 = (s: string) => new TextEncoder().encode(s);

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

export function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

export function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 255, (n >>> 8) & 255]);
}

/** 64-bit little endian (sizes up to 2^53). */
export function u64le(n: number): Uint8Array {
  const lo = n % 2 ** 32;
  const hi = Math.floor(n / 2 ** 32);
  return concat([u32le(lo), u32le(hi)]);
}

/** Width and height of a JPEG or PNG, when they can be read. */
export function imageSize(b: Uint8Array): { width: number; height: number; mime: string } | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20), mime: 'image/png' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], mime: 'image/jpeg' };
      }
      i += 2 + len;
    }
    return { width: 0, height: 0, mime: 'image/jpeg' };
  }
  return null;
}
