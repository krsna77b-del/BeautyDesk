// Match migrated and new accounts with identical JS normalization, without rewriting records.
// Never choose an arbitrary account when legacy emails normalize to the same value.
const initialized = new WeakSet();
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
function findClientsByEmail(db, value) {
  const email = normalizeEmail(value);
  if (!email) return [];
  if (!initialized.has(db)) {
    db.function('beautydesk_login_email', { deterministic: true }, normalizeEmail);
    initialized.add(db);
  }
  return db.prepare('SELECT * FROM clients WHERE beautydesk_login_email(email)=? LIMIT 2').all(email);
}
module.exports = { normalizeEmail, findClientsByEmail };
