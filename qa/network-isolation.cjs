'use strict';
// Disposable test server only. Fail immediately on any non-loopback HTTP request.
const allowed = input => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('NONLOCAL_NETWORK_BLOCKED_IN_RECONSTRUCTION_TEST'); };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { allowed(input); return nativeFetch(input, options); };
for (const protocol of ['http', 'https']) {
  const module = require('node:' + protocol);
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (input, ...rest) {
      if (typeof input === 'string' || input instanceof URL) allowed(input);
      else { const host = input.hostname || input.host || 'localhost'; if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('NONLOCAL_NETWORK_BLOCKED_IN_RECONSTRUCTION_TEST'); }
      return original.call(this, input, ...rest);
    };
  }
}
