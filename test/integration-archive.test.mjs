import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { zipSync } from 'fflate';
import { bundleDigest, readBundle, writeBundle } from '../src/iflow-bundle.mjs';

const MiB = 1024 * 1024;
const empty = new Uint8Array(0);

// Use fflate only to prepare a compressed payload and its checksum. The record
// builder deliberately permits duplicates, unsafe paths and false size fields
// that a normal archive writer cannot produce.
function payload(bytes = empty, level = 6) {
  const zip = zipSync({ fixture: bytes }, { level });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const length = view.getUint32(18, true);
  return {
    compressed: zip.subarray(start, start + length),
    size: bytes.length,
    crc: view.getUint32(14, true),
    compression: view.getUint16(8, true)
  };
}

function archive(entries, comment = empty) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const { name, data, declaredSize = data.size } of entries) {
    const encoded = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + encoded.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(data.compression, 8);
    local.writeUInt32LE(data.crc, 14);
    local.writeUInt32LE(data.compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(encoded.length, 26);
    local.set(encoded, 30);
    const central = Buffer.alloc(46 + encoded.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(data.compression, 10);
    central.writeUInt32LE(data.crc, 16);
    central.writeUInt32LE(data.compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(offset, 42);
    central.set(encoded, 46);
    locals.push(local, data.compressed);
    directory.push(central);
    offset += local.length + data.compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((size, record) => size + record.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, ...directory, end, comment]);
}

function assertRejected(bytes, pattern = /bundle zip/) {
  assert.throws(() => readBundle(bytes), pattern);
}

test('binary, unknown, Unicode and empty members round-trip without rewriting input bytes', () => {
  const binary = Uint8Array.from({ length: 65539 }, (_, index) => index % 256);
  binary.set([0x50, 0x4b, 0x07, 0x08], 1023);
  const files = new Map([
    ['META-INF/', empty],
    ['META-INF/MANIFEST.MF', Buffer.from('Bundle-Version: 1.2.3\r\n')],
    ['unknown/猫.dat', binary],
    ['__proto__', Uint8Array.of(0, 255, 128)],
    ['empty', empty]
  ]);
  const zipped = Buffer.from(writeBundle(files));
  const original = Buffer.from(zipped);
  const result = readBundle(zipped);
  assert.equal(bundleDigest(result), bundleDigest(files));
  assert.deepEqual([...result.keys()], [...files.keys()]);
  for (const [name, bytes] of files) assert.deepEqual(Buffer.from(result.get(name)), Buffer.from(bytes));
  assert.deepEqual(zipped, original, 'descriptor normalization must not mutate a Buffer-backed source');
  assert.equal(readBundle(writeBundle(new Map())).size, 0);
});

test('valid stored archives and comments containing apparent local headers remain readable', () => {
  const binary = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 255, 127);
  const zipped = archive([{ name: 'binary', data: payload(binary, 0) }], Buffer.from('PK\x03\x04not another file'));
  assert.deepEqual(Buffer.from(readBundle(zipped).get('binary')), Buffer.from(binary));
});

test('signed and unsigned descriptors preserve binary signature bytes and reject mismatches', () => {
  const bytes = Uint8Array.of(0x50, 0x4b, 0x07, 0x08, 0x50, 0x4b, 0x03, 0x04, 255);
  const data = payload(bytes, 0);
  const base = archive([{ name: 'binary', data }]);
  const centralOffset = base.readUInt32LE(base.length - 6);
  for (const signed of [false, true]) {
    const local = Buffer.from(base.subarray(0, centralOffset));
    const central = Buffer.from(base.subarray(centralOffset, base.length - 22));
    const end = Buffer.from(base.subarray(base.length - 22));
    const descriptor = Buffer.alloc(signed ? 16 : 12);
    const offset = signed ? 4 : 0;
    if (signed) descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(data.crc, offset);
    descriptor.writeUInt32LE(data.compressed.length, offset + 4);
    descriptor.writeUInt32LE(data.size, offset + 8);
    local.writeUInt16LE(0x0808, 6);
    local.fill(0, 14, 26);
    central.writeUInt16LE(0x0808, 8);
    end.writeUInt32LE(centralOffset + descriptor.length, 16);
    const zip = Buffer.concat([local, descriptor, central, end]);
    assert.deepEqual(Buffer.from(readBundle(zip).get('binary')), Buffer.from(bytes));
    zip[centralOffset + offset] ^= 1;
    assertRejected(zip, /data descriptor/);
  }
});

test('malformed extras, alternate filenames, ZIP64 and invalid UTF-8 are rejected', () => {
  const base = archive([{ name: 'x', data: payload() }]);
  const centralOffset = base.readUInt32LE(base.length - 6);
  for (const [kind, claimedSize] of [[0x7075, 0], [1, 0], [0x9999, 1]]) {
    const extra = Buffer.alloc(4);
    extra.writeUInt16LE(kind, 0);
    extra.writeUInt16LE(claimedSize, 2);
    const central = Buffer.from(base.subarray(centralOffset, base.length - 22));
    const end = Buffer.from(base.subarray(base.length - 22));
    central.writeUInt16LE(extra.length, 30);
    end.writeUInt32LE(central.length + extra.length, 12);
    assertRejected(Buffer.concat([base.subarray(0, centralOffset), central, extra, end]));
  }
  const invalidName = Buffer.from(base);
  invalidName[30] = 0xff;
  invalidName[centralOffset + 46] = 0xff;
  assertRejected(invalidName);
  assertRejected(archive([{ name: 'missing-deflate', data: { compressed: empty, size: 0, crc: 0, compression: 8 } }]));
});

test('both reader and writer reject unsafe, ambiguous and duplicate member paths', () => {
  const data = payload();
  for (const name of ['', '../x', 'a/../x', '/absolute', '//host/file', 'C:relative', 'C:/absolute',
    'a\\b', '\\host\\file', 'a\0b', 'a//b', './x', 'a/./b', 'a//']) {
    assertRejected(archive([{ name, data }]), /unsafe member path/);
    assert.throws(() => writeBundle([[name, empty]]), /unsafe member path/);
  }
  assertRejected(archive([{ name: 'same', data }, { name: 'same', data }]), /duplicate member path/);
  assert.throws(() => writeBundle([['same', empty], ['same', empty]]), /duplicate member path/);
  for (const names of [['a', 'a/'], ['a', 'a/b']]) {
    assertRejected(archive(names.map(name => ({ name, data }))), /conflicting member paths|member directory/);
    assert.throws(() => writeBundle(names.map(name => [name, empty])), /conflicting member paths|member directory/);
  }
  assert.throws(() => writeBundle([['unpaired-\ud800', empty]]), /unsafe member path/);
  assert.throws(() => writeBundle([['x'.repeat(65536), empty]]), /unsafe member path/);
});

test('malformed, truncated, overlapping and unindexed ZIP records are rejected', () => {
  const valid = archive([{ name: 'file', data: payload(Uint8Array.of(1, 2, 3), 0) }]);
  for (const length of [0, 1, 29, 34, valid.length - 23, valid.length - 22, valid.length - 1]) {
    assertRejected(valid.subarray(0, length));
  }
  assertRejected(Buffer.from('not a zip'));
  assertRejected(Buffer.concat([valid, Uint8Array.of(0)]));
  const central = valid.readUInt32LE(valid.length - 6);
  const variants = [
    bytes => bytes.writeUInt32LE(0, 0),
    bytes => bytes.writeUInt32LE(0, central),
    bytes => bytes.writeUInt32LE(1, central + 42),
    bytes => bytes.writeUInt16LE(0xffff, central + 28),
    bytes => bytes.writeUInt16LE(1, central + 34),
    bytes => bytes.writeUInt16LE(1, bytes.length - 18),
    bytes => bytes.writeUInt16LE(2, bytes.length - 12),
    bytes => bytes.writeUInt32LE(1, bytes.length - 10),
    bytes => { bytes[30] ^= 1; },
    bytes => bytes.writeUInt16LE(0x0801, 6),
    bytes => { bytes.writeUInt16LE(99, 8); bytes.writeUInt16LE(99, central + 10); }
  ];
  for (const mutate of variants) {
    const bytes = Buffer.from(valid);
    mutate(bytes);
    assertRejected(bytes);
  }
  assert.throws(() => readBundle('not bytes'), /archive must be bytes/);
  assert.throws(() => writeBundle([['file', 'not bytes']]), /member content must be bytes/);
});

test('actual byte counts and CRC reject deceptive declarations and corrupted data', () => {
  const data = payload(new Uint8Array(64 * 1024));
  assertRejected(archive([{ name: 'small', data, declaredSize: 1 }]), /actual member size/);
  assertRejected(archive([{ name: 'large', data, declaredSize: data.size + 1 }]), /size or checksum/);
  const stored = archive([{ name: 'file', data: payload(Uint8Array.of(1, 2, 3), 0) }]);
  stored[34] ^= 0xff;
  assertRejected(stored, /checksum/);
  const truncated = { ...data, compressed: data.compressed.subarray(0, data.compressed.length - 2) };
  assertRejected(archive([{ name: 'truncated-deflate', data: truncated }]));
  const directory = archive([{ name: 'dir/', data: payload(Uint8Array.of(1)) }]);
  assertRejected(directory, /nonempty directory/);
  assert.throws(() => writeBundle([['dir/', Uint8Array.of(1)]]), /invalid member size/);
});

test('compressed archive and member-count limits apply to reads and writes', () => {
  assertRejected(new Uint8Array(20 * MiB + 1), /compressed archive exceeds/);
  const files = Array.from({ length: 2000 }, (_, index) => [`member-${index}`, empty]);
  const valid = writeBundle(files);
  assert.equal(readBundle(valid).size, 2000);
  assertRejected(archive([...files, ['overflow', empty]].map(([name]) => ({ name, data: payload() }))), /oversized central directory/);
  assert.throws(() => writeBundle([...files, ['overflow', empty]]), /more than 2000 members/);
  // Two incompressible, individually legal members must stop the writer at
  // the compressed archive budget, rather than assembling a larger ZIP first.
  const random = randomBytes(11 * MiB);
  assert.throws(() => writeBundle([['one', random], ['two', random]]), /compressed archive exceeds|unable to write archive/);
});

test('zip bombs are stopped using actual expanded output, not declared sizes', () => {
  const oversized = new Uint8Array(20 * MiB + 1);
  const data = payload(oversized);
  assertRejected(archive([{ name: 'bomb', data, declaredSize: 20 * MiB }]), /actual expanded byte limit/);
  assertRejected(archive([{ name: 'oversized', data }]), /oversized member/);
  assert.throws(() => writeBundle([['oversized', oversized]]), /invalid member size/);
});

test('20 MiB member boundary is accepted and 100 MiB aggregate output is enforced', () => {
  const bytes = new Uint8Array(20 * MiB);
  const data = payload(bytes);
  const files = readBundle(archive([{ name: 'boundary', data }]));
  assert.deepEqual(files.get('boundary'), bytes);
  const writerResult = readBundle(writeBundle([['boundary', bytes]]));
  assert.deepEqual(writerResult.get('boundary'), bytes);
  const entries = Array.from({ length: 6 }, (_, index) => ({ name: `member-${index}`, data }));
  assertRejected(archive(entries), /actual expanded byte limit/);
  assert.throws(() => writeBundle(entries.map(({ name }) => [name, bytes])), /actual expanded byte limit/);
});
