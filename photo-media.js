'use strict';
// In-memory only. Never log URLs, bearer tokens, response bodies or image bytes.
const { createHash, timingSafeEqual } = require('node:crypto');
const sharp = require('sharp');
const LIMITS = Object.freeze({ inputBytes: 5 * 1024 * 1024, outputBytes: 2 * 1024 * 1024,
  metadataBytes: 16384, pixels: 16000000, dimension: 8000, outputDimension: 1568,
  networkMs: 15000, decodeMs: 6000, decodeSeconds: 4 });
const GRAPH_VERSION = 'v23.0';
const MIME_TYPES = Object.freeze(['image/jpeg', 'image/png']);
class PhotoMediaError extends Error { constructor(code) { super(code); this.name = 'PhotoMediaError'; this.code = code; } }
const fail = code => { throw new PhotoMediaError(code); };
const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
function shaBytes(value) {
  if (typeof value !== 'string') fail('invalid_hash');
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const digest = Buffer.from(value, 'base64');
    if (digest.length === 32 && digest.toString('base64') === value) return digest;
  }
  fail('invalid_hash');
}
function trustedDownloadUrl(value, mediaId) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) fail('untrusted_media_url');
  let url;
  try { url = new URL(value); } catch { fail('untrusted_media_url'); }
  // Deliberately fail closed if Meta changes endpoints. No suffix/wildcard hosts.
  if (url.protocol !== 'https:' || url.hostname !== 'lookaside.fbsbx.com' || url.port || url.username || url.password
      || url.hash || url.pathname !== '/whatsapp_business/attachments/'
      || !value.startsWith('https://lookaside.fbsbx.com/whatsapp_business/attachments/?')) fail('untrusted_media_url');
  const params = [...url.searchParams.entries()];
  if (params.length !== 3 || new Set(params.map(([key]) => key)).size !== 3
      || params.some(([key]) => !['mid', 'ext', 'hash'].includes(key))
      || url.searchParams.get('mid') !== mediaId || !/^[0-9]{1,20}$/.test(url.searchParams.get('ext') || '')
      || !/^[A-Za-z0-9_-]{1,1024}$/.test(url.searchParams.get('hash') || '')) fail('untrusted_media_url');
  return url.href;
}
function contentType(response) { return String(response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase(); }
async function readBounded(response, maxBytes, signal) {
  const lengthHeader = response.headers?.get('content-length');
  if (lengthHeader !== null && lengthHeader !== undefined && (!/^[0-9]+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes)) {
    void response.body?.cancel().catch(() => {}); fail('too_large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('invalid_response');
  const reader = response.body.getReader(); const chunks = []; let length = 0; let done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) fail('media_timeout');
      const next = await reader.read();
      if (signal.aborted) fail('media_timeout');
      if (next.done) { done = true; break; }
      length += next.value.byteLength;
      if (length > maxBytes) fail('too_large');
      chunks.push(Buffer.from(next.value));
    }
    if (!length) fail('empty_media');
    if (lengthHeader != null && Number(lengthHeader) !== length) fail('size_mismatch');
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}
async function getBounded(fetchImpl, url, token, maxBytes, signal, expectedType) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, Accept: expectedType, 'Accept-Encoding': 'identity' }, signal });
  if (!response || response.redirected || (response.url && response.url !== url)) fail('unexpected_redirect');
  if (response.status !== 200) { void response.body?.cancel().catch(() => {}); fail('media_unavailable'); }
  const encoding = response.headers?.get('content-encoding');
  if (encoding && encoding !== 'identity') { void response.body?.cancel().catch(() => {}); fail('invalid_response'); }
  const type = contentType(response);
  if (type !== expectedType) { void response.body?.cancel().catch(() => {}); fail('unsupported_type'); }
  return readBounded(response, maxBytes, signal);
}
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function validateEnvelope(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > LIMITS.inputBytes) fail('too_large');
  if (!MIME_TYPES.includes(mimeType)) fail('unsupported_type');
  if (mimeType === 'image/jpeg') {
    if (buffer.length < 8 || !buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        || !buffer.subarray(-2).equals(Buffer.from([255, 217]))) fail('malformed_image');
    return;
  }
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('malformed_image');
  let offset = 8; let header = false; let data = false; let ended = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('malformed_image');
    const size = buffer.readUInt32BE(offset); const end = offset + 12 + size;
    if (end > buffer.length) fail('malformed_image');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) fail('malformed_image');
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('animated_image');
    if (!header && (type !== 'IHDR' || size !== 13)) fail('malformed_image');
    if (type === 'IHDR') { if (header) fail('malformed_image'); header = true; }
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { if (size || !data || end !== buffer.length) fail('malformed_image'); ended = true; }
    if (type[0] === type[0].toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) fail('malformed_image');
    offset = end;
  }
  if (!ended) fail('malformed_image');
}
async function normalizePhotoImage(buffer, mimeType) {
  validateEnvelope(buffer, mimeType);
  // Each decoder receives only a bounded buffer, never a filename/URL. Output metadata
  // is stripped by sharp's default; do not add withMetadata/keepMetadata here.
  const decoder = sharp(buffer, { failOn: 'warning', limitInputPixels: LIMITS.pixels, sequentialRead: true, animated: false });
  let timer; let output;
  try {
    const work = (async () => {
      const metadata = await decoder.metadata();
      if (metadata.format !== (mimeType === 'image/jpeg' ? 'jpeg' : 'png')) fail('unsupported_type');
      if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1
          || metadata.width > LIMITS.dimension || metadata.height > LIMITS.dimension || metadata.width * metadata.height > LIMITS.pixels) fail('dimensions_exceeded');
      if (metadata.pages > 1) fail('animated_image');
      const result = await decoder.rotate().flatten({ background: '#ffffff' })
        .resize({ width: LIMITS.outputDimension, height: LIMITS.outputDimension, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: false, chromaSubsampling: '4:2:0' }).timeout({ seconds: LIMITS.decodeSeconds }).toBuffer({ resolveWithObject: true });
      output = result.data;
      if (output.length > LIMITS.outputBytes) fail('too_large');
      return { buffer: output, mimeType: 'image/jpeg', width: result.info.width, height: result.info.height };
    })();
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { decoder.destroy(); reject(new PhotoMediaError('decode_timeout')); }, LIMITS.decodeMs); })]);
  } catch (error) {
    output?.fill(0);
    if (error instanceof PhotoMediaError) throw error;
    fail('malformed_image');
  } finally { clearTimeout(timer); decoder.destroy(); }
}
function createPhotoMedia({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a trusted function');
  return Object.freeze({ async retrieve({ mediaId, phoneNumberId, accessToken, expectedSha256 } = {}) {
    if (!numericId(mediaId) || !numericId(phoneNumberId)) fail('invalid_media_id');
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192 || /[\s\x00-\x1f\x7f]/.test(accessToken)) fail('media_not_configured');
    const expected = expectedSha256 === undefined ? null : shaBytes(expectedSha256);
    const controller = new AbortController(); let timer; let source; let metadataBuffer;
    const work = (async () => {
      const metadataUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?phone_number_id=${phoneNumberId}`;
      metadataBuffer = await getBounded(fetchImpl, metadataUrl, accessToken, LIMITS.metadataBytes, controller.signal, 'application/json');
      let metadata;
      try { metadata = JSON.parse(metadataBuffer.toString('utf8')); } catch { fail('invalid_metadata'); }
      if (!metadata || metadata.id !== mediaId || (metadata.messaging_product !== undefined && metadata.messaging_product !== 'whatsapp')
          || !Number.isSafeInteger(metadata.file_size) || metadata.file_size < 1) fail('invalid_metadata');
      if (metadata.file_size > LIMITS.inputBytes) fail('too_large');
      if (!MIME_TYPES.includes(metadata.mime_type)) fail('unsupported_type');
      const hash = shaBytes(metadata.sha256);
      if (expected && !timingSafeEqual(expected, hash)) fail('hash_mismatch');
      const downloadUrl = trustedDownloadUrl(metadata.url, mediaId);
      source = await getBounded(fetchImpl, downloadUrl, accessToken, LIMITS.inputBytes, controller.signal, metadata.mime_type);
      if (source.length !== metadata.file_size) fail('size_mismatch');
      if (!timingSafeEqual(createHash('sha256').update(source).digest(), hash)) fail('hash_mismatch');
      if (controller.signal.aborted) fail('media_timeout');
      const normalized = await normalizePhotoImage(source, metadata.mime_type);
      if (controller.signal.aborted) { normalized.buffer.fill(0); fail('media_timeout'); }
      return { ...normalized, sourceSha256: hash.toString('hex') };
    })();
    try {
      return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PhotoMediaError('media_timeout')); }, LIMITS.networkMs); })]);
    } catch (error) {
      controller.abort();
      if (error instanceof PhotoMediaError) throw error;
      fail('media_unavailable');
    } finally { clearTimeout(timer); source?.fill(0); metadataBuffer?.fill(0); }
  } });
}
module.exports = { createPhotoMedia, normalizePhotoImage, PhotoMediaError, LIMITS, MIME_TYPES, GRAPH_VERSION, trustedDownloadUrl };
