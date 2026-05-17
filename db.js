const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const dbDir = path.join(__dirname, 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(path.join(dbDir, 'dental.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_number TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    date_of_birth DATE, gender TEXT, phone TEXT, email TEXT,
    address TEXT, city TEXT, medical_history TEXT, allergies TEXT,
    insurance_provider TEXT, insurance_number TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    role TEXT DEFAULT 'Dentist', specialization TEXT, phone TEXT, email TEXT,
    active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, category TEXT, duration INTEGER DEFAULT 30,
    price REAL DEFAULT 0, description TEXT, active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL, dentist_id INTEGER, service_id INTEGER,
    appointment_date DATE NOT NULL, appointment_time TIME NOT NULL,
    duration INTEGER DEFAULT 30, status TEXT DEFAULT 'scheduled', notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (dentist_id) REFERENCES staff(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
  );
  CREATE TABLE IF NOT EXISTS treatments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL, appointment_id INTEGER, dentist_id INTEGER,
    treatment_date DATE NOT NULL, tooth_number TEXT, diagnosis TEXT,
    procedure_name TEXT, notes TEXT, cost REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id),
    FOREIGN KEY (dentist_id) REFERENCES staff(id)
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL, patient_id INTEGER NOT NULL, appointment_id INTEGER,
    issue_date DATE NOT NULL, due_date DATE,
    subtotal REAL DEFAULT 0, tax_rate REAL DEFAULT 0, tax_amount REAL DEFAULT 0,
    discount REAL DEFAULT 0, total REAL DEFAULT 0,
    amount_paid REAL DEFAULT 0, balance REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'unpaid', payment_method TEXT, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id),
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );
  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL, service_id INTEGER,
    description TEXT NOT NULL, quantity INTEGER DEFAULT 1,
    unit_price REAL DEFAULT 0, total REAL DEFAULT 0,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    category TEXT, unit TEXT DEFAULT 'pcs',
    current_stock REAL DEFAULT 0, min_stock REAL DEFAULT 0,
    unit_cost REAL DEFAULT 0, supplier TEXT, location TEXT, notes TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL, transaction_type TEXT NOT NULL,
    quantity REAL NOT NULL, balance_after REAL,
    unit_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0,
    reference TEXT, notes TEXT, transaction_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES inventory(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS clinic_settings (
    key TEXT PRIMARY KEY, value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sms_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_number TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    provider TEXT,
    error_message TEXT,
    appointment_id INTEGER,
    patient_id INTEGER,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Activity Log ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── Users & Sessions ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    permissions TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Seed default admin user (only on first run)
if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
  const crypto = require('crypto');
  const salt   = crypto.randomBytes(16).toString('hex');
  const hash   = crypto.pbkdf2Sync('admin123', salt, 10000, 64, 'sha512').toString('hex');
  db.prepare(`INSERT INTO users (username,password_hash,salt,full_name,role,permissions) VALUES (?,?,?,?,?,?)`)
    .run('admin', hash, salt, 'Administrator', 'admin', '["all"]');
}

// Default settings — always force OMR for existing DBs too
const upsertSetting = db.prepare(`INSERT OR REPLACE INTO clinic_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)`);
const insertIgnore  = db.prepare(`INSERT OR IGNORE INTO clinic_settings (key,value) VALUES (?,?)`);
[
  ['clinic_name', 'Bright Smile Dental Clinic'],
  ['clinic_address', '123 Medical Street, Suite 100'],
  ['clinic_city', 'Muscat, Oman'],
  ['clinic_phone', '+968-24123456'],
  ['clinic_email', 'info@brightsmile.com'],
  ['clinic_website', 'www.brightsmile.com'],
  ['working_start', '08:00'],
  ['working_end', '18:00'],
  ['appointment_duration', '30'],
  ['tax_rate', '0'],
  ['clinic_signature', ''],
  ['clinic_stamp', ''],
].forEach(([k,v]) => insertIgnore.run(k,v));
// Always enforce OMR currency
upsertSetting.run('currency_symbol', 'OMR');

// Migrations
try { db.exec('ALTER TABLE appointments ADD COLUMN reminder_sms_sent INTEGER DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE patients ADD COLUMN photo TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE patients ADD COLUMN photo_thumb TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE patients ADD COLUMN created_by_user_id INTEGER REFERENCES users(id)'); } catch(_) {}
// Set Omantel as default provider (only if provider was previously 'none' or unset)
const currentProvider = db.prepare(`SELECT value FROM clinic_settings WHERE key='sms_provider'`).get();
if (!currentProvider || currentProvider.value === 'none') {
  upsertSetting.run('sms_provider', 'omantel');
}
// SMS defaults (only insert if not already set)
[
  ['sms_provider',             'omantel'],
  ['sms_sender_id',            'Clinic'],
  ['sms_omantel_url',          'https://smsvas.com/bulk/public/index.php/api/v1/sendsms'],
  ['sms_omantel_username',     ''],
  ['sms_omantel_password',     ''],
  ['sms_auto_booking',         '1'],
  ['sms_auto_reminder',        '1'],
  ['sms_reminder_hours',       '24'],
  ['sms_twilio_sid',           ''],
  ['sms_twilio_token',         ''],
  ['sms_twilio_phone',         ''],
  ['sms_unifonic_sid',         ''],
  ['sms_template_booking',     'Dear {patient_name}, your appointment at {clinic_name} is confirmed for {date} at {time}. Dentist: {dentist_name}. Contact: {clinic_phone}'],
  ['sms_template_reminder',    'Reminder: Dear {patient_name}, you have an appointment at {clinic_name} on {date} at {time}. Please arrive 10 minutes early. Contact: {clinic_phone}'],
  ['sms_template_cancellation','Dear {patient_name}, your appointment at {clinic_name} on {date} at {time} has been cancelled. Please contact us to reschedule: {clinic_phone}'],
].forEach(([k,v]) => insertIgnore.run(k,v));

// Seed staff
if (db.prepare('SELECT COUNT(*) as c FROM staff').get().c === 0) {
  const ins = db.prepare(`INSERT INTO staff (first_name,last_name,role,specialization,phone,email) VALUES (?,?,?,?,?,?)`);
  ins.run('Sarah','Al-Balushi','Dentist','General Dentistry','+968-91234567','sarah@brightsmile.com');
  ins.run('Mohammed','Al-Rashdi','Dentist','Orthodontics','+968-92345678','mohammed@brightsmile.com');
  ins.run('Fatima','Al-Hinai','Hygienist','Dental Hygiene','+968-93456789','fatima@brightsmile.com');
}

// Seed services
if (db.prepare('SELECT COUNT(*) as c FROM services').get().c === 0) {
  const ins = db.prepare(`INSERT INTO services (name,category,duration,price,description) VALUES (?,?,?,?,?)`);
  [
    ['Dental Cleaning','Preventive',60,15.000,'Professional teeth cleaning and polishing'],
    ['Full Mouth X-Ray','Diagnostic',30,20.000,'Complete radiographic examination'],
    ['Tooth Extraction (Simple)','Surgical',60,25.000,'Simple tooth removal'],
    ['Surgical Extraction','Surgical',90,45.000,'Complex tooth removal including wisdom teeth'],
    ['Root Canal Treatment','Endodontic',90,80.000,'Root canal therapy (per canal)'],
    ['Composite Filling','Restorative',45,20.000,'Tooth-colored resin filling'],
    ['Amalgam Filling','Restorative',45,15.000,'Silver alloy filling'],
    ['Dental Crown','Restorative',90,95.000,'Porcelain or metal crown'],
    ['Dental Bridge','Prosthetic',120,190.000,'Fixed 3-unit bridge'],
    ['Teeth Whitening','Cosmetic',60,35.000,'In-office whitening treatment'],
    ['Orthodontic Consultation','Orthodontic',30,10.000,'Initial braces/Invisalign assessment'],
    ['Metal Braces','Orthodontic',120,450.000,'Traditional metal braces (full treatment)'],
    ['Invisalign','Orthodontic',60,550.000,'Clear aligner treatment'],
    ['Dental Implant','Implant',120,320.000,'Single tooth titanium implant'],
    ['Dentures (Full)','Prosthetic',60,160.000,'Complete upper or lower denture'],
    ['Night Guard','Preventive',30,35.000,'Custom occlusal guard for bruxism'],
    ['Fluoride Treatment','Preventive',15,4.500,'Topical fluoride application'],
    ['Dental Sealants','Preventive',30,6.500,'Protective sealant per tooth'],
  ].forEach(r => ins.run(...r));
}

// Seed patients
if (db.prepare('SELECT COUNT(*) as c FROM patients').get().c === 0) {
  const ins = db.prepare(`INSERT INTO patients (patient_number,first_name,last_name,date_of_birth,gender,phone,email,address,city,medical_history,allergies,insurance_provider,insurance_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ['P00001','Ahmed','Al-Siyabi','1985-03-15','Male','+968-91111222','ahmed@email.com','Way 3012, Al-Khuwair','Muscat','None','Penicillin','DAMAN','DM-123456'],
    ['P00002','Aisha','Al-Kalbani','1990-07-22','Female','+968-92222333','aisha@email.com','Way 5041, Ruwi','Muscat','Type 2 Diabetes','None','Takaful Oman','TO-789012'],
    ['P00003','Khalid','Al-Amri','1975-11-08','Male','+968-93333444','khalid@email.com','Al-Seeb Street','Seeb','Hypertension','Aspirin','NLGIC','NL-345678'],
    ['P00004','Maryam','Al-Harthi','1995-04-30','Female','+968-94444555','maryam@email.com','Al-Qurum','Muscat','None','None','Al-Ahlia','AA-901234'],
    ['P00005','Salim','Al-Ghafri','1968-09-12','Male','+968-95555666','salim@email.com','Way 1201, Bausher','Muscat','Heart Disease - on Warfarin','Warfarin','OIFC','OI-567890'],
    ['P00006','Noor','Al-Lawati','2001-01-25','Female','+968-96666777','noor@email.com','Al-Hail','Muscat','None','Latex','DAMAN','DM-112233'],
    ['P00007','Omar','Al-Maqbali','1982-06-14','Male','+968-97777888','omar@email.com','Sohar','Sohar','Asthma','Sulfa drugs','Takaful Oman','TO-445566'],
  ].forEach(r => ins.run(...r));

  const todayStr  = new Date().toISOString().split('T')[0];
  const tomorrow  = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
  const lastMonth = new Date(Date.now()-30*86400000).toISOString().split('T')[0];

  const iA = db.prepare(`INSERT INTO appointments (patient_id,dentist_id,service_id,appointment_date,appointment_time,duration,status,notes) VALUES (?,?,?,?,?,?,?,?)`);
  iA.run(1,1,1,todayStr,'09:00',60,'scheduled','Regular cleaning');
  iA.run(2,2,11,todayStr,'10:30',30,'confirmed','Initial braces consultation');
  iA.run(3,1,5,todayStr,'14:00',90,'scheduled','Root canal treatment');
  iA.run(4,1,1,tomorrow,'09:30',60,'scheduled','Annual cleaning');
  iA.run(5,2,12,tomorrow,'11:00',120,'confirmed','Braces check-up');
  iA.run(1,1,6,yesterday,'10:00',45,'completed','Filling replacement');
  iA.run(2,2,10,yesterday,'14:30',60,'completed','Whitening treatment');
  iA.run(3,1,1,lastMonth,'09:00',60,'completed','Routine cleaning');
  iA.run(6,1,8,lastMonth,'11:00',90,'completed','Crown preparation');
  iA.run(7,2,4,lastMonth,'15:00',90,'cancelled','Patient no-show');

  const iT = db.prepare(`INSERT INTO treatments (patient_id,appointment_id,dentist_id,treatment_date,tooth_number,diagnosis,procedure_name,notes,cost) VALUES (?,?,?,?,?,?,?,?,?)`);
  iT.run(1,6,1,yesterday,'#14','Carious lesion','Composite Filling','Small cavity, composite resin applied',20.000);
  iT.run(2,7,2,yesterday,null,'Tooth discoloration','Teeth Whitening','3 shades improvement',35.000);
  iT.run(3,8,1,lastMonth,null,'Plaque buildup','Dental Cleaning','Full mouth scaling',15.000);
  iT.run(6,9,1,lastMonth,'#30','Crown fracture','Dental Crown','PFM crown placed',95.000);

  const iI = db.prepare(`INSERT INTO invoices (invoice_number,patient_id,appointment_id,issue_date,due_date,subtotal,tax_rate,tax_amount,discount,total,amount_paid,balance,payment_status,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  iI.run('INV-2024-0001',1,6,yesterday,todayStr,20,0,0,0,20,20,0,'paid','Cash');
  iI.run('INV-2024-0002',2,7,yesterday,todayStr,35,0,0,0,35,35,0,'paid','Credit Card');
  iI.run('INV-2024-0003',3,8,lastMonth,todayStr,15,0,0,0,15,0,15,'unpaid',null);
  iI.run('INV-2024-0004',6,9,lastMonth,todayStr,95,0,0,5,90,45,45,'partial','Insurance');

  const iIi = db.prepare(`INSERT INTO invoice_items (invoice_id,service_id,description,quantity,unit_price,total) VALUES (?,?,?,?,?,?)`);
  iIi.run(1,6,'Composite Filling - Tooth #14',1,20,20);
  iIi.run(2,10,'Teeth Whitening Treatment',1,35,35);
  iIi.run(3,1,'Dental Cleaning - Full Mouth',1,15,15);
  iIi.run(4,8,'Dental Crown - Tooth #30',1,95,95);
}

// Seed inventory
if (db.prepare('SELECT COUNT(*) as c FROM inventory').get().c === 0) {
  const ins = db.prepare(`INSERT INTO inventory (item_code,name,category,unit,current_stock,min_stock,unit_cost,supplier,location,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  [
    ['INV001','Nitrile Gloves (S)','PPE','box(100)',50,10,3.500,'MedSupply Oman','Cabinet A','Powder-free'],
    ['INV002','Nitrile Gloves (M)','PPE','box(100)',45,10,3.500,'MedSupply Oman','Cabinet A','Powder-free'],
    ['INV003','Nitrile Gloves (L)','PPE','box(100)',30,10,3.500,'MedSupply Oman','Cabinet A','Powder-free'],
    ['INV004','Surgical Face Masks','PPE','box(50)',8,15,2.750,'MedSupply Oman','Cabinet A','3-ply disposable'],
    ['INV005','Disposable Aprons','PPE','roll(100)',12,5,4.500,'MedSupply Oman','Storage',''],
    ['INV006','Dental Syringes (Aspirating)','Instruments','pcs',120,20,1.200,'DentaSupply Oman','Cabinet B',''],
    ['INV007','Lidocaine 2% Cartridges','Anesthetics','box(50)',6,5,35.000,'Oman Pharma','Refrigerator','Keep refrigerated'],
    ['INV008','Articaine 4% Cartridges','Anesthetics','box(50)',3,5,42.000,'Oman Pharma','Refrigerator','Low stock - reorder'],
    ['INV009','Composite Resin A2 (4g)','Restorative','unit',15,5,28.500,'DentaSupply Oman','Cabinet C',''],
    ['INV010','Composite Resin A3 (4g)','Restorative','unit',12,5,28.500,'DentaSupply Oman','Cabinet C',''],
    ['INV011','Glass Ionomer Cement','Restorative','kit',8,3,22.000,'DentaSupply Oman','Cabinet C',''],
    ['INV012','Temporary Cement (IRM)','Restorative','unit',4,3,15.000,'DentaSupply Oman','Cabinet C',''],
    ['INV013','X-Ray Films Size 2','Radiology','box(150)',2,2,45.000,'RadioDent Oman','Lead Cabinet','Expiry check needed'],
    ['INV014','Cotton Rolls','Consumables','bag(500)',10,3,3.250,'MedSupply Oman','Cabinet D',''],
    ['INV015','Gauze Pads 2x2','Consumables','box(200)',15,5,2.750,'MedSupply Oman','Cabinet D',''],
    ['INV016','Saliva Ejectors','Consumables','bag(100)',20,5,1.750,'MedSupply Oman','Cabinet D',''],
    ['INV017','Dental Floss Rolls','Preventive','pcs',50,10,0.650,'DentaSupply Oman','Reception',''],
    ['INV018','Prophy Paste Medium','Preventive','jar',8,3,6.000,'DentaSupply Oman','Cabinet E',''],
    ['INV019','Carbide Burs Round #4','Burs','box(10)',6,2,9.250,'DentaSupply Oman','Instrument Room',''],
    ['INV020','Diamond Burs Assorted','Burs','box(10)',4,2,12.500,'DentaSupply Oman','Instrument Room',''],
    ['INV021','Matrix Bands (Tofflemire)','Instruments','box(50)',3,2,4.000,'DentaSupply Oman','Cabinet B',''],
    ['INV022','Alginate Impression Material','Impression','kg',5,2,11.000,'DentaSupply Oman','Cabinet F',''],
    ['INV023','Suture 3-0 Silk','Surgical','box(12)',8,3,16.000,'Oman Pharma','Surgical Room',''],
    ['INV024','Chlorhexidine Mouthwash','Medications','bottle',20,5,2.250,'Oman Pharma','Medicine Cabinet',''],
    ['INV025','Dental Dam Kit','Endodontic','kit',5,2,24.000,'DentaSupply Oman','Endo Room',''],
  ].forEach(r => ins.run(...r));

  // Initial stock transactions
  const iT2 = db.prepare(`INSERT INTO inventory_transactions (item_id,transaction_type,quantity,balance_after,unit_cost,total_cost,notes,transaction_date) VALUES (?,?,?,?,?,?,?,?)`);
  const d1 = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  iT2.run(4,  'out', 7,  8,  2.750, 19.250,'Weekly usage', d1);
  iT2.run(7,  'out', 4,  6,  35.000,140.000,'Clinical use', d1);
  iT2.run(8,  'out', 2,  3,  42.000,84.000,'Clinical use', d1);
  iT2.run(1,  'in',  100,150, 3.500,350.000,'Monthly restock', d1);
}

module.exports = db;
