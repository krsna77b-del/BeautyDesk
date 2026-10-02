// Test-only preload: fake providers, no checkout .env, no outgoing network.
require('dotenv').config = () => ({ parsed: {} });
let sequence = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'graph.facebook.com') {
    const body = JSON.parse(options.body);
    if (body.text.body.startsWith("You're booked!")) {
      if (process.env.TEST_FINAL_REPLY_MODE === 'unknown') throw Error('Test final confirmation outcome unknown');
      if (process.env.TEST_FINAL_REPLY_MODE === 'failed') return new Response(JSON.stringify({error:{code:190}}), {status:401});
    }
    if (!['27820000000', '27820000001'].includes(body.to)) throw Error('Unexpected test destination');
    if (body.text.body.includes('MOCK_META_FAIL')) return new Response(JSON.stringify({error:{code:190}}), {status:401});
    if (body.text.body.includes('MOCK_META_UNKNOWN')) throw Error('Test transport failure');
    if (body.text.body.includes('MOCK_META_DELAY')) await new Promise(resolve=>setTimeout(resolve,250));
    return new Response(JSON.stringify({messages:[{id:'wamid.integration.'+(++sequence)}]}), {status:200,headers:{'content-type':'application/json'}});
  }
  if (url.hostname === 'api.anthropic.com') return new Response(JSON.stringify({id:'msg_test',type:'message',role:'assistant',model:'claude-haiku-4-5',content:[{type:'text',text:'Test receptionist reply'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
  throw Error('Network request blocked in integration test');
};
for (const name of ['node:http','node:https']) {
  const client = require(name); client.request = () => { throw Error('Outgoing HTTP blocked in test'); }; client.get = client.request;
}
// Explicit opt-in, test-process-only photo fixture. Never loaded by npm start.
if (process.env.TEST_PHOTO_FLOW === 'mock') {
  require('../photo-media').createPhotoMedia = () => ({retrieve: async () => ({buffer:Buffer.from('local fake pixels'),mimeType:'image/jpeg'})});
  require('../photo-vision').createPhotoVision = () => ({analyze: async (image,catalog) => ({candidateServiceIds:[catalog[0].id],category:catalog[0].photo_category,confidence:0.95})});
}
