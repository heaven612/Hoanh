// Minimal ZIP writer (no dependencies). Text-like files are deflated with the
// browser's native CompressionStream; already-compressed media is stored as is.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const COMPRESSIBLE = /\.(html?|css|js|mjs|json|md|txt|svg|xml|rels|csv|map)$/i;

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Unsupported zip entry data');
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  constructor() {
    this.entries = [];
    this.names = new Set();
  }

  has(name) {
    return this.names.has(name);
  }

  /** Adds a file. Returns the (possibly de-duplicated) name actually used. */
  add(name, data) {
    let finalName = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.names.has(finalName)) {
      const dot = finalName.lastIndexOf('.');
      const base = dot > finalName.lastIndexOf('/') ? finalName.slice(0, dot) : finalName;
      const ext = dot > finalName.lastIndexOf('/') ? finalName.slice(dot) : '';
      let i = 2;
      while (this.names.has(`${base}-${i}${ext}`)) i++;
      finalName = `${base}-${i}${ext}`;
    }
    this.names.add(finalName);
    this.entries.push({ name: finalName, data: toBytes(data) });
    return finalName;
  }

  get size() {
    return this.entries.reduce((sum, e) => sum + e.data.length, 0);
  }

  async toBlob(mimeType = 'application/zip') {
    const { time, day } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      let method = 0;
      let payload = entry.data;
      if (COMPRESSIBLE.test(entry.name) && entry.data.length > 512 && typeof CompressionStream !== 'undefined') {
        const compressed = await deflateRaw(entry.data);
        if (compressed.length < entry.data.length) {
          method = 8;
          payload = compressed;
        }
      }

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 file names
      local.setUint16(8, method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, payload.length, true);
      local.setUint32(22, entry.data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, nameBytes, payload);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, method, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, day, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, payload.length, true);
      cd.setUint32(24, entry.data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, nameBytes);

      offset += 30 + nameBytes.length + payload.length;
    }

    const centralSize = central.reduce((sum, p) => sum + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: mimeType });
  }
}
