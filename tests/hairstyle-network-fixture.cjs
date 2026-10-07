'use strict';
// Offline process preload only. Never imported by production application code.
require('./network-mocks.cjs');
const sharp = require('sharp');
const { PreviewProviderError, allowedStyles } = require('../hairstyle-google');
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  const abort = () => { clearTimeout(timer); reject(new PreviewProviderError('preview_interrupted')); };
  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, { once: true });
});
require('../hairstyle-google').createGooglePreview = () => ({
  async suggest({ image, preferences, beforeSend, signal }) {
    beforeSend();
    if (!Buffer.isBuffer(image.buffer)) throw Error('Synthetic source missing');
    await pause(Number(process.env.TEST_PREVIEW_DELAY_MS || 5), signal);
    if (process.env.TEST_PREVIEW_FAILURE === 'analysis') throw new PreviewProviderError('preview_provider_access');
    if (process.env.TEST_PREVIEW_FAILURE === 'suggestions') return [{ id: 'untrusted' }];
    return allowedStyles(preferences).slice(0, 3);
  },
  async generate({ image, styleId, beforeSend, signal }) {
    beforeSend();
    if (!image.buffer.some(byte => byte !== 0)) throw Error('Original image cleared too soon');
    await pause(Number(process.env.TEST_PREVIEW_DELAY_MS || 5), signal);
    if (process.env.TEST_PREVIEW_FAILURE === 'edit') throw new PreviewProviderError('preview_timeout');
    const buffer = await sharp({ create: { width: 80, height: 80, channels: 3, background: styleId === 'soft-waves' ? '#ddbbbb' : '#bbccdd' } }).jpeg().toBuffer();
    return { buffer, mimeType: 'image/jpeg' };
  },
});
