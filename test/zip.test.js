const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Writable } = require('stream');
const { streamZip, fileCrc32, layout } = require('../src/services/zip');

// Minimal reader: end record → central directory → local headers → stored data.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10), centralOffset = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0, p = centralOffset; i < count; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const crc = buffer.readUInt32LE(p + 16), size = buffer.readUInt32LE(p + 24), nameLength = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files[name] = { crc, data: buffer.subarray(start, start + size) };
    p += 46 + nameLength + extra;
  }
  return files;
}

test('download-all ZIP stores every clip byte for byte with correct CRC and exact length', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcreator-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sources = { 'clip_001.mp4': Buffer.alloc(300000, 7), 'клип 2.mp4': Buffer.from('second clip with a Cyrillic name') };
  const entries = [];
  for (const [name, data] of Object.entries(sources)) {
    const file = path.join(dir, name); fs.writeFileSync(file, data);
    entries.push({ name, path: file, size: data.length, crc: await fileCrc32(file), mtime: new Date() });
  }
  const chunks = [];
  const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
  let headers = null;
  res.writeHead = (status, h) => { headers = h; };
  await streamZip(res, entries, 'клипы.zip');
  const zip = Buffer.concat(chunks);
  assert.equal(Number(headers['Content-Length']), zip.length);
  const files = readZip(zip);
  for (const [name, data] of Object.entries(sources)) {
    assert.ok(files[name], `${name} is in the archive`);
    assert.ok(files[name].data.equals(data));
    assert.equal(files[name].crc, zlib.crc32(data));
  }
});

test('archives over 4 GB get ZIP64 size, offset and end records', () => {
  const big = 5 * 1024 ** 3;
  const { parts, size } = layout([{ name: 'a.mp4', path: 'x', size: big, crc: 1 }, { name: 'b.mp4', path: 'y', size: 10, crc: 2 }]);
  const headers = Buffer.concat(parts.filter(Buffer.isBuffer));
  assert.ok(headers.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end of central directory');
  assert.ok(headers.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'ZIP64 locator');
  assert.equal(size, headers.length + big + 10);
});
