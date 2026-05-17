const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');
const db      = require('./db');
const sms     = require('./sms');

const app      = express();
const PORT     = process.env.PORT || 3000;
const START_TS = Date.now();   // changes every server restart → busts browser cache

function serveIndex(req, res) {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace(/\?v=\d+/g, `?v=${START_TS}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('html').send(html);
}

app.use(express.json({ limit: '10mb' }));

// Serve index.html dynamically so ?v= always matches current server start time
app.get('/', serveIndex);

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function hashPwd(pwd, salt) {
  return crypto.pbkdf2Sync(pwd, salt, 10000, 64, 'sha512').toString('hex');
}
function getSession(token) {
  if (!token) return null;
  return db.prepare(`SELECT s.token,u.id,u.username,u.full_name,u.role,u.permissions,u.active
    FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.token=? AND s.expires_at>datetime('now') AND u.active=1`).get(token);
}
function requireAuth(req, res, next) {
  const s = getSession(req.headers['x-session-token']);
  if (!s) return res.status(401).json({ error: 'Authentication required' });
  req.user = s;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
function logActivity(userId, action, entity, entityId, description) {
  try { db.prepare('INSERT INTO activity_log (user_id,action,entity,entity_id,description) VALUES (?,?,?,?,?)').run(userId, action, entity, entityId ? String(entityId) : null, description || null); } catch(_) {}
}

// All /api routes require auth EXCEPT /api/auth/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = db.prepare(`SELECT * FROM users WHERE username=? AND active=1`).get(username);
  if (!user || hashPwd(password, user.salt) !== user.password_hash)
    return res.status(401).json({ error: 'Invalid username or password' });
  const token    = crypto.randomBytes(32).toString('hex');
  const expires  = new Date(Date.now() + 10 * 3600 * 1000).toISOString().replace('T',' ').split('.')[0];
  db.prepare(`INSERT INTO sessions (user_id,token,expires_at) VALUES (?,?,?)`).run(user.id, token, expires);
  db.prepare(`UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?`).run(user.id);
  db.prepare(`DELETE FROM sessions WHERE expires_at<datetime('now')`).run();
  logActivity(user.id, 'login', 'session', null, `Logged in: ${user.username}`);
  res.json({ token, user: { id:user.id, username:user.username, full_name:user.full_name, role:user.role, permissions:JSON.parse(user.permissions||'[]') } });
});

app.post('/api/auth/reset-default-admin', express.json(), (req, res) => {
  const allowedHost = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.ip === '::1' || req.ip === '127.0.0.1';
  if (!allowedHost) return res.status(403).json({ error: 'Reset allowed only from localhost' });
  const password = req.body?.password;
  if (!password || String(password).trim().length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const admin = db.prepare(`SELECT id FROM users WHERE username='admin'`).get();
  if (!admin) return res.status(404).json({ error: 'Admin user not found' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPwd(password, salt);
  db.prepare(`UPDATE users SET salt=?, password_hash=?, active=1 WHERE id=?`).run(salt, hash, admin.id);
  logActivity(admin.id, 'update', 'user', admin.id, 'Reset admin password via local reset route');
  res.json({ success: true, message: 'Admin password has been reset. Use the new password to login.' });
});

app.post('/api/auth/logout', (req, res) => {
  const t = req.headers['x-session-token'];
  if (t) {
    const s = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(t);
    if (s) logActivity(s.user_id, 'logout', 'session', null, 'Logged out');
    db.prepare(`DELETE FROM sessions WHERE token=?`).run(t);
  }
  res.json({ success: true });
});

app.post('/api/auth/logout-beacon', express.json(), (req, res) => {
  try {
    const t = req.body?.token;
    if (t) {
      const s = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(t);
      if (s) logActivity(s.user_id, 'logout', 'session', null, 'Logged out (tab closed)');
      db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    }
  } catch(_) {}
  res.status(200).end();
});

app.get('/api/auth/me', (req, res) => {
  const s = getSession(req.headers['x-session-token']);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id:s.id, username:s.username, full_name:s.full_name, role:s.role, permissions:JSON.parse(s.permissions||'[]') });
});

// ─── USER MANAGEMENT (admin only) ─────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id,username,full_name,role,permissions,active,created_at,last_login FROM users ORDER BY id ASC`).all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, full_name, role, permissions } = req.body;
  if (!username||!password||!full_name) return res.status(400).json({ error: 'Username, password, and full name are required' });
  if (db.prepare(`SELECT id FROM users WHERE username=?`).get(username))
    return res.status(409).json({ error: 'Username already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPwd(password, salt);
  const r = db.prepare(`INSERT INTO users (username,password_hash,salt,full_name,role,permissions) VALUES (?,?,?,?,?,?)`)
    .run(username, hash, salt, full_name, role||'user', JSON.stringify(permissions||[]));
  res.status(201).json(db.prepare(`SELECT id,username,full_name,role,permissions,active,created_at FROM users WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { full_name, role, permissions, active, password } = req.body;
  const id = req.params.id;
  if (password) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare(`UPDATE users SET salt=?,password_hash=? WHERE id=?`).run(salt, hashPwd(password,salt), id);
  }
  db.prepare(`UPDATE users SET full_name=?,role=?,permissions=?,active=? WHERE id=?`)
    .run(full_name, role||'user', JSON.stringify(permissions||[]), active!==undefined?active:1, id);
  res.json(db.prepare(`SELECT id,username,full_name,role,permissions,active,created_at,last_login FROM users WHERE id=?`).get(id));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare(`DELETE FROM users WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// ─── PATIENTS ────────────────────────────────────────────────────────────────

app.get('/api/patients', (req, res) => {
  const { search } = req.query;
  let rows;
  const cols = `id,patient_number,first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number,photo_thumb,created_at,updated_at`;
  if (search) {
    const q = `%${search}%`;
    rows = db.prepare(`SELECT ${cols} FROM patients WHERE first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR patient_number LIKE ? OR email LIKE ? ORDER BY id DESC`).all(q,q,q,q,q);
  } else {
    rows = db.prepare(`SELECT ${cols} FROM patients ORDER BY id DESC`).all();
  }
  res.json(rows);
});

app.get('/api/patients/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, u.full_name as created_by_name FROM patients p LEFT JOIN users u ON p.created_by_user_id=u.id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const appointments = db.prepare(`
    SELECT a.*,s.name as service_name,st.first_name||' '||st.last_name as dentist_name
    FROM appointments a
    LEFT JOIN services s ON a.service_id=s.id
    LEFT JOIN staff st ON a.dentist_id=st.id
    WHERE a.patient_id=? ORDER BY a.appointment_date DESC,a.appointment_time DESC`).all(req.params.id);
  const treatments = db.prepare(`
    SELECT t.*,st.first_name||' '||st.last_name as dentist_name
    FROM treatments t LEFT JOIN staff st ON t.dentist_id=st.id
    WHERE t.patient_id=? ORDER BY t.treatment_date DESC`).all(req.params.id);
  const invoices = db.prepare(`SELECT * FROM invoices WHERE patient_id=? ORDER BY issue_date DESC`).all(req.params.id);
  res.json({ ...p, appointments, treatments, invoices });
});

app.post('/api/patients', (req, res) => {
  const { first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number,photo,photo_thumb } = req.body;

  // Duplicate check: same name + date of birth
  if (date_of_birth) {
    const dup = db.prepare(
      `SELECT id,patient_number FROM patients WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND date_of_birth=?`
    ).get(first_name, last_name, date_of_birth);
    if (dup) return res.status(409).json({ error: `A patient with this name and date of birth already exists (${dup.patient_number}).` });
  }

  // Duplicate check: same phone number (if provided)
  if (phone && phone.trim()) {
    const dupPhone = db.prepare(`SELECT id,patient_number,first_name,last_name FROM patients WHERE phone=?`).get(phone.trim());
    if (dupPhone) return res.status(409).json({ error: `Phone number already registered to ${dupPhone.first_name} ${dupPhone.last_name} (${dupPhone.patient_number}).` });
  }

  const maxRow = db.prepare(`SELECT MAX(CAST(SUBSTR(patient_number,2) AS INTEGER)) as maxn FROM patients`).get();
  const patient_number = `P${String((maxRow?.maxn||0)+1).padStart(5,'0')}`;
  const n = v => (v === undefined || v === '') ? null : v;
  const r = db.prepare(`INSERT INTO patients (patient_number,first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number,photo,photo_thumb,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(patient_number,n(first_name),n(last_name),n(date_of_birth),n(gender),n(phone),n(email),n(address),n(city),n(medical_history),n(allergies),n(insurance_provider),n(insurance_number),n(photo),n(photo_thumb),req.user.id);
  logActivity(req.user.id, 'add', 'patient', r.lastInsertRowid, `Added patient ${patient_number}: ${first_name} ${last_name}`);
  res.status(201).json(db.prepare(`SELECT * FROM patients WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/patients/:id', (req, res) => {
  const { first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number,photo,photo_thumb } = req.body;
  const id = req.params.id;

  // Duplicate check: same name + DOB but different patient
  if (date_of_birth) {
    const dup = db.prepare(
      `SELECT id,patient_number FROM patients WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND date_of_birth=? AND id!=?`
    ).get(first_name, last_name, date_of_birth, id);
    if (dup) return res.status(409).json({ error: `Another patient with this name and date of birth already exists (${dup.patient_number}).` });
  }

  // Duplicate check: same phone but different patient
  if (phone && phone.trim()) {
    const dupPhone = db.prepare(`SELECT id,patient_number,first_name,last_name FROM patients WHERE phone=? AND id!=?`).get(phone.trim(), id);
    if (dupPhone) return res.status(409).json({ error: `Phone number already registered to ${dupPhone.first_name} ${dupPhone.last_name} (${dupPhone.patient_number}).` });
  }

  const n = v => (v === undefined || v === '') ? null : v;
  db.prepare(`UPDATE patients SET first_name=?,last_name=?,date_of_birth=?,gender=?,phone=?,email=?,address=?,city=?,medical_history=?,allergies=?,insurance_provider=?,insurance_number=?,photo=?,photo_thumb=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(n(first_name),n(last_name),n(date_of_birth),n(gender),n(phone),n(email),n(address),n(city),n(medical_history),n(allergies),n(insurance_provider),n(insurance_number),n(photo),n(photo_thumb),id);
  logActivity(req.user.id, 'update', 'patient', id, `Updated patient #${id}: ${first_name} ${last_name}`);
  res.json(db.prepare(`SELECT * FROM patients WHERE id=?`).get(id));
});

app.delete('/api/patients/:id', (req, res) => {
  const p = db.prepare('SELECT patient_number,first_name,last_name FROM patients WHERE id=?').get(req.params.id);
  db.prepare(`DELETE FROM patients WHERE id=?`).run(req.params.id);
  if (p) logActivity(req.user.id, 'delete', 'patient', req.params.id, `Deleted patient ${p.patient_number}: ${p.first_name} ${p.last_name}`);
  res.json({ success: true });
});

// ─── APPOINTMENTS ─────────────────────────────────────────────────────────────

app.get('/api/appointments', (req, res) => {
  const { date, status, dentist_id, patient_id, from, to, search } = req.query;
  let sql = `SELECT a.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.phone as patient_phone,s.name as service_name,s.duration as service_duration,st.first_name||' '||st.last_name as dentist_name FROM appointments a LEFT JOIN patients p ON a.patient_id=p.id LEFT JOIN services s ON a.service_id=s.id LEFT JOIN staff st ON a.dentist_id=st.id WHERE 1=1`;
  const params = [];
  if (date)       { sql += ` AND a.appointment_date=?`; params.push(date); }
  if (from)       { sql += ` AND a.appointment_date>=?`; params.push(from); }
  if (to)         { sql += ` AND a.appointment_date<=?`; params.push(to); }
  if (status)     { sql += ` AND a.status=?`; params.push(status); }
  if (dentist_id) { sql += ` AND a.dentist_id=?`; params.push(dentist_id); }
  if (patient_id) { sql += ` AND a.patient_id=?`; params.push(patient_id); }
  if (search)     { const q=`%${search}%`; sql += ` AND (p.first_name LIKE ? OR p.last_name LIKE ? OR p.patient_number LIKE ? OR s.name LIKE ? OR (p.first_name||' '||p.last_name) LIKE ?)`; params.push(q,q,q,q,q); }
  sql += ` ORDER BY a.appointment_date DESC,a.appointment_time DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/appointments/:id', (req, res) => {
  const row = db.prepare(`SELECT a.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.date_of_birth as patient_dob,p.gender as patient_gender,p.photo as patient_photo,s.name as service_name,st.first_name||' '||st.last_name as dentist_name FROM appointments a LEFT JOIN patients p ON a.patient_id=p.id LEFT JOIN services s ON a.service_id=s.id LEFT JOIN staff st ON a.dentist_id=st.id WHERE a.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/appointments', async (req, res, next) => {
  try {
    const { patient_id,dentist_id,service_id,appointment_date,appointment_time,duration,notes } = req.body;
    const r = db.prepare(`INSERT INTO appointments (patient_id,dentist_id,service_id,appointment_date,appointment_time,duration,notes) VALUES (?,?,?,?,?,?,?)`).run(patient_id,dentist_id||null,service_id||null,appointment_date,appointment_time,duration||30,notes||null);
    const newAppt = db.prepare(`SELECT a.*,p.first_name||' '||p.last_name as patient_name FROM appointments a LEFT JOIN patients p ON a.patient_id=p.id WHERE a.id=?`).get(r.lastInsertRowid);

    try {
      const cfg = sms.getConfig();
      if (cfg.sms_auto_booking !== '0') await _sendApptSMS(r.lastInsertRowid, 'booking', cfg);
    } catch(e) { console.error('[SMS] Booking SMS failed:', e.message); }

    logActivity(req.user.id, 'add', 'appointment', r.lastInsertRowid, `Added appointment for patient #${patient_id} on ${appointment_date}`);
    res.status(201).json(newAppt);
  } catch(e) { next(e); }
});

app.put('/api/appointments/:id', (req, res) => {
  const { patient_id,dentist_id,service_id,appointment_date,appointment_time,duration,status,notes } = req.body;
  db.prepare(`UPDATE appointments SET patient_id=?,dentist_id=?,service_id=?,appointment_date=?,appointment_time=?,duration=?,status=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(patient_id,dentist_id||null,service_id||null,appointment_date,appointment_time,duration||30,status||'scheduled',notes||null,req.params.id);
  logActivity(req.user.id, 'update', 'appointment', req.params.id, `Updated appointment #${req.params.id} — status: ${status||'scheduled'}`);
  res.json({ success: true });
});

app.delete('/api/appointments/:id', (req, res) => {
  const a = db.prepare('SELECT appointment_date,appointment_time FROM appointments WHERE id=?').get(req.params.id);
  db.prepare(`DELETE FROM appointments WHERE id=?`).run(req.params.id);
  if (a) logActivity(req.user.id, 'delete', 'appointment', req.params.id, `Deleted appointment #${req.params.id} (${a.appointment_date} ${a.appointment_time})`);
  res.json({ success: true });
});

// ─── TREATMENTS ───────────────────────────────────────────────────────────────

app.get('/api/treatments', (req, res) => {
  const { patient_id, search } = req.query;
  let sql = `SELECT t.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.photo as patient_photo,st.first_name||' '||st.last_name as dentist_name FROM treatments t LEFT JOIN patients p ON t.patient_id=p.id LEFT JOIN staff st ON t.dentist_id=st.id WHERE 1=1`;
  const params = [];
  if (patient_id) { sql += ` AND t.patient_id=?`; params.push(patient_id); }
  if (search)     { const q=`%${search}%`; sql += ` AND (p.first_name LIKE ? OR p.last_name LIKE ? OR p.patient_number LIKE ? OR t.procedure_name LIKE ? OR t.diagnosis LIKE ? OR (p.first_name||' '||p.last_name) LIKE ?)`; params.push(q,q,q,q,q,q); }
  sql += ` ORDER BY t.treatment_date DESC,t.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/treatments/:id', (req, res) => {
  const treatment = db.prepare(`SELECT t.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.date_of_birth as patient_dob,p.gender as patient_gender,p.photo as patient_photo,st.first_name||' '||st.last_name as dentist_name FROM treatments t LEFT JOIN patients p ON t.patient_id=p.id LEFT JOIN staff st ON t.dentist_id=st.id WHERE t.id=?`).get(req.params.id);
  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });
  res.json(treatment);
});

app.post('/api/treatments', (req, res) => {
  const { patient_id,appointment_id,dentist_id,treatment_date,tooth_number,diagnosis,procedure_name,notes,cost } = req.body;
  const r = db.prepare(`INSERT INTO treatments (patient_id,appointment_id,dentist_id,treatment_date,tooth_number,diagnosis,procedure_name,notes,cost) VALUES (?,?,?,?,?,?,?,?,?)`).run(patient_id,appointment_id||null,dentist_id||null,treatment_date,tooth_number||null,diagnosis||null,procedure_name||null,notes||null,cost||0);
  logActivity(req.user.id, 'add', 'treatment', r.lastInsertRowid, `Added treatment for patient #${patient_id}: ${procedure_name||'—'}`);
  res.status(201).json(db.prepare(`SELECT * FROM treatments WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/treatments/:id', (req, res) => {
  const { patient_id,appointment_id,dentist_id,treatment_date,tooth_number,diagnosis,procedure_name,notes,cost } = req.body;
  db.prepare(`UPDATE treatments SET patient_id=?,appointment_id=?,dentist_id=?,treatment_date=?,tooth_number=?,diagnosis=?,procedure_name=?,notes=?,cost=? WHERE id=?`).run(patient_id,appointment_id||null,dentist_id||null,treatment_date,tooth_number||null,diagnosis||null,procedure_name||null,notes||null,cost||0,req.params.id);
  logActivity(req.user.id, 'update', 'treatment', req.params.id, `Updated treatment #${req.params.id}: ${procedure_name||'—'}`);
  res.json({ success: true });
});

app.delete('/api/treatments/:id', (req, res) => {
  const t = db.prepare('SELECT procedure_name,patient_id FROM treatments WHERE id=?').get(req.params.id);
  db.prepare(`DELETE FROM treatments WHERE id=?`).run(req.params.id);
  if (t) logActivity(req.user.id, 'delete', 'treatment', req.params.id, `Deleted treatment #${req.params.id}: ${t.procedure_name||'—'}`);
  res.json({ success: true });
});

// ─── INVOICES ─────────────────────────────────────────────────────────────────

app.get('/api/invoices', (req, res) => {
  const { patient_id, payment_status, search } = req.query;
  let sql = `SELECT i.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.photo as patient_photo,p.photo_thumb as patient_photo_thumb FROM invoices i LEFT JOIN patients p ON i.patient_id=p.id WHERE 1=1`;
  const params = [];
  if (patient_id)     { sql += ` AND i.patient_id=?`; params.push(patient_id); }
  if (payment_status) { sql += ` AND i.payment_status=?`; params.push(payment_status); }
  if (search)         { const q=`%${search}%`; sql += ` AND (p.first_name LIKE ? OR p.last_name LIKE ? OR p.patient_number LIKE ? OR i.invoice_number LIKE ? OR (p.first_name||' '||p.last_name) LIKE ?)`; params.push(q,q,q,q,q); }
  sql += ` ORDER BY i.issue_date DESC,i.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/invoices/:id', (req, res) => {
  const inv = db.prepare(`SELECT i.*,p.first_name||' '||p.last_name as patient_name,p.patient_number,p.date_of_birth as patient_dob,p.gender as patient_gender,p.photo as patient_photo,p.photo_thumb as patient_photo_thumb,p.phone as patient_phone,p.email as patient_email,p.address as patient_address,p.city as patient_city,p.insurance_provider,p.insurance_number FROM invoices i LEFT JOIN patients p ON i.patient_id=p.id WHERE i.id=?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`SELECT * FROM invoice_items WHERE invoice_id=?`).all(req.params.id);
  res.json({ ...inv, items });
});

app.post('/api/invoices', (req, res) => {
  const { patient_id,appointment_id,issue_date,due_date,items,tax_rate,discount,notes,payment_method,amount_paid } = req.body;
  const invoiceItems = Array.isArray(items) ? items : [];
  if (!patient_id) return res.status(400).json({ error: 'Patient is required.' });
  if (!issue_date) return res.status(400).json({ error: 'Issue date is required.' });
  if (!invoiceItems.length) return res.status(400).json({ error: 'At least one invoice item is required.' });

  const validatedItems = invoiceItems.map(i => ({
    service_id: i.service_id || null,
    description: (i.description || '').trim(),
    quantity: Math.max(1, parseInt(i.quantity, 10) || 1),
    unit_price: Math.max(0, parseFloat(i.unit_price) || 0)
  })).filter(i => i.description);

  if (!validatedItems.length) return res.status(400).json({ error: 'At least one invoice item with a description is required.' });

  const subtotal = validatedItems.reduce((s,i) => s + (i.quantity * i.unit_price), 0);
  const disc = parseFloat(discount) || 0;
  const taxable = subtotal - disc;
  const taxRate = parseFloat(tax_rate) || 0;
  const taxAmount = taxable * taxRate / 100;
  const total = taxable + taxAmount;
  const paid = parseFloat(amount_paid) || 0;
  const balance = total - paid;
  const status = paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  const year = new Date().getFullYear();
  const maxRow = db.prepare(`SELECT MAX(CAST(SUBSTR(invoice_number,-4) AS INTEGER)) as maxseq FROM invoices WHERE invoice_number LIKE ?`).get(`INV-${year}-%`);
  let seq = (maxRow?.maxseq || 0) + 1;
  let invoice_number = null;
  const maxAttempts = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    invoice_number = `INV-${year}-${String(seq + attempt).padStart(4,'0')}`;
    try {
      const r = db.prepare(`INSERT INTO invoices (invoice_number,patient_id,appointment_id,issue_date,due_date,subtotal,tax_rate,tax_amount,discount,total,amount_paid,balance,payment_status,payment_method,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invoice_number,patient_id,appointment_id||null,issue_date,due_date||null,subtotal,taxRate,taxAmount,disc,total,paid,balance,status,payment_method||null,notes||null);
      const invId = r.lastInsertRowid;
      const insItem = db.prepare(`INSERT INTO invoice_items (invoice_id,service_id,description,quantity,unit_price,total) VALUES (?,?,?,?,?,?)`);
      validatedItems.forEach(i => insItem.run(invId, i.service_id, i.description, i.quantity, i.unit_price, i.quantity * i.unit_price));
      logActivity(req.user.id, 'add', 'invoice', invId, `Added invoice ${invoice_number} for patient #${patient_id}`);
      return res.status(201).json(db.prepare(`SELECT * FROM invoices WHERE id=?`).get(invId));
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint failed')) {
        return res.status(500).json({ error: `Failed to create invoice: ${e.message}` });
      }
      // Try the next number in sequence
    }
  }
  res.status(500).json({ error: 'Failed to generate unique invoice number after multiple attempts.' });
});

app.put('/api/invoices/:id', (req, res) => {
  const { amount_paid, payment_method, notes } = req.body;
  const inv = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const paid = parseFloat(amount_paid)||0;
  const balance = inv.total - paid;
  const status = paid >= inv.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  db.prepare(`UPDATE invoices SET amount_paid=?,balance=?,payment_status=?,payment_method=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(paid,balance,status,payment_method||inv.payment_method,notes||inv.notes,req.params.id);
  logActivity(req.user.id, 'update', 'invoice', req.params.id, `Updated payment for ${inv.invoice_number} — paid: ${paid}, status: ${status}`);
  res.json(db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id));
});

app.delete('/api/invoices/:id', (req, res) => {
  const inv = db.prepare('SELECT invoice_number FROM invoices WHERE id=?').get(req.params.id);
  db.prepare(`DELETE FROM invoices WHERE id=?`).run(req.params.id);
  if (inv) logActivity(req.user.id, 'delete', 'invoice', req.params.id, `Deleted invoice ${inv.invoice_number}`);
  res.json({ success: true });
});

app.delete('/api/invoices-test/cleanup', (req, res) => {
  try {
    db.exec(`DELETE FROM invoice_items; DELETE FROM invoices;`);
    res.json({ success: true, message: 'All test invoices cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STAFF ────────────────────────────────────────────────────────────────────

app.get('/api/staff', (req, res) => {
  const { active } = req.query;
  let sql = `SELECT * FROM staff`;
  if (active !== undefined) sql += ` WHERE active=${active==='true'||active==='1'?1:0}`;
  sql += ` ORDER BY id DESC`;
  res.json(db.prepare(sql).all());
});

app.post('/api/staff', (req, res) => {
  const { first_name,last_name,role,specialization,phone,email } = req.body;

  // Duplicate: same full name within the same role
  const dupName = db.prepare(
    `SELECT id FROM staff WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND role=?`
  ).get(first_name, last_name, role||'Dentist');
  if (dupName) return res.status(409).json({ error: `A ${role||'Dentist'} named "${first_name} ${last_name}" already exists.` });

  // Duplicate: same email (if provided)
  if (email && email.trim()) {
    const dupEmail = db.prepare(`SELECT id,first_name,last_name FROM staff WHERE LOWER(email)=LOWER(?)`).get(email.trim());
    if (dupEmail) return res.status(409).json({ error: `Email already registered to ${dupEmail.first_name} ${dupEmail.last_name}.` });
  }

  // Duplicate: same phone (if provided)
  if (phone && phone.trim()) {
    const dupPhone = db.prepare(`SELECT id,first_name,last_name FROM staff WHERE phone=?`).get(phone.trim());
    if (dupPhone) return res.status(409).json({ error: `Phone number already registered to ${dupPhone.first_name} ${dupPhone.last_name}.` });
  }

  const n = v => (v === undefined || v === '') ? null : v;
  const r = db.prepare(`INSERT INTO staff (first_name,last_name,role,specialization,phone,email) VALUES (?,?,?,?,?,?)`).run(first_name,last_name,role||'Dentist',n(specialization),n(phone),n(email));
  res.status(201).json(db.prepare(`SELECT * FROM staff WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/staff/:id', (req, res) => {
  const { first_name,last_name,role,specialization,phone,email,active } = req.body;
  const id = req.params.id;

  // Duplicate: same full name within the same role (excluding self)
  const dupName = db.prepare(
    `SELECT id FROM staff WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND role=? AND id!=?`
  ).get(first_name, last_name, role||'Dentist', id);
  if (dupName) return res.status(409).json({ error: `Another ${role||'Dentist'} named "${first_name} ${last_name}" already exists.` });

  // Duplicate: same email but different record
  if (email && email.trim()) {
    const dupEmail = db.prepare(`SELECT id,first_name,last_name FROM staff WHERE LOWER(email)=LOWER(?) AND id!=?`).get(email.trim(), id);
    if (dupEmail) return res.status(409).json({ error: `Email already registered to ${dupEmail.first_name} ${dupEmail.last_name}.` });
  }

  // Duplicate: same phone but different record
  if (phone && phone.trim()) {
    const dupPhone = db.prepare(`SELECT id,first_name,last_name FROM staff WHERE phone=? AND id!=?`).get(phone.trim(), id);
    if (dupPhone) return res.status(409).json({ error: `Phone number already registered to ${dupPhone.first_name} ${dupPhone.last_name}.` });
  }

  const n = v => (v === undefined || v === '') ? null : v;
  db.prepare(`UPDATE staff SET first_name=?,last_name=?,role=?,specialization=?,phone=?,email=?,active=? WHERE id=?`).run(first_name,last_name,role||'Dentist',n(specialization),n(phone),n(email),active!==undefined?active:1,id);
  res.json(db.prepare(`SELECT * FROM staff WHERE id=?`).get(id));
});

app.delete('/api/staff/:id', (req, res) => {
  db.prepare(`DELETE FROM staff WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// ─── SERVICES ─────────────────────────────────────────────────────────────────

app.get('/api/services', (req, res) => {
  const { active } = req.query;
  let sql = `SELECT * FROM services`;
  if (active !== undefined) sql += ` WHERE active=${active==='true'||active==='1'?1:0}`;
  sql += ` ORDER BY id DESC`;
  res.json(db.prepare(sql).all());
});

app.post('/api/services', (req, res) => {
  const { name,category,duration,price,description } = req.body;
  const r = db.prepare(`INSERT INTO services (name,category,duration,price,description) VALUES (?,?,?,?,?)`).run(name,category||null,duration||30,price||0,description||null);
  res.status(201).json(db.prepare(`SELECT * FROM services WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/services/:id', (req, res) => {
  const { name,category,duration,price,description,active } = req.body;
  db.prepare(`UPDATE services SET name=?,category=?,duration=?,price=?,description=?,active=? WHERE id=?`).run(name,category||null,duration||30,price||0,description||null,active!==undefined?active:1,req.params.id);
  res.json(db.prepare(`SELECT * FROM services WHERE id=?`).get(req.params.id));
});

app.delete('/api/services/:id', (req, res) => {
  db.prepare(`DELETE FROM services WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const rows = db.prepare(`SELECT key,value FROM clinic_settings`).all();
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  res.json(obj);
});

app.put('/api/settings', (req, res) => {
  const upd = db.prepare(`INSERT OR REPLACE INTO clinic_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)`);
  db.exec('BEGIN');
  try {
    Object.entries(req.body).forEach(([k,v]) => upd.run(k, v));
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ success: true });
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────

app.get('/api/reports/dashboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.substring(0,8) + '01';
  const prevMonthDate = new Date(); prevMonthDate.setMonth(prevMonthDate.getMonth()-1);
  const prevMonth = prevMonthDate.toISOString().split('T')[0].substring(0,8) + '01';

  const totalPatients = db.prepare(`SELECT COUNT(*) as c FROM patients`).get().c;
  const todayAppts = db.prepare(`SELECT COUNT(*) as c FROM appointments WHERE appointment_date=?`).get(today).c;
  const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount_paid),0) as total FROM invoices WHERE issue_date>=?`).get(monthStart).total;
  const prevMonthRevenue = db.prepare(`SELECT COALESCE(SUM(amount_paid),0) as total FROM invoices WHERE issue_date>=? AND issue_date<?`).get(prevMonth,monthStart).total;
  const pendingInvoices = db.prepare(`SELECT COUNT(*) as c FROM invoices WHERE payment_status!='paid'`).get().c;
  const pendingAmount = db.prepare(`SELECT COALESCE(SUM(balance),0) as total FROM invoices WHERE payment_status!='paid'`).get().total;

  const upcomingAppts = db.prepare(`SELECT a.*,p.first_name||' '||p.last_name as patient_name,s.name as service_name,st.first_name||' '||st.last_name as dentist_name FROM appointments a LEFT JOIN patients p ON a.patient_id=p.id LEFT JOIN services s ON a.service_id=s.id LEFT JOIN staff st ON a.dentist_id=st.id WHERE a.appointment_date>=? AND a.status NOT IN ('cancelled','completed') ORDER BY a.appointment_date,a.appointment_time LIMIT 8`).all(today);

  // Monthly revenue for last 6 months
  const revenueByMonth = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const ym = d.toISOString().substring(0,7);
    const rev = db.prepare(`SELECT COALESCE(SUM(amount_paid),0) as total FROM invoices WHERE strftime('%Y-%m',issue_date)=?`).get(ym).total;
    revenueByMonth.push({ month: ym, revenue: rev });
  }

  // Appointment status breakdown (last 30 days)
  const apptStatus = db.prepare(`SELECT status,COUNT(*) as cnt FROM appointments WHERE appointment_date>=date('now','-30 days') GROUP BY status`).all();

  // New patients this month
  const newPatients = db.prepare(`SELECT COUNT(*) as c FROM patients WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')`).get().c;

  res.json({ totalPatients, todayAppts, monthRevenue, prevMonthRevenue, pendingInvoices, pendingAmount, upcomingAppts, revenueByMonth, apptStatus, newPatients });
});

app.get('/api/reports/revenue', (req, res) => {
  const { year, from, to } = req.query;
  let data;
  if (from && to) {
    data = db.prepare(`SELECT strftime('%Y-%m',issue_date) as month,COALESCE(SUM(total),0) as billed,COALESCE(SUM(amount_paid),0) as collected FROM invoices WHERE issue_date>=? AND issue_date<=? GROUP BY month ORDER BY month`).all(from,to);
  } else {
    const y = year || new Date().getFullYear();
    data = db.prepare(`SELECT strftime('%Y-%m',issue_date) as month,COALESCE(SUM(total),0) as billed,COALESCE(SUM(amount_paid),0) as collected FROM invoices WHERE strftime('%Y',issue_date)=? GROUP BY month ORDER BY month`).all(String(y));
  }
  const byStatus = db.prepare(`SELECT payment_status,COUNT(*) as cnt,COALESCE(SUM(total),0) as amount FROM invoices GROUP BY payment_status`).all();
  const topServices = db.prepare(`SELECT ii.description,COUNT(*) as cnt,SUM(ii.total) as revenue FROM invoice_items ii GROUP BY ii.description ORDER BY revenue DESC LIMIT 10`).all();
  res.json({ monthly: data, byStatus, topServices });
});

app.get('/api/reports/appointments', (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || new Date(Date.now() - 90*86400000).toISOString().split('T')[0];
  const toDate   = to   || new Date().toISOString().split('T')[0];
  const byStatus = db.prepare(`SELECT status,COUNT(*) as cnt FROM appointments WHERE appointment_date>=? AND appointment_date<=? GROUP BY status`).all(fromDate,toDate);
  const byDay    = db.prepare(`SELECT strftime('%w',appointment_date) as dow,COUNT(*) as cnt FROM appointments WHERE appointment_date>=? AND appointment_date<=? GROUP BY dow`).all(fromDate,toDate);
  const byDentist= db.prepare(`SELECT st.first_name||' '||st.last_name as dentist,COUNT(*) as cnt FROM appointments a LEFT JOIN staff st ON a.dentist_id=st.id WHERE a.appointment_date>=? AND a.appointment_date<=? GROUP BY a.dentist_id`).all(fromDate,toDate);
  const byService= db.prepare(`SELECT s.name as service,COUNT(*) as cnt FROM appointments a LEFT JOIN services s ON a.service_id=s.id WHERE a.appointment_date>=? AND a.appointment_date<=? GROUP BY a.service_id ORDER BY cnt DESC LIMIT 10`).all(fromDate,toDate);
  const byMonth  = db.prepare(`SELECT strftime('%Y-%m',appointment_date) as month,COUNT(*) as cnt FROM appointments WHERE appointment_date>=? AND appointment_date<=? GROUP BY month ORDER BY month`).all(fromDate,toDate);
  res.json({ byStatus, byDay, byDentist, byService, byMonth });
});

app.get('/api/reports/patients', (req, res) => {
  const byGender = db.prepare(`SELECT COALESCE(gender,'Unknown') as gender,COUNT(*) as cnt FROM patients GROUP BY gender`).all();
  const byMonth  = db.prepare(`SELECT strftime('%Y-%m',created_at) as month,COUNT(*) as cnt FROM patients WHERE created_at>=date('now','-12 months') GROUP BY month ORDER BY month`).all();
  const withInsurance = db.prepare(`SELECT COUNT(*) as c FROM patients WHERE insurance_provider IS NOT NULL AND insurance_provider!=''`).get().c;
  const total = db.prepare(`SELECT COUNT(*) as c FROM patients`).get().c;
  res.json({ byGender, byMonth, withInsurance, total, withoutInsurance: total - withInsurance });
});

app.post('/api/activity/print', (req, res) => {
  const { entity, entity_id, description } = req.body;
  logActivity(req.user.id, 'print', entity||'report', entity_id||null, description||'Printed report');
  res.json({ success: true });
});

app.get('/api/reports/users', requireAdmin, (req, res) => {
  const { user_id, from, to, action } = req.query;
  const joinParams = [];
  let joinCond = '';
  if (from)   { joinCond += ` AND date(al.created_at)>=?`; joinParams.push(from); }
  if (to)     { joinCond += ` AND date(al.created_at)<=?`; joinParams.push(to); }
  if (action) { joinCond += ` AND al.action=?`;             joinParams.push(action); }
  const whereCond  = user_id ? ` WHERE u.id=?` : '';
  const whereParam = user_id ? [user_id] : [];
  const sql = `
    SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at, u.last_login,
      SUM(CASE WHEN al.action='add'    THEN 1 ELSE 0 END) as total_added,
      SUM(CASE WHEN al.action='update' THEN 1 ELSE 0 END) as total_updated,
      SUM(CASE WHEN al.action='delete' THEN 1 ELSE 0 END) as total_deleted,
      SUM(CASE WHEN al.action='print'  THEN 1 ELSE 0 END) as total_printed,
      SUM(CASE WHEN al.action='login'  THEN 1 ELSE 0 END) as total_logins,
      COUNT(al.id) as total_actions
    FROM users u
    LEFT JOIN activity_log al ON al.user_id=u.id${joinCond}
    ${whereCond}
    GROUP BY u.id ORDER BY u.full_name ASC`;
  res.json(db.prepare(sql).all(...joinParams, ...whereParam));
});

app.get('/api/reports/activity-log', requireAdmin, (req, res) => {
  const { user_id, from, to, action } = req.query;
  let sql = `SELECT al.id,al.action,al.entity,al.entity_id,al.description,al.created_at,
    u.full_name,u.username FROM activity_log al JOIN users u ON al.user_id=u.id WHERE 1=1`;
  const params = [];
  if (user_id) { sql += ` AND al.user_id=?`;           params.push(user_id); }
  if (from)    { sql += ` AND date(al.created_at)>=?`; params.push(from); }
  if (to)      { sql += ` AND date(al.created_at)<=?`; params.push(to); }
  if (action)  { sql += ` AND al.action=?`;            params.push(action); }
  sql += ` ORDER BY al.created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...params));
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────

// NOTE: specific sub-routes must come BEFORE /:id
app.get('/api/inventory/low-stock', (req, res) => {
  const rows = db.prepare(`SELECT *, current_stock*unit_cost as value FROM inventory WHERE current_stock<=min_stock AND active=1 ORDER BY (current_stock*1.0/CASE WHEN min_stock>0 THEN min_stock ELSE 1 END) ASC`).all();
  res.json(rows);
});

app.get('/api/inventory/report', (req, res) => {
  const items = db.prepare(`SELECT *, current_stock*unit_cost as value, CASE WHEN current_stock<=min_stock THEN 1 ELSE 0 END as is_low FROM inventory WHERE active=1 ORDER BY id DESC`).all();
  const total_value = items.reduce((s,i)=>s+(i.value||0),0);
  const low_count   = items.filter(i=>i.is_low).length;
  const by_category = db.prepare(`SELECT category,COUNT(*) as cnt,SUM(current_stock*unit_cost) as value FROM inventory WHERE active=1 GROUP BY category ORDER BY value DESC`).all();
  res.json({ items, total_value, low_count, total_items:items.length, by_category });
});

app.get('/api/inventory', (req, res) => {
  const { search } = req.query;
  let sql = `SELECT *, current_stock*unit_cost as value, CASE WHEN current_stock<=min_stock THEN 1 ELSE 0 END as low_stock FROM inventory WHERE active=1`;
  const params = [];
  if (search) { const q=`%${search}%`; sql += ` AND (name LIKE ? OR item_code LIKE ? OR category LIKE ? OR supplier LIKE ?)`; params.push(q,q,q,q); }
  sql += ` ORDER BY id DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/inventory/:id', (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error:'Not found' });
  const transactions = db.prepare(`SELECT * FROM inventory_transactions WHERE item_id=? ORDER BY transaction_date DESC,id DESC LIMIT 100`).all(req.params.id);
  res.json({ ...item, transactions });
});

app.post('/api/inventory', (req, res) => {
  const { name,category,unit,current_stock,min_stock,unit_cost,supplier,location,notes } = req.body;
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM inventory`).get().c;
  const item_code = `INV${String(cnt+1).padStart(3,'0')}`;
  const r = db.prepare(`INSERT INTO inventory (item_code,name,category,unit,current_stock,min_stock,unit_cost,supplier,location,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(item_code,name,category||null,unit||'pcs',parseFloat(current_stock)||0,parseFloat(min_stock)||0,parseFloat(unit_cost)||0,supplier||null,location||null,notes||null);
  res.status(201).json(db.prepare(`SELECT * FROM inventory WHERE id=?`).get(r.lastInsertRowid));
});

app.put('/api/inventory/:id', (req, res) => {
  const { name,category,unit,current_stock,min_stock,unit_cost,supplier,location,notes,active } = req.body;
  db.prepare(`UPDATE inventory SET name=?,category=?,unit=?,current_stock=?,min_stock=?,unit_cost=?,supplier=?,location=?,notes=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(name,category||null,unit||'pcs',parseFloat(current_stock)||0,parseFloat(min_stock)||0,parseFloat(unit_cost)||0,supplier||null,location||null,notes||null,active!==undefined?active:1,req.params.id);
  res.json(db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id));
});

app.delete('/api/inventory/:id', (req, res) => {
  db.prepare(`DELETE FROM inventory WHERE id=?`).run(req.params.id);
  res.json({ success:true });
});

app.post('/api/inventory/:id/transaction', (req, res) => {
  const { transaction_type,quantity,notes,transaction_date,unit_cost } = req.body;
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error:'Item not found' });
  const qty = parseFloat(quantity)||0;
  if (qty <= 0 && transaction_type !== 'adjustment') return res.status(400).json({ error:'Quantity must be positive' });
  let newStock;
  if (transaction_type === 'in')       newStock = item.current_stock + qty;
  else if (transaction_type === 'out') newStock = Math.max(0, item.current_stock - qty);
  else                                  newStock = qty;
  const uc = parseFloat(unit_cost)||item.unit_cost;
  const totalCost = transaction_type !== 'adjustment' ? qty*uc : 0;
  const date = transaction_date || new Date().toISOString().split('T')[0];
  db.prepare(`INSERT INTO inventory_transactions (item_id,transaction_type,quantity,balance_after,unit_cost,total_cost,notes,transaction_date) VALUES (?,?,?,?,?,?,?,?)`).run(item.id,transaction_type,qty,newStock,uc,totalCost,notes||null,date);
  db.prepare(`UPDATE inventory SET current_stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newStock,item.id);
  res.json({ success:true, new_stock:newStock });
});

// ─── BACKUP & RESTORE ─────────────────────────────────────────────────────────

app.get('/api/backup/export', (req, res) => {
  try {
    const settings = {};
    db.prepare('SELECT key,value FROM clinic_settings').all().forEach(r => settings[r.key] = r.value);
    const backup = {
      version: '1.0',
      app: 'Dental Clinic Management System',
      exported_at: new Date().toISOString(),
      data: {
        settings,
        patients:                db.prepare('SELECT * FROM patients').all(),
        staff:                   db.prepare('SELECT * FROM staff').all(),
        services:                db.prepare('SELECT * FROM services').all(),
        appointments:            db.prepare('SELECT * FROM appointments').all(),
        treatments:              db.prepare('SELECT * FROM treatments').all(),
        invoices:                db.prepare('SELECT * FROM invoices').all(),
        invoice_items:           db.prepare('SELECT * FROM invoice_items').all(),
        inventory:               db.prepare('SELECT * FROM inventory').all(),
        inventory_transactions:  db.prepare('SELECT * FROM inventory_transactions').all(),
      }
    };
    const filename = `dental-backup-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(backup);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/download-db', (req, res) => {
  const dbPath = path.join(__dirname, 'database', 'dental.db');
  const filename = `dental-db-${new Date().toISOString().split('T')[0]}.db`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(dbPath);
});

app.post('/api/backup/restore', express.json({ limit: '100mb' }), (req, res) => {
  const { data, version } = req.body;
  if (!data) return res.status(400).json({ error: 'Invalid backup file — missing data section.' });
  try {
    db.exec('BEGIN');
    // Clear all tables in dependency order
    db.exec(`DELETE FROM inventory_transactions; DELETE FROM inventory;
             DELETE FROM invoice_items; DELETE FROM invoices;
             DELETE FROM treatments; DELETE FROM appointments;
             DELETE FROM services; DELETE FROM staff; DELETE FROM patients;
             DELETE FROM clinic_settings;`);
    // Reset auto-increment sequences
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN
             ('patients','staff','services','appointments','treatments',
              'invoices','invoice_items','inventory','inventory_transactions')`);

    if (data.settings) {
      const s = db.prepare('INSERT INTO clinic_settings (key,value) VALUES (?,?)');
      Object.entries(data.settings).forEach(([k,v]) => s.run(k,v));
    }
    if (data.patients?.length) {
      const s = db.prepare(`INSERT INTO patients (id,patient_number,first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number,photo,photo_thumb,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      data.patients.forEach(r => s.run(r.id,r.patient_number,r.first_name,r.last_name,r.date_of_birth,r.gender,r.phone,r.email,r.address,r.city,r.medical_history,r.allergies,r.insurance_provider,r.insurance_number,r.photo,r.photo_thumb,r.created_at,r.updated_at));
    }
    if (data.staff?.length) {
      const s = db.prepare(`INSERT INTO staff (id,first_name,last_name,role,specialization,phone,email,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
      data.staff.forEach(r => s.run(r.id,r.first_name,r.last_name,r.role,r.specialization,r.phone,r.email,r.active,r.created_at));
    }
    if (data.services?.length) {
      const s = db.prepare(`INSERT INTO services (id,name,category,duration,price,description,active,created_at) VALUES (?,?,?,?,?,?,?,?)`);
      data.services.forEach(r => s.run(r.id,r.name,r.category,r.duration,r.price,r.description,r.active,r.created_at));
    }
    if (data.appointments?.length) {
      const s = db.prepare(`INSERT INTO appointments (id,patient_id,dentist_id,service_id,appointment_date,appointment_time,duration,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      data.appointments.forEach(r => s.run(r.id,r.patient_id,r.dentist_id,r.service_id,r.appointment_date,r.appointment_time,r.duration,r.status,r.notes,r.created_at,r.updated_at));
    }
    if (data.treatments?.length) {
      const s = db.prepare(`INSERT INTO treatments (id,patient_id,appointment_id,dentist_id,treatment_date,tooth_number,diagnosis,procedure_name,notes,cost,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      data.treatments.forEach(r => s.run(r.id,r.patient_id,r.appointment_id,r.dentist_id,r.treatment_date,r.tooth_number,r.diagnosis,r.procedure_name,r.notes,r.cost,r.created_at));
    }
    if (data.invoices?.length) {
      const s = db.prepare(`INSERT INTO invoices (id,invoice_number,patient_id,appointment_id,issue_date,due_date,subtotal,tax_rate,tax_amount,discount,total,amount_paid,balance,payment_status,payment_method,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      data.invoices.forEach(r => s.run(r.id,r.invoice_number,r.patient_id,r.appointment_id,r.issue_date,r.due_date,r.subtotal,r.tax_rate,r.tax_amount,r.discount,r.total,r.amount_paid,r.balance,r.payment_status,r.payment_method,r.notes,r.created_at,r.updated_at));
    }
    if (data.invoice_items?.length) {
      const s = db.prepare(`INSERT INTO invoice_items (id,invoice_id,service_id,description,quantity,unit_price,total) VALUES (?,?,?,?,?,?,?)`);
      data.invoice_items.forEach(r => s.run(r.id,r.invoice_id,r.service_id,r.description,r.quantity,r.unit_price,r.total));
    }
    if (data.inventory?.length) {
      const s = db.prepare(`INSERT INTO inventory (id,item_code,name,category,unit,current_stock,min_stock,unit_cost,supplier,location,notes,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      data.inventory.forEach(r => s.run(r.id,r.item_code,r.name,r.category,r.unit,r.current_stock,r.min_stock,r.unit_cost,r.supplier,r.location,r.notes,r.active,r.created_at,r.updated_at));
    }
    if (data.inventory_transactions?.length) {
      const s = db.prepare(`INSERT INTO inventory_transactions (id,item_id,transaction_type,quantity,balance_after,unit_cost,total_cost,reference,notes,transaction_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      data.inventory_transactions.forEach(r => s.run(r.id,r.item_id,r.transaction_type,r.quantity,r.balance_after,r.unit_cost,r.total_cost,r.reference,r.notes,r.transaction_date,r.created_at));
    }
    db.exec('COMMIT');
    res.json({ success:true, restored: {
      patients: data.patients?.length||0, staff: data.staff?.length||0,
      appointments: data.appointments?.length||0, invoices: data.invoices?.length||0,
      inventory: data.inventory?.length||0, services: data.services?.length||0,
    }});
  } catch(e) {
    try { db.exec('ROLLBACK'); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

// ─── SMS ──────────────────────────────────────────────────────────────────────

app.post('/api/sms/send', async (req, res) => {
  const { to, message, appointment_id, patient_id } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
  try {
    const result = await sms.sendSMS({ to, message, appointment_id, patient_id });
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sms/logs', (req, res) => {
  const { limit = 100 } = req.query;
  const rows = db.prepare(`
    SELECT l.*, p.first_name||' '||p.last_name as patient_name
    FROM sms_logs l
    LEFT JOIN patients p ON l.patient_id = p.id
    ORDER BY l.sent_at DESC LIMIT ?`).all(parseInt(limit));
  res.json(rows);
});

app.delete('/api/sms/logs', (req, res) => {
  db.prepare(`DELETE FROM sms_logs`).run();
  res.json({ success: true });
});

// Build and send SMS for an appointment (uses configured template)
app.post('/api/sms/appointment/:id', async (req, res) => {
  const { type = 'booking' } = req.body; // booking | reminder | cancellation
  const appt = db.prepare(`
    SELECT a.*, p.first_name||' '||p.last_name as patient_name, p.phone as patient_phone, p.id as patient_id,
           s.name as service_name, st.first_name||' '||st.last_name as dentist_name
    FROM appointments a
    LEFT JOIN patients p ON a.patient_id=p.id
    LEFT JOIN services s ON a.service_id=s.id
    LEFT JOIN staff st ON a.dentist_id=st.id
    WHERE a.id=?`).get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.patient_phone) return res.status(400).json({ error: 'Patient has no phone number on record.' });

  const cfg = sms.getConfig();
  const templateKey = `sms_template_${type}`;
  const template = cfg[templateKey] ||
    'Dear {patient_name}, you have an appointment at {clinic_name} on {date} at {time}.';

  const dateStr = appt.appointment_date
    ? (() => { const p=appt.appointment_date.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; })()
    : '';

  const filled = sms.fillTemplate(template, {
    patient_name: appt.patient_name || '',
    date:         dateStr,
    time:         appt.appointment_time || '',
    clinic_name:  cfg.clinic_name || 'Dental Clinic',
    clinic_phone: cfg.clinic_phone || '',
    dentist_name: appt.dentist_name || '',
    service:      appt.service_name || ''
  });

  try {
    const result = await sms.sendSMS({ to: appt.patient_phone, message: filled, appointment_id: appt.id, patient_id: appt.patient_id });
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SMS AUTOMATION ───────────────────────────────────────────────────────────

// Shared: build message from template and send for a given appointment
async function _sendApptSMS(apptId, type, cfg) {
  cfg = cfg || sms.getConfig();
  const appt = db.prepare(`
    SELECT a.*, p.first_name||' '||p.last_name as patient_name,
           p.phone as patient_phone, p.id as patient_id,
           s.name  as service_name,
           st.first_name||' '||st.last_name as dentist_name
    FROM appointments a
    LEFT JOIN patients p ON a.patient_id = p.id
    LEFT JOIN services s ON a.service_id  = s.id
    LEFT JOIN staff   st ON a.dentist_id  = st.id
    WHERE a.id = ?`).get(apptId);

  if (!appt?.patient_phone) return; // no phone — skip silently

  const templateKey = `sms_template_${type}`;
  const template = cfg[templateKey] ||
    'Dear {patient_name}, your appointment at {clinic_name} is set for {date} at {time}. Contact: {clinic_phone}';

  const dp  = (appt.appointment_date || '').split('-');
  const dateStr = dp.length === 3 ? `${dp[2]}/${dp[1]}/${dp[0]}` : appt.appointment_date;

  const message = sms.fillTemplate(template, {
    patient_name: appt.patient_name  || '',
    date:         dateStr,
    time:         appt.appointment_time || '',
    clinic_name:  cfg.clinic_name    || 'Dental Clinic',
    clinic_phone: cfg.clinic_phone   || '',
    dentist_name: appt.dentist_name  || '',
    service:      appt.service_name  || ''
  });

  await sms.sendSMS({ to: appt.patient_phone, message, appointment_id: appt.id, patient_id: appt.patient_id });
}

// Reminder scheduler — runs every 30 minutes
async function _checkAndSendReminders() {
  try {
    const cfg = sms.getConfig();
    if (cfg.sms_auto_reminder === '0') return;

    const hoursAhead = Math.max(1, parseInt(cfg.sms_reminder_hours || '24'));
    const targetDate = new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString().split('T')[0];

    const appts = db.prepare(`
      SELECT a.id FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      WHERE a.appointment_date = ?
        AND a.status IN ('scheduled','confirmed')
        AND a.reminder_sms_sent = 0
        AND p.phone IS NOT NULL AND p.phone != ''
    `).all(targetDate);

    for (const { id } of appts) {
      try {
        await _sendApptSMS(id, 'reminder', cfg);
        db.prepare(`UPDATE appointments SET reminder_sms_sent = 1 WHERE id = ?`).run(id);
        console.log(`  [SMS Reminder] Sent for appointment #${id}`);
      } catch(e) {
        console.error(`  [SMS Reminder] Failed for appointment #${id}: ${e.message}`);
      }
    }
  } catch(e) { console.error('[SMS Scheduler]', e.message); }
}

function _startSmsScheduler() {
  const INTERVAL = 30 * 60 * 1000; // 30 minutes
  _checkAndSendReminders();         // run once on startup
  setInterval(_checkAndSendReminders, INTERVAL);
  console.log('  [SMS] Reminder scheduler active — checks every 30 min');
}

// ─── SERVE SPA ────────────────────────────────────────────────────────────────

app.get('*', serveIndex);

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[API Error]', req.method, req.path, err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

process.on('uncaughtException', err => {
  console.error('[Server] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('[Server] Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  Dental Clinic Management System     ║`);
  console.log(`  ║  Running at: http://localhost:${PORT}    ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  _startSmsScheduler();
});
