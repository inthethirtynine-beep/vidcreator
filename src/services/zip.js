/* Streams finished clips as one ZIP. MP4 is already compressed, so entries are stored (method 0):
   the archive costs no CPU, its exact size is known up front (the browser shows real progress), and
   ZIP64 records are added only when a file, an offset or the archive passes 4 GB. CRC-32 of each file
   is computed once and cached by the caller. */
const fs = require('fs');
const zlib = require('zlib');

const MAX32 = 0xffffffff;

let table = null;
function crc32Buffer(buffer, crc = 0) {
  if (zlib.crc32) return zlib.crc32(buffer, crc);
  table ||= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = ~crc >>> 0;
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function fileCrc32(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) crc = crc32Buffer(chunk, crc);
  return crc >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Lay out every header for entries [{ name, path, size, crc, mtime }]; returns the parts and total size. */
function layout(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), { time, day } = dosDateTime(entry.mtime || new Date());
    const big = entry.size >= MAX32;
    const local = Buffer.alloc(30 + name.length + (big ? 20 : 0));
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(big ? 45 : 20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(big ? MAX32 : entry.size, 18); local.writeUInt32LE(big ? MAX32 : entry.size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(big ? 20 : 0, 28); name.copy(local, 30);
    if (big) { const x = 30 + name.length; local.writeUInt16LE(1, x); local.writeUInt16LE(16, x + 2); local.writeBigUInt64LE(BigInt(entry.size), x + 4); local.writeBigUInt64LE(BigInt(entry.size), x + 12); }
    parts.push(local, { file: entry.path, size: entry.size });
    // Central directory: ZIP64 extra carries whichever of size / offset does not fit in 32 bits.
    const farOffset = offset >= MAX32, extraFields = (big ? 2 : 0) + (farOffset ? 1 : 0), extraLength = extraFields ? 4 + extraFields * 8 : 0;
    const record = Buffer.alloc(46 + name.length + extraLength);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(45, 4); record.writeUInt16LE(big || farOffset ? 45 : 20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(day, 14); record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(big ? MAX32 : entry.size, 20); record.writeUInt32LE(big ? MAX32 : entry.size, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt16LE(extraLength, 30);
    record.writeUInt32LE(farOffset ? MAX32 : offset, 42); name.copy(record, 46);
    if (extraLength) {
      let x = 46 + name.length;
      record.writeUInt16LE(1, x); record.writeUInt16LE(extraFields * 8, x + 2); x += 4;
      if (big) { record.writeBigUInt64LE(BigInt(entry.size), x); record.writeBigUInt64LE(BigInt(entry.size), x + 8); x += 16; }
      if (farOffset) record.writeBigUInt64LE(BigInt(offset), x);
    }
    central.push(record);
    offset += local.length + entry.size;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0), centralOffset = offset;
  parts.push(...central);
  const zip64 = centralOffset >= MAX32 || centralSize >= MAX32 || entries.length >= 0xffff;
  if (zip64) {
    const record = Buffer.alloc(56), locator = Buffer.alloc(20);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40); record.writeBigUInt64LE(BigInt(centralOffset), 48);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8); locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8); end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(zip64 ? MAX32 : centralSize, 12); end.writeUInt32LE(zip64 ? MAX32 : centralOffset, 16);
  parts.push(end);
  return { parts, size: parts.reduce((sum, p) => sum + (Buffer.isBuffer(p) ? p.length : p.size), 0) };
}

/** Write the archive to an HTTP response; stops quietly if the browser cancels the download. */
async function streamZip(res, entries, filename) {
  const { parts, size } = layout(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="clips.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  let aborted = false, current = null, wake = null;
  res.on('close', () => { if (!res.writableFinished) { aborted = true; current?.destroy(); wake?.(); } });
  for (const part of parts) {
    if (aborted) return;
    if (Buffer.isBuffer(part)) { if (!res.write(part)) await new Promise(r => { wake = r; res.once('drain', r); }); continue; }
    await new Promise((resolve, reject) => {
      current = fs.createReadStream(part.file, { highWaterMark: 4 * 1024 * 1024 });
      wake = resolve;
      current.on('error', reject);
      current.on('end', resolve);
      current.on('close', resolve);
      current.pipe(res, { end: false });
    });
    current = null;
  }
  if (!aborted) res.end();
}

module.exports = { streamZip, fileCrc32, layout };
