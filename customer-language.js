const db = require('./db');
const ai = require('./ai');
const copy = require('./customer-copy');
const LANGUAGES = Object.freeze(['en', 'zu', 'af', 'xh']);
const CHOICES = { '1':'en', english:'en', en:'en', '2':'zu', isizulu:'zu', zulu:'zu', zu:'zu', '3':'af', afrikaans:'af', af:'af', '4':'xh', isixhosa:'xh', xhosa:'xh', xh:'xh' };
const MENU = 'Choose your language / Khetha ulimi / Kies jou taal / Khetha ulwimi:\n1. English\n2. isiZulu\n3. Afrikaans\n4. isiXhosa\nReply 1–4 / Phendula 1–4 / Antwoord 1–4.\nChange anytime: LANGUAGE / ulimi / taal / ulwimi.';
const ALIASES = {
  zu: { yebo:'YES', cha:'NO', bhukha:'book', 'izinsizakalo':'services', 'amanani':'prices', 'amahora':'hours', 'ukubhukha kwami':'my appointment', 'xhumana nesaluni':'contact salon', kusasa:'tomorrow', namuhla:'today', umsombuluko:'monday', ulwesibili:'tuesday', ulwesithathu:'wednesday', ulwesine:'thursday', ulwesihlanu:'friday', umgqibelo:'saturday', isonto:'sunday', 'nakanjani':'any', 'ukubhukha okusha':'new booking', khansela:'cancel' },
  af: { ja:'YES', nee:'NO', bespreek:'book', 'bespreek afspraak':'book appointment', dienste:'services', pryse:'prices', openingstye:'hours', 'my afspraak':'my appointment', 'kontak salon':'contact salon', môre:'tomorrow', vandag:'today', maandag:'monday', dinsdag:'tuesday', woensdag:'wednesday', donderdag:'thursday', vrydag:'friday', saterdag:'saturday', sondag:'sunday', enige:'any', 'nuwe bespreking':'new booking', kanselleer:'cancel' },
  xh: { ewe:'YES', hayi:'NO', bhukisha:'book', iinkonzo:'services', amaxabiso:'prices', iiyure:'hours', 'ubhukisho lwam':'my appointment', 'qhagamshelana nesaluni':'contact salon', ngomso:'tomorrow', namhlanje:'today', umvulo:'monday', ulwesibini:'tuesday', ulwesithathu:'wednesday', ulwesine:'thursday', ulwesihlanu:'friday', umgqibelo:'saturday', icawe:'sunday', 'nawuphi na':'any', 'ubhukisho olutsha':'new booking', rhoxisa:'cancel' }
};
function normalizeInput(value, language, services = []) {
  const raw = String(value || '');
  // A salon's literal service name always wins over a command/date alias.
  if (services.some(service => service.name.toLowerCase() === raw.trim().toLowerCase())) return raw;
  return ALIASES[language]?.[raw.trim().replace(/[.!]+$/, '').toLowerCase()] || raw;
}
function canonicalHistory(history = []) {
  return history.filter(row => !row.language_control || row.direction === 'in').map(row => {
    let messageFormat = row.messageFormat;
    if (!messageFormat && row.message_format_json) messageFormat = JSON.parse(row.message_format_json);
    return { ...row, body: row.language_control ? '[Language control]' : row.canonical_body ?? row.body, ...(messageFormat ? { messageFormat } : {}) };
  });
}
function display(result, language) {
  if (!result.messageFormat) {
    if (language !== 'en') throw Error('customer_copy_format_required');
    return { ...result, canonicalText: result.text, language };
  }
  const text = copy.render(result.messageFormat, language);
  if (text.length > 4096) throw Error('customer_copy_too_long');
  return { ...result, text, canonicalText: result.text, language };
}
async function generateReply(input) {
  const history = canonicalHistory(input.history);
  const context = { ...input, history };
  // Owner simulator remains read-only and in its existing language.
  if (input.dryRun || input.customerPhone === 'simulator' || process.env.WHATSAPP_CUSTOMER_LANGUAGES !== '1') {
    return ai.generateReply(context);
  }
  const phone = String(input.customerPhone || '').replace(/^\+/, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) throw Error('language_sender_required');
  // Preferences exist before the modular CRM customer is created, including
  // legacy salons. Never derive a tenant from customer input.
  let preference = db.prepare('SELECT * FROM whatsapp_customer_languages WHERE client_id=? AND customer_phone=?').get(input.client.id, phone);
  const language = preference?.language || 'en';
  const incoming = normalizeInput(input.incomingMessage, language, input.services);
  const command = String(incoming).trim().replace(/[.!]+$/, '').toLowerCase();
  const at = new Date(input.messageAt || input.now || new Date()).getTime();
  if (!Number.isFinite(at)) throw Error('language_timestamp_required');
  const tagControl = () => db.prepare("UPDATE messages SET language_control=1 WHERE client_id=? AND customer_phone=? AND direction='in' AND wa_message_id=?").run(input.client.id, input.customerPhone, input.incomingMessageId);
  const menu = () => ({ text:MENU, canonicalText:'', mode:'language', languageControl:true, language });
  const normalizedContext = { ...context, incomingMessage: incoming, customerLanguage: language };
  // These controls must never be swallowed by onboarding or an open menu.
  if (/^(stop|stop reminders|unsubscribe|start reminders)$/.test(command)) {
    return display(await ai.generateReply(normalizedContext), language);
  }
  const switchMatch = /^(?:\/?language|ulimi|taal|ulwimi)(?:\s+(.+))?$/.exec(command);
  if (preference && at < preference.updated_at_ms) { tagControl(); return menu(); }
  if (switchMatch || !preference?.language || preference.choosing) {
    const choice = CHOICES[switchMatch?.[1] || (preference?.choosing ? command : '')];
    if (!choice) {
      // Preserve a first substantive request as booking history, but never
      // interpret a first number/YES as a service selection or consent.
      if (preference || switchMatch || /^(?:[1-9]\d*|yes|no|confirm|ok)$/.test(command) || input.incomingType === 'image') tagControl();
      db.prepare(`INSERT INTO whatsapp_customer_languages(client_id,customer_phone,language,choosing,updated_at_ms)
        VALUES (?,?,NULL,1,?) ON CONFLICT(client_id,customer_phone)
        DO UPDATE SET choosing=1,updated_at_ms=excluded.updated_at_ms`).run(input.client.id,phone,at);
      return menu();
    }
    tagControl();
    // A selector response is never sent to the booking/consent parser.
    // Rebuild a fresh prompt from canonical history and require a subsequent
    // accepted reply context and later explicit confirmation as before.
    const result = await ai.generateReply({ ...context, incomingMessage:'', incomingType:'text', customerLanguage:choice });
    const output = display(result, choice);
    db.prepare(`INSERT INTO whatsapp_customer_languages(client_id,customer_phone,language,choosing,updated_at_ms)
      VALUES (?,?,?,0,?) ON CONFLICT(client_id,customer_phone)
      DO UPDATE SET language=excluded.language,choosing=0,updated_at_ms=excluded.updated_at_ms`).run(input.client.id,phone,choice,at);
    return output;
  }
  if (incoming !== input.incomingMessage) {
    // Store only normalized commands, never a second copy of photo style details.
    db.prepare("UPDATE messages SET canonical_body=? WHERE client_id=? AND customer_phone=? AND direction='in' AND wa_message_id=?").run(incoming,input.client.id,input.customerPhone,input.incomingMessageId);
  }
  return display(await ai.generateReply(normalizedContext), language);
}
module.exports = { generateReply, canonicalHistory, normalizeInput, LANGUAGES, MENU };
