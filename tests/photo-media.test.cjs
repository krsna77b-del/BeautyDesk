'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { createPhotoMedia, normalizePhotoImage, PhotoMediaError, LIMITS, GRAPH_VERSION, trustedDownloadUrl } = require('../photo-media');
const mediaId = '123456789', phoneNumberId = '987654321';
const downloadUrl = `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}&ext=9999999999&hash=fake_safe_hash`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let png, jpeg;
before(async () => {
  png = await sharp({ create: { width: 16, height: 12, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  jpeg = await sharp({ create: { width: 18, height: 12, channels: 3, background: '#999' } }).jpeg().withExif({ IFD0: { Artist: 'PRIVATE CAMERA OWNER', ImageDescription: 'PRIVATE IMAGE METADATA' } }).toBuffer();
});
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof PhotoMediaError && error.code === code && error.message === code);
function fixture({ bytes = png, type = 'image/png', metadata = {}, getResponse, downloadResponse } = {}) {
  const calls = [];
  const meta = { id: mediaId, messaging_product: 'whatsapp', file_size: bytes.length, mime_type: type, sha256: sha(bytes), url: downloadUrl, ...metadata };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return getResponse ? getResponse(meta) : new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
    if (calls.length === 2) return downloadResponse ? downloadResponse(bytes) : new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
    throw Error('Unexpected request; external network is disabled in this fixture');
  };
  return { calls, media: createPhotoMedia({ fetchImpl }), args: { mediaId, phoneNumberId, accessToken: 'FAKE_LOCAL_META_TOKEN', expectedSha256: sha(bytes) } };
}
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const buffer = Buffer.alloc(body.length + 12); buffer.writeUInt32BE(body.length, 0); buffer.write(type, 4, 4, 'ascii'); body.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4); return buffer;
}

test('exact Meta download URL is allowed; off-origin, redirect and ambiguous URLs are rejected', () => {
  assert.equal(trustedDownloadUrl(downloadUrl, mediaId), downloadUrl);
  const invalid = [undefined, '', 'http:' + downloadUrl.slice(6), downloadUrl.replace('lookaside.fbsbx.com', 'evil.example'),
    downloadUrl.replace('lookaside.fbsbx.com', 'lookaside.fbsbx.com.evil.example'), downloadUrl.replace('lookaside.fbsbx.com', 'user:password@lookaside.fbsbx.com'),
    downloadUrl.replace('lookaside.fbsbx.com', 'lookaside.fbsbx.com:444'), downloadUrl + '#fragment', downloadUrl + '&redirect=https://evil.example',
    downloadUrl + '&mid=' + mediaId, downloadUrl.replace(mediaId, '111'), downloadUrl.replace('ext=9999999999', 'ext=oops'),
    downloadUrl.replace('hash=fake_safe_hash', 'hash=a%2Fb'), downloadUrl.replace('/attachments/', '/attachments/../attachments/'),
    downloadUrl.replace('/attachments/', '/attachments'), downloadUrl.replace('https://', 'https:\\'), downloadUrl + ' ', 'https://127.0.0.1/private'];
  for (const value of invalid) assert.throws(() => trustedDownloadUrl(value, mediaId), error => error instanceof PhotoMediaError && error.code === 'untrusted_media_url');
});
test('JPEG normalization strips camera metadata without enlarging', async () => {
  assert.ok((await sharp(jpeg).metadata()).exif);
  const result = await normalizePhotoImage(jpeg, 'image/jpeg'); const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.mimeType, 'image/jpeg'); assert.equal(result.width, 18); assert.equal(result.height, 12);
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined);
  assert.ok(result.buffer.length <= LIMITS.outputBytes); assert.doesNotMatch(result.buffer.toString('latin1'), /PRIVATE/);
});
test('PNG normalization flattens transparency onto white and converts to JPEG', async () => {
  const result = await normalizePhotoImage(png, 'image/png'); const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.width, 16); assert.equal(result.height, 12); assert.equal(result.mimeType, 'image/jpeg'); assert.equal(info.channels, 3);
  assert.ok(data.every(channel => channel >= 250));
});
test('large but allowed images are resized to a bounded aspect ratio', async () => {
  const bytes = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#aaf' } }).png().toBuffer();
  const result = await normalizePhotoImage(bytes, 'image/png');
  assert.equal(result.width, LIMITS.outputDimension); assert.equal(result.height, LIMITS.outputDimension / 2);
});
test('empty, oversized, MIME-mismatched and truncated images fail closed', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(LIMITS.inputBytes + 1)]) await rejectsCode(normalizePhotoImage(bytes, 'image/jpeg'), 'too_large');
  await rejectsCode(normalizePhotoImage(png, 'image/gif'), 'unsupported_type');
  for (const [bytes, type] of [[png, 'image/jpeg'], [jpeg, 'image/png'], [png.subarray(0, -1), 'image/png'], [jpeg.subarray(0, -2), 'image/jpeg'],
    [Buffer.concat([png, Buffer.from('injected trailing bytes')]), 'image/png'], [Buffer.from([255, 216, 255, 0, 0, 0, 255, 217]), 'image/jpeg']]) {
    await rejectsCode(normalizePhotoImage(bytes, type), 'malformed_image');
  }
});
test('PNG CRC corruption, unknown critical chunks and animation chunks are rejected', async () => {
  const corrupt = Buffer.from(png); corrupt[29] ^= 1;
  await rejectsCode(normalizePhotoImage(corrupt, 'image/png'), 'malformed_image');
  const unknownCritical = Buffer.concat([png.subarray(0, 33), chunk('ZZZZ', Buffer.alloc(0)), png.subarray(33)]);
  await rejectsCode(normalizePhotoImage(unknownCritical, 'image/png'), 'malformed_image');
  for (const type of ['acTL', 'fcTL', 'fdAT']) {
    const animated = Buffer.concat([png.subarray(0, 33), chunk(type, Buffer.alloc(8)), png.subarray(33)]);
    await rejectsCode(normalizePhotoImage(animated, 'image/png'), 'animated_image');
  }
});
test('dimension and pixel bombs are rejected before output', async () => {
  const tooWide = await sharp({ create: { width: LIMITS.dimension + 1, height: 1, channels: 3, background: '#aaf' } }).png().toBuffer();
  await rejectsCode(normalizePhotoImage(tooWide, 'image/png'), 'dimensions_exceeded');
  const tooManyPixels = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: '#aaf' } }).png().toBuffer();
  await assert.rejects(normalizePhotoImage(tooManyPixels, 'image/png'), PhotoMediaError);
});
test('retrieval scopes metadata to salon phone, authenticates exact hosts, verifies hash, and normalizes in memory', async () => {
  const { media, args, calls } = fixture(); const result = await media.retrieve(args);
  assert.equal(result.mimeType, 'image/jpeg'); assert.equal(result.sourceSha256, sha(png)); assert.equal(result.width, 16);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?phone_number_id=${phoneNumberId}`);
  assert.equal(calls[1].url, downloadUrl);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer FAKE_LOCAL_META_TOKEN'); assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.ok(options.signal instanceof AbortSignal);
  }
});
test('canonical base64 and hexadecimal hashes are accepted and mismatched inbound hashes block download', async () => {
  const hashBase64 = createHash('sha256').update(png).digest('base64'); const good = fixture({ metadata: { sha256: hashBase64 } });
  assert.equal((await good.media.retrieve({ ...good.args, expectedSha256: hashBase64 })).sourceSha256, sha(png));
  const bad = fixture(); await rejectsCode(bad.media.retrieve({ ...bad.args, expectedSha256: '0'.repeat(64) }), 'hash_mismatch'); assert.equal(bad.calls.length, 1);
  const invalid = fixture(); await rejectsCode(invalid.media.retrieve({ ...invalid.args, expectedSha256: 'not-a-hash' }), 'invalid_hash'); assert.equal(invalid.calls.length, 0);
});
test('invalid IDs and bearer token input cause no network calls', async () => {
  for (const change of [{ mediaId: '../etc' }, { mediaId: '0' }, { mediaId: 123 }, { phoneNumberId: '' }, { phoneNumberId: '1?x=2' }]) {
    const f = fixture(); await rejectsCode(f.media.retrieve({ ...f.args, ...change }), 'invalid_media_id'); assert.equal(f.calls.length, 0);
  }
  for (const accessToken of ['', 'token\nX-Header: injected', 'a'.repeat(8193)]) {
    const f = fixture(); await rejectsCode(f.media.retrieve({ ...f.args, accessToken }), 'media_not_configured'); assert.equal(f.calls.length, 0);
  }
});
test('foreign metadata, unsupported media and metadata sizes are rejected before downloading', async () => {
  for (const [metadata, code] of [[{ id: 'different' }, 'invalid_metadata'], [{ messaging_product: 'messenger' }, 'invalid_metadata'],
    [{ file_size: 0 }, 'invalid_metadata'], [{ file_size: 1.5 }, 'invalid_metadata'], [{ file_size: LIMITS.inputBytes + 1 }, 'too_large'],
    [{ mime_type: 'image/svg+xml' }, 'unsupported_type'], [{ sha256: 'bad' }, 'invalid_hash'], [{ url: 'https://evil.example/photo.jpg' }, 'untrusted_media_url']]) {
    const f = fixture({ metadata }); await rejectsCode(f.media.retrieve(f.args), code); assert.equal(f.calls.length, 1);
  }
});
test('untrusted metadata JSON and oversized metadata responses fail safely', async () => {
  const invalid = fixture({ getResponse: () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }) });
  await rejectsCode(invalid.media.retrieve(invalid.args), 'invalid_metadata');
  for (const length of [String(LIMITS.metadataBytes + 1), '-1', 'invalid']) {
    const f = fixture({ getResponse: meta => new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json', 'content-length': length } }) });
    await rejectsCode(f.media.retrieve(f.args), 'too_large'); assert.equal(f.calls.length, 1);
  }
  const oversized = fixture({ getResponse: () => new Response('x'.repeat(LIMITS.metadataBytes + 1), { headers: { 'content-type': 'application/json' } }) });
  await rejectsCode(oversized.media.retrieve(oversized.args), 'too_large');
});
test('wrong status, content type, compression, redirect and returned URL are rejected', async () => {
  for (const [makeResponse, code] of [
    [() => new Response('denied', { status: 403 }), 'media_unavailable'],
    [() => new Response('text', { headers: { 'content-type': 'text/html' } }), 'unsupported_type'],
    [meta => new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), 'invalid_response'],
  ]) {
    const f = fixture({ getResponse: makeResponse }); await rejectsCode(f.media.retrieve(f.args), code); assert.equal(f.calls.length, 1);
  }
  for (const property of ['redirected', 'url']) {
    const f = fixture({ getResponse: meta => { const response = new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }); Object.defineProperty(response, property, { value: property === 'url' ? 'https://evil.example' : true }); return response; } });
    await rejectsCode(f.media.retrieve(f.args), 'unexpected_redirect'); assert.equal(f.calls.length, 1);
  }
});
test('download length, hash and streaming byte limits are enforced', async () => {
  const hashMismatch = fixture({ downloadResponse: bytes => { const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1; return new Response(corrupt, { headers: { 'content-type': 'image/png' } }); } });
  await rejectsCode(hashMismatch.media.retrieve(hashMismatch.args), 'hash_mismatch');
  const sizeMismatch = fixture({ metadata: { file_size: png.length + 1 } }); await rejectsCode(sizeMismatch.media.retrieve(sizeMismatch.args), 'size_mismatch');
  const headerMismatch = fixture({ downloadResponse: bytes => new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length + 1) } }) });
  await rejectsCode(headerMismatch.media.retrieve(headerMismatch.args), 'size_mismatch');
  const oversized = fixture({ downloadResponse: () => new Response(Buffer.alloc(LIMITS.inputBytes + 1), { headers: { 'content-type': 'image/png' } }) });
  await rejectsCode(oversized.media.retrieve(oversized.args), 'too_large');
  const empty = fixture({ downloadResponse: () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }) });
  await rejectsCode(empty.media.retrieve(empty.args), 'empty_media');
});
test('transport errors never expose URL, token or provider response text', async () => {
  let calls = 0; const media = createPhotoMedia({ fetchImpl: async () => { calls++; throw Error('secret token FAKE_LOCAL_META_TOKEN https://private-photo-url'); } });
  await rejectsCode(media.retrieve({ mediaId, phoneNumberId, accessToken: 'FAKE_LOCAL_META_TOKEN' }), 'media_unavailable'); assert.equal(calls, 1);
});
test('hung transport is bounded and aborted without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal, calls = 0;
  const media = createPhotoMedia({ fetchImpl: async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  const pending = media.retrieve({ mediaId, phoneNumberId, accessToken: 'FAKE_LOCAL_META_TOKEN' });
  const rejection = rejectsCode(pending, 'media_timeout'); t.mock.timers.tick(LIMITS.networkMs); await rejection;
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
});
