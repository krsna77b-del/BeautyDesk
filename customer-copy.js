// Versioned customer-message format. Values are opaque salon/customer facts unless
// explicitly wrapped as another message. Never translate by search-and-replace.
const catalog = require('./customer-copy.json');
class CustomerMessage {
  constructor(key, values = []) { this.version = 1; this.key = key; this.values = values; }
  toString() { return render(this, 'en'); }
}
function m(parts, ...values) {
  return new CustomerMessage(parts.reduce((s, part, i) => s + (i ? '{' + (i - 1) + '}' : '') + part, ''), values);
}
function s(text) { return new CustomerMessage(text); }
function join(values, separator = '\n') {
  return values.reduce((result, value, i) => i ? m`${result}${separator}${value}` : value, '');
}
function isMessage(value) {
  return !!value && value.version === 1 && typeof value.key === 'string' && Array.isArray(value.values);
}
function render(value, language = 'en', depth = 0) {
  if (depth > 40) throw Error('customer_copy_depth');
  if (!isMessage(value)) return String(value ?? '');
  const translated = language === 'en' ? value.key : catalog[value.key]?.[language];
  // Composition-only formats contain no language. They still keep facts opaque.
  const format = translated ?? (/^(?:\{\d+\}|\s|[.,:;()!?✨-])*$/.test(value.key) ? value.key : null);
  if (format == null) throw Error('customer_copy_missing_translation');
  const slots = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1])).sort((a,b) => a-b).join(',');
  if (slots(format) !== slots(value.key)) throw Error('customer_copy_invalid_placeholders');
  return format.replace(/\{(\d+)\}/g, (_, index) => render(value.values[Number(index)], language, depth + 1));
}
function finish(reply) {
  const messageFormat = isMessage(reply.text) ? reply.text : reply.messageFormat || null;
  return { ...reply, text: String(reply.text), ...(messageFormat ? { messageFormat } : {}) };
}
module.exports = { m, s, join, render, isMessage, finish };
