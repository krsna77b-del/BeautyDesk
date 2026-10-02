// Deterministic, consent-first photo workflow. Images never enter chat history.
const crypto = require('node:crypto');
const db = require('./db');
const TTL_MS = 30 * 60 * 1000;
const CONSULT = 'I can’t safely estimate this from the photo. Please contact the salon directly for a consultation and a confirmed quote. No appointment has been made.';
const DISABLED = 'Photo estimates are not enabled for this salon yet. Please describe the look you want or send Bookings to choose from the salon’s menu. You can also contact the salon directly for a consultation.';
const CANCEL = /^(?:cancel|stop|no|no thanks|decline)[.!\s]*$/i;
const CONSENT = /^I AGREE[.!\s]*$/i;
const CATEGORIES = ['hair', 'nails', 'beauty'];
const iso = now => new Date(now).toISOString();
function eligibleServices(clientId, services) {
  return services.filter(s => s.client_id === clientId && s.photo_eligible === 1 && CATEGORIES.includes(s.photo_category)
    && typeof s.photo_description === 'string' && s.photo_description.trim().length >= 10 && s.photo_description.length <= 400
    && typeof s.name === 'string' && s.name.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(s.name)
    && Number.isInteger(s.price) && s.price >= 0 && s.price <= 100000 && Number.isInteger(s.duration_mins) && s.duration_mins >= 5 && s.duration_mins <= 720);
}
function snapshot(s) { return { id:s.id, name:s.name, price:s.price, duration_mins:s.duration_mins, photo_category:s.photo_category, photo_description:s.photo_description }; }
function fingerprint(services) { return JSON.stringify(services.map(snapshot).sort((a,b)=>a.id.localeCompare(b.id))); }
function photoStatus(env = process.env) {
  const base = require('./photo-vision').photoVisionStatus(env);
  if (!base.ready) return base;
  try {
    const url = new URL(env.PHOTO_PRIVACY_URL || '');
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hash) throw Error();
  } catch { return { ready:false, reason:'photo_privacy_notice_required' }; }
  return { ready:true, reason:'configured_not_live_verified' };
}
function cleanup(now = new Date()) {
  const cutoff = iso(now);
  db.prepare('DELETE FROM photo_uploads WHERE expires_at<=?').run(cutoff);
  db.prepare('DELETE FROM photo_sessions WHERE expires_at<=?').run(cutoff);
}
function end(session) {
  db.prepare('DELETE FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').run(session.client_id,session.customer_phone,session.source_message_id);
  db.prepare('DELETE FROM photo_sessions WHERE id=? AND client_id=?').run(session.id,session.client_id);
}
function bindReply(sessionId, clientId, phone, outgoingId) {
  if (sessionId) db.prepare('UPDATE photo_sessions SET reply_id=? WHERE id=? AND client_id=? AND customer_phone=?').run(outgoingId,sessionId,clientId,phone);
}
function freshReply(session, input) {
  const reply = db.prepare("SELECT id,accepted_at,delivery_status FROM messages WHERE id=? AND client_id=? AND customer_phone=? AND direction='out'").get(session.reply_id,input.client.id,input.customerPhone);
  const accepted = Date.parse(reply?.accepted_at), sent = new Date(input.messageAt).getTime(), received = new Date(input.receivedAt).getTime();
  return !!reply && input.confirmationMessageId === reply.id && ['accepted','sent','delivered','read'].includes(reply.delivery_status)
    && Number.isFinite(accepted) && Number.isFinite(sent) && Number.isFinite(received) && received >= accepted && Math.floor(sent/1000) > Math.floor(accepted/1000);
}
function consentText() {
  return `Before analysing: with your permission I’ll send this photo and the style details you provide to Anthropic for automated service matching. Only share a reference or your own photo that you have permission to use, without other people or private health information. BeautyDesk does not save the image file; its temporary reference expires after 30 minutes. Anthropic’s processing and retention are explained in the salon’s privacy notice: ${process.env.PHOTO_PRIVACY_URL}. Reply I AGREE to continue, or NO to use text booking. This does not book an appointment.`;
}
function prompt(session) {
  if (session.stage === 'consent') return consentText();
  if (session.stage === 'role') return 'Is this a REFERENCE photo of the look you want, or a CURRENT photo of your own hair, nails or style? Reply REFERENCE or CURRENT. Please use one clear photo without unrelated people.';
  if (session.stage === 'details') return 'In one message, describe your desired result and your current length and condition, including existing colour, extensions, gel or other product where relevant. Don’t include private health information. Say CONSULTATION if you’re unsure. A photo cannot establish condition, treatment suitability or a guaranteed outcome.';
  if (session.stage === 'choose') return estimateText(JSON.parse(session.candidates_json));
  return 'Please continue your booking or reply CANCEL to stop this request.';
}
function estimateText(candidates) {
  return `Photo-based menu estimate, subject to the salon checking your hair/nails and the work required:\n${candidates.map((s,i)=>`${i+1}. ${s.name}: estimated R${s.price}, ${s.duration_mins} min. Includes: ${s.photo_description}`).join('\n')}\nThese are possible matches from this salon’s approved menu. A photo cannot guarantee the result or final cost. Extra work or add-ons are not included unless listed; contact the salon for those. Reply BOOK 1${candidates.length > 1 ? ` (or BOOK 2${candidates.length > 2 ? '/BOOK 3' : ''})` : ''} to choose a service and continue to available times, or CONSULTATION. Nothing is booked yet.`;
}
function createPhotoFlow(deps = {}) {
  const status = deps.status || photoStatus;
  const retrieve = deps.retrieve || (args => require('./photo-media').createPhotoMedia().retrieve(args));
  const analyze = deps.analyze || ((image,catalog,context) => require('./photo-vision').createPhotoVision({env:process.env}).analyze(image,catalog,context));
  async function handle(input) {
    const now = input.now || new Date(), text = String(input.incomingMessage || '').trim();
    cleanup(now);
    let session = db.prepare('SELECT * FROM photo_sessions WHERE client_id=? AND customer_phone=?').get(input.client.id,input.customerPhone);
    const tag = s => db.prepare('UPDATE messages SET photo_session_id=? WHERE client_id=? AND customer_phone=? AND direction=\'in\' AND wa_message_id=?').run(s.id,input.client.id,input.customerPhone,input.incomingMessageId);
    const answer = (s,message) => ({text:message, mode:'photo_guided', photoSessionId:s?.id || null});
    const activeClient = () => db.prepare('SELECT * FROM clients WHERE id=?').get(input.client.id);
    const catalog = () => eligibleServices(input.client.id,db.prepare('SELECT * FROM services WHERE client_id=?').all(input.client.id));
    if (input.incomingType === 'image') {
      if (input.bookingNeedsReview || (input.latestBooking && !input.allowAdditionalBooking)) {
        db.prepare('DELETE FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').run(input.client.id,input.customerPhone,input.incomingMessageId);
        if (session) end(session);
        return answer(null,'Your existing appointment is unchanged. Please contact the salon to change it. For a separate appointment, say new booking before sending a photo.');
      }
      if (!activeClient()?.photo_estimates_enabled || !status().ready || !catalog().length) {
        db.prepare('DELETE FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').run(input.client.id,input.customerPhone,input.incomingMessageId);
        if (session) end(session);
        return answer(null,DISABLED);
      }
      const upload = db.prepare('SELECT * FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').get(input.client.id,input.customerPhone,input.incomingMessageId);
      if (session) {
        const source = db.prepare("SELECT created_at FROM messages WHERE client_id=? AND customer_phone=? AND direction='in' AND wa_message_id=?").get(input.client.id,input.customerPhone,session.source_message_id);
        if (!upload || !Number.isFinite(Date.parse(source?.created_at)) || new Date(input.messageAt).getTime() <= Date.parse(source.created_at)) {
          db.prepare('DELETE FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=? AND incoming_id<>?').run(input.client.id,input.customerPhone,input.incomingMessageId,session.source_message_id);
          tag(session);
          return answer(session,`That older or unavailable photo has not replaced your current request.\n${prompt(session)}`);
        }
        end(session);
      }
      if (!upload) return answer(null,'This photo is unavailable or unsupported. Please send one clear JPEG or PNG photo, or contact the salon for a consultation.');
      session = {id:crypto.randomUUID(),client_id:input.client.id,customer_phone:input.customerPhone,source_message_id:input.incomingMessageId,stage:'consent',expires_at:upload.expires_at};
      db.prepare('INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at) VALUES (@id,@client_id,@customer_phone,@source_message_id,@stage,@expires_at)').run(session);
      tag(session);
      return answer(session,prompt(session));
    }
    if (!session) {
      const previous = (input.history || []).at(-1);
      if (previous?.photo_session_id && !/^(?:bookings?|new booking|another booking)[.!\s]*$/i.test(text)) {
        const marker = {id:previous.photo_session_id};
        tag(marker);
        db.prepare("UPDATE messages SET body='[Expired photo reply removed]' WHERE client_id=? AND customer_phone=? AND wa_message_id=? AND direction='in'").run(input.client.id,input.customerPhone,input.incomingMessageId);
        return answer(marker,'That photo request has ended or expired. Send a new photo for a fresh estimate, or send Bookings to start a text booking. Existing appointments are unchanged.');
      }
      return null;
    }
    tag(session);
    if (CANCEL.test(text) || /^consultation[.!\s]*$/i.test(text)) {
      end(session);
      return answer(session,CANCEL.test(text) ? "I've stopped this booking request and removed the temporary photo reference. Existing appointments are unchanged. Send Bookings to choose a service without a photo." : CONSULT);
    }
    if (input.bookingNeedsReview || (input.latestBooking && !input.allowAdditionalBooking)) {
      end(session); return answer(session,'Your existing appointment is unchanged. Please contact the salon before making any changes.');
    }
    if (!activeClient()?.photo_estimates_enabled || !status().ready) { end(session); return answer(session,DISABLED); }
    if (session.stage === 'booking') {
      const selected = JSON.parse(session.selected_json);
      const current = catalog().find(s=>s.id===selected.id);
      if (!current || JSON.stringify(snapshot(current)) !== JSON.stringify(selected)) {
        end(session); return answer(session,'The salon’s service details have changed since your estimate. Please send a new photo for a fresh estimate, or send Bookings to choose from the current menu. Nothing new has been booked.');
      }
      return { photoSelection:{ sessionId:session.id,service:current }, photoSessionId:session.id };
    }
    // Every stage requires a later response to its accepted prompt, not a batched
    // or delayed answer received before the relevant question was shown.
    if (!freshReply(session,input)) return answer(session,`Please read this message, wait two seconds, then reply.\n${prompt(session)}`);
    if (session.stage === 'consent') {
      if (!CONSENT.test(text)) return answer(session,prompt(session));
      db.prepare("UPDATE photo_sessions SET stage='role', consent_at=?, consent_message_id=? WHERE id=?").run(iso(now),input.incomingMessageId,session.id);
      session.stage='role'; return answer(session,prompt(session));
    }
    if (session.stage === 'role') {
      const role = /^(reference|current)[.!\s]*$/i.exec(text)?.[1]?.toLowerCase();
      if (!role) return answer(session,prompt(session));
      db.prepare("UPDATE photo_sessions SET stage='details', photo_role=? WHERE id=?").run(role,session.id);
      session.stage='details'; return answer(session,prompt(session));
    }
    if (session.stage === 'details') {
      if (text.length < 15 || text.length > 1000 || /[\p{Cc}\p{Cf}]/u.test(text)) return answer(session,prompt(session));
      const upload=db.prepare('SELECT * FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').get(input.client.id,input.customerPhone,session.source_message_id);
      if (!upload || !session.consent_at) { end(session); return answer(session,'The temporary photo reference expired. Please send a new photo, or contact the salon directly.'); }
      const services=catalog(), before=fingerprint(services), client=activeClient();
      if (!services.length) { end(session); return answer(session,CONSULT); }
      let image;
      // Persist analysis start before I/O. A process crash is quarantined by the
      // existing job recovery; another input can never replay a paid vision call.
      db.prepare("UPDATE photo_sessions SET stage='analysing' WHERE id=?").run(session.id);
      try {
        image=await retrieve({mediaId:upload.media_id,phoneNumberId:client.wa_phone_number_id,accessToken:client.wa_access_token,expectedSha256:upload.sha256 || undefined});
        const current=activeClient();
        if (!current?.photo_estimates_enabled || !current.whatsapp_enabled || current.wa_phone_number_id!==client.wa_phone_number_id || !status().ready || fingerprint(catalog())!==before || Date.parse(session.expires_at)<=Date.now() || !db.prepare('SELECT id FROM photo_sessions WHERE id=?').get(session.id)) throw Error('configuration_changed');
        const result=await analyze(image,services,{photoRole:session.photo_role,details:text});
        if (!activeClient()?.photo_estimates_enabled || !activeClient()?.whatsapp_enabled || activeClient()?.wa_phone_number_id!==client.wa_phone_number_id || !status().ready || fingerprint(catalog())!==before || Date.parse(session.expires_at)<=Date.now() || !db.prepare('SELECT id FROM photo_sessions WHERE id=?').get(session.id)) throw Error('configuration_changed');
        const ids=result.candidateServiceIds;
        if (!Number.isFinite(result.confidence) || result.confidence<0.8 || !Array.isArray(ids) || ids.length<1 || ids.length>3 || new Set(ids).size!==ids.length || !CATEGORIES.includes(result.category)) throw Error('uncertain');
        const candidates=ids.map(id=>services.find(s=>s.id===id && s.photo_category===result.category));
        if (candidates.some(s=>!s)) throw Error('invalid_candidate');
        const candidatesJson=JSON.stringify(candidates.map(snapshot));
        db.prepare("UPDATE photo_sessions SET stage='choose', candidates_json=? WHERE id=?").run(candidatesJson,session.id);
        session.stage='choose'; session.candidates_json=candidatesJson;
        return answer(session,prompt(session));
      } catch { end(session); return answer(session,CONSULT); }
      finally {
        if (Buffer.isBuffer(image?.buffer)) image.buffer.fill(0);
        db.prepare('DELETE FROM photo_uploads WHERE client_id=? AND customer_phone=? AND incoming_id=?').run(input.client.id,input.customerPhone,session.source_message_id);
        // Do not keep supplied condition/style details in long-lived chat logs.
        db.prepare("UPDATE messages SET body='[Photo style details provided; removed after processing]' WHERE client_id=? AND customer_phone=? AND wa_message_id=? AND direction='in'").run(input.client.id,input.customerPhone,input.incomingMessageId);
      }
    }
    if (session.stage === 'choose') {
      const index=/^BOOK ([1-3])[.!\s]*$/i.exec(text);
      const candidates=JSON.parse(session.candidates_json), selected=index && candidates[Number(index[1])-1];
      if (!selected) return answer(session,prompt(session));
      const current=catalog().find(s=>s.id===selected.id);
      if (!current || JSON.stringify(snapshot(current))!==JSON.stringify(selected)) {
        end(session); return answer(session,'The salon’s menu changed after that estimate. Please send a new photo for a fresh estimate, or send Bookings for the current menu.');
      }
      db.prepare("UPDATE photo_sessions SET stage='booking', selected_json=?, selection_message_id=?, candidates_json=NULL WHERE id=?").run(JSON.stringify(selected),input.incomingMessageId,session.id);
      return {photoSelection:{sessionId:session.id,service:current},photoSessionId:session.id};
    }
    end(session); return answer(session,'That photo request needs a fresh start. Please send a new photo or contact the salon directly. No new appointment has been made.');
  }
  return {handle};
}
module.exports={createPhotoFlow,photoStatus,eligibleServices,cleanup,bindReply,snapshot,TTL_MS};
