// ─────────────────────────────────────────────────────────────────────────────
//  SMS Module — Omantel / Twilio / Unifonic / Test Mode
//  Uses Node.js built-in fetch (Node 18+) — zero extra dependencies
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./db');

function getConfig() {
  const rows = db.prepare(`SELECT key,value FROM clinic_settings WHERE key LIKE 'sms_%'`).all();
  const cfg = {};
  rows.forEach(r => cfg[r.key] = r.value);
  return cfg;
}

function logSMS({ to, message, status, provider, error_message, appointment_id, patient_id }) {
  db.prepare(`INSERT INTO sms_logs (to_number,message,status,provider,error_message,appointment_id,patient_id)
              VALUES (?,?,?,?,?,?,?)`)
    .run(to, message, status, provider, error_message||null, appointment_id||null, patient_id||null);
}

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
}

// ── Main send function ────────────────────────────────────────────────────────
async function sendSMS({ to, message, appointment_id, patient_id }) {
  const cfg      = getConfig();
  const provider = cfg.sms_provider || 'none';
  const meta     = { to, message, appointment_id, patient_id };

  if (provider === 'none')     { logSMS({ ...meta, status:'simulated', provider:'none' }); return { success:true, simulated:true }; }
  if (provider === 'omantel')  return _omantel(cfg, meta);
  if (provider === 'twilio')   return _twilio(cfg, meta);
  if (provider === 'unifonic') return _unifonic(cfg, meta);

  throw new Error(`Unknown SMS provider: ${provider}`);
}

// ── Omantel SMS Gateway ───────────────────────────────────────────────────────
//  Omantel provides a Bulk-SMS HTTP API to corporate customers.
//  The gateway URL, username and password are supplied by Omantel when you
//  register for the service.  Contact: sms-support@omantel.om
//
//  Default endpoint:  https://smsvas.com/bulk/public/index.php/api/v1/sendsms
//  (This is the common Omantel reseller gateway; use the URL Omantel gave you.)
//
//  Request  POST JSON:
//    { "username":"…", "password":"…", "SenderID":"…",
//      "SMSText":"…", "GSM":"968XXXXXXXX" }
//  Response JSON:
//    { "ERRORCODE":"000", "ERRORTEXT":"Success", "ID":"…" }  (000 = success)
// ─────────────────────────────────────────────────────────────────────────────
async function _omantel(cfg, meta) {
  const apiUrl   = cfg.sms_omantel_url      || 'https://smsvas.com/bulk/public/index.php/api/v1/sendsms';
  const username = cfg.sms_omantel_username;
  const password = cfg.sms_omantel_password;
  const senderId = cfg.sms_sender_id        || 'Clinic';

  if (!username || !password) throw new Error('Omantel username or password not configured. Check Settings → SMS.');

  // Strip non-digit chars and ensure Oman country code (968)
  let gsm = meta.to.replace(/\D/g, '');
  if (gsm.startsWith('00')) gsm = gsm.slice(2);
  if (gsm.startsWith('968') && gsm.length > 9) { /* already has country code */ }
  else if (!gsm.startsWith('968')) gsm = '968' + gsm;

  const payload = {
    username,
    password,
    SenderID: senderId,
    SMSText:  meta.message,
    GSM:      gsm
  };

  let resp, data;
  try {
    resp = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  } catch(e) {
    logSMS({ ...meta, status:'failed', provider:'omantel', error_message: e.message });
    throw new Error('Omantel gateway unreachable: ' + e.message);
  }

  // Omantel returns ERRORCODE "000" for success
  const code = data.ERRORCODE ?? data.errorcode ?? data.code ?? '';
  const errText = data.ERRORTEXT ?? data.errortext ?? data.message ?? JSON.stringify(data);

  if (resp.ok && (code === '000' || code === 0 || String(code) === '0')) {
    logSMS({ ...meta, status:'sent', provider:'omantel' });
    return { success:true, message_id: data.ID ?? data.id };
  }

  const errMsg = `Omantel error ${code}: ${errText}`;
  logSMS({ ...meta, status:'failed', provider:'omantel', error_message: errMsg });
  throw new Error(errMsg);
}

// ── Twilio ────────────────────────────────────────────────────────────────────
async function _twilio(cfg, meta) {
  const sid   = cfg.sms_twilio_sid;
  const token = cfg.sms_twilio_token;
  const from  = cfg.sms_twilio_phone;
  if (!sid || !token || !from) throw new Error('Twilio credentials incomplete. Check Settings → SMS.');

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({ To: meta.to, From: from, Body: meta.message });

  let resp, data;
  try {
    resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method:'POST', headers:{ Authorization:`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:body.toString()
    });
    data = await resp.json();
  } catch(e) { logSMS({ ...meta, status:'failed', provider:'twilio', error_message:e.message }); throw new Error('Twilio: '+e.message); }

  if (!resp.ok) { const m=data.message||'Twilio error'; logSMS({ ...meta, status:'failed', provider:'twilio', error_message:m }); throw new Error(m); }
  logSMS({ ...meta, status:'sent', provider:'twilio' });
  return { success:true, sid:data.sid };
}

// ── Unifonic ──────────────────────────────────────────────────────────────────
async function _unifonic(cfg, meta) {
  const appSid   = cfg.sms_unifonic_sid;
  const senderId = cfg.sms_sender_id || 'Clinic';
  if (!appSid) throw new Error('Unifonic AppSid not configured. Check Settings → SMS.');

  const body = new URLSearchParams({ AppSid:appSid, SenderID:senderId, Body:meta.message, Recipient:meta.to });

  let resp, data;
  try {
    resp = await fetch('https://api.unifonic.com/rest/SMS/messages', {
      method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:body.toString()
    });
    data = await resp.json();
  } catch(e) { logSMS({ ...meta, status:'failed', provider:'unifonic', error_message:e.message }); throw new Error('Unifonic: '+e.message); }

  if (data.Success !== 'True') { const m=data.Message||'Unifonic error'; logSMS({ ...meta, status:'failed', provider:'unifonic', error_message:m }); throw new Error(m); }
  logSMS({ ...meta, status:'sent', provider:'unifonic' });
  return { success:true };
}

module.exports = { sendSMS, fillTemplate, getConfig };
