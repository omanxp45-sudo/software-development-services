'use strict';

// ═══════════════════════════════════════════
// GLOBALS & UTILS
// ═══════════════════════════════════════════
let SETTINGS = {};
let allPatients = [], allStaff = [], allServices = [];
let _currentPatient = null;
let _authToken = sessionStorage.getItem('clinic_token') || null;
let _currentUser = null;
let currentTreatments = [];
let _loadedAppts = [];
let _loadedInvs  = [];
let currentInvoiceItems = [];
let currentViewingInvoiceId = null;
let confirmCallback = null;
let currentLang = 'en';
let currentSection = 'dashboard';

const translations = {
  en: {
    dir: 'ltr',
    name: 'English',
    nav: { dashboard: 'Dashboard', patients: 'Patients', appointments: 'Appointments', treatments: 'Treatments', invoices: 'Billing', reports: 'Reports', settings: 'Settings', about: 'About' },
    pageTitles: { dashboard: 'Dashboard', patients: 'Patients', appointments: 'Appointments', treatments: 'Treatments', invoices: 'Billing & Invoices', reports: 'Reports & Analytics', settings: 'Settings', about: 'About' },
    topbar: { online: 'Online' }
  },
  ar: {
    dir: 'rtl',
    name: 'العربية',
    nav: { dashboard: 'لوحة التحكم', patients: 'المرضى', appointments: 'المواعيد', treatments: 'العلاجات', invoices: 'الفواتير', reports: 'التقارير', settings: 'الإعدادات', about: 'حول' },
    pageTitles: { dashboard: 'لوحة المعلومات', patients: 'المرضى', appointments: 'المواعيد', treatments: 'العلاجات', invoices: 'الفواتير', reports: 'التقارير والتحليلات', settings: 'الإعدادات', about: 'حول' },
    topbar: { online: 'متصل' }
  }
};

const $ = id => document.getElementById(id);

// Barcode-aware search — typing = instant client-side filter, Enter = API search + auto-open
// typeFn  : called on each keystroke (debounced 250ms) — should filter in-memory, no re-render
// enterFn : called on Enter / barcode scan — may call API and auto-open single result
function _searchBox(inputId, placeholder, typeFn, enterFn, extraStyle='') {
  const ef = enterFn || typeFn;
  return `<div class="search-box" style="min-width:250px;${extraStyle}">
    <i class="fas fa-search"></i>
    <input type="text" class="form-control" id="${inputId}" placeholder="${placeholder}"
      style="padding-right:52px" autocomplete="off"
      oninput="_debouncedSearch('${inputId}','${typeFn}',250);_showClear('${inputId}',this.value)"
      onkeydown="if(event.key==='Enter'){event.preventDefault();clearTimeout(_searchTimers['${inputId}']);_runSearch('${inputId}','${ef}');}else if(event.key==='Escape'){_clearSearch('${inputId}');}"/>
    <span id="${inputId}-clr" data-type-fn="${typeFn}"
      style="position:absolute;right:30px;top:50%;transform:translateY(-50%);cursor:pointer;color:#aaa;display:none;font-size:15px;z-index:2;line-height:1;user-select:none;"
      onclick="_clearSearch('${inputId}')">&#10005;</span>
    <i class="fas fa-barcode" style="left:auto;right:9px;color:#cbd5e1;pointer-events:none;" title="Type to search · Enter to scan barcode"></i>
  </div>`;
}
const _searchTimers = {};
function _debouncedSearch(id, fn, delay) {
  clearTimeout(_searchTimers[id]);
  _searchTimers[id] = setTimeout(() => _runSearch(id, fn), delay);
}
function _runSearch(id, fn) {
  window[fn]($(id)?.value || '');
}
function _showClear(id, val) {
  const c = document.getElementById(id+'-clr');
  if (c) c.style.display = val ? 'inline' : 'none';
}
function _clearSearch(inputId) {
  const el = $(inputId);
  if (el) { el.value = ''; el.focus(); }
  _showClear(inputId, '');
  clearTimeout(_searchTimers[inputId]);
  const fn = document.getElementById(inputId+'-clr')?.dataset.typeFn;
  if (fn && window[fn]) window[fn]('');
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html) e.innerHTML = html; return e; };

async function api(method, url, data) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (_authToken) opts.headers['x-session-token'] = _authToken;
  if (data) opts.body = JSON.stringify(data);
  const r = await fetch(url, opts);
  if (r.status === 401) { showLoginScreen(); throw new Error('Session expired — please log in again.'); }
  if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
  return r.json();
}

const get  = url        => api('GET', url);
const post = (url, d)   => api('POST', url, d);
const put  = (url, d)   => api('PUT', url, d);
const del  = url        => api('DELETE', url);

function fmt(n, sym) { return (sym||SETTINGS.currency_symbol||'ر.ع.') + ' ' + parseFloat(n||0).toFixed(2); }
function fmtDate(d) { if (!d) return '—'; const s = String(d).split('T')[0].split(' ')[0]; const p = s.split('-'); return p.length===3 ? `${p[2]}/${p[1]}/${p[0]}` : d; }
function fmtDateTime(d) {
  let dt;
  if (!d) { dt = new Date(); }
  else if (d instanceof Date) { dt = d; }
  else {
    // SQLite stores CURRENT_TIMESTAMP as UTC without timezone marker.
    // Append 'Z' so JavaScript parses it as UTC → displays in local time.
    const s = String(d).trim();
    dt = new Date(/[TZ+]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  }
  const dd=String(dt.getDate()).padStart(2,'0'), mm=String(dt.getMonth()+1).padStart(2,'0'),
        yyyy=dt.getFullYear(), HH=String(dt.getHours()).padStart(2,'0'), MM=String(dt.getMinutes()).padStart(2,'0');
  return `${dd}/${mm}/${yyyy} ${HH}:${MM}`;
}
function today() { return new Date().toISOString().split('T')[0]; }
function esc(s) { if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type='success') {
  const t = $('main-toast');
  t.className = `toast align-items-center text-white border-0 bg-${type==='error'?'danger':type==='warning'?'warning':type==='info'?'info':'success'}`;
  $('toast-message').textContent = msg;
  bootstrap.Toast.getOrCreateInstance(t, { delay: 3000 }).show();
}
const showToast = toast;

function confirm(msg, cb) {
  $('confirm-message').textContent = msg;
  confirmCallback = cb;
  bootstrap.Modal.getOrCreateInstance($('confirmModal')).show();
}

function showModal(id) { bootstrap.Modal.getOrCreateInstance($(id)).show(); }
function hideModal(id) { bootstrap.Modal.getOrCreateInstance($(id)).hide(); }
function _markAddMode(modalId, isAdd) { const el = document.querySelector(`#${modalId} .modal-content`); if (el) el.classList.toggle('add-mode', !!isAdd); }

// ── Name field validation ─────────────────────────────────────────────────
function validateName(value) {
  const v = (value||'').trim();
  if (!v) return 'This field is required';
  if (!/^[A-Z]/.test(v)) return 'Must start with a capital letter';
  if (/[0-9]/.test(v)) return 'Must not contain numbers';
  if (/[^A-Za-z\s'\-]/.test(v)) return 'Must contain letters only';
  return null;
}

function _nameFieldFeedback(el) {
  const err = validateName(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && el.value.trim().length > 0);
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachNameValidation(...ids) {
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('is-valid','is-invalid');
    const fb = el.parentNode.querySelector('.invalid-feedback');
    if (fb) fb.textContent = '';

    // Block numbers and symbols at keypress level
    el.onkeydown = e => {
      const ctrl = e.ctrlKey || e.metaKey;
      const nav  = ['Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
                    'Home','End','Tab','Enter'].includes(e.key);
      if (ctrl || nav) return;                        // always allow control keys
      if (!/^[A-Za-z\s'\-]$/.test(e.key)) e.preventDefault(); // block anything else
    };

    // Strip on paste (handles copy-paste of invalid chars)
    el.onpaste = e => {
      e.preventDefault();
      const raw     = (e.clipboardData || window.clipboardData).getData('text');
      const cleaned = raw.replace(/[^A-Za-z\s'\-]/g, '');
      const s = el.selectionStart, end = el.selectionEnd;
      el.value = el.value.slice(0, s) + cleaned + el.value.slice(end);
      el.setSelectionRange(s + cleaned.length, s + cleaned.length);
      el.dispatchEvent(new Event('input'));
    };

    // Auto-capitalise + live validation
    el.oninput = () => {
      const pos = el.selectionStart;
      const cap = el.value.replace(/(?:^|[\s\-'])\S/g, c => c.toUpperCase());
      if (cap !== el.value) { el.value = cap; el.setSelectionRange(pos, pos); }
      _nameFieldFeedback(el);
    };
  });
}

// ── Date of Birth validation ──────────────────────────────────────────────
function validateDOB(value) {
  if (!value) return 'Date of birth is required';
  const parts = value.split('-');
  if (parts.length !== 3) return 'Must be a valid date';
  const [y, m, d] = parts.map(Number);
  // Check the calendar date is real (catches Feb 31, Apr 31, etc.)
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() + 1 !== m || parsed.getDate() !== d)
    return 'Invalid date — day and month do not match (e.g. 31 Feb does not exist)';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (parsed > today) return 'Date of birth cannot be in the future';
  const minYear = new Date(); minYear.setFullYear(minYear.getFullYear() - 120);
  if (parsed < minYear) return 'Age cannot exceed 120 years';
  return null;
}

function _dobFeedback(el) {
  const err = validateDOB(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && !!el.value);
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachDOBValidation(id) {
  const el = $(id);
  if (!el) return;
  el.max = today();
  const min = new Date(); min.setFullYear(min.getFullYear() - 120);
  el.min = min.toISOString().split('T')[0];
  el.classList.remove('is-valid', 'is-invalid');
  const fb = el.parentNode.querySelector('.invalid-feedback');
  if (fb) fb.textContent = '';
  el.onchange = () => _dobFeedback(el);
  el.oninput  = () => _dobFeedback(el);
}

// ── Phone validation (Oman) ───────────────────────────────────────────────
function validatePhone(value) {
  if (!value || !value.trim()) return 'Phone number is required';
  const v = value.trim();
  // Strip international prefix +968 or 00968
  let digits = v;
  if      (v.startsWith('+968'))  digits = v.slice(4);
  else if (v.startsWith('00968')) digits = v.slice(5);
  if (!/^\d+$/.test(digits))       return 'Phone must contain numbers only';
  if (digits.length !== 8)         return 'Oman phone must be exactly 8 digits';
  if (!/^[279]/.test(digits))      return 'Must start with 9 (mobile), 7 (mobile), or 2 (landline)';
  if (/^(\d)\1{7}$/.test(digits))  return 'Invalid phone — repeated digits not allowed';
  return null;
}

function _phoneFeedback(el) {
  const err = validatePhone(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && !!el.value.trim());
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachPhoneValidation(id) {
  const el = $(id);
  if (!el) return;
  el.placeholder = 'e.g. 91234567 or +96891234567';
  el.classList.remove('is-valid','is-invalid');
  const fb = el.parentNode.querySelector('.invalid-feedback');
  if (fb) fb.textContent = '';
  el.onkeydown = e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const nav  = ['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Tab','Enter'].includes(e.key);
    if (ctrl || nav) return;
    if (!/^[\d+]$/.test(e.key)) e.preventDefault();   // allow digits + + only
  };
  el.onpaste = e => {
    e.preventDefault();
    const raw     = (e.clipboardData || window.clipboardData).getData('text');
    const cleaned = raw.replace(/[^\d+]/g, '');
    const s = el.selectionStart, end = el.selectionEnd;
    el.value = el.value.slice(0, s) + cleaned + el.value.slice(end);
    el.setSelectionRange(s + cleaned.length, s + cleaned.length);
    el.dispatchEvent(new Event('input'));
  };
  el.oninput = () => _phoneFeedback(el);
}

// ── Email validation ──────────────────────────────────────────────────────
function validateEmail(value) {
  if (!value || !value.trim()) return null;   // optional field
  const v = value.trim();
  if (/\s/.test(v))                           return 'Email cannot contain spaces';
  if (/^[.@\-_]/.test(v))                    return 'Email cannot start with a special character';
  if (/[.@\-_]$/.test(v))                    return 'Email cannot end with a special character';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Must be a valid email (e.g. name@email.com)';
  return null;
}

function _emailFeedback(el) {
  const err = validateEmail(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && !!el.value.trim());
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachEmailValidation(id) {
  const el = $(id);
  if (!el) return;
  el.placeholder = 'e.g. name@email.com';
  el.classList.remove('is-valid','is-invalid');
  const fb = el.parentNode.querySelector('.invalid-feedback');
  if (fb) fb.textContent = '';
  el.onkeydown = e => { if (e.key === ' ') e.preventDefault(); };
  el.oninput = () => {
    const pos = el.selectionStart;
    const lower = el.value.toLowerCase();
    if (lower !== el.value) { el.value = lower; el.setSelectionRange(pos, pos); }
    _emailFeedback(el);
  };
}

// ── City validation ───────────────────────────────────────────────────────
function validateCity(value) {
  if (!value || !value.trim()) return 'City is required';
  const v = value.trim();
  if (v.length < 2)  return 'City must be at least 2 characters';
  if (v.length > 50) return 'City must be less than 50 characters';
  if (/[0-9]/.test(v))            return 'City must contain letters only — no numbers';
  if (/[^A-Za-z\s'\-]/.test(v))  return 'City must not contain special characters';
  return null;
}

function _cityFeedback(el) {
  const err = validateCity(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && !!el.value.trim());
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachCityValidation(id) {
  const el = $(id);
  if (!el) return;
  el.placeholder = 'e.g. Muscat';
  el.maxLength = 50;
  el.classList.remove('is-valid','is-invalid');
  const fb = el.parentNode.querySelector('.invalid-feedback');
  if (fb) fb.textContent = '';
  el.onkeydown = e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const nav  = ['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Tab','Enter'].includes(e.key);
    if (ctrl || nav) return;
    if (!/^[A-Za-z\s'\-]$/.test(e.key)) e.preventDefault();
  };
  el.onpaste = e => {
    e.preventDefault();
    const cleaned = (e.clipboardData||window.clipboardData).getData('text').replace(/[^A-Za-z\s'\-]/g,'');
    const s = el.selectionStart, end = el.selectionEnd;
    el.value = el.value.slice(0,s) + cleaned + el.value.slice(end);
    el.setSelectionRange(s+cleaned.length, s+cleaned.length);
    el.dispatchEvent(new Event('input'));
  };
  el.oninput = () => {
    const pos = el.selectionStart;
    const cap = el.value.replace(/(?:^|[\s\-'])\S/g, c => c.toUpperCase());
    if (cap !== el.value) { el.value = cap; el.setSelectionRange(pos, pos); }
    _cityFeedback(el);
  };
}

// ── Address validation ────────────────────────────────────────────────────
function validateAddress(value) {
  if (!value || !value.trim()) return 'Address is required';
  const v = value.trim();
  if (v.length < 5)   return 'Address must be at least 5 characters';
  if (v.length > 150) return 'Address must be less than 150 characters';
  if (/[@%*$^&!()\[\]{}"<>?;=+|~`]/.test(v)) return 'Address contains unsupported characters';
  return null;
}

function _addressFeedback(el) {
  const err = validateAddress(el.value);
  el.classList.toggle('is-invalid', !!err);
  el.classList.toggle('is-valid',   !err && !!el.value.trim());
  let fb = el.parentNode.querySelector('.invalid-feedback');
  if (!fb) { fb = document.createElement('div'); fb.className = 'invalid-feedback'; el.parentNode.appendChild(fb); }
  fb.textContent = err || '';
}

function attachAddressValidation(id) {
  const el = $(id);
  if (!el) return;
  el.placeholder = 'e.g. Building 25, Al Khuwair';
  el.maxLength = 150;
  el.classList.remove('is-valid','is-invalid');
  const fb = el.parentNode.querySelector('.invalid-feedback');
  if (fb) fb.textContent = '';
  el.onkeydown = e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const nav  = ['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Tab','Enter'].includes(e.key);
    if (ctrl || nav) return;
    if (/^[@%*$^&!()\[\]{}"<>?;=+|~`]$/.test(e.key)) e.preventDefault();
  };
  el.oninput = () => _addressFeedback(el);
}

// Shared patient header for all print reports
const _rphCSS = `
  .rpt-ph{width:100%;border-collapse:collapse;font-family:Arial,sans-serif;}
  .rph-l{font-weight:bold;width:160px;padding:7px 14px;font-size:13px;color:#111;white-space:nowrap;vertical-align:top;}
  .rph-c{font-weight:bold;width:10px;padding:7px 3px;color:#111;font-size:13px;vertical-align:top;}
  .rph-v{padding:7px 14px;font-size:13px;color:#333;vertical-align:top;}
  .rph-g{padding-left:28px;}
  .rpt-patient-photo{text-align:center;margin-bottom:15px;}
  .rpt-patient-photo img{width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #007bff;}
  .rpt-patient-photo .no-photo{width:80px;height:80px;border-radius:50%;background:#f1f5f9;border:3px solid #007bff;display:inline-flex;align-items:center;justify-content:center;}
  .rpt-patient-photo .no-photo i{color:#94a3b8;font-size:2rem;}
`;
function _patientHdr(patNo, name, dob, gender, dateStr, photo, createdByName) {
  const age = dob ? Math.floor((Date.now()-new Date(dob))/(365.25*24*3600*1000)) : null;
  const ageStr = age !== null ? age+' Year(s)' : '—';
  const d = fmtDate(new Date().toISOString().split('T')[0]);
  const photoCell = photo
    ? `<td style="width:120px;padding-right:14px;vertical-align:middle;"><img src="${photo}" style="width:110px;height:110px;border-radius:50%;object-fit:cover;border:3px solid #1a56db;display:block;"/></td>`
    : '';
  const infoColspan = photo ? '' : ' colspan="2"';
  const createdByRow = createdByName
    ? `<tr><td class="rph-l">Registered By</td><td class="rph-c">:</td><td class="rph-v" colspan="4">${esc(createdByName)}</td></tr>`
    : '';
  return `<table style="width:100%;border-collapse:collapse;border:1px solid #bbb;margin-bottom:12px;">
  <tr>
    ${photoCell}
    <td${infoColspan} style="padding:0;vertical-align:middle;">
      <table class="rpt-ph" style="width:100%;margin:0;border:none;">
        <tr>
          <td class="rph-l">Patient's No</td><td class="rph-c">:</td>
          <td class="rph-v">${esc(patNo||'—')}</td>
          <td class="rph-l rph-g">Date</td><td class="rph-c">:</td>
          <td class="rph-v">${d}</td>
        </tr>
        <tr>
          <td class="rph-l">Name of Patient</td><td class="rph-c">:</td>
          <td class="rph-v" colspan="4"><strong>${esc(name||'—')}</strong></td>
        </tr>
        <tr>
          <td class="rph-l">Age</td><td class="rph-c">:</td>
          <td class="rph-v">${ageStr}</td>
          <td class="rph-l rph-g">Sex</td><td class="rph-c">:</td>
          <td class="rph-v">${esc(gender||'—')}</td>
        </tr>
        ${createdByRow}
      </table>
    </td>
    <td style="width:115px;text-align:center;padding:6px 8px;vertical-align:middle;border-left:1px solid #ddd;">
      <svg id="pt-barcode" data-value="${esc(patNo||'')}"></svg>
    </td>
  </tr>
</table>`;
}

function renderBarcode(svgId, value) {
  if (typeof JsBarcode === 'undefined' || !svgId) return;
  const el = document.getElementById(svgId);
  if (!el) return;
  try {
    JsBarcode(`#${svgId}`, String(value || ''), {
      format: 'CODE128',
      width: 1.5,
      height: 38,
      displayValue: true,
      fontSize: 11,
      margin: 3,
      background: 'transparent'
    });
  } catch (e) {
    console.warn('Barcode render failed', e);
  }
}

function statusBadge(s) {
  const labels = { scheduled:'Scheduled', confirmed:'Confirmed', completed:'Completed', cancelled:'Cancelled', 'no-show':'No-Show', paid:'Paid', unpaid:'Unpaid', partial:'Partial' };
  return `<span class="badge-status status-${s}">${labels[s]||s}</span>`;
}

function calcAge(dob) {
  if (!dob) return '—';
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000)) + ' yrs';
}

function t(path, fallback='') {
  const parts = path.split('.');
  let value = translations[currentLang];
  for (const part of parts) {
    if (!value || typeof value !== 'object') return fallback;
    value = value[part];
  }
  return value || fallback;
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.documentElement.dir = translations[currentLang].dir || 'ltr';
  document.body.dir = translations[currentLang].dir || 'ltr';
  document.title = `${t(`pageTitles.${currentSection}`, pageTitles[currentSection] || currentSection)} — ${SETTINGS.clinic_name || 'Dental Clinic'}`;
  if ($('topbar-online')) $('topbar-online').textContent = t('topbar.online', 'Online');
  if ($('language-selector')) $('language-selector').value = currentLang;
  document.querySelectorAll('#sidebar .nav-link').forEach(a => {
    const section = a.dataset.section;
    const label = t(`nav.${section}`, pageTitles[section] || section);
    const span = a.querySelector('span');
    if (span) span.textContent = label;
  });
  if ($('page-title')) $('page-title').textContent = t(`pageTitles.${currentSection}`, pageTitles[currentSection] || currentSection);
}

function setLanguage(lang) {
  if (!translations[lang]) lang = 'en';
  currentLang = lang;
  localStorage.setItem('clinicLang', lang);
  applyLanguage();
  updateClock();
}

function changeLanguage(lang) {
  setLanguage(lang);
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const sections = ['dashboard','patients','appointments','treatments','invoices','reports','inventory','settings','about'];
const pageTitles = { dashboard:'Dashboard', patients:'Patients', appointments:'Appointments', treatments:'Treatments', invoices:'Billing & Invoices', reports:'Reports & Analytics', settings:'Settings', about:'About' };
let _charts = {};

function navigate(section) {
  currentSection = section;
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.section === section);
  });
  const title = t(`pageTitles.${section}`, pageTitles[section] || section);
  $('page-title').textContent = title;
  document.title = `${title} — ${SETTINGS.clinic_name || 'Dental Clinic'}`;
  // Destroy existing charts to prevent canvas reuse errors
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch(e){} });
  _charts = {};
  const fn = { dashboard: loadDashboard, patients: loadPatients, appointments: loadAppointments, treatments: loadTreatments, invoices: loadInvoices, reports: loadReports, inventory: loadInventory, settings: loadSettings, about: loadAbout };
  if (fn[section]) fn[section]();
}

// ═══════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════
async function loadDashboard() {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-primary"></div></div>`;
  try {
    const d = await get('/api/reports/dashboard');
    renderDashboard(d);
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">Error loading dashboard: ${e.message}</div>`; }
}

function renderDashboard(d) {
  const revChange = d.prevMonthRevenue > 0
    ? ((d.monthRevenue - d.prevMonthRevenue) / d.prevMonthRevenue * 100).toFixed(1)
    : null;

  $('content-area').innerHTML = `
    <div class="section-header"><h4>Dashboard</h4><p>Welcome back! Here's what's happening today.</p></div>

    <div class="row g-3 mb-4">
      <div class="col-sm-6 col-xl-3">
        <div class="stat-card">
          <div class="stat-icon blue"><i class="fas fa-users"></i></div>
          <div><div class="stat-value">${d.totalPatients}</div><div class="stat-label">Total Patients</div>
          <div class="stat-change up"><i class="fas fa-user-plus fa-xs"></i> ${d.newPatients} new this month</div></div>
        </div>
      </div>
      <div class="col-sm-6 col-xl-3">
        <div class="stat-card">
          <div class="stat-icon green"><i class="fas fa-calendar-day"></i></div>
          <div><div class="stat-value">${d.todayAppts}</div><div class="stat-label">Today's Appointments</div>
          <div class="stat-change" style="color:#64748b">Scheduled for today</div></div>
        </div>
      </div>
      <div class="col-sm-6 col-xl-3">
        <div class="stat-card">
          <div class="stat-icon amber"><i class="fas fa-dollar-sign"></i></div>
          <div><div class="stat-value">${fmt(d.monthRevenue)}</div><div class="stat-label">Revenue This Month</div>
          ${revChange !== null ? `<div class="stat-change ${revChange>=0?'up':'down'}"><i class="fas fa-arrow-${revChange>=0?'up':'down'} fa-xs"></i> ${Math.abs(revChange)}% vs last month</div>` : ''}</div>
        </div>
      </div>
      <div class="col-sm-6 col-xl-3">
        <div class="stat-card">
          <div class="stat-icon red"><i class="fas fa-file-invoice"></i></div>
          <div><div class="stat-value">${d.pendingInvoices}</div><div class="stat-label">Pending Invoices</div>
          <div class="stat-change" style="color:#dc2626">${fmt(d.pendingAmount)} outstanding</div></div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-lg-7">
        <div class="card h-100">
          <div class="card-header d-flex justify-content-between align-items-center">
            <strong><i class="fas fa-chart-line me-2 text-primary"></i>Revenue (Last 6 Months)</strong>
          </div>
          <div class="card-body"><div class="chart-container"><canvas id="revenueChart"></canvas></div></div>
        </div>
      </div>
      <div class="col-lg-5">
        <div class="card h-100">
          <div class="card-header"><strong><i class="fas fa-chart-donut me-2 text-success"></i>Appointment Status (30 days)</strong></div>
          <div class="card-body d-flex align-items-center justify-content-center">
            <div style="max-height:260px;max-width:260px;width:100%"><canvas id="apptStatusChart"></canvas></div>
          </div>
        </div>
      </div>
    </div>

    <div class="row g-3 mt-1">
      <div class="col-12">
        <div class="table-card">
          <div class="table-toolbar">
            <i class="fas fa-clock text-primary"></i>
            <h6>Upcoming Appointments</h6>
            <button class="btn btn-primary btn-sm ms-auto" onclick="navigate('appointments')">View All</button>
          </div>
          <div class="table-responsive">
            <table class="table">
              <thead><tr><th>Date & Time</th><th>Patient</th><th>Service</th><th>Dentist</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                ${d.upcomingAppts.length ? d.upcomingAppts.map(a => `
                  <tr>
                    <td><strong>${fmtDate(a.appointment_date)}</strong> <span class="text-muted">${a.appointment_time}</span></td>
                    <td>${esc(a.patient_name)}</td>
                    <td>${esc(a.service_name||'—')}</td>
                    <td>${esc(a.dentist_name||'—')}</td>
                    <td>${statusBadge(a.status)}</td>
                    <td><button class="btn btn-xs btn-outline-success" onclick="quickUpdateAppt(${a.id},'completed')"><i class="fas fa-check"></i></button>
                        <button class="btn btn-xs btn-outline-danger ms-1" onclick="quickUpdateAppt(${a.id},'cancelled')"><i class="fas fa-times"></i></button></td>
                  </tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted py-4">No upcoming appointments</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  // Revenue chart
  const months = d.revenueByMonth.map(m => {
    const [y,mo] = m.month.split('-');
    return `${mo}/${y}`;
  });
  _charts.revenue = new Chart($('revenueChart'), {
    type: 'bar',
    data: { labels: months, datasets: [{ label: 'Revenue', data: d.revenueByMonth.map(m=>m.revenue), backgroundColor: 'rgba(26,86,219,.7)', borderColor: '#1a56db', borderWidth: 1, borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: v => '$'+v.toLocaleString() } } } }
  });

  // Status donut
  const statusColors = { scheduled:'#3b82f6', confirmed:'#10b981', completed:'#8b5cf6', cancelled:'#ef4444', 'no-show':'#f59e0b' };
  const statusData = d.apptStatus;
  _charts.apptStatus = new Chart($('apptStatusChart'), {
    type: 'doughnut',
    data: {
      labels: statusData.map(s => s.status),
      datasets: [{ data: statusData.map(s => s.cnt), backgroundColor: statusData.map(s => statusColors[s.status]||'#94a3b8'), borderWidth: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 12, font: { size: 11 } } } } }
  });
}

async function quickUpdateAppt(id, status) {
  try {
    const a = await get(`/api/appointments/${id}`);
    await put(`/api/appointments/${id}`, { ...a, status });
    toast(`Appointment marked as ${status}`);
    loadDashboard();
  } catch(e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// PATIENTS
// ═══════════════════════════════════════════
// typing → client-side filter (no re-render, no focus loss)
function _filterPatients(val) {
  const q = (val||'').toLowerCase();
  const list = q ? allPatients.filter(p =>
    (p.first_name+' '+p.last_name).toLowerCase().includes(q) ||
    (p.patient_number||'').toLowerCase().includes(q) ||
    (p.phone||'').includes(q) ||
    (p.email||'').toLowerCase().includes(q)
  ) : allPatients;
  const tbody = document.querySelector('#patients-table-print tbody');
  if (tbody) tbody.innerHTML = list.length
    ? list.map(_ptRow).join('')
    : '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-user-slash"></i>No patients found</div></td></tr>';
  const badge = $('pt-count-badge');
  if (badge) badge.textContent = list.length + ' records';
}
// barcode Enter → API search + auto-open single result
async function _searchPatients(val) {
  await loadPatients(val);
  if ($('patient-search')) { $('patient-search').value = val; _showClear('patient-search', val); }
  if (val && allPatients.length === 1) viewPatient(allPatients[0].id);
}
function _ptRow(p) {
  return `<tr>
    <td><span class="badge bg-light text-dark">${esc(p.patient_number)}</span></td>
    <td><strong class="cursor-pointer text-primary d-flex align-items-center" onclick="viewPatient(${p.id})" style="cursor:pointer">
      ${p.photo_thumb?`<div style="width:40px;height:40px;min-width:40px;border-radius:50%;overflow:hidden;border:2px solid #e2e8f0;flex-shrink:0;margin-right:8px;"><img src="${p.photo_thumb}" width="40" height="40" style="width:40px;height:40px;display:block;object-fit:cover;"></div>`:''}
      ${esc(p.first_name)} ${esc(p.last_name)}</strong></td>
    <td>${fmtDate(p.date_of_birth)} <small class="text-muted">(${calcAge(p.date_of_birth)})</small></td>
    <td>${p.gender||'—'}</td><td>${esc(p.phone||'—')}</td><td>${esc(p.email||'—')}</td>
    <td>${p.insurance_provider?`<span class="badge bg-info-subtle text-info">${esc(p.insurance_provider)}</span>`:'—'}</td>
    <td class="action-btns" style="white-space:nowrap;">
      <button class="btn btn-sm btn-outline-dark" onclick="printPatientSticker(${p.id})" title="Print Sticker"><i class="fas fa-tag"></i></button>
      <button class="btn btn-sm btn-outline-info" onclick="printPatientAppointmentsById(${p.id})" title="Print Appointments"><i class="fas fa-print"></i></button>
      <button class="btn btn-sm btn-outline-primary" onclick="viewPatient(${p.id})" title="View"><i class="fas fa-eye"></i></button>
      <button class="btn btn-sm btn-outline-secondary" onclick="openPatientModal(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
      <button class="btn btn-sm btn-outline-success" onclick="openAppointmentModal(null,${p.id})" title="New Appointment"><i class="fas fa-calendar-plus"></i></button>
      <button class="btn btn-sm btn-outline-danger" onclick="deletePatient(${p.id},'${esc(p.first_name)} ${esc(p.last_name)}')" title="Delete"><i class="fas fa-trash"></i></button>
    </td></tr>`;
}

async function loadPatients(search='') {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-primary"></div></div>`;
  try {
    const url = search ? `/api/patients?search=${encodeURIComponent(search)}` : '/api/patients';
    allPatients = await get(url);
    renderPatientsTable(allPatients, search);
    if (search && $('patient-search')) $('patient-search').value = search;
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function renderPatientsTable(patients, search='') {
  $('content-area').innerHTML = `
    <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4>Patients</h4><p>Manage patient records and medical information</p></div>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary" onclick="printPatientsList()"><i class="fas fa-print me-1"></i>Print</button>
        <button class="btn btn-primary" onclick="openPatientModal()"><i class="fas fa-plus me-1"></i>Add Patient</button>
      </div>
    </div>
    <div class="table-card">
      <div class="table-toolbar">
        ${_searchBox('patient-search','Type to search · Enter to scan barcode','_filterPatients','_searchPatients')}
        <span class="badge bg-secondary ms-2" id="pt-count-badge">${patients.length} records</span>
      </div>
      <div class="table-responsive" id="patients-table-print">
        <table class="table">
          <thead><tr><th>#</th><th>Name</th><th>DOB / Age</th><th>Gender</th><th>Phone</th><th>Email</th><th>Insurance</th><th>Actions</th></tr></thead>
          <tbody>
            ${patients.length ? patients.map(_ptRow).join('') : '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-user-slash"></i>No patients found</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

let _patientPhoto = null;       // full photo base64 (stored, shown in view)
let _patientPhotoThumb = null;  // 80x80 thumbnail (shown in table)

function _resizeImage(img, size, quality) {
  // Centre-crop to square then scale — guarantees uniform 1:1 output
  const src  = Math.min(img.width, img.height);
  const srcX = (img.width  - src) / 2;
  const srcY = (img.height - src) / 2;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(img, srcX, srcY, src, src, 0, 0, size, size);
  return c.toDataURL('image/jpeg', quality);
}

function handlePatientPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      _patientPhoto      = _resizeImage(img, 400, 0.88);
      _patientPhotoThumb = _resizeImage(img, 80,  0.75);
      _setPatientPhotoPreview(_patientPhoto);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removePatientPhoto() {
  _patientPhoto = null;
  _patientPhotoThumb = null;
  _setPatientPhotoPreview(null);
  $('patient-photo-input').value = '';
}

function _setPatientPhotoPreview(src) {
  const wrap = $('patient-photo-upload');
  const prev = $('patient-photo-preview');
  const rm   = $('patient-photo-remove');
  if (src) {
    prev.src = src;
    wrap.classList.add('has-photo');
    rm.style.display = '';
  } else {
    prev.src = '';
    wrap.classList.remove('has-photo');
    rm.style.display = 'none';
  }
}

async function openPatientModal(id=null) {
  $('patient-id').value = id||'';
  $('patientModalTitle').innerHTML = id ? '<i class="fas fa-user-edit me-2"></i>Edit Patient' : '<i class="fas fa-user-plus me-2"></i>Add Patient';
  const fields = ['first-name','last-name','dob','gender','phone','email','address','city','medical','allergies','insurance-provider','insurance-number'];
  fields.forEach(f => { const el = $(`patient-${f}`); if(el) el.value = ''; });
  _patientPhoto = null;
  _patientPhotoThumb = null;
  _setPatientPhotoPreview(null);
  $('patient-photo-input').value = '';
  if (id) {
    try {
      const p = await get(`/api/patients/${id}`);
      $('patient-first-name').value = p.first_name||'';
      $('patient-last-name').value  = p.last_name||'';
      $('patient-dob').value        = p.date_of_birth||'';
      $('patient-gender').value     = p.gender||'';
      $('patient-phone').value      = p.phone||'';
      $('patient-email').value      = p.email||'';
      $('patient-address').value    = p.address||'';
      $('patient-city').value       = p.city||'';
      $('patient-medical').value    = p.medical_history||'';
      $('patient-allergies').value  = p.allergies||'';
      $('patient-insurance-provider').value = p.insurance_provider||'';
      $('patient-insurance-number').value   = p.insurance_number||'';
      if (p.photo) {
        _patientPhoto      = p.photo;
        _patientPhotoThumb = p.photo_thumb || null;
        _setPatientPhotoPreview(p.photo);
      }
    } catch(e) { toast(e.message,'error'); return; }
  }
  attachNameValidation('patient-first-name', 'patient-last-name');
  attachDOBValidation('patient-dob');
  attachPhoneValidation('patient-phone');
  attachEmailValidation('patient-email');
  attachCityValidation('patient-city');
  attachAddressValidation('patient-address');
  _markAddMode('patientModal', !$('patient-id').value);
  showModal('patientModal');
}

async function savePatient() {
  const id = $('patient-id').value;
  const fn = $('patient-first-name').value.trim();
  const ln = $('patient-last-name').value.trim();
  const fnErr = validateName(fn), lnErr = validateName(ln);
  if (fnErr) { _nameFieldFeedback($('patient-first-name')); toast('First name: ' + fnErr, 'warning'); return; }
  if (lnErr) { _nameFieldFeedback($('patient-last-name'));  toast('Last name: '  + lnErr, 'warning'); return; }
  const dobErr = validateDOB($('patient-dob').value);
  if (dobErr) { _dobFeedback($('patient-dob')); toast('Date of birth: ' + dobErr, 'warning'); return; }
  const phoneErr = validatePhone($('patient-phone').value);
  if (phoneErr) { _phoneFeedback($('patient-phone')); toast('Phone: ' + phoneErr, 'warning'); return; }
  const emailErr = validateEmail($('patient-email').value);
  if (emailErr) { _emailFeedback($('patient-email')); toast('Email: ' + emailErr, 'warning'); return; }
  const cityErr = validateCity($('patient-city').value);
  if (cityErr) { _cityFeedback($('patient-city')); toast('City: ' + cityErr, 'warning'); return; }
  const addrErr = validateAddress($('patient-address').value);
  if (addrErr) { _addressFeedback($('patient-address')); toast('Address: ' + addrErr, 'warning'); return; }
  const data = {
    first_name: fn, last_name: ln,
    date_of_birth: $('patient-dob').value||null,
    gender: $('patient-gender').value||null,
    phone: $('patient-phone').value||null,
    email: $('patient-email').value||null,
    address: $('patient-address').value||null,
    city: $('patient-city').value||null,
    medical_history: $('patient-medical').value||null,
    allergies: $('patient-allergies').value||null,
    insurance_provider: $('patient-insurance-provider').value||null,
    insurance_number: $('patient-insurance-number').value||null,
    photo: _patientPhoto || null,
    photo_thumb: _patientPhotoThumb || null,
  };
  try {
    if (id) { await put(`/api/patients/${id}`, data); toast('Patient updated'); }
    else     { await post('/api/patients', data); toast('Patient added'); }
    hideModal('patientModal');
    loadPatients();
  } catch(e) { toast(e.message,'error'); }
}

async function viewPatient(id) {
  try {
    const p = await get(`/api/patients/${id}`);
    _currentPatient = p;
    $('patientViewTitle').innerHTML = `<i class="fas fa-user me-2"></i>${esc(p.first_name)} ${esc(p.last_name)} <small class="ms-2 opacity-75">${esc(p.patient_number)}</small>`;
    $('patient-view-edit-btn').onclick = () => { hideModal('patientViewModal'); openPatientModal(id); };
    $('patient-view-content').innerHTML = `
      <div class="profile-header">
        <div class="d-flex align-items-center gap-3">
          ${p.photo ? `<div style="width:90px;height:90px;min-width:90px;border-radius:50%;overflow:hidden;border:3px solid rgba(255,255,255,.5);flex-shrink:0;"><img src="${p.photo}" width="90" height="90" style="width:90px;height:90px;display:block;object-fit:cover;"></div>` : ''}
          <div style="flex:1;">
            <table style="width:100%;border-collapse:collapse;color:#fff;font-size:.88rem;">
              <tr>
                <td style="font-weight:700;white-space:nowrap;padding:3px 8px 3px 0;opacity:.85;">Patient's No</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td style="padding:3px 20px 3px 0;">${esc(p.patient_number)}</td>
                <td style="font-weight:700;white-space:nowrap;padding:3px 6px 3px 0;opacity:.85;">Date</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td style="padding:3px 0;">${fmtDate((p.created_at||'').substring(0,10))}</td>
              </tr>
              <tr>
                <td style="font-weight:700;white-space:nowrap;padding:3px 8px 3px 0;opacity:.85;">Name of Patient</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td colspan="4" style="padding:3px 0;font-size:1rem;font-weight:700;">${esc(p.first_name)} ${esc(p.last_name)}</td>
              </tr>
              <tr>
                <td style="font-weight:700;white-space:nowrap;padding:3px 8px 3px 0;opacity:.85;">Age</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td style="padding:3px 20px 3px 0;">${calcAge(p.date_of_birth)}</td>
                <td style="font-weight:700;white-space:nowrap;padding:3px 6px 3px 0;opacity:.85;">Sex</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td style="padding:3px 0;">${esc(p.gender||'—')}</td>
              </tr>
              ${p.phone ? `<tr>
                <td style="font-weight:700;white-space:nowrap;padding:3px 8px 3px 0;opacity:.85;">Phone</td>
                <td style="font-weight:700;padding:3px 6px 3px 0;">:</td>
                <td colspan="4" style="padding:3px 0;">${esc(p.phone)}</td>
              </tr>` : ''}
            </table>
          </div>
        </div>
      </div>
      <div class="p-3">
        <ul class="nav nav-tabs mb-3" id="patientTabs">
          <li class="nav-item"><a class="nav-link active" data-bs-toggle="tab" href="#tab-info">Info</a></li>
          <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#tab-appts">Appointments (${p.appointments.length})</a></li>
          <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#tab-treats">Treatments (${p.treatments.length})</a></li>
          <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#tab-invs">Invoices (${p.invoices.length})</a></li>
        </ul>
        <div class="tab-content">
          <div class="tab-pane fade show active" id="tab-info">
            <table class="rec-table">
              <tr><td class="rec-label">Date of Birth</td><td class="rec-colon">:</td><td class="rec-value">${fmtDate(p.date_of_birth)}</td></tr>
              <tr><td class="rec-label">Email</td><td class="rec-colon">:</td><td class="rec-value">${esc(p.email||'—')}</td></tr>
              <tr><td class="rec-label">Address</td><td class="rec-colon">:</td><td class="rec-value">${esc(p.address||'—')}${p.city?', '+esc(p.city):''}</td></tr>
              <tr><td class="rec-label">Insurance</td><td class="rec-colon">:</td><td class="rec-value">${p.insurance_provider ? `${esc(p.insurance_provider)} — ${esc(p.insurance_number||'')}` : '—'}</td></tr>
              <tr><td class="rec-label">Registered</td><td class="rec-colon">:</td><td class="rec-value">${fmtDate((p.created_at||'').substring(0,10))}</td></tr>
              ${p.medical_history ? `<tr><td class="rec-label">Medical History</td><td class="rec-colon">:</td><td class="rec-value">${esc(p.medical_history)}</td></tr>` : ''}
              ${p.allergies ? `<tr class="rec-allergy"><td class="rec-label"><i class="fas fa-exclamation-triangle me-1"></i>Allergies</td><td class="rec-colon">:</td><td class="rec-value">${esc(p.allergies)}</td></tr>` : ''}
            </table>
          </div>
          <div class="tab-pane fade" id="tab-appts">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h6 class="mb-0">Appointment History</h6>
              <button class="btn btn-sm btn-outline-primary" onclick="printPatientAppointments()"><i class="fas fa-print me-1"></i>Print Appointments</button>
            </div>
            <div class="table-responsive"><table class="table table-sm">
              <thead><tr><th>Date</th><th>Time</th><th>Service</th><th>Dentist</th><th>Status</th></tr></thead>
              <tbody>${p.appointments.map(a=>`<tr><td>${fmtDate(a.appointment_date)}</td><td>${a.appointment_time}</td><td>${esc(a.service_name||'—')}</td><td>${esc(a.dentist_name||'—')}</td><td>${statusBadge(a.status)}</td></tr>`).join('')||'<tr><td colspan="5" class="text-center text-muted">No appointments</td></tr>'}</tbody>
            </table></div>
          </div>
          <div class="tab-pane fade" id="tab-treats">
            <div class="table-responsive"><table class="table table-sm">
              <thead><tr><th>Date</th><th>Tooth</th><th>Procedure</th><th>Diagnosis</th><th>Cost</th></tr></thead>
              <tbody>${p.treatments.map(t=>`<tr><td>${fmtDate(t.treatment_date)}</td><td>${esc(t.tooth_number||'—')}</td><td>${esc(t.procedure_name||'—')}</td><td>${esc(t.diagnosis||'—')}</td><td>${fmt(t.cost)}</td></tr>`).join('')||'<tr><td colspan="5" class="text-center text-muted">No treatments</td></tr>'}</tbody>
            </table></div>
          </div>
          <div class="tab-pane fade" id="tab-invs">
            <div class="table-responsive"><table class="table table-sm">
              <thead><tr><th>Invoice #</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
              <tbody>${p.invoices.map(i=>`<tr><td>${esc(i.invoice_number)}</td><td>${fmtDate(i.issue_date)}</td><td>${fmt(i.total)}</td><td>${fmt(i.amount_paid)}</td><td>${fmt(i.balance)}</td><td>${statusBadge(i.payment_status)}</td></tr>`).join('')||'<tr><td colspan="6" class="text-center text-muted">No invoices</td></tr>'}</tbody>
            </table></div>
          </div>
        </div>
      </div>`;
    showModal('patientViewModal');
  } catch(e) { toast(e.message,'error'); }
}

async function printPatientSticker(id) {
  let p;
  if (id === undefined || id === null) {
    p = _currentPatient;
  } else {
    p = allPatients.find(pt => pt.id === id);
    if (!p) try { p = await get(`/api/patients/${id}`); } catch(_) {}
  }
  if (!p) { toast('No patient selected', 'warning'); return; }

  const addr = [p.address, p.city].filter(Boolean).join(', ');
  const clinic = esc(SETTINGS.clinic_name || 'Dental Clinic');
  const phone  = esc(SETTINGS.clinic_phone || '');

  const w = window.open('', '_blank', 'width=360,height=300');
  w.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Sticker — ${esc(p.patient_number)}</title>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#999;display:flex;flex-direction:column;align-items:center;padding:12px;font-family:Arial,Helvetica,sans-serif;}
    .no-print{width:100%;text-align:center;margin-bottom:10px;display:flex;gap:6px;justify-content:center;}
    .no-print button{padding:5px 16px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;}
    .btn-pr{background:#1a56db;color:#fff;}
    .btn-cl{background:#555;color:#fff;}
    .sticker{
      width:50mm; height:25mm;
      background:#fff;
      padding:1mm 1.5mm 0.8mm 1.5mm;
      border:0.5px solid #888;
      display:flex; flex-direction:column;
      overflow:hidden;
      box-shadow:0 2px 6px rgba(0,0,0,.35);
    }
    /* Clinic header */
    .s-clinic{
      font-size:7pt; font-weight:bold; text-align:center; letter-spacing:0.03em;
      border-bottom:0.25mm solid #999; padding-bottom:0.3mm; margin-bottom:0.4mm;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#111;
    }
    /* Row: barcode left + number right */
    .s-mid{
      display:flex; align-items:center; gap:1.5mm;
      margin-bottom:0.5mm;
    }
    svg#sticker-bc{ width:16mm; height:7.5mm; flex-shrink:0; display:block; }
    .s-num{
      flex:1; font-size:15pt; font-weight:900; color:#000;
      text-align:right; letter-spacing:-0.5pt; white-space:nowrap;
      line-height:1;
    }
    /* Patient name — large bold caps */
    .s-name{
      font-size:9.5pt; font-weight:900; color:#000;
      text-transform:uppercase; line-height:1.15;
      word-break:break-word; letter-spacing:0.02em;
    }
    /* DOB / address */
    .s-info{
      font-size:6.5pt; font-weight:bold; color:#111; margin-top:auto; padding-top:0.3mm;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    @media print{
      @page{size:50mm 25mm;margin:0;}
      body{background:transparent;padding:0;display:block;margin:0;}
      .no-print{display:none!important;}
      .sticker{border:none;box-shadow:none;width:50mm;height:25mm;}
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn-pr" onclick="window.print()">🖨️ Print Sticker</button>
    <button class="btn-cl" onclick="window.close()">✕ Close</button>
  </div>
  <div class="sticker">
    <div class="s-clinic">${clinic}</div>
    <div class="s-mid">
      <svg id="sticker-bc"></svg>
      <div class="s-num">${esc(p.patient_number)}</div>
    </div>
    <div class="s-name">${esc((p.first_name+' '+p.last_name).toUpperCase())}</div>
    <div class="s-info">DOB: ${fmtDate(p.date_of_birth||'')}${addr?' &nbsp;|&nbsp; '+esc(addr):''}</div>
  </div>
  <script>
    window.onload = function() {
      if (typeof JsBarcode !== 'undefined') {
        JsBarcode('#sticker-bc', '${esc(p.patient_number)}', {
          format:'CODE128', width:1, height:28,
          displayValue:false, margin:0, background:'transparent'
        });
      }
    };
  <\/script>
</body>
</html>`);
  w.document.close();
}

function printPatientProfile() {
  const p = _currentPatient;
  if (!p) { toast('No patient selected','warning'); return; }
  post('/api/activity/print', { entity:'patient_profile', entity_id:p.id, description:`Printed patient profile: ${p.patient_number} — ${p.first_name} ${p.last_name}` }).catch(()=>{});

  const row2 = (l1,v1,l2,v2) => `<tr>
    <td class="pi-l">${l1}</td><td class="pi-c">:</td><td class="pi-v">${v1}</td>
    <td class="pi-l pi-sep">${l2||''}</td><td class="pi-c">${l2?':':''}</td><td class="pi-v">${v2||''}</td></tr>`;

  const infoRows = [
    row2('Date of Birth', fmtDate(p.date_of_birth), 'Phone', esc(p.phone||'—')),
    row2('Email', esc(p.email||'—'), 'City', esc(p.city||'—')),
    row2('Address', esc(p.address||'—'), 'Insurance', p.insurance_provider ? esc(p.insurance_provider)+' — '+esc(p.insurance_number||'') : '—'),
    row2('Registered', fmtDate((p.created_at||'').substring(0,10)), 'Medical History', esc(p.medical_history||'—')),
    ...(p.allergies ? [`<tr class="pi-alert"><td class="pi-l">⚠ Allergies</td><td class="pi-c">:</td><td class="pi-v" colspan="4">${esc(p.allergies)}</td></tr>`] : [])
  ].join('');

  const appts  = (p.appointments||[]).map(a=>`<tr><td>${fmtDate(a.appointment_date)}</td><td>${a.appointment_time}</td><td>${esc(a.service_name||'—')}</td><td>${esc(a.dentist_name||'—')}</td><td>${a.status}</td></tr>`).join('');
  const treats = (p.treatments||[]).map(t=>`<tr><td>${fmtDate(t.treatment_date)}</td><td>${esc(t.tooth_number||'—')}</td><td>${esc(t.procedure_name||'—')}</td><td>${esc(t.diagnosis||'—')}</td><td>${fmt(t.cost)}</td></tr>`).join('');
  const invs   = (p.invoices||[]).map(i=>`<tr><td>${esc(i.invoice_number)}</td><td>${fmtDate(i.issue_date)}</td><td>${fmt(i.total)}</td><td>${fmt(i.amount_paid)}</td><td>${fmt(i.balance)}</td><td>${i.payment_status}</td></tr>`).join('');

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head>
  <title>${esc(p.first_name)} ${esc(p.last_name)} — Patient Profile</title>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,sans-serif;font-size:12px;padding:18px;}
    .ch{text-align:center;border-bottom:2px solid #1a56db;padding-bottom:8px;margin-bottom:12px;}
    .ch h3{color:#1a56db;font-size:15px;} .ch p{color:#555;font-size:11px;margin-top:3px;}
    ${_rphCSS}
    .pi-tbl{width:100%;border-collapse:collapse;border:1px solid #bbb;margin-bottom:12px;}
    .pi-tbl tr{border-bottom:1px solid #ddd;}
    .pi-tbl tr:last-child{border-bottom:none;}
    .pi-l{font-weight:bold;width:110px;padding:5px 9px;white-space:nowrap;color:#111;vertical-align:top;}
    .pi-c{font-weight:bold;width:8px;padding:5px 2px;color:#111;vertical-align:top;}
    .pi-v{padding:5px 9px;color:#333;vertical-align:top;}
    .pi-sep{border-left:1px solid #ccc;}
    .pi-alert{background:#fff5f5;}
    .pi-alert td{color:#c00!important;font-weight:bold;}
    .sec-title{font-weight:bold;color:#1a56db;border-bottom:1px solid #1a56db;padding-bottom:2px;margin:12px 0 5px;font-size:12px;}
    .pt{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px;}
    .pt th{background:#1a56db;color:#fff;padding:4px 7px;text-align:left;}
    .pt td{padding:4px 7px;border-bottom:1px solid #eee;}
    .ft{text-align:center;color:#aaa;font-size:10px;margin-top:12px;border-top:1px solid #ddd;padding-top:5px;}
    @media print{body{padding:8px;}@page{margin:10mm;}}
  </style></head><body>
  <div class="ch">
    <h3>${esc(SETTINGS.clinic_name||'Dental Clinic')}</h3>
    <p>${esc(SETTINGS.clinic_address||'')}${SETTINGS.clinic_city?', '+esc(SETTINGS.clinic_city):''} | ${esc(SETTINGS.clinic_phone||'')} | ${esc(SETTINGS.clinic_email||'')}</p>
  </div>
  ${_patientHdr(p.patient_number, p.first_name+' '+p.last_name, p.date_of_birth, p.gender, null, p.photo, p.created_by_name)}
  <table class="pi-tbl">${infoRows}</table>
  ${appts  ? `<div class="sec-title">Appointments</div><table class="pt"><thead><tr><th>Date</th><th>Time</th><th>Service</th><th>Dentist</th><th>Status</th></tr></thead><tbody>${appts}</tbody></table>` : ''}
  ${treats ? `<div class="sec-title">Treatments</div><table class="pt"><thead><tr><th>Date</th><th>Tooth</th><th>Procedure</th><th>Diagnosis</th><th>Cost</th></tr></thead><tbody>${treats}</tbody></table>` : ''}
  ${invs   ? `<div class="sec-title">Invoices</div><table class="pt"><thead><tr><th>Invoice #</th><th>Date</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${invs}</tbody></table>` : ''}
  <div class="ft">Generated on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')} — ${esc(SETTINGS.clinic_name||'Dental Clinic')}</div>
  <script>window.onload=function(){if(typeof JsBarcode!=='undefined'){var b=document.getElementById('pt-barcode');if(b&&b.dataset.value){try{JsBarcode('#pt-barcode',b.dataset.value,{format:'CODE128',width:1.5,height:38,displayValue:true,fontSize:11,margin:3,background:'transparent'});}catch(e){}}}setTimeout(()=>window.print(),700);setTimeout(()=>window.close(),2700);}<\/script>
</body></html>`);
  w.document.close();
}

function printPatientAppointments() {
  const modal = $('patientViewModal');
  const title = $('patientViewTitle').textContent;
  const patientName = title.split(' <small')[0]; // Extract patient name

  // Get appointments data from the current patient
  const appointmentsTable = modal.querySelector('#tab-appts table');
  const appointmentsHTML = appointmentsTable ? appointmentsTable.outerHTML : '<p>No appointments found</p>';

  if (_currentPatient) post('/api/activity/print', { entity:'patient_appointments', entity_id:_currentPatient.id, description:`Printed appointments for ${_currentPatient.patient_number}` }).catch(()=>{});
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('Unable to open print window. Please allow popups for this site.', 'warning');
    return;
  }
  printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <title>${patientName} - Appointments</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .clinic-header { text-align: center; border-bottom: 2px solid #007bff; padding-bottom: 10px; margin-bottom: 20px; }
    .clinic-header h2 { color: #007bff; margin: 0; }
    .clinic-header p { margin: 5px 0; color: #666; }
    .table { margin-bottom: 20px; }
    ${_rphCSS}
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="clinic-header">
    <h2>${SETTINGS.clinic_name || 'Dental Clinic'}</h2>
    <p>${SETTINGS.clinic_address || ''} ${SETTINGS.clinic_city || ''}</p>
    <p>Phone: ${SETTINGS.clinic_phone || ''} | Email: ${SETTINGS.clinic_email || ''}</p>
  </div>
  ${_currentPatient ? _patientHdr(_currentPatient.patient_number, `${_currentPatient.first_name} ${_currentPatient.last_name}`, _currentPatient.date_of_birth, _currentPatient.gender, null, _currentPatient.photo_thumb, _currentPatient.created_by_name) : ''}

  <h5 class="mb-3">Appointment History</h5>
  ${appointmentsHTML}

  <div class="mt-4 text-center text-muted small">
    <p>Generated on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')}</p>
  </div>

  <script>
    window.onload = function() {
      if(typeof JsBarcode!=='undefined'){var b=document.getElementById('pt-barcode');if(b&&b.dataset.value){try{JsBarcode('#pt-barcode',b.dataset.value,{format:'CODE128',width:1.5,height:38,displayValue:true,fontSize:11,margin:3,background:'transparent'});}catch(e){}}}
      setTimeout(() => { window.print(); }, 700);
      setTimeout(() => { window.close(); }, 2700);
    }
  </script>
</body>
</html>`);
  printWindow.document.close();
}

async function printPatientAppointmentsById(patientId) {
  try {
    const p = await get(`/api/patients/${patientId}`);
    const patientName = `${esc(p.first_name)} ${esc(p.last_name)}`;
    post('/api/activity/print', { entity:'patient_appointments', entity_id:p.id, description:`Printed appointments for ${p.patient_number}` }).catch(()=>{});
    const appointmentsHTML = p.appointments.length
      ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Date</th><th>Time</th><th>Service</th><th>Dentist</th><th>Status</th></tr></thead><tbody>${p.appointments.map(a => `<tr><td>${fmtDate(a.appointment_date)}</td><td>${a.appointment_time}</td><td>${esc(a.service_name||'—')}</td><td>${esc(a.dentist_name||'—')}</td><td>${statusBadge(a.status)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p>No appointments found for this patient.</p>';

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Unable to open print window. Please allow popups for this site.', 'warning');
      return;
    }
    printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <title>${patientName} - Appointments</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .clinic-header { text-align: center; border-bottom: 2px solid #007bff; padding-bottom: 10px; margin-bottom: 20px; }
    .clinic-header h2 { color: #007bff; margin: 0; }
    .clinic-header p { margin: 5px 0; color: #666; }
    .table { margin-bottom: 20px; }
    ${_rphCSS}
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="clinic-header">
    <h2>${SETTINGS.clinic_name || 'Dental Clinic'}</h2>
    <p>${SETTINGS.clinic_address || ''} ${SETTINGS.clinic_city || ''}</p>
    <p>Phone: ${SETTINGS.clinic_phone || ''} | Email: ${SETTINGS.clinic_email || ''}</p>
  </div>
  ${_patientHdr(p.patient_number, patientName, p.date_of_birth, p.gender, null, p.photo_thumb, p.created_by_name)}
  <h5 class="mb-3">Appointment History</h5>
  ${appointmentsHTML}
  <div class="mt-4 text-center text-muted small"><p>Generated on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')}</p></div>
  <script>
    window.onload = function() { if(typeof JsBarcode!=='undefined'){var b=document.getElementById('pt-barcode');if(b&&b.dataset.value){try{JsBarcode('#pt-barcode',b.dataset.value,{format:'CODE128',width:1.5,height:38,displayValue:true,fontSize:11,margin:3,background:'transparent'});}catch(e){}}} setTimeout(() => { window.print(); }, 700); setTimeout(() => { window.close(); }, 2700); }
  </script>
</body>
</html>`);
    printWindow.document.close();
  } catch (e) {
    showToast('Unable to print appointments: ' + e.message, 'error');
  }
}

async function printTreatmentRecord(treatmentId) {
  try {
    const treatment = await get(`/api/treatments/${treatmentId}`);
    if (!treatment) throw new Error('Treatment record not found');
    const idx = currentTreatments.findIndex(t => Number(t.id) === Number(treatmentId));
    if (idx !== -1) currentTreatments[idx] = treatment;
    post('/api/activity/print', { entity:'treatment', entity_id:treatmentId, description:`Printed treatment #${treatmentId}` }).catch(()=>{});

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Unable to open print window. Please allow popups for this site.', 'warning');
      return;
    }

    printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <title>Treatment Record - ${treatment.patient_name || 'Record'}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .clinic-header { text-align: center; border-bottom: 2px solid #007bff; padding-bottom: 10px; margin-bottom: 20px; }
    .clinic-header h2 { color: #007bff; margin: 0; }
    .clinic-header p { margin: 5px 0; color: #666; }
    .record-section { margin-bottom: 20px; padding: 15px; border: 1px solid #dee2e6; border-radius: 5px; }
    .record-section h4 { margin-bottom: 10px; color: #495057; border-bottom: 1px solid #dee2e6; padding-bottom: 5px; }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f8f9fa; }
    .info-item label { font-weight: bold; color: #666; }
    ${_rphCSS}
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="clinic-header">
    <h2>${SETTINGS.clinic_name || 'Dental Clinic'}</h2>
    <p>${SETTINGS.clinic_address || ''} ${SETTINGS.clinic_city || ''}</p>
    <p>Phone: ${SETTINGS.clinic_phone || ''} | Email: ${SETTINGS.clinic_email || ''}</p>
  </div>
  ${_patientHdr(treatment.patient_number, treatment.patient_name, treatment.patient_dob, treatment.patient_gender, fmtDate(treatment.treatment_date), treatment.patient_photo)}

  <div class="record-section">
    <h4><i class="fas fa-tooth me-2"></i>Treatment Details</h4>
    <div class="info-grid">
      <div class="info-item"><label>Treatment Date:</label><span>${fmtDate(treatment.treatment_date)}</span></div>
      <div class="info-item"><label>Tooth Number:</label><span>${esc(treatment.tooth_number || '—')}</span></div>
      <div class="info-item"><label>Procedure:</label><span>${esc(treatment.procedure_name || '—')}</span></div>
      <div class="info-item"><label>Diagnosis:</label><span>${esc(treatment.diagnosis || '—')}</span></div>
      <div class="info-item"><label>Dentist:</label><span>${esc(treatment.dentist_name || '—')}</span></div>
      <div class="info-item"><label>Cost:</label><span>${fmt(treatment.cost)}</span></div>
    </div>
  </div>

  ${treatment.notes ? `
  <div class="record-section">
    <h4><i class="fas fa-notes-medical me-2"></i>Notes</h4>
    <p>${esc(treatment.notes).replace(/\\n/g, '<br>')}</p>
  </div>
  ` : ''}

  <div class="mt-4 text-center text-muted small">
    <p>Treatment ID: ${treatment.id} | Generated on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')}</p>
  </div>

  <script>
    window.onload = function() {
      if(typeof JsBarcode!=='undefined'){var b=document.getElementById('pt-barcode');if(b&&b.dataset.value){try{JsBarcode('#pt-barcode',b.dataset.value,{format:'CODE128',width:1.5,height:38,displayValue:true,fontSize:11,margin:3,background:'transparent'});}catch(e){}}}
      setTimeout(() => { window.print(); }, 700);
      setTimeout(() => { window.close(); }, 2700);
    }
  </script>
</body>
</html>`);
    printWindow.document.close();
  } catch (e) {
    showToast('Failed to load treatment record: ' + e.message, 'error');
  }
}

function deletePatient(id, name) {
  confirm(`Delete patient "${name}"? All appointments, treatments, and records will be removed.`, async () => {
    try { await del(`/api/patients/${id}`); toast('Patient deleted'); loadPatients(); }
    catch(e) { toast(e.message,'error'); }
  });
}

function printPatientsList() {
  const element = $('patients-table-print');
  if (!element) return;
  const clinic = SETTINGS;
  post('/api/activity/print', { entity:'patients_list', entity_id:null, description:'Printed patients list' }).catch(()=>{});
  const printWindow = window.open('', '', 'width=1000,height=700');
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Patients List</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <style>
    body { font-size: 12px; }
    .print-header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .print-date { text-align: right; color: #666; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th { background-color: #007bff; color: white; padding: 8px; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    .action-btns { display: none; }
    .patient-thumb { width:40px; height:40px; min-width:40px; border-radius:50%; overflow:hidden; border:2px solid #e2e8f0; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; background:#f1f5f9; flex-shrink:0; vertical-align:middle; }
    .patient-thumb img { width:40px; height:40px; object-fit:cover; display:block; border-radius:50%; }
    .patient-thumb i { color:#94a3b8; font-size:.95rem; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body class="p-4">
  <div class="print-header">
    <h3>${esc(clinic.clinic_name||'Dental Clinic')}</h3>
    <p style="margin:5px 0;">${esc(clinic.clinic_address||'')} | ${esc(clinic.clinic_phone||'')}</p>
    <div class="print-date">Printed on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')}</div>
  </div>
  <h5 style="margin-bottom: 15px;">Patients List</h5>
  ${element.innerHTML}
  <script>
    window.onload = function() { window.print(); setTimeout(() => window.close(), 500); }
  </script>
</body>
</html>`;
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

// ═══════════════════════════════════════════
// APPOINTMENTS
// ═══════════════════════════════════════════
function _apptRow(a, todayVal) {
  return `<tr>
    <td><strong>${fmtDate(a.appointment_date)}</strong>${a.appointment_date===todayVal?' <span class="badge bg-primary ms-1">Today</span>':''}</td>
    <td>${a.appointment_time}</td>
    <td><div style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${a.patient_id})">${esc(a.patient_name)}</div>
        <small class="text-muted">${esc(a.patient_number)}</small></td>
    <td>${esc(a.service_name||'—')}</td>
    <td>${esc(a.dentist_name||'—')}</td>
    <td>${a.duration} min</td>
    <td><select class="form-select form-select-sm status-select" onchange="updateApptStatus(${a.id},this.value)" style="width:130px">
      ${['scheduled','confirmed','completed','cancelled','no-show'].map(s=>`<option value="${s}" ${a.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
    </select></td>
    <td class="action-btns">
      <button class="btn btn-sm btn-outline-info" onclick="printAppointment(${a.id})" title="Print"><i class="fas fa-print"></i></button>
      <button class="btn btn-sm btn-outline-primary" style="border-color:#0891b2;color:#0891b2" onclick="openSmsModal(${a.id})" title="Send SMS"><i class="fas fa-sms"></i></button>
      <button class="btn btn-sm btn-outline-secondary" onclick="openAppointmentModal(${a.id})" title="Edit"><i class="fas fa-edit"></i></button>
      <button class="btn btn-sm btn-outline-warning" onclick="createInvoiceForAppt(${a.patient_id})" title="Create Invoice"><i class="fas fa-file-invoice-dollar"></i></button>
      <button class="btn btn-sm btn-outline-danger" onclick="deleteAppointment(${a.id})" title="Delete"><i class="fas fa-trash"></i></button>
    </td></tr>`;
}
function _filterAppts(val) {
  const q = (val||'').toLowerCase();
  const todayVal = today();
  const list = q ? _loadedAppts.filter(a =>
    (a.patient_name||'').toLowerCase().includes(q) ||
    (a.patient_number||'').toLowerCase().includes(q) ||
    (a.service_name||'').toLowerCase().includes(q) ||
    (a.dentist_name||'').toLowerCase().includes(q)
  ) : _loadedAppts;
  const tbody = document.querySelector('#appointments-table-print tbody');
  if (tbody) tbody.innerHTML = list.length
    ? list.map(a => _apptRow(a, todayVal)).join('')
    : '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-calendar-times"></i>No appointments found</div></td></tr>';
  const badge = $('appt-count-badge');
  if (badge) badge.textContent = list.length + ' appointments';
}
async function loadAppointments(filter={}) {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-success"></div></div>`;
  try {
    const params = new URLSearchParams(filter).toString();
    const appts  = await get('/api/appointments' + (params?'?'+params:''));
    _loadedAppts = appts;
    renderAppointmentsSection(appts, filter);
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function renderAppointmentsSection(appts, filter={}) {
  const todayVal = today();
  $('content-area').innerHTML = `
    <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4>Appointments</h4><p>Schedule and manage patient appointments</p></div>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary" onclick="printAppointmentsList()"><i class="fas fa-print me-1"></i>Print</button>
        <button class="btn btn-success" onclick="openAppointmentModal()"><i class="fas fa-plus me-1"></i>New Appointment</button>
      </div>
    </div>
    <div class="table-card mb-3">
      <div class="table-toolbar flex-wrap gap-2">
        ${_searchBox('appt-search','Type to search · Enter to scan barcode','_filterAppts','_searchAppts')}
        <select class="form-select form-select-sm" id="filter-status" style="width:150px" onchange="applyApptFilters()">
          <option value="">All Statuses</option>
          <option ${filter.status==='scheduled'?'selected':''}>scheduled</option>
          <option ${filter.status==='confirmed'?'selected':''}>confirmed</option>
          <option ${filter.status==='completed'?'selected':''}>completed</option>
          <option ${filter.status==='cancelled'?'selected':''}>cancelled</option>
          <option ${filter.status==='no-show'?'selected':''}>no-show</option>
        </select>
        <input type="date" class="form-control form-control-sm" id="filter-from" value="${filter.from||''}" placeholder="From" style="width:140px" onchange="applyApptFilters()"/>
        <input type="date" class="form-control form-control-sm" id="filter-to" value="${filter.to||''}" placeholder="To" style="width:140px" onchange="applyApptFilters()"/>
        <button class="btn btn-sm btn-outline-primary" onclick="applyApptFilters({from:'${todayVal}',to:'${todayVal}'})"><i class="fas fa-calendar-day me-1"></i>Today</button>
        <button class="btn btn-sm btn-outline-secondary" onclick="loadAppointments()"><i class="fas fa-times"></i></button>
        <span class="badge bg-secondary ms-auto" id="appt-count-badge">${appts.length} appointments</span>
      </div>
      <div class="table-responsive" id="appointments-table-print">
        <table class="table">
          <thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Service</th><th>Dentist</th><th>Duration</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${appts.length ? appts.map(a => `
              <tr>
                <td><strong>${fmtDate(a.appointment_date)}</strong>${a.appointment_date===todayVal?' <span class="badge bg-primary ms-1">Today</span>':''}</td>
                <td>${a.appointment_time}</td>
                <td>
                  <div style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${a.patient_id})">${esc(a.patient_name)}</div>
                  <small class="text-muted">${esc(a.patient_number)}</small>
                </td>
                <td>${esc(a.service_name||'—')}</td>
                <td>${esc(a.dentist_name||'—')}</td>
                <td>${a.duration} min</td>
                <td>
                  <select class="form-select form-select-sm status-select" onchange="updateApptStatus(${a.id},this.value)" style="width:130px">
                    ${['scheduled','confirmed','completed','cancelled','no-show'].map(s=>`<option value="${s}" ${a.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
                  </select>
                </td>
                <td class="action-btns">
                  <button class="btn btn-sm btn-outline-info" onclick="printAppointment(${a.id})" title="Print Appointment"><i class="fas fa-print"></i></button>
                  <button class="btn btn-sm btn-outline-primary" style="border-color:#0891b2;color:#0891b2" onclick="openSmsModal(${a.id})" title="Send SMS"><i class="fas fa-sms"></i></button>
                  <button class="btn btn-sm btn-outline-secondary" onclick="openAppointmentModal(${a.id})" title="Edit"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-sm btn-outline-warning" onclick="createInvoiceForAppt(${a.patient_id})" title="Create Invoice"><i class="fas fa-file-invoice-dollar"></i></button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteAppointment(${a.id})" title="Delete"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('') : '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-calendar-times"></i>No appointments found</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

function applyApptFilters(preset) {
  const filter = preset || {};
  if (!preset) {
    const s = $('filter-status')?.value;
    const f = $('filter-from')?.value;
    const t = $('filter-to')?.value;
    const q = $('appt-search')?.value;
    if (s) filter.status = s;
    if (f) filter.from = f;
    if (t) filter.to = t;
    if (q) filter.search = q;
  }
  loadAppointments(filter);
}

function _searchAppts(val) {
  applyApptFilters();
}

function openAppointmentModal(id=null, prePatientId=null) {
  $('appt-id').value       = id||'';
  $('appt-date').value     = today();
  $('appt-time').value     = '09:00';
  $('appt-duration').value = SETTINGS.appointment_duration||30;
  $('appt-status').value   = 'scheduled';
  $('appt-notes').value    = '';
  $('appointmentModalTitle').innerHTML = id ? '<i class="fas fa-edit me-2"></i>Edit Appointment' : '<i class="fas fa-calendar-plus me-2"></i>New Appointment';
  _markAddMode('appointmentModal', !id);
  showModal('appointmentModal');

  Promise.all([loadStaffOptions('appt-dentist-id'), loadServiceOptions('appt-service-id'), loadPatientOptions('appt-patient-id')])
    .then(async () => {
      if (prePatientId) $('appt-patient-id').value = prePatientId;
      if (id) {
        try {
          const a = await get(`/api/appointments/${id}`);
          $('appt-patient-id').value  = a.patient_id;
          $('appt-dentist-id').value  = a.dentist_id||'';
          $('appt-service-id').value  = a.service_id||'';
          $('appt-date').value        = a.appointment_date;
          $('appt-time').value        = a.appointment_time;
          $('appt-duration').value    = a.duration;
          $('appt-status').value      = a.status;
          $('appt-notes').value       = a.notes||'';
        } catch(e) { toast(e.message,'error'); }
      }
    })
    .catch(e => toast('Could not load options: ' + e.message, 'error'));
}

async function saveAppointment() {
  const id   = $('appt-id').value;
  const date = $('appt-date').value;
  const time = $('appt-time').value;
  const pid  = $('appt-patient-id').value;
  if (!pid || !date || !time) { toast('Patient, date, and time are required','warning'); return; }
  const data = {
    patient_id: parseInt(pid),
    dentist_id: parseInt($('appt-dentist-id').value)||null,
    service_id: parseInt($('appt-service-id').value)||null,
    appointment_date: date, appointment_time: time,
    duration: parseInt($('appt-duration').value)||30,
    status: $('appt-status').value,
    notes: $('appt-notes').value||null
  };
  try {
    if (id) { await put(`/api/appointments/${id}`, data); toast('Appointment updated'); }
    else     { await post('/api/appointments', data); toast('Appointment booked'); }
    hideModal('appointmentModal');
    loadAppointments();
  } catch(e) { toast(e.message,'error'); }
}

async function updateApptStatus(id, status) {
  try {
    const a = await get(`/api/appointments/${id}`);
    await put(`/api/appointments/${id}`, { ...a, status });
    toast(`Status updated to ${status}`);
  } catch(e) { toast(e.message,'error'); }
}

function deleteAppointment(id) {
  confirm('Delete this appointment?', async () => {
    try { await del(`/api/appointments/${id}`); toast('Appointment deleted'); loadAppointments(); }
    catch(e) { toast(e.message,'error'); }
  });
}

async function printAppointment(id) {
  try {
    const a = await get(`/api/appointments/${id}`);
    const clinic = SETTINGS;
    const statusColors = {
      scheduled:'#dbeafe;color:#1e40af', confirmed:'#d1fae5;color:#065f46',
      completed:'#e0e7ff;color:#3730a3', cancelled:'#fee2e2;color:#991b1b',
      'no-show':'#fef3c7;color:#92400e'
    };
    const sc = statusColors[a.status] || '#f1f5f9;color:#334155';
    const w = window.open('', '', 'width=820,height=700,scrollbars=yes');
    w.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Appointment #${id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Segoe UI, Arial, sans-serif; background: #fff; color: #1e293b; }
    .no-print { padding: 12px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; gap: 10px; }
    .no-print button { padding: 7px 18px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .btn-print { background: #1a56db; color: #fff; }
    .btn-close-win { background: #6b7280; color: #fff; }
    .header { background: #1a56db; color: #fff; padding: 22px 28px; }
    .header h3 { font-size: 1.25rem; font-weight: 700; }
    .header p  { font-size: 0.82rem; opacity: .85; margin-top: 3px; }
    .appt-banner { background: #f8fafc; border-left: 5px solid #1a56db; padding: 16px 28px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .appt-banner .ref { font-size: 1.6rem; font-weight: 800; color: #1a56db; }
    .status-pill { padding: 5px 14px; border-radius: 20px; font-weight: 700; font-size: 0.82rem; background: ${sc.split(';')[0]}; color: ${sc.split(':').pop()}; text-transform: uppercase; }
    .body { padding: 24px 28px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
    .cell { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
    .cell:nth-child(odd) { border-right: 1px solid #e2e8f0; background: #fafafa; }
    .cell label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; display: block; margin-bottom: 3px; }
    .cell span { font-size: 0.92rem; font-weight: 600; color: #0f172a; }
    .notes-box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; }
    .notes-box label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: .05em; color: #92400e; font-weight: 700; display: block; margin-bottom: 5px; }
    .notes-box p { font-size: 0.9rem; color: #78350f; margin: 0; }
    .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 30px; }
    .sig-box { border-top: 1.5px solid #334155; padding-top: 8px; }
    .sig-box label { font-size: 0.75rem; color: #64748b; }
    .footer { margin-top: 30px; padding: 14px 28px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 0.72rem; color: #94a3b8; }
    ${_rphCSS}
    @media print {
      .no-print { display: none !important; }
      body { padding: 0; }
      @page { margin: 14mm; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">🖨️ Print</button>
    <button class="btn-close-win" onclick="window.close()">✕ Close</button>
  </div>

  <div class="header">
    <h3>${esc(clinic.clinic_name||'Dental Clinic')}</h3>
    <p>${esc(clinic.clinic_address||'')}${clinic.clinic_city?', '+esc(clinic.clinic_city):''} &nbsp;|&nbsp; ${esc(clinic.clinic_phone||'')} &nbsp;|&nbsp; ${esc(clinic.clinic_email||'')}</p>
  </div>

  <div class="appt-banner">
    <div>
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:2px">Appointment Reference</div>
      <div class="ref">APT-${String(id).padStart(5,'0')}</div>
    </div>
    <div>
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:4px">Status</div>
      <span class="status-pill">${a.status||'scheduled'}</span>
    </div>
    <div style="margin-left:auto;text-align:right;font-size:0.78rem;color:#64748b">
      Printed: ${fmtDateTime()}
    </div>
  </div>

  <div class="body">
    ${_patientHdr(a.patient_number, a.patient_name, a.patient_dob, a.patient_gender, fmtDate(a.appointment_date), a.patient_photo)}
    <div class="grid">
      <div class="cell"><label>Appointment Date</label><span>${a.appointment_date ? fmtDate(a.appointment_date) : '—'}</span></div>
      <div class="cell"><label>Appointment Time</label><span>${a.appointment_time||'—'}</span></div>
      <div class="cell"><label>Duration</label><span>${a.duration||30} minutes</span></div>
      <div class="cell"><label>Service</label><span>${esc(a.service_name||'—')}</span></div>
      <div class="cell"><label>Patient Name</label><span>${esc(a.patient_name||'—')}</span></div>
      <div class="cell"><label>Patient ID</label><span>${esc(a.patient_number||'—')}</span></div>
      <div class="cell"><label>Patient Phone</label><span>${esc(a.patient_phone||'—')}</span></div>
      <div class="cell"><label>Attending Dentist</label><span>${esc(a.dentist_name||'—')}</span></div>
    </div>

    ${a.notes ? `<div class="notes-box"><label>Notes / Special Instructions</label><p>${esc(a.notes)}</p></div>` : ''}

    <div class="sig-grid">
      <div class="sig-box"><label>Patient Signature &amp; Date</label></div>
      <div class="sig-box"><label>Dentist / Staff Signature &amp; Date</label></div>
    </div>
  </div>

  <div class="footer">
    <strong>${esc(clinic.clinic_name||'Dental Clinic')}</strong>
    ${clinic.clinic_phone ? ` &nbsp;|&nbsp; ${esc(clinic.clinic_phone)}` : ''}
    ${clinic.clinic_email ? ` &nbsp;|&nbsp; ${esc(clinic.clinic_email)}` : ''}
  </div>
</body>
</html>`);
    w.document.close();
  } catch(e) {
    toast('Could not load appointment: ' + e.message, 'error');
  }
}

function printAppointmentsList() {
  const element = $('appointments-table-print');
  if (!element) return;
  const clinic = SETTINGS;
  const printWindow = window.open('', '', 'width=1200,height=700');
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Appointments List</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <style>
    body { font-size: 12px; }
    .print-header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .print-date { text-align: right; color: #666; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th { background-color: #28a745; color: white; padding: 8px; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    .action-btns { display: none; }
    .status-select { display: none; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body class="p-4">
  <div class="print-header">
    <h3>${esc(clinic.clinic_name||'Dental Clinic')}</h3>
    <p style="margin:5px 0;">${esc(clinic.clinic_address||'')} | ${esc(clinic.clinic_phone||'')}</p>
    <div class="print-date">Printed on ${fmtDateTime()}</div>
  </div>
  <h5 style="margin-bottom: 15px;">Appointments Schedule</h5>
  ${element.innerHTML}
  <script>
    window.onload = function() { window.print(); setTimeout(() => window.close(), 500); }
  </script>
</body>
</html>`;
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

// ═══════════════════════════════════════════
// TREATMENTS
// ═══════════════════════════════════════════
async function loadTreatments(search='') {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-info"></div></div>`;
  try {
    const url = search ? `/api/treatments?search=${encodeURIComponent(search)}` : '/api/treatments';
    const treats = await get(url);
    currentTreatments = treats || [];
    renderTreatmentsSection(treats, search);
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function _treatRow(t) {
  return `<tr>
    <td>${fmtDate(t.treatment_date)}</td>
    <td><div style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${t.patient_id})">${esc(t.patient_name)}</div>
        <small class="text-muted">${esc(t.patient_number)}</small></td>
    <td>${esc(t.tooth_number||'—')}</td>
    <td>${esc(t.procedure_name||'—')}</td>
    <td>${esc(t.diagnosis||'—')}</td>
    <td>${esc(t.dentist_name||'—')}</td>
    <td>${fmt(t.cost)}</td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.notes)}">${esc(t.notes||'—')}</td>
    <td class="action-btns">
      <button class="btn btn-sm btn-outline-info" onclick="printTreatmentRecord(${t.id})" title="Print"><i class="fas fa-print"></i></button>
      <button class="btn btn-sm btn-outline-secondary" onclick="openTreatmentModal(${t.id})" title="Edit"><i class="fas fa-edit"></i></button>
      <button class="btn btn-sm btn-outline-danger" onclick="deleteTreatment(${t.id})" title="Delete"><i class="fas fa-trash"></i></button>
    </td></tr>`;
}
function _filterTreats(val) {
  const q = (val||'').toLowerCase();
  const list = q ? currentTreatments.filter(t =>
    (t.patient_name||'').toLowerCase().includes(q) ||
    (t.patient_number||'').toLowerCase().includes(q) ||
    (t.procedure_name||'').toLowerCase().includes(q) ||
    (t.diagnosis||'').toLowerCase().includes(q)
  ) : currentTreatments;
  const tbody = document.querySelector('#treatments-table-print tbody');
  if (tbody) tbody.innerHTML = list.length
    ? list.map(_treatRow).join('')
    : '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-tooth"></i>No treatment records</div></td></tr>';
  const badge = $('treat-count-badge');
  if (badge) badge.textContent = list.length + ' records';
}
function _searchTreatments(val) { loadTreatments(val); }

function renderTreatmentsSection(treats, search='') {
  const _restoreSearch = search;
  $('content-area').innerHTML = `
    <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4>Treatment Records</h4><p>Clinical procedures and dental treatment history</p></div>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary" onclick="printTreatmentsList()"><i class="fas fa-print me-1"></i>Print</button>
        <button class="btn btn-info text-white" onclick="openTreatmentModal()"><i class="fas fa-plus me-1"></i>Add Treatment</button>
      </div>
    </div>
    <div class="table-card">
      <div class="table-toolbar flex-wrap gap-2">
        ${_searchBox('treat-search','Type to search · Enter to scan barcode','_filterTreats','_searchTreatments')}
        <span class="badge bg-secondary ms-auto" id="treat-count-badge">${treats.length} records</span>
      </div>
      <div class="table-responsive" id="treatments-table-print">
        <table class="table">
          <thead><tr><th>Date</th><th>Patient</th><th>Tooth</th><th>Procedure</th><th>Diagnosis</th><th>Dentist</th><th>Cost</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${treats.length ? treats.map(t => `
              <tr>
                <td>${fmtDate(t.treatment_date)}</td>
                <td><span style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${t.patient_id})">${esc(t.patient_name)}</span></td>
                <td>${t.tooth_number ? `<span class="badge bg-secondary">${esc(t.tooth_number)}</span>` : '—'}</td>
                <td>${esc(t.procedure_name||'—')}</td>
                <td>${esc(t.diagnosis||'—')}</td>
                <td>${esc(t.dentist_name||'—')}</td>
                <td><strong>${fmt(t.cost)}</strong></td>
                <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.notes)}">${esc(t.notes||'—')}</td>
                <td class="action-btns">
                  <button class="btn btn-sm btn-outline-info" onclick="printTreatmentRecord(${t.id})" title="Print"><i class="fas fa-print"></i></button>
                  <button class="btn btn-sm btn-outline-secondary" onclick="openTreatmentModal(${t.id})" title="Edit"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteTreatment(${t.id})" title="Delete"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('') : '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-tooth"></i>No treatment records</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  if (_restoreSearch && $('treat-search')) $('treat-search').value = _restoreSearch;
}

function openTreatmentModal(id=null, prePatientId=null) {
  $('treat-id').value        = id||'';
  $('treat-date').value      = today();
  $('treat-tooth').value     = '';
  $('treat-diagnosis').value = '';
  $('treat-procedure').value = '';
  $('treat-notes').value     = '';
  $('treat-cost').value      = '0';
  $('treatmentModalTitle').innerHTML = id ? '<i class="fas fa-edit me-2"></i>Edit Treatment' : '<i class="fas fa-plus me-2"></i>Add Treatment';
  _markAddMode('treatmentModal', !id);
  showModal('treatmentModal');

  // Populate dropdowns and pre-fill fields after modal is visible
  Promise.all([loadPatientOptions('treat-patient-id'), loadStaffOptions('treat-dentist-id')])
    .then(async () => {
      if (prePatientId) $('treat-patient-id').value = prePatientId;
      if (id) {
        try {
          const t = await get(`/api/treatments/${id}`);
          if (t) {
            $('treat-patient-id').value  = t.patient_id;
            $('treat-dentist-id').value  = t.dentist_id||'';
            $('treat-date').value        = t.treatment_date;
            $('treat-tooth').value       = t.tooth_number||'';
            $('treat-diagnosis').value   = t.diagnosis||'';
            $('treat-procedure').value   = t.procedure_name||'';
            $('treat-notes').value       = t.notes||'';
            $('treat-cost').value        = t.cost||0;
          }
        } catch(e) { toast(e.message,'error'); }
      }
    })
    .catch(e => toast('Could not load options: ' + e.message, 'error'));
}

async function saveTreatment() {
  const id  = $('treat-id').value;
  const pid = $('treat-patient-id').value;
  const dt  = $('treat-date').value;
  if (!pid || !dt) { toast('Patient and date are required','warning'); return; }
  const data = {
    patient_id: parseInt(pid),
    dentist_id: parseInt($('treat-dentist-id').value)||null,
    treatment_date: dt,
    tooth_number:   $('treat-tooth').value||null,
    diagnosis:      $('treat-diagnosis').value||null,
    procedure_name: $('treat-procedure').value||null,
    notes:          $('treat-notes').value||null,
    cost:           parseFloat($('treat-cost').value)||0
  };
  try {
    if (id) { await put(`/api/treatments/${id}`, data); toast('Treatment updated'); }
    else     { await post('/api/treatments', data); toast('Treatment added'); }
    hideModal('treatmentModal');
    loadTreatments();
  } catch(e) { toast(e.message,'error'); }
}

function deleteTreatment(id) {
  confirm('Delete this treatment record?', async () => {
    try { await del(`/api/treatments/${id}`); toast('Treatment deleted'); loadTreatments(); }
    catch(e) { toast(e.message,'error'); }
  });
}

function printTreatmentsList() {
  const element = $('treatments-table-print');
  if (!element) return;
  const clinic = SETTINGS;
  const printWindow = window.open('', '', 'width=1200,height=700');
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Treatment Records</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <style>
    body { font-size: 12px; }
    .print-header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .print-date { text-align: right; color: #666; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th { background-color: #17a2b8; color: white; padding: 8px; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    .action-btns { display: none; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body class="p-4">
  <div class="print-header">
    <h3>${esc(clinic.clinic_name||'Dental Clinic')}</h3>
    <p style="margin:5px 0;">${esc(clinic.clinic_address||'')} | ${esc(clinic.clinic_phone||'')}</p>
    <div class="print-date">Printed on ${fmtDateTime()}</div>
  </div>
  <h5 style="margin-bottom: 15px;">Treatment Records</h5>
  ${element.innerHTML}
  <script>
    window.onload = function() { window.print(); setTimeout(() => window.close(), 500); }
  </script>
</body>
</html>`;
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

// ═══════════════════════════════════════════
// INVOICES / BILLING
// ═══════════════════════════════════════════
function _invRow(i) {
  return `<tr>
    <td><span class="badge bg-warning-subtle text-warning fw-bold">${esc(i.invoice_number)}</span></td>
    <td>${fmtDate(i.issue_date)}</td>
    <td><div style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${i.patient_id})">${esc(i.patient_name)}</div>
        <small class="text-muted">${esc(i.patient_number)}</small></td>
    <td>${fmt(i.total)}</td>
    <td class="text-success fw-bold">${fmt(i.amount_paid)}</td>
    <td class="${i.balance>0?'text-danger fw-bold':''}">${fmt(i.balance)}</td>
    <td>${statusBadge(i.payment_status)}</td>
    <td class="action-btns">
      <button class="btn btn-sm btn-outline-warning" onclick="viewInvoice(${i.id})" title="View"><i class="fas fa-eye"></i></button>
      <button class="btn btn-sm btn-outline-danger" onclick="deleteInvoice(${i.id},'${esc(i.invoice_number)}')" title="Delete"><i class="fas fa-trash"></i></button>
    </td></tr>`;
}
function _filterInvs(val) {
  const q = (val||'').toLowerCase();
  const list = q ? _loadedInvs.filter(i =>
    (i.invoice_number||'').toLowerCase().includes(q) ||
    (i.patient_name||'').toLowerCase().includes(q) ||
    (i.patient_number||'').toLowerCase().includes(q)
  ) : _loadedInvs;
  const tbody = document.querySelector('#inv-tbody');
  if (tbody) tbody.innerHTML = list.length
    ? list.map(_invRow).join('')
    : '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-file-invoice"></i>No invoices found</div></td></tr>';
  const badge = $('inv-count-badge');
  if (badge) badge.textContent = list.length + ' invoices';
}
function _searchInvoices(val) { _applyInvFilters(); }
function _applyInvFilters() {
  const filter = {};
  const s = $('filter-inv-status')?.value;
  const q = $('inv-search')?.value;
  if (s) filter.payment_status = s;
  if (q) filter.search = q;
  loadInvoices(filter);
}

async function loadInvoices(filter={}) {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-warning"></div></div>`;
  try {
    const params = new URLSearchParams(filter).toString();
    const invs   = await get('/api/invoices' + (params?'?'+params:''));
    _loadedInvs = invs;
    renderInvoicesSection(invs, filter);
    if (filter.search && $('inv-search')) { $('inv-search').value = filter.search; _showClear('inv-search', filter.search); }
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function renderInvoicesSection(invs, filter={}) {
  const totalBilled   = invs.reduce((s,i)=>s+i.total,0);
  const totalCollected= invs.reduce((s,i)=>s+i.amount_paid,0);
  const totalPending  = invs.reduce((s,i)=>s+i.balance,0);

  $('content-area').innerHTML = `
    <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4>Billing & Invoices</h4><p>Manage invoices and track payments</p></div>
      <button class="btn btn-warning" onclick="openInvoiceModal()"><i class="fas fa-plus me-1"></i>Create Invoice</button>
    </div>
    <div class="row g-3 mb-3">
      <div class="col-sm-4"><div class="stat-card"><div class="stat-icon amber"><i class="fas fa-file-invoice-dollar"></i></div><div><div class="stat-value">${fmt(totalBilled)}</div><div class="stat-label">Total Billed</div></div></div></div>
      <div class="col-sm-4"><div class="stat-card"><div class="stat-icon green"><i class="fas fa-check-circle"></i></div><div><div class="stat-value">${fmt(totalCollected)}</div><div class="stat-label">Collected</div></div></div></div>
      <div class="col-sm-4"><div class="stat-card"><div class="stat-icon red"><i class="fas fa-exclamation-circle"></i></div><div><div class="stat-value">${fmt(totalPending)}</div><div class="stat-label">Outstanding</div></div></div></div>
    </div>
    <div class="table-card">
      <div class="table-toolbar flex-wrap gap-2">
        ${_searchBox('inv-search','Type to search · Enter to scan barcode','_filterInvs','_searchInvoices')}
        <select class="form-select form-select-sm" id="filter-inv-status" style="width:150px" onchange="_applyInvFilters()">
          <option value="">All Statuses</option>
          <option ${filter.payment_status==='unpaid'?'selected':''} value="unpaid">Unpaid</option>
          <option ${filter.payment_status==='partial'?'selected':''} value="partial">Partial</option>
          <option ${filter.payment_status==='paid'?'selected':''} value="paid">Paid</option>
        </select>
        <span class="badge bg-secondary ms-auto" id="inv-count-badge">${invs.length} invoices</span>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead><tr><th>Invoice #</th><th>Patient</th><th>Date</th><th>Due</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="inv-tbody">
            ${invs.length ? invs.map(i => `
              <tr>
                <td><strong>${esc(i.invoice_number)}</strong></td>
                <td><span style="cursor:pointer;color:#1a56db;font-weight:600" onclick="viewPatient(${i.patient_id})">${esc(i.patient_name)}</span></td>
                <td>${fmtDate(i.issue_date)}</td>
                <td>${fmtDate(i.due_date)}</td>
                <td>${fmt(i.total)}</td>
                <td>${fmt(i.amount_paid)}</td>
                <td><strong ${i.balance>0?'class="text-danger"':''}>${fmt(i.balance)}</strong></td>
                <td>${statusBadge(i.payment_status)}</td>
                <td class="action-btns">
                  <button class="btn btn-sm btn-outline-primary" onclick="viewInvoice(${i.id})" title="View"><i class="fas fa-eye"></i></button>
                  ${i.payment_status!=='paid'?`<button class="btn btn-sm btn-outline-success" onclick="openPaymentModal(${i.id},${i.total},${i.amount_paid})" title="Record Payment"><i class="fas fa-dollar-sign"></i></button>`:''}
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteInvoice(${i.id},'${esc(i.invoice_number)}')" title="Delete"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('') : '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-file-invoice"></i>No invoices found</div></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function openInvoiceModal(prePatientId=null) {
  try {
    await loadPatientOptions('inv-patient-id');
    currentInvoiceItems = [];
    renderInvoiceItemsTable();
    $('inv-issue-date').value    = today();
    $('inv-due-date').value      = '';
    $('inv-notes').value         = '';
    $('inv-discount').value      = '0';
    $('inv-tax-rate').value      = SETTINGS.tax_rate||'0';
    $('inv-amount-paid').value   = '0';
    $('inv-payment-method').value= '';
    recalcInvoice();
    if (prePatientId) $('inv-patient-id').value = prePatientId;
    addInvoiceItem();
    _markAddMode('invoiceModal', true);
    showModal('invoiceModal');
  } catch(e) { toast('Could not open invoice form: ' + e.message, 'error'); }
}

function createInvoiceForAppt(patientId) { openInvoiceModal(patientId); }

function addInvoiceItem() {
  currentInvoiceItems.push({ service_id: null, description: '', quantity: 1, unit_price: 0 });
  renderInvoiceItemsTable();
}

function removeInvoiceItem(idx) {
  currentInvoiceItems.splice(idx, 1);
  renderInvoiceItemsTable();
  recalcInvoice();
}

function renderInvoiceItemsTable() {
  const tbody = $('invoice-items-body');
  if (!tbody) return;
  tbody.innerHTML = currentInvoiceItems.map((item, i) => `
    <tr>
      <td><input type="text" class="form-control form-control-sm" placeholder="Description" value="${esc(item.description)}" oninput="updateInvoiceItem(${i},'description',this.value)"/></td>
      <td>
        <select class="form-select form-select-sm" onchange="selectInvoiceService(${i},this.value)">
          <option value="">Manual...</option>
          ${allServices.filter(s=>s.active).map(s=>`<option value="${s.id}" data-price="${s.price}" ${item.service_id==s.id?'selected':''}>${esc(s.name)}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" class="form-control form-control-sm" min="1" value="${item.quantity}" oninput="updateInvoiceItem(${i},'quantity',+this.value||1)"/></td>
      <td><input type="number" class="form-control form-control-sm" min="0" step="0.01" value="${item.unit_price}" oninput="updateInvoiceItem(${i},'unit_price',+this.value||0)"/></td>
      <td class="fw-bold">${fmt(item.quantity*item.unit_price)}</td>
      <td><button class="btn btn-xs btn-outline-danger" onclick="removeInvoiceItem(${i})"><i class="fas fa-times"></i></button></td>
    </tr>`).join('');
}

function updateInvoiceItem(idx, field, val) {
  currentInvoiceItems[idx][field] = val;
  renderInvoiceItemsTable();
  recalcInvoice();
}

function selectInvoiceService(idx, serviceId) {
  if (!serviceId) return;
  const svc = allServices.find(s=>s.id==serviceId);
  if (svc) {
    currentInvoiceItems[idx].service_id  = svc.id;
    currentInvoiceItems[idx].description = svc.name;
    currentInvoiceItems[idx].unit_price  = svc.price;
    renderInvoiceItemsTable();
    recalcInvoice();
  }
}

function recalcInvoice() {
  const subtotal   = currentInvoiceItems.reduce((s,i)=>s+(i.quantity*(i.unit_price||0)),0);
  const discount   = parseFloat($('inv-discount')?.value)||0;
  const taxRate    = parseFloat($('inv-tax-rate')?.value)||0;
  const taxable    = Math.max(subtotal - discount, 0);
  const tax        = taxable * taxRate / 100;
  const total      = taxable + tax;
  const paid       = parseFloat($('inv-amount-paid')?.value)||0;
  const balance    = Math.max(total - paid, 0);
  if($('inv-subtotal')) $('inv-subtotal').textContent = fmt(subtotal);
  if($('inv-total'))    $('inv-total').textContent    = fmt(total);
  if($('inv-balance'))  $('inv-balance').textContent  = fmt(balance);
}

async function saveInvoice() {
  const pid = $('inv-patient-id').value;
  const dt  = $('inv-issue-date').value;
  if (!pid || !dt) { toast('Patient and issue date are required','warning'); return; }

  const items = currentInvoiceItems
    .map(i => ({
      service_id: i.service_id||null,
      description: (i.description||'').trim(),
      quantity: Math.max(1, Number(i.quantity) || 1),
      unit_price: Math.max(0, Number(i.unit_price) || 0)
    }))
    .filter(i => i.description);

  if (!items.length) {
    toast('Add at least one invoice item with a description','warning'); return;
  }

  const invalidItem = items.find(i => i.quantity <= 0 || i.unit_price < 0);
  if (invalidItem) {
    toast('Invoice items must have a valid quantity and unit price','warning'); return;
  }

  const data = {
    patient_id: parseInt(pid, 10),
    issue_date: dt,
    due_date:   $('inv-due-date').value||null,
    discount:   parseFloat($('inv-discount').value)||0,
    tax_rate:   parseFloat($('inv-tax-rate').value)||0,
    notes:      $('inv-notes').value||null,
    payment_method: $('inv-payment-method').value||null,
    amount_paid:    parseFloat($('inv-amount-paid').value)||0,
    items
  };
  try {
    await post('/api/invoices', data);
    toast('Invoice created');
    hideModal('invoiceModal');
    loadInvoices();
  } catch(e) { toast(e.message,'error'); }
}

async function viewInvoice(id) {
  currentViewingInvoiceId = id;
  try {
    const inv = await get(`/api/invoices/${id}`);
    const clinic = SETTINGS;
    $('invoice-view-content').innerHTML = `
      <div id="printable-invoice">
        <style>${_rphCSS}</style>
        ${_patientHdr(inv.patient_number, inv.patient_name, inv.patient_dob, inv.patient_gender, fmtDate(inv.issue_date), inv.patient_photo || inv.patient_photo_thumb)}
        <div class="d-flex justify-content-between align-items-start mb-4">
          <div>
            <h4 class="text-primary fw-bold">${esc(clinic.clinic_name||'Dental Clinic')}</h4>
            <div class="text-muted small">${esc(clinic.clinic_address||'')} ${esc(clinic.clinic_city||'')}</div>
            <div class="text-muted small">${esc(clinic.clinic_phone||'')} | ${esc(clinic.clinic_email||'')}</div>
          </div>
          <div class="text-end">
            <h5 class="fw-bold">INVOICE</h5>
            <div><strong>${esc(inv.invoice_number)}</strong></div>
            <div class="text-muted small">Date: ${fmtDate(inv.issue_date)}</div>
            ${inv.due_date?`<div class="text-muted small">Due: ${fmtDate(inv.due_date)}</div>`:''}
            <div class="mt-1">${statusBadge(inv.payment_status)}</div>
          </div>
        </div>
        <div class="bg-light p-3 rounded mb-3">
          <strong>Bill To:</strong><br/>
          ${esc(inv.patient_name)} <span class="text-muted">(${esc(inv.patient_number)})</span><br/>
          ${inv.patient_phone?`${esc(inv.patient_phone)}<br/>`:''}
          ${inv.patient_email?`${esc(inv.patient_email)}<br/>`:''}
          ${inv.patient_address?`${esc(inv.patient_address)}, ${esc(inv.patient_city||'')}<br/>`:''}
          ${inv.insurance_provider?`<span class="badge bg-info-subtle text-info">${esc(inv.insurance_provider)} #${esc(inv.insurance_number||'')}</span>`:''}
        </div>
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light"><tr><th>Description</th><th class="text-center">Qty</th><th class="text-end">Unit Price</th><th class="text-end">Total</th></tr></thead>
          <tbody>${inv.items.map(i=>`<tr><td>${esc(i.description)}</td><td class="text-center">${i.quantity}</td><td class="text-end">${fmt(i.unit_price)}</td><td class="text-end"><strong>${fmt(i.total)}</strong></td></tr>`).join('')}</tbody>
        </table>
        <div class="row justify-content-end">
          <div class="col-md-5">
            <table class="table table-sm">
              <tr><td>Subtotal</td><td class="text-end">${fmt(inv.subtotal)}</td></tr>
              ${inv.discount>0?`<tr><td>Discount</td><td class="text-end text-danger">- ${fmt(inv.discount)}</td></tr>`:''}
              ${inv.tax_amount>0?`<tr><td>Tax (${inv.tax_rate}%)</td><td class="text-end">${fmt(inv.tax_amount)}</td></tr>`:''}
              <tr class="fw-bold"><td>Total</td><td class="text-end">${fmt(inv.total)}</td></tr>
              <tr><td>Amount Paid</td><td class="text-end text-success">${fmt(inv.amount_paid)}</td></tr>
              <tr class="fw-bold text-danger"><td>Balance Due</td><td class="text-end">${fmt(inv.balance)}</td></tr>
            </table>
          </div>
        </div>
        ${inv.notes?`<div class="alert alert-light"><strong>Notes:</strong> ${esc(inv.notes)}</div>`:''}
        ${inv.payment_method?`<div class="text-muted small">Payment Method: ${esc(inv.payment_method)}</div>`:''}
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:40px;gap:16px;">
          <div style="flex:1;text-align:center;">
            ${SETTINGS.clinic_signature ? `<img src="${esc(SETTINGS.clinic_signature)}" style="max-height:60px;max-width:160px;object-fit:contain;display:block;margin:0 auto 6px;"/>` : '<div style="height:60px;"></div>'}
            <div style="border-top:1.5px solid #334155;padding-top:5px;font-size:11px;color:#555;">Authorized Signature</div>
          </div>
          <div style="flex:0 0 100px;text-align:center;">
            <div style="width:90px;height:90px;border:1.5px dashed #bbb;border-radius:50%;margin:0 auto;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fafafe;">
              ${SETTINGS.clinic_stamp ? `<img src="${esc(SETTINGS.clinic_stamp)}" style="width:100%;height:100%;object-fit:contain;"/>` : '<span style="font-size:9px;color:#ccc;">Stamp</span>'}
            </div>
          </div>
          <div style="flex:1;text-align:center;">
            <div style="height:60px;"></div>
            <div style="border-top:1.5px solid #334155;padding-top:5px;font-size:11px;color:#555;">Patient / Receiver Signature</div>
          </div>
        </div>
      </div>`;
    renderBarcode('pt-barcode', inv.patient_number);
    $('inv-pay-btn').style.display = inv.payment_status==='paid' ? 'none' : '';
    $('inv-pay-btn').onclick = () => { hideModal('invoiceViewModal'); openPaymentModal(id, inv.total, inv.amount_paid); };
    showModal('invoiceViewModal');
  } catch(e) { toast(e.message,'error'); }
}

function printBill() {
  const content = $('printable-invoice');
  if (!content) return;
  post('/api/activity/print', { entity:'invoice', entity_id:currentViewingInvoiceId, description:`Printed invoice #${currentViewingInvoiceId}` }).catch(()=>{});
  const printWindow = window.open('', '', 'width=900,height=700');
  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Invoice</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <style>
    body { font-size: 13px; }
    .print-header { margin-bottom: 20px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body class="p-4">
${content.innerHTML}
<div style="text-align:center;color:#999;font-size:11px;margin-top:12px;border-top:1px solid #ddd;padding-top:6px;">Printed by: ${esc(_currentUser?.full_name||'—')} | ${fmtDateTime()}</div>
<script>
  window.onload = function() {
    if (typeof JsBarcode !== 'undefined') {
      var b = document.getElementById('pt-barcode');
      if (b && b.dataset.value) {
        try { JsBarcode('#pt-barcode', b.dataset.value, { format: 'CODE128', width: 1.5, height: 38, displayValue: true, fontSize: 11, margin: 3, background: 'transparent' }); } catch(e) {}
      }
    }
    window.print();
    setTimeout(() => window.close(), 500);
  }
</script>
</body>
</html>`);
  printWindow.document.close();
}

function downloadBillPDF() {
  const element = $('printable-invoice');
  if (!element) { toast('Invoice not found', 'error'); return; }
  const opt = {
    margin: 10,
    filename: 'invoice.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
  };
  if (typeof html2pdf !== 'undefined') {
    html2pdf().set(opt).from(element).save();
  } else {
    toast('PDF library not loaded. Using print instead.', 'warning');
    printBill();
  }
}

function printInvoice() {
  printBill();
}

function openPaymentModal(id, total, alreadyPaid) {
  $('pay-invoice-id').value = id;
  $('pay-total').value      = fmt(total);
  $('pay-amount').value     = (total - (alreadyPaid||0)).toFixed(2);
  showModal('paymentModal');
}

async function submitPayment() {
  const id     = $('pay-invoice-id').value;
  const amount = parseFloat($('pay-amount').value)||0;
  const method = $('pay-method').value;
  if (!amount) { toast('Enter payment amount','warning'); return; }
  try {
    await put(`/api/invoices/${id}`, { amount_paid: amount, payment_method: method });
    toast('Payment recorded');
    hideModal('paymentModal');
    loadInvoices();
  } catch(e) { toast(e.message,'error'); }
}

function deleteInvoice(id, num) {
  confirm(`Delete invoice ${num}?`, async () => {
    try { await del(`/api/invoices/${id}`); toast('Invoice deleted'); loadInvoices(); }
    catch(e) { toast(e.message,'error'); }
  });
}

// ═══════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════
async function loadReports() {
  $('content-area').innerHTML = `
    <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4>Reports & Analytics</h4><p>Business insights and performance metrics</p></div>
      <button class="btn btn-outline-secondary" onclick="printReports()"><i class="fas fa-print me-1"></i>Print</button>
    </div>
    <div class="row g-3 mb-3">
      <div class="col-md-4">
        <select class="form-select" id="report-year" onchange="refreshReports()">
          ${[0,1,2].map(i=>{const y=new Date().getFullYear()-i;return`<option value="${y}">${y}</option>`;}).join('')}
        </select>
      </div>
    </div>
    <div class="row g-3" id="reports-container">
      <div class="col-lg-8"><div class="card"><div class="card-header"><strong><i class="fas fa-chart-bar me-2 text-warning"></i>Monthly Revenue</strong></div><div class="card-body"><div class="chart-container"><canvas id="rpt-revenue"></canvas></div></div></div></div>
      <div class="col-lg-4"><div class="card"><div class="card-header"><strong><i class="fas fa-chart-pie me-2 text-primary"></i>Payment Status</strong></div><div class="card-body d-flex align-items-center justify-content-center" style="min-height:200px"><canvas id="rpt-pay-status" style="max-height:220px"></canvas></div></div></div>
      <div class="col-lg-6"><div class="card"><div class="card-header"><strong><i class="fas fa-calendar me-2 text-success"></i>Appointments (Last 90 days)</strong></div><div class="card-body"><div class="chart-container"><canvas id="rpt-appts"></canvas></div></div></div></div>
      <div class="col-lg-6"><div class="card"><div class="card-header"><strong><i class="fas fa-users me-2 text-info"></i>Patient Demographics</strong></div><div class="card-body d-flex align-items-center justify-content-center" style="min-height:200px"><canvas id="rpt-patients" style="max-height:220px"></canvas></div></div></div>
      <div class="col-12"><div class="card"><div class="card-header"><strong><i class="fas fa-star me-2 text-danger"></i>Top Services by Revenue</strong></div><div class="card-body"><div id="rpt-top-services"></div></div></div></div>
      ${_currentUser && _currentUser.role==='admin' ? `
      <div class="col-12">
        <div class="card border-primary">
          <div class="card-header d-flex justify-content-between align-items-center" style="background:linear-gradient(135deg,#1a56db,#1e40af);color:#fff;">
            <strong><i class="fas fa-user-shield me-2"></i>User Activity Report</strong>
            <button class="btn btn-sm btn-light" onclick="printUserReport()"><i class="fas fa-print me-1"></i>Print</button>
          </div>
          <div class="card-body border-bottom py-2 px-3" style="background:#f8faff;">
            <div class="row g-2 align-items-end">
              <div class="col-md-3">
                <label class="form-label small fw-semibold mb-1"><i class="fas fa-user me-1 text-primary"></i>User</label>
                <select class="form-select form-select-sm" id="ua-user-id" onchange="loadUserActivity()">
                  <option value="">All Users</option>
                </select>
              </div>
              <div class="col-md-2">
                <label class="form-label small fw-semibold mb-1"><i class="fas fa-calendar-alt me-1 text-success"></i>From</label>
                <input type="date" class="form-control form-control-sm" id="ua-from" onchange="loadUserActivity()">
              </div>
              <div class="col-md-2">
                <label class="form-label small fw-semibold mb-1"><i class="fas fa-calendar-alt me-1 text-success"></i>To</label>
                <input type="date" class="form-control form-control-sm" id="ua-to" onchange="loadUserActivity()">
              </div>
              <div class="col-md-3">
                <label class="form-label small fw-semibold mb-1"><i class="fas fa-bolt me-1 text-warning"></i>Activity</label>
                <select class="form-select form-select-sm" id="ua-action" onchange="loadUserActivity()">
                  <option value="">All Activities</option>
                  <option value="add">Add</option>
                  <option value="update">Update</option>
                  <option value="delete">Delete</option>
                  <option value="print">Print</option>
                  <option value="login">Login</option>
                  <option value="logout">Logout</option>
                </select>
              </div>
              <div class="col-md-2">
                <button class="btn btn-outline-secondary btn-sm w-100" onclick="clearUserActivityFilter()">
                  <i class="fas fa-times me-1"></i>Clear Filters
                </button>
              </div>
            </div>
          </div>
          <div class="card-body p-0"><div id="rpt-user-activity"><div class="text-center py-4 text-muted"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</div></div></div>
        </div>
      </div>` : ''}
    </div>`;
  refreshReports();
}

async function refreshReports() {
  try {
    const year     = $('report-year')?.value || new Date().getFullYear();
    const [rev, appts, patients] = await Promise.all([
      get(`/api/reports/revenue?year=${year}`),
      get('/api/reports/appointments'),
      get('/api/reports/patients')
    ]);

    // Revenue bar chart
    const allMonths = Array.from({length:12},(_,i)=>{const d=new Date(year,i);return `${year}-${String(i+1).padStart(2,'0')}`;});
    const revMap = {}; rev.monthly.forEach(m=>revMap[m.month]=m);
    if (_charts.revenue) _charts.revenue.destroy();
    _charts.revenue = new Chart($('rpt-revenue'), {
      type:'bar',
      data:{labels:allMonths.map(m=>{const[y,mo]=m.split('-');return `${mo}/${y}`;}),
        datasets:[
          {label:'Billed',data:allMonths.map(m=>revMap[m]?.billed||0),backgroundColor:'rgba(26,86,219,.4)',borderColor:'#1a56db',borderWidth:1,borderRadius:4},
          {label:'Collected',data:allMonths.map(m=>revMap[m]?.collected||0),backgroundColor:'rgba(16,185,129,.7)',borderColor:'#059669',borderWidth:1,borderRadius:4}
        ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top'}},scales:{y:{beginAtZero:true,ticks:{callback:v=>'$'+v.toLocaleString()}}}}
    });

    // Payment status donut
    const psColors={paid:'#10b981',unpaid:'#ef4444',partial:'#f59e0b'};
    if (_charts.payStatus) _charts.payStatus.destroy();
    _charts.payStatus = new Chart($('rpt-pay-status'), {
      type:'doughnut',
      data:{labels:rev.byStatus.map(s=>s.payment_status),datasets:[{data:rev.byStatus.map(s=>s.amount),backgroundColor:rev.byStatus.map(s=>psColors[s.payment_status]||'#94a3b8'),borderWidth:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},padding:10}},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fmt(ctx.raw)}`}}}}
    });

    // Appointments bar
    if (_charts.appts) _charts.appts.destroy();
    _charts.appts = new Chart($('rpt-appts'), {
      type:'bar',
      data:{labels:appts.byMonth.map(m=>{const[y,mo]=m.month.split('-');return `${mo}/${y}`;}),
        datasets:[{label:'Appointments',data:appts.byMonth.map(m=>m.cnt),backgroundColor:'rgba(16,185,129,.7)',borderRadius:5}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}
    });

    // Patient gender donut
    const gColors={'Male':'#3b82f6','Female':'#ec4899','Other':'#8b5cf6','Unknown':'#94a3b8'};
    if (_charts.patients) _charts.patients.destroy();
    _charts.patients = new Chart($('rpt-patients'), {
      type:'pie',
      data:{labels:patients.byGender.map(g=>g.gender),datasets:[{data:patients.byGender.map(g=>g.cnt),backgroundColor:patients.byGender.map(g=>gColors[g.gender]||'#94a3b8'),borderWidth:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},padding:10}}}}
    });

    // Top services table
    const maxRev = rev.topServices[0]?.revenue||1;
    $('rpt-top-services').innerHTML = `
      <div class="row g-2">
        ${rev.topServices.slice(0,8).map(s=>`
          <div class="col-md-6">
            <div class="d-flex align-items-center gap-2 p-2 rounded bg-light">
              <div style="flex:1">
                <div class="d-flex justify-content-between"><strong style="font-size:.85rem">${esc(s.description)}</strong><span class="text-success fw-bold">${fmt(s.revenue)}</span></div>
                <div class="progress mt-1" style="height:4px"><div class="progress-bar bg-primary" style="width:${(s.revenue/maxRev*100).toFixed(0)}%"></div></div>
              </div>
              <span class="badge bg-secondary">${s.cnt}x</span>
            </div>
          </div>`).join('')}
      </div>`;

    // User activity loaded separately so filters work independently
    if (_currentUser && _currentUser.role==='admin') loadUserActivity();
  } catch(e) { toast(e.message,'error'); }
}

const _actBadge = { add:'bg-success', update:'bg-warning text-dark', delete:'bg-danger', print:'bg-info text-dark', login:'bg-primary', logout:'bg-secondary' };
const _actLabel = { add:'Add', update:'Update', delete:'Delete', print:'Print', login:'Login', logout:'Logout' };

async function loadUserActivity() {
  const el = $('rpt-user-activity');
  if (!el) return;
  el.innerHTML = `<div class="text-center py-3 text-muted"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</div>`;

  // Populate user dropdown once
  const sel = $('ua-user-id');
  if (sel && sel.options.length <= 1) {
    try {
      const allUsers = await get('/api/users');
      allUsers.forEach(u => {
        const o = document.createElement('option');
        o.value = u.id; o.textContent = `${esc(u.full_name)} (${esc(u.username)})`;
        sel.appendChild(o);
      });
    } catch(_) {}
  }

  const userId = $('ua-user-id')?.value || '';
  const from   = $('ua-from')?.value   || '';
  const to     = $('ua-to')?.value     || '';
  const action = $('ua-action')?.value || '';

  const q = new URLSearchParams();
  if (userId) q.set('user_id', userId);
  if (from)   q.set('from', from);
  if (to)     q.set('to', to);
  if (action) q.set('action', action);
  const qs = q.toString();

  try {
    const [users, log] = await Promise.all([
      get(`/api/reports/users${qs?'?'+qs:''}`),
      get(`/api/reports/activity-log${qs?'?'+qs:''}`)
    ]);

    const totals = { added:0, updated:0, deleted:0, printed:0, logins:0 };
    users.forEach(u => { totals.added+=u.total_added; totals.updated+=u.total_updated; totals.deleted+=u.total_deleted; totals.printed+=u.total_printed; totals.logins+=u.total_logins; });

    const summaryHtml = `
      <div class="table-responsive">
        <table class="table table-sm table-hover mb-0">
          <thead class="table-light">
            <tr>
              <th>#</th><th>Full Name</th><th>Username</th><th>Role</th><th>Status</th>
              <th title="Records added"><i class="fas fa-plus-circle text-success"></i> Added</th>
              <th title="Records updated"><i class="fas fa-edit text-warning"></i> Updated</th>
              <th title="Records deleted"><i class="fas fa-trash text-danger"></i> Deleted</th>
              <th title="Print actions"><i class="fas fa-print text-info"></i> Printed</th>
              <th title="Login count"><i class="fas fa-sign-in-alt text-primary"></i> Logins</th>
              <th>Last Login</th>
            </tr>
          </thead>
          <tbody>
            ${users.map((u,i)=>`<tr>
              <td>${i+1}</td>
              <td><strong>${esc(u.full_name)}</strong></td>
              <td><code>${esc(u.username)}</code></td>
              <td><span class="badge ${u.role==='admin'?'bg-danger':'bg-secondary'}">${esc(u.role)}</span></td>
              <td><span class="badge ${u.active?'bg-success':'bg-dark'}">${u.active?'Active':'Inactive'}</span></td>
              <td><span class="badge bg-success">${u.total_added}</span></td>
              <td><span class="badge bg-warning text-dark">${u.total_updated}</span></td>
              <td><span class="badge bg-danger">${u.total_deleted}</span></td>
              <td><span class="badge bg-info text-dark">${u.total_printed}</span></td>
              <td><span class="badge bg-primary">${u.total_logins}</span></td>
              <td>${u.last_login?fmtDateTime(u.last_login):'Never'}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot class="table-secondary fw-bold">
            <tr>
              <td colspan="5" class="text-end">Totals:</td>
              <td><span class="badge bg-success">${totals.added}</span></td>
              <td><span class="badge bg-warning text-dark">${totals.updated}</span></td>
              <td><span class="badge bg-danger">${totals.deleted}</span></td>
              <td><span class="badge bg-info text-dark">${totals.printed}</span></td>
              <td><span class="badge bg-primary">${totals.logins}</span></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;

    const detailHtml = log.length ? `
      <div class="border-top mt-0">
        <div class="px-3 py-2 bg-light border-bottom d-flex justify-content-between align-items-center">
          <strong style="font-size:.85rem"><i class="fas fa-list me-1 text-secondary"></i>Activity Log</strong>
          <span class="badge bg-secondary">${log.length}${log.length===300?' (max)':''} entries</span>
        </div>
        <div class="table-responsive" style="max-height:320px;overflow-y:auto;">
          <table class="table table-sm table-striped mb-0" style="font-size:.8rem;">
            <thead class="table-dark sticky-top">
              <tr><th>Date / Time</th><th>User</th><th>Action</th><th>Entity</th><th>Description</th></tr>
            </thead>
            <tbody>
              ${log.map(r=>`<tr>
                <td style="white-space:nowrap">${fmtDateTime(r.created_at)}</td>
                <td><strong>${esc(r.full_name)}</strong></td>
                <td><span class="badge ${_actBadge[r.action]||'bg-secondary'}">${_actLabel[r.action]||esc(r.action)}</span></td>
                <td>${esc(r.entity)}</td>
                <td>${esc(r.description||'—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : (qs ? `<div class="text-center text-muted py-3 small">No activity records match the selected filters.</div>` : '');

    el.innerHTML = summaryHtml + detailHtml;
  } catch(e) { el.innerHTML = `<p class="text-danger p-3">Failed to load user activity: ${esc(e.message)}</p>`; }
}

function clearUserActivityFilter() {
  ['ua-user-id','ua-from','ua-to','ua-action'].forEach(id => { if ($(id)) $(id).value = ''; });
  loadUserActivity();
}

async function printUserReport() {
  if (!(_currentUser && _currentUser.role==='admin')) { toast('Admin access required','warning'); return; }
  try {
    const userId = $('ua-user-id')?.value || '';
    const from   = $('ua-from')?.value   || '';
    const to     = $('ua-to')?.value     || '';
    const action = $('ua-action')?.value || '';
    const q = new URLSearchParams();
    if (userId) q.set('user_id', userId);
    if (from)   q.set('from', from);
    if (to)     q.set('to', to);
    if (action) q.set('action', action);
    const qs = q.toString();

    const [users, log] = await Promise.all([
      get(`/api/reports/users${qs?'?'+qs:''}`),
      get(`/api/reports/activity-log${qs?'?'+qs:''}`)
    ]);
    post('/api/activity/print', { entity:'user_report', entity_id:null, description:'Printed user activity report' }).catch(()=>{});
    const totals = { added:0, updated:0, deleted:0, printed:0, logins:0 };
    users.forEach(u=>{ totals.added+=u.total_added; totals.updated+=u.total_updated; totals.deleted+=u.total_deleted; totals.printed+=u.total_printed; totals.logins+=u.total_logins; });
    // Build filter summary line for the report header
    const filterParts = [];
    if (userId) { const sel=$('ua-user-id'); filterParts.push('User: '+(sel?.options[sel.selectedIndex]?.text||userId)); }
    if (from)   filterParts.push('From: '+fmtDate(from));
    if (to)     filterParts.push('To: '+fmtDate(to));
    if (action) filterParts.push('Activity: '+(_actLabel[action]||action));
    const filterLine = filterParts.length ? `<div style="font-size:11px;color:#555;margin-top:4px;">Filters: ${filterParts.join(' | ')}</div>` : '';
    const w = window.open('','_blank');
    w.document.write(`<!DOCTYPE html><html><head>
  <title>User Activity Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,sans-serif;font-size:12px;padding:18px;}
    .ch{text-align:center;border-bottom:2px solid #1a56db;padding-bottom:8px;margin-bottom:16px;}
    .ch h3{color:#1a56db;font-size:15px;} .ch p{color:#555;font-size:11px;margin-top:3px;}
    table{width:100%;border-collapse:collapse;margin-top:10px;}
    th{background:#1a56db;color:#fff;padding:6px 8px;text-align:left;font-size:11px;}
    td{padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;text-align:center;}
    td:nth-child(2),td:nth-child(3),td:nth-child(4){text-align:left;}
    tfoot td{background:#f1f5f9;font-weight:bold;}
    .badge-admin{background:#dc3545;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;}
    .badge-user{background:#6c757d;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;}
    .badge-active{background:#198754;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;}
    .badge-inactive{background:#212529;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;}
    .ft{text-align:center;color:#aaa;font-size:10px;margin-top:12px;border-top:1px solid #ddd;padding-top:5px;}
    @media print{body{padding:8px;}@page{margin:10mm;}}
  </style></head><body>
  <div class="ch">
    <h3>${esc(SETTINGS.clinic_name||'Dental Clinic')}</h3>
    <p>${esc(SETTINGS.clinic_address||'')}${SETTINGS.clinic_city?', '+esc(SETTINGS.clinic_city):''} | ${esc(SETTINGS.clinic_phone||'')} | ${esc(SETTINGS.clinic_email||'')}</p>
    <h5 style="color:#1a56db;margin-top:6px;">User Activity Report</h5>
    ${filterLine}
  </div>
  <table>
    <thead><tr><th>#</th><th>Full Name</th><th>Username</th><th>Role</th><th>Status</th><th>Added</th><th>Updated</th><th>Deleted</th><th>Printed</th><th>Logins</th><th>Last Login</th></tr></thead>
    <tbody>
      ${users.map((u,i)=>`<tr>
        <td>${i+1}</td>
        <td style="text-align:left"><strong>${esc(u.full_name)}</strong></td>
        <td style="text-align:left">${esc(u.username)}</td>
        <td style="text-align:left"><span class="${u.role==='admin'?'badge-admin':'badge-user'}">${esc(u.role)}</span></td>
        <td><span class="${u.active?'badge-active':'badge-inactive'}">${u.active?'Active':'Inactive'}</span></td>
        <td>${u.total_added}</td><td>${u.total_updated}</td><td>${u.total_deleted}</td>
        <td>${u.total_printed}</td><td>${u.total_logins}</td>
        <td>${u.last_login?fmtDateTime(u.last_login):'Never'}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td colspan="5" style="text-align:right;">Totals:</td>
      <td>${totals.added}</td><td>${totals.updated}</td><td>${totals.deleted}</td>
      <td>${totals.printed}</td><td>${totals.logins}</td><td></td>
    </tr></tfoot>
  </table>
  ${log.length ? `
  <br/>
  <table>
    <thead style="background:#334155;">
      <tr><th>Date / Time</th><th>User</th><th>Action</th><th>Entity</th><th>Description</th></tr>
    </thead>
    <tbody>
      ${log.map(r=>`<tr>
        <td style="white-space:nowrap;text-align:left">${fmtDateTime(r.created_at)}</td>
        <td style="text-align:left">${esc(r.full_name)}</td>
        <td style="text-align:left">${esc(r.action)}</td>
        <td style="text-align:left">${esc(r.entity)}</td>
        <td style="text-align:left">${esc(r.description||'—')}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : ''}
  <div class="ft">Generated on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')} — ${esc(SETTINGS.clinic_name||'Dental Clinic')}</div>
  <script>window.onload=function(){setTimeout(()=>window.print(),500);setTimeout(()=>window.close(),2500);}<\/script>
</body></html>`);
    w.document.close();
  } catch(e) { toast('Failed to load user report: '+e.message,'error'); }
}

function printReports() {
  const clinic = SETTINGS;
  const year = $('report-year')?.value || new Date().getFullYear();
  post('/api/activity/print', { entity:'analytics_report', entity_id:null, description:`Printed analytics report for ${year}` }).catch(()=>{});
  const printWindow = window.open('', '', 'width=1200,height=800');
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Reports & Analytics</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <style>
    body { font-size: 12px; }
    .print-header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .print-date { text-align: right; color: #666; font-size: 11px; }
    .section-title { font-size: 14px; font-weight: bold; margin: 20px 0 10px 0; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th { background-color: #007bff; color: white; padding: 8px; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd; }
    @media print { body { margin: 0; } .no-print { display: none; } }
  </style>
</head>
<body class="p-4">
  <div class="print-header">
    <h3>${esc(clinic.clinic_name||'Dental Clinic')}</h3>
    <p style="margin:5px 0;">${esc(clinic.clinic_address||'')} | ${esc(clinic.clinic_phone||'')}</p>
    <h5 style="margin-top:10px;">Reports & Analytics - ${year}</h5>
    <div class="print-date">Printed on ${fmtDateTime()} | Printed by: ${esc(_currentUser?.full_name||'—')}</div>
  </div>

  <div class="section-title">Report Summary</div>
  <p>This report contains business insights and performance metrics for the selected period.</p>
  
  <div style="page-break-after: always; padding-bottom: 20px;">
    <p>For detailed charts and analytics, please view the report in the system.</p>
  </div>
  
  <script>
    window.onload = function() { 
      setTimeout(() => { window.print(); }, 500); 
      setTimeout(() => { window.close(); }, 2000);
    }
  </script>
</body>
</html>`;
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
async function loadSettings() {
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border text-secondary"></div></div>`;
  try {
    const [settings, staff, services] = await Promise.all([get('/api/settings'), get('/api/staff'), get('/api/services')]);
    allStaff    = staff;
    allServices = services;
    renderSettingsSection(settings, staff, services);
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function renderSettingsSection(settings, staff, services) {
  $('content-area').innerHTML = `
    <div class="section-header"><h4>Settings</h4><p>Configure clinic information, staff, and services</p></div>
    <ul class="nav nav-tabs mb-3" id="settingsTabs">
      <li class="nav-item"><a class="nav-link active" data-bs-toggle="tab" href="#stab-clinic"><i class="fas fa-hospital me-1"></i>Clinic Info</a></li>
      <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-staff"><i class="fas fa-user-md me-1"></i>Staff (${staff.length})</a></li>
      <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-services"><i class="fas fa-list-alt me-1"></i>Services (${services.length})</a></li>
      <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-sms"><i class="fas fa-sms me-1"></i>SMS</a></li>
      <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-backup"><i class="fas fa-database me-1"></i>Backup & Restore</a></li>
      <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-system"><i class="fas fa-sliders-h me-1"></i>System</a></li>
      ${_currentUser?.role==='admin' ? `<li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#stab-users" onclick="loadUsersTab()"><i class="fas fa-users-cog me-1"></i>Users</a></li>` : ''}
    </ul>
    <div class="tab-content">
      <!-- CLINIC INFO -->
      <div class="tab-pane fade show active" id="stab-clinic">
        <div class="card"><div class="card-body">
          <div class="row g-3">
            <div class="col-md-6"><label class="form-label fw-semibold">Clinic Name</label><input class="form-control" id="s-clinic-name" value="${esc(settings.clinic_name||'')}"/></div>
            <div class="col-md-6"><label class="form-label fw-semibold">Phone</label><input class="form-control" id="s-clinic-phone" value="${esc(settings.clinic_phone||'')}"/></div>
            <div class="col-md-6"><label class="form-label fw-semibold">Email</label><input class="form-control" id="s-clinic-email" value="${esc(settings.clinic_email||'')}"/></div>
            <div class="col-md-6"><label class="form-label fw-semibold">Website</label><input class="form-control" id="s-clinic-website" value="${esc(settings.clinic_website||'')}"/></div>
            <div class="col-md-8"><label class="form-label fw-semibold">Address</label><input class="form-control" id="s-clinic-address" value="${esc(settings.clinic_address||'')}"/></div>
            <div class="col-md-4"><label class="form-label fw-semibold">City / State / ZIP</label><input class="form-control" id="s-clinic-city" value="${esc(settings.clinic_city||'')}"/></div>
            <div class="col-12"><hr class="my-2"/></div>
            <div class="col-md-6">
              <label class="form-label fw-semibold"><i class="fas fa-signature me-1 text-primary"></i>Authorized Signature</label>
              <div class="d-flex align-items-center gap-3">
                <div id="sig-preview" style="width:160px;height:70px;border:1px dashed #bbb;border-radius:6px;display:flex;align-items:center;justify-content:center;background:#fafafa;overflow:hidden;cursor:pointer;" onclick="document.getElementById('sig-upload').click()">
                  ${settings.clinic_signature ? `<img src="${esc(settings.clinic_signature)}" style="max-width:100%;max-height:100%;object-fit:contain;"/>` : '<span style="font-size:11px;color:#aaa;">Click to upload</span>'}
                </div>
                <div>
                  <input type="file" id="sig-upload" accept="image/*" style="display:none" onchange="handleSignatureUpload(this,'sig-preview','s-clinic-signature')"/>
                  <input type="hidden" id="s-clinic-signature" value="${esc(settings.clinic_signature||'')}"/>
                  <button class="btn btn-sm btn-outline-secondary d-block mb-1" onclick="document.getElementById('sig-upload').click()"><i class="fas fa-upload me-1"></i>Upload</button>
                  <button class="btn btn-sm btn-outline-danger d-block" onclick="clearSignatureImage('sig-preview','s-clinic-signature')"><i class="fas fa-times me-1"></i>Clear</button>
                </div>
              </div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-semibold"><i class="fas fa-stamp me-1 text-primary"></i>Clinic Stamp / Seal</label>
              <div class="d-flex align-items-center gap-3">
                <div id="stamp-preview" style="width:90px;height:90px;border:1px dashed #bbb;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#fafafa;overflow:hidden;cursor:pointer;" onclick="document.getElementById('stamp-upload').click()">
                  ${settings.clinic_stamp ? `<img src="${esc(settings.clinic_stamp)}" style="width:100%;height:100%;object-fit:contain;"/>` : '<span style="font-size:11px;color:#aaa;text-align:center;">Click to<br/>upload</span>'}
                </div>
                <div>
                  <input type="file" id="stamp-upload" accept="image/*" style="display:none" onchange="handleSignatureUpload(this,'stamp-preview','s-clinic-stamp')"/>
                  <input type="hidden" id="s-clinic-stamp" value="${esc(settings.clinic_stamp||'')}"/>
                  <button class="btn btn-sm btn-outline-secondary d-block mb-1" onclick="document.getElementById('stamp-upload').click()"><i class="fas fa-upload me-1"></i>Upload</button>
                  <button class="btn btn-sm btn-outline-danger d-block" onclick="clearSignatureImage('stamp-preview','s-clinic-stamp')"><i class="fas fa-times me-1"></i>Clear</button>
                </div>
              </div>
            </div>
            <div class="col-12"><button class="btn btn-primary" onclick="saveClinicSettings()"><i class="fas fa-save me-1"></i>Save Clinic Info</button></div>
          </div>
        </div></div>
      </div>

      <!-- STAFF -->
      <div class="tab-pane fade" id="stab-staff">
        <div class="table-card">
          <div class="table-toolbar flex-wrap gap-2">
            ${_searchBox('staff-search','Search staff name, role...','_filterStaff')}
            <button class="btn btn-secondary btn-sm ms-auto" onclick="openStaffModal()"><i class="fas fa-plus me-1"></i>Add Staff</button>
          </div>
          <div class="table-responsive">
            <table class="table" id="staff-table">
              <thead><tr><th>Name</th><th>Role</th><th>Specialization</th><th>Phone</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>${renderStaffRows(staff)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- SERVICES -->
      <div class="tab-pane fade" id="stab-services">
        <div class="table-card">
          <div class="table-toolbar flex-wrap gap-2">
            ${_searchBox('svc-search','Search service name, category...','_filterServices')}
            <button class="btn btn-secondary btn-sm ms-auto" onclick="openServiceModal()"><i class="fas fa-plus me-1"></i>Add Service</button>
          </div>
          <div class="table-responsive">
            <table class="table" id="services-table">
              <thead><tr><th>Name</th><th>Category</th><th>Duration</th><th>Price</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>${renderServiceRows(services)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- BACKUP & RESTORE -->
      <div class="tab-pane fade" id="stab-backup">
        <div class="card"><div class="card-body">
          <div class="row g-3">
            <div class="col-12">
              <h6 class="mb-3"><i class="fas fa-download me-2 text-success"></i>Create Backup</h6>
              <p class="text-muted small mb-3">Download a complete backup of all your clinic data including patients, appointments, treatments, invoices, and settings.</p>
              <button class="btn btn-success me-2" onclick="createBackup()"><i class="fas fa-folder-open me-1"></i>Backup JSON — Choose Location</button>
              <button class="btn btn-outline-secondary" onclick="downloadDatabase()"><i class="fas fa-database me-1"></i>Backup Database File — Choose Location</button>
            </div>
            <div class="col-12"><hr/></div>
            <div class="col-12">
              <h6 class="mb-3"><i class="fas fa-upload me-2 text-warning"></i>Restore from Backup</h6>
              <p class="text-muted small mb-3">Upload a backup file to restore your clinic data. <strong>Warning:</strong> This will replace all current data.</p>
              <input type="file" class="form-control mb-2" id="backup-file" accept=".json"/>
              <button class="btn btn-warning" onclick="restoreBackup()"><i class="fas fa-upload me-1"></i>Restore from Backup</button>
              <div class="mt-2 small text-muted" id="restore-status"></div>
            </div>
            <div class="col-12"><hr/></div>
            <div class="col-12">
              <h6 class="mb-3"><i class="fas fa-info-circle me-2 text-info"></i>Backup Information</h6>
              <div class="alert alert-info small">
                <strong>What's included in backup:</strong><br/>
                • Patient records and medical history<br/>
                • Appointments and scheduling data<br/>
                • Treatment records and procedures<br/>
                • Invoices and billing information<br/>
                • Staff and service configurations<br/>
                • Clinic settings and preferences<br/>
                <br/>
                <strong>Important:</strong> Keep backups in a secure location. Test restore functionality regularly.
              </div>
            </div>
          </div>
        </div></div>
      </div>

      ${renderSmsSettingsTab(settings)}

      <!-- SYSTEM -->
      <div class="tab-pane fade" id="stab-users"><div id="users-tab-content" class="p-1"><div class="text-center py-4 text-muted">Loading…</div></div></div>
      <div class="tab-pane fade" id="stab-system">
        <div class="card"><div class="card-body">
          <div class="row g-3">
            <div class="col-md-3"><label class="form-label fw-semibold">Currency Symbol</label><input class="form-control" id="s-currency-symbol" value="${esc(settings.currency_symbol||'ر.ع.')}"/></div>
            <div class="col-md-3"><label class="form-label fw-semibold">Tax Rate (%)</label><input type="number" class="form-control" id="s-tax-rate" value="${settings.tax_rate||0}" min="0" step="0.5"/></div>
            <div class="col-md-3"><label class="form-label fw-semibold">Working Hours Start</label><input type="time" class="form-control" id="s-working-start" value="${settings.working_start||'08:00'}"/></div>
            <div class="col-md-3"><label class="form-label fw-semibold">Working Hours End</label><input type="time" class="form-control" id="s-working-end" value="${settings.working_end||'18:00'}"/></div>
            <div class="col-md-3"><label class="form-label fw-semibold">Default Appt. Duration (min)</label><input type="number" class="form-control" id="s-appt-duration" value="${settings.appointment_duration||30}" min="5" step="5"/></div>
            <div class="col-12"><button class="btn btn-primary" onclick="saveSystemSettings()"><i class="fas fa-save me-1"></i>Save System Settings</button></div>
          </div>
        </div></div>
      </div>
    </div>`;
  // Auto-load SMS log when SMS tab is clicked
  document.querySelector('a[href="#stab-sms"]')?.addEventListener('shown.bs.tab', loadSmsLog);
}

function _filterStaff(val) {
  const q = val.toLowerCase();
  const filtered = q ? allStaff.filter(s=>(s.first_name+' '+s.last_name).toLowerCase().includes(q)||s.role?.toLowerCase().includes(q)||(s.specialization||'').toLowerCase().includes(q)) : allStaff;
  const tbody = document.querySelector('#staff-table tbody');
  if (tbody) tbody.innerHTML = renderStaffRows(filtered);
}

function _filterServices(val) {
  const q = val.toLowerCase();
  const filtered = q ? allServices.filter(s=>s.name.toLowerCase().includes(q)||(s.category||'').toLowerCase().includes(q)) : allServices;
  const tbody = document.querySelector('#services-table tbody');
  if (tbody) tbody.innerHTML = renderServiceRows(filtered);
}

function renderStaffRows(staff) {
  if (!staff.length) return '<tr><td colspan="7" class="text-center text-muted py-3">No staff members</td></tr>';
  return staff.map(s=>`
    <tr>
      <td><strong>${esc(s.first_name)} ${esc(s.last_name)}</strong></td>
      <td><span class="badge bg-primary-subtle text-primary">${esc(s.role)}</span></td>
      <td>${esc(s.specialization||'—')}</td>
      <td>${esc(s.phone||'—')}</td>
      <td>${esc(s.email||'—')}</td>
      <td><span class="badge-status ${s.active?'status-confirmed':'status-cancelled'}">${s.active?'Active':'Inactive'}</span></td>
      <td class="action-btns">
        <button class="btn btn-sm btn-outline-secondary" onclick="openStaffModal(${s.id})"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteStaff(${s.id},'${esc(s.first_name)} ${esc(s.last_name)}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function renderServiceRows(services) {
  if (!services.length) return '<tr><td colspan="6" class="text-center text-muted py-3">No services</td></tr>';
  return services.map(s=>`
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td><span class="badge bg-light text-dark border">${esc(s.category||'—')}</span></td>
      <td>${s.duration} min</td>
      <td><strong>${fmt(s.price)}</strong></td>
      <td><span class="badge-status ${s.active?'status-confirmed':'status-cancelled'}">${s.active?'Active':'Inactive'}</span></td>
      <td class="action-btns">
        <button class="btn btn-sm btn-outline-secondary" onclick="openServiceModal(${s.id})"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteService(${s.id},'${esc(s.name)}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function handleSignatureUpload(input, previewId, hiddenId) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const src = e.target.result;
    const preview = $(previewId);
    if (preview) preview.innerHTML = `<img src="${src}" style="max-width:100%;max-height:100%;object-fit:contain;"/>`;
    const hidden = $(hiddenId);
    if (hidden) hidden.value = src;
  };
  reader.readAsDataURL(file);
}

function clearSignatureImage(previewId, hiddenId) {
  const preview = $(previewId);
  if (preview) preview.innerHTML = '<span style="font-size:11px;color:#aaa;">Click to upload</span>';
  const hidden = $(hiddenId);
  if (hidden) hidden.value = '';
}

async function saveClinicSettings() {
  try {
    await put('/api/settings', {
      clinic_name:      $('s-clinic-name').value,
      clinic_phone:     $('s-clinic-phone').value,
      clinic_email:     $('s-clinic-email').value,
      clinic_website:   $('s-clinic-website').value,
      clinic_address:   $('s-clinic-address').value,
      clinic_city:      $('s-clinic-city').value,
      clinic_signature: $('s-clinic-signature')?.value || '',
      clinic_stamp:     $('s-clinic-stamp')?.value || '',
    });
    await reloadSettings();
    toast('Clinic info saved');
  } catch(e) { toast(e.message,'error'); }
}

async function saveSystemSettings() {
  try {
    await put('/api/settings', {
      currency_symbol:      $('s-currency-symbol').value,
      tax_rate:             $('s-tax-rate').value,
      working_start:        $('s-working-start').value,
      working_end:          $('s-working-end').value,
      appointment_duration: $('s-appt-duration').value,
    });
    await reloadSettings();
    toast('System settings saved');
  } catch(e) { toast(e.message,'error'); }
}

// Tracks whether staffModal was opened from the appointment modal
let _staffCallerContext = null;

function quickAddDentist() {
  _staffCallerContext = 'appointment';
  $('staff-id').value             = '';
  $('staff-first-name').value     = '';
  $('staff-last-name').value      = '';
  $('staff-role').value           = 'Dentist';
  $('staff-specialization').value = '';
  $('staff-phone').value          = '';
  $('staff-email').value          = '';
  $('staff-active').checked       = true;
  $('staffModalTitle').innerHTML  = '<i class="fas fa-user-md me-2"></i>Add New Dentist';
  attachNameValidation('staff-first-name', 'staff-last-name');
  attachPhoneValidation('staff-phone');
  attachEmailValidation('staff-email');
  _markAddMode('staffModal', true);
  showModal('staffModal');
}

async function openStaffModal(id=null) {
  $('staff-id').value            = id||'';
  $('staff-first-name').value    = '';
  $('staff-last-name').value     = '';
  $('staff-role').value          = 'Dentist';
  $('staff-specialization').value= '';
  $('staff-phone').value         = '';
  $('staff-email').value         = '';
  $('staff-active').checked      = true;
  $('staffModalTitle').innerHTML = id ? '<i class="fas fa-user-edit me-2"></i>Edit Staff' : '<i class="fas fa-user-plus me-2"></i>Add Staff';
  attachNameValidation('staff-first-name', 'staff-last-name');
  attachPhoneValidation('staff-phone');
  attachEmailValidation('staff-email');
  _markAddMode('staffModal', !id);
  if (id) {
    const s = allStaff.find(x=>x.id==id);
    if (s) {
      $('staff-first-name').value    = s.first_name||'';
      $('staff-last-name').value     = s.last_name||'';
      $('staff-role').value          = s.role||'Dentist';
      $('staff-specialization').value= s.specialization||'';
      $('staff-phone').value         = s.phone||'';
      $('staff-email').value         = s.email||'';
      $('staff-active').checked      = s.active===1;
    }
  }
  showModal('staffModal');
}

async function saveStaff() {
  const id = $('staff-id').value;
  const fn = $('staff-first-name').value.trim();
  const ln = $('staff-last-name').value.trim();
  const fnErrS = validateName(fn), lnErrS = validateName(ln);
  if (fnErrS) { _nameFieldFeedback($('staff-first-name')); toast('First name: ' + fnErrS, 'warning'); return; }
  if (lnErrS) { _nameFieldFeedback($('staff-last-name'));  toast('Last name: '  + lnErrS, 'warning'); return; }
  const sPhoneErr = validatePhone($('staff-phone').value);
  if (sPhoneErr) { _phoneFeedback($('staff-phone')); toast('Phone: ' + sPhoneErr, 'warning'); return; }
  const sEmailErr = validateEmail($('staff-email').value);
  if (sEmailErr) { _emailFeedback($('staff-email')); toast('Email: ' + sEmailErr, 'warning'); return; }
  const data = {
    first_name: fn, last_name: ln,
    role:           $('staff-role').value,
    specialization: $('staff-specialization').value||null,
    phone:          $('staff-phone').value||null,
    email:          $('staff-email').value||null,
    active:         $('staff-active').checked ? 1 : 0,
  };
  try {
    let newId = null;
    if (id) { await put(`/api/staff/${id}`, data); toast('Staff updated'); }
    else     { const r = await post('/api/staff', data); newId = r.id; toast('Dentist added'); }
    hideModal('staffModal');

    // Always refresh the global staff list
    allStaff = await get('/api/staff?active=1');

    if (_staffCallerContext === 'appointment') {
      // Refresh the dentist dropdown inside the appointment modal
      _staffCallerContext = null;
      const sel = $('appt-dentist-id');
      if (sel) {
        sel.innerHTML = `<option value="">Select dentist...</option>` +
          allStaff.filter(s => s.active).map(s =>
            `<option value="${s.id}">${esc(s.first_name)} ${esc(s.last_name)} — ${esc(s.role)}</option>`
          ).join('');
        if (newId) sel.value = newId;  // auto-select the dentist just added
      }
    } else {
      _staffCallerContext = null;
      const tbody = document.querySelector('#staff-table tbody');
      if (tbody) tbody.innerHTML = renderStaffRows(allStaff);
    }
  } catch(e) { toast(e.message,'error'); }
}

function deleteStaff(id, name) {
  confirm(`Remove staff member "${name}"?`, async () => {
    try {
      await del(`/api/staff/${id}`);
      toast('Staff removed');
      allStaff = await get('/api/staff');
      const tbody = document.querySelector('#staff-table tbody');
      if (tbody) tbody.innerHTML = renderStaffRows(allStaff);
    } catch(e) { toast(e.message,'error'); }
  });
}

async function openServiceModal(id=null) {
  $('service-id').value          = id||'';
  $('service-name').value        = '';
  $('service-category').value    = '';
  $('service-duration').value    = '30';
  $('service-price').value       = '0';
  $('service-description').value = '';
  $('service-active').checked    = true;
  $('serviceModalTitle').innerHTML = id ? '<i class="fas fa-edit me-2"></i>Edit Service' : '<i class="fas fa-plus me-2"></i>Add Service';
  if (id) {
    const s = allServices.find(x=>x.id==id);
    if (s) {
      $('service-name').value        = s.name||'';
      $('service-category').value    = s.category||'';
      $('service-duration').value    = s.duration||30;
      $('service-price').value       = s.price||0;
      $('service-description').value = s.description||'';
      $('service-active').checked    = s.active===1;
    }
  }
  _markAddMode('serviceModal', !$('service-id')?.value);
  showModal('serviceModal');
}

async function saveService() {
  const id   = $('service-id').value;
  const name = $('service-name').value.trim();
  if (!name) { toast('Service name is required','warning'); return; }
  const data = {
    name,
    category:    $('service-category').value||null,
    duration:    parseInt($('service-duration').value)||30,
    price:       parseFloat($('service-price').value)||0,
    description: $('service-description').value||null,
    active:      $('service-active').checked ? 1 : 0,
  };
  try {
    if (id) { await put(`/api/services/${id}`, data); toast('Service updated'); }
    else     { await post('/api/services', data); toast('Service added'); }
    hideModal('serviceModal');
    allServices = await get('/api/services');
    const tbody = document.querySelector('#services-table tbody');
    if (tbody) tbody.innerHTML = renderServiceRows(allServices);
  } catch(e) { toast(e.message,'error'); }
}

function deleteService(id, name) {
  confirm(`Delete service "${name}"?`, async () => {
    try {
      await del(`/api/services/${id}`);
      toast('Service deleted');
      allServices = await get('/api/services');
      const tbody = document.querySelector('#services-table tbody');
      if (tbody) tbody.innerHTML = renderServiceRows(allServices);
    } catch(e) { toast(e.message,'error'); }
  });
}

// ═══════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════
async function loadPatientOptions(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  if (!allPatients.length) allPatients = await get('/api/patients');
  sel.innerHTML = `<option value="">Select patient...</option>` + allPatients.map(p=>`<option value="${p.id}">${esc(p.first_name)} ${esc(p.last_name)} (${esc(p.patient_number)})</option>`).join('');
}

// Roles that can perform dental procedures and should appear in dentist dropdowns
const DENTIST_ROLES = new Set(['Dentist','Orthodontist','Periodontist','Endodontist','Oral Surgeon']);

async function loadStaffOptions(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  if (!allStaff.length) allStaff = await get('/api/staff?active=1');
  const dentists = allStaff.filter(s => s.active && DENTIST_ROLES.has(s.role));
  sel.innerHTML = `<option value="">Select dentist...</option>` +
    dentists.map(s => `<option value="${s.id}">${esc(s.first_name)} ${esc(s.last_name)} — ${esc(s.role)}</option>`).join('');
}

async function loadServiceOptions(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  if (!allServices.length) allServices = await get('/api/services?active=1');
  sel.innerHTML = `<option value="">Select service...</option>` + allServices.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)} (${s.duration}min — ${fmt(s.price)})</option>`).join('');
}

// ═══════════════════════════════════════════
// ABOUT
// ═══════════════════════════════════════════
function loadAbout() {
  const clinic = SETTINGS;
  $('content-area').innerHTML = `
    <div class="section-header">
      <h4><i class="fas fa-info-circle me-2"></i>About Dental Clinic Manager</h4>
      <p>Learn more about our system and get in touch with our support team</p>
    </div>
    
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-primary text-white">
            <h5 class="mb-0"><i class="fas fa-hospital me-2"></i>About ${esc(clinic.clinic_name||'Our Clinic')}</h5>
          </div>
          <div class="card-body">
            <p><strong>Dental Clinic Management System</strong></p>
            <p>A comprehensive software solution for managing dental clinic operations including:</p>
            <ul>
              <li>Patient Information Management</li>
              <li>Appointment Scheduling</li>
              <li>Treatment Records & History</li>
              <li>Invoice and Billing System</li>
              <li>Staff Management</li>
              <li>Business Reports & Analytics</li>
            </ul>
            <p class="text-muted mb-0"><small>Version 1.0.0 | Designed for modern dental practices</small></p>
          </div>
        </div>
      </div>
      
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-success text-white">
            <h5 class="mb-0"><i class="fas fa-headset me-2"></i>Technical Support</h5>
          </div>
          <div class="card-body">
            <h6 class="mb-3">Get Help & Contact Us</h6>
            <div class="mb-3">
              <strong><i class="fas fa-envelope text-danger me-2"></i>Email:</strong><br/>
              <a href="mailto:Omanxp45@gmail.com" style="text-decoration:none; color:#1a56db">Omanxp45@gmail.com</a>
            </div>
            <div class="mb-3">
              <strong><i class="fas fa-phone text-success me-2"></i>Mobile:</strong><br/>
              <a href="tel:+96894055999" style="text-decoration:none; color:#1a56db">+968-94055999</a>
            </div>
            <div class="alert alert-info mb-0">
              <small><strong>Hours:</strong> Available for support during clinic operating hours or by appointment</small>
            </div>
          </div>
        </div>
      </div>
      
      <div class="col-12">
        <div class="card">
          <div class="card-header bg-info text-white">
            <h5 class="mb-0"><i class="fas fa-list-check me-2"></i>System Features</h5>
          </div>
          <div class="card-body">
            <div class="row g-3">
              <div class="col-md-6">
                <h6><i class="fas fa-check text-success me-2"></i>Core Features</h6>
                <ul class="small mb-0">
                  <li>Complete Patient Management</li>
                  <li>Appointment Scheduling System</li>
                  <li>Treatment Documentation</li>
                  <li>Printable Reports & Documents</li>
                </ul>
              </div>
              <div class="col-md-6">
                <h6><i class="fas fa-check text-success me-2"></i>Advanced Features</h6>
                <ul class="small mb-0">
                  <li>Invoice & Billing Management</li>
                  <li>Payment Tracking</li>
                  <li>Automated Backup & Restore</li>
                  <li>Business Analytics & Reports</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="col-12">
        <div class="card bg-light">
          <div class="card-body text-center">
            <p class="mb-0 text-muted">
              <small>Dental Clinic Manager • All Rights Reserved © ${new Date().getFullYear()}</small><br/>
              <small>Designed to simplify dental practice management</small>
            </p>
          </div>
        </div>
      </div>
    </div>`;
}

async function reloadSettings() {
  SETTINGS = await get('/api/settings');
  $('clinic-name-sidebar').textContent = SETTINGS.clinic_name || 'Dental Clinic';
  document.title = (SETTINGS.clinic_name || 'Dental Clinic') + ' — Manager';
}

// ═══════════════════════════════════════════
// BACKUP FUNCTIONS
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// SMS
// ═══════════════════════════════════════════
let _currentSmsAppt = null;

async function openSmsModal(apptId) {
  try {
    const a = await get(`/api/appointments/${apptId}`);
    _currentSmsAppt = a;
    $('sms-appt-id').value    = apptId;
    $('sms-patient-name').value = a.patient_name || '—';
    $('sms-phone').value        = a.patient_phone || '';
    $('sms-template').value     = 'booking';
    applySmsTemplate('booking');

    // Show provider status
    const cfg      = await get('/api/settings');
    const provider = cfg.sms_provider || 'none';
    const info     = $('sms-status-info');
    info.style.display = '';
    if (provider === 'none') {
      info.className   = 'alert alert-warning small py-2 mb-0';
      info.innerHTML   = '<i class="fas fa-exclamation-triangle me-1"></i>SMS is in <strong>Test Mode</strong> — messages are logged but NOT sent. Go to <strong>Settings → SMS</strong> to configure Omantel.';
    } else if (provider === 'omantel') {
      info.className   = 'alert alert-success small py-2 mb-0';
      info.innerHTML   = '🇴🇲 <strong>Omantel</strong> — SMS will be sent via Omantel Bulk SMS Gateway.';
    } else {
      info.className   = 'alert alert-success small py-2 mb-0';
      info.innerHTML   = `<i class="fas fa-check-circle me-1"></i>Provider: <strong>${provider.toUpperCase()}</strong> — SMS will be sent.`;
    }

    showModal('smsModal');
  } catch(e) { toast(e.message, 'error'); }
}

function applySmsTemplate(type) {
  if (type === 'custom') {
    $('sms-message').value = '';
    updateSmsCharCount();
    return;
  }
  if (!_currentSmsAppt) return;
  const a = _currentSmsAppt;
  const dateStr = a.appointment_date
    ? (() => { const p=a.appointment_date.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; })() : '';

  const tpl = {
    booking:      SETTINGS.sms_template_booking     || 'Dear {patient_name}, your appointment at {clinic_name} is confirmed for {date} at {time}. Dentist: {dentist_name}. Contact: {clinic_phone}',
    reminder:     SETTINGS.sms_template_reminder    || 'Reminder: Dear {patient_name}, you have an appointment at {clinic_name} on {date} at {time}. Please arrive 10 minutes early. Contact: {clinic_phone}',
    cancellation: SETTINGS.sms_template_cancellation|| 'Dear {patient_name}, your appointment at {clinic_name} on {date} has been cancelled. Please contact us to reschedule: {clinic_phone}'
  };
  const template = tpl[type] || '';
  const vars = {
    patient_name: a.patient_name     || '',
    date:         dateStr,
    time:         a.appointment_time || '',
    clinic_name:  SETTINGS.clinic_name  || 'Dental Clinic',
    clinic_phone: SETTINGS.clinic_phone || '',
    dentist_name: a.dentist_name     || '',
    service:      a.service_name     || ''
  };
  $('sms-message').value = template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
  updateSmsCharCount();
}

function updateSmsCharCount() {
  const len   = ($('sms-message')?.value || '').length;
  const parts = Math.ceil(len / 160) || 1;
  const el    = $('sms-char-count');
  if (el) {
    el.textContent = `${len} chars${parts > 1 ? ` / ${parts} SMS` : ''}`;
    el.className   = len > 320 ? 'text-danger fw-bold' : len > 160 ? 'text-warning' : 'text-muted';
  }
}

async function submitSendSMS() {
  const apptId  = $('sms-appt-id').value;
  const phone   = ($('sms-phone').value || '').trim();
  const message = ($('sms-message').value || '').trim();
  if (!phone)   { toast('Phone number is required', 'warning'); return; }
  if (!message) { toast('Message text is required', 'warning'); return; }

  try {
    const r = await post('/api/sms/send', {
      to:             phone,
      message,
      appointment_id: apptId ? parseInt(apptId) : null,
      patient_id:     _currentSmsAppt?.patient_id || null
    });
    if (r.simulated) {
      toast('Test Mode — SMS logged but not actually sent.', 'info');
    } else {
      toast('SMS sent successfully!');
    }
    hideModal('smsModal');
  } catch(e) { toast('SMS failed: ' + e.message, 'error'); }
}

// ── SMS Settings (rendered inside Settings page) ───────────────────────────
function renderSmsSettingsTab(settings) {
  const provider = settings.sms_provider || 'none';
  return `
  <div class="tab-pane fade" id="stab-sms">
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="card">
          <div class="card-header"><strong><i class="fas fa-cogs me-2"></i>SMS Provider</strong></div>
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label fw-semibold">Provider</label>
              <select class="form-select" id="s-sms-provider" onchange="toggleSmsFields(this.value)" autocomplete="off">
                <option value="omantel" ${provider==='omantel'?'selected':''}>🇴🇲 Omantel (Bulk SMS Gateway)</option>
                <option value="twilio"  ${provider==='twilio'?'selected':''}>Twilio</option>
                <option value="unifonic"${provider==='unifonic'?'selected':''}>Unifonic (Gulf Region)</option>
                <option value="none"    ${provider==='none'?'selected':''}>None / Test Mode</option>
              </select>
            </div>

            <!-- Omantel fields -->
            <div id="sms-f-omantel" style="display:${provider==='omantel'?'':'none'}">
              <div class="alert alert-info small py-2 mb-2">
                <i class="fas fa-info-circle me-1"></i>
                Enter the credentials provided by <strong>Omantel Bulk SMS</strong>.<br/>
                Contact: <a href="mailto:sms-support@omantel.om">sms-support@omantel.om</a> | <a href="tel:+96824001">+968 24001</a>
              </div>
              <div class="mb-2">
                <label class="form-label fw-semibold small">Gateway URL</label>
                <input type="text" class="form-control form-control-sm" id="s-sms-omantel-url"
                  value="${esc(settings.sms_omantel_url||'https://smsvas.com/bulk/public/index.php/api/v1/sendsms')}"
                  placeholder="https://smsvas.com/bulk/public/index.php/api/v1/sendsms" autocomplete="off"/>
                <div class="form-text">Provided by Omantel — use the URL in your contract.</div>
              </div>
              <div class="mb-2"><label class="form-label fw-semibold small">Username</label><input type="text" class="form-control form-control-sm" id="s-sms-omantel-username" value="${esc(settings.sms_omantel_username||'')}" autocomplete="off" placeholder="Your Omantel SMS username"/></div>
              <div class="mb-2"><label class="form-label fw-semibold small">Password</label><input type="password" class="form-control form-control-sm" id="s-sms-omantel-password" value="${esc(settings.sms_omantel_password||'')}" autocomplete="off"/></div>
            </div>

            <!-- Twilio fields -->
            <div id="sms-f-twilio" style="display:${provider==='twilio'?'':'none'}">
              <div class="mb-2"><label class="form-label fw-semibold small">Account SID</label><input type="text" class="form-control form-control-sm" id="s-sms-twilio-sid" value="${esc(settings.sms_twilio_sid||'')}" placeholder="ACxxxxxxxxxxxxxxxx" autocomplete="off"/></div>
              <div class="mb-2"><label class="form-label fw-semibold small">Auth Token</label><input type="password" class="form-control form-control-sm" id="s-sms-twilio-token" value="${esc(settings.sms_twilio_token||'')}" autocomplete="off"/></div>
              <div class="mb-2"><label class="form-label fw-semibold small">From Phone Number</label><input type="text" class="form-control form-control-sm" id="s-sms-twilio-phone" value="${esc(settings.sms_twilio_phone||'')}" placeholder="+1234567890" autocomplete="off"/></div>
            </div>

            <!-- Unifonic fields -->
            <div id="sms-f-unifonic" style="display:${provider==='unifonic'?'':'none'}">
              <div class="mb-2"><label class="form-label fw-semibold small">App SID</label><input type="text" class="form-control form-control-sm" id="s-sms-unifonic-sid" value="${esc(settings.sms_unifonic_sid||'')}" autocomplete="off"/></div>
            </div>

            <!-- Test mode -->
            <div id="sms-f-none" style="display:${provider==='none'?'':'none'}">
              <div class="alert alert-warning small py-2"><i class="fas fa-flask me-1"></i>Test Mode — messages are logged but <strong>not sent</strong>. Safe for testing the system.</div>
            </div>

            <!-- Sender ID (all providers except test) -->
            <div class="mb-3" id="sms-f-sender" style="display:${provider!=='none'?'':'none'}">
              <label class="form-label fw-semibold small">Sender Name / ID <span class="text-muted">(max 11 chars)</span></label>
              <input type="text" class="form-control form-control-sm" id="s-sms-sender-id" value="${esc(settings.sms_sender_id||'Clinic')}" maxlength="11" autocomplete="off"/>
              <div class="form-text">Shown as the SMS sender — use your clinic name.</div>
            </div>
            <div class="d-flex gap-2 flex-wrap">
              <button class="btn btn-primary btn-sm" onclick="saveSmsSettings()"><i class="fas fa-save me-1"></i>Save Settings</button>
              <button class="btn btn-outline-secondary btn-sm" onclick="sendTestSmsPrompt()"><i class="fas fa-paper-plane me-1"></i>Send Test SMS</button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header"><strong><i class="fas fa-file-alt me-2"></i>Message Templates</strong></div>
          <div class="card-body">
            <p class="text-muted small mb-2">Variables: <code>{patient_name}</code> <code>{date}</code> <code>{time}</code> <code>{clinic_name}</code> <code>{dentist_name}</code> <code>{clinic_phone}</code></p>
            <div class="mb-2">
              <label class="form-label fw-semibold small">Booking Confirmation</label>
              <textarea class="form-control form-control-sm" id="s-sms-t-booking" rows="3" autocomplete="off">${esc(settings.sms_template_booking||'')}</textarea>
            </div>
            <div class="mb-2">
              <label class="form-label fw-semibold small">Appointment Reminder</label>
              <textarea class="form-control form-control-sm" id="s-sms-t-reminder" rows="3" autocomplete="off">${esc(settings.sms_template_reminder||'')}</textarea>
            </div>
            <div class="mb-2">
              <label class="form-label fw-semibold small">Cancellation Notice</label>
              <textarea class="form-control form-control-sm" id="s-sms-t-cancel" rows="3" autocomplete="off">${esc(settings.sms_template_cancellation||'')}</textarea>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="saveSmsTemplates()"><i class="fas fa-save me-1"></i>Save Templates</button>
          </div>
        </div>
      </div>
      <div class="col-12">
        <div class="table-card">
          <div class="table-toolbar">
            <h6><i class="fas fa-history me-2 text-info"></i>SMS Log</h6>
            <button class="btn btn-sm btn-outline-secondary ms-auto me-2" onclick="loadSmsLog()"><i class="fas fa-sync me-1"></i>Refresh</button>
            <button class="btn btn-sm btn-outline-danger" onclick="clearSmsLog()"><i class="fas fa-trash me-1"></i>Clear Log</button>
          </div>
          <div class="table-responsive" id="sms-log-container"><div class="text-center p-3 text-muted"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</div></div>
        </div>
      </div>
    </div>
  </div>`;
}

function toggleSmsFields(provider) {
  ['none','omantel','twilio','unifonic'].forEach(p => {
    const el = $(`sms-f-${p}`);
    if (el) el.style.display = provider === p ? '' : 'none';
  });
  const senderEl = $('sms-f-sender');
  if (senderEl) senderEl.style.display = provider !== 'none' ? '' : 'none';
}

async function saveSmsSettings() {
  const provider = $('s-sms-provider')?.value || 'omantel';
  const data = {
    sms_provider:           provider,
    sms_sender_id:          $('s-sms-sender-id')?.value          || 'Clinic',
    sms_omantel_url:        $('s-sms-omantel-url')?.value        || '',
    sms_omantel_username:   $('s-sms-omantel-username')?.value   || '',
    sms_omantel_password:   $('s-sms-omantel-password')?.value   || '',
    sms_twilio_sid:         $('s-sms-twilio-sid')?.value         || '',
    sms_twilio_token:       $('s-sms-twilio-token')?.value       || '',
    sms_twilio_phone:       $('s-sms-twilio-phone')?.value       || '',
    sms_unifonic_sid:       $('s-sms-unifonic-sid')?.value       || '',
  };
  try {
    await put('/api/settings', data);
    await reloadSettings();
    toast('SMS settings saved');
  } catch(e) { toast(e.message, 'error'); }
}

async function saveSmsTemplates() {
  const data = {
    sms_template_booking:      $('s-sms-t-booking')?.value  || '',
    sms_template_reminder:     $('s-sms-t-reminder')?.value || '',
    sms_template_cancellation: $('s-sms-t-cancel')?.value   || '',
  };
  try {
    await put('/api/settings', data);
    await reloadSettings();
    toast('SMS templates saved');
  } catch(e) { toast(e.message, 'error'); }
}

async function loadSmsLog() {
  const container = $('sms-log-container');
  if (!container) return;
  try {
    const logs = await get('/api/sms/logs?limit=200');
    if (!logs.length) {
      container.innerHTML = '<div class="empty-state py-4"><i class="fas fa-inbox"></i>No SMS messages logged yet</div>';
      return;
    }
    const statusClass = { sent:'text-success', failed:'text-danger', simulated:'text-warning' };
    const statusIcon  = { sent:'check-circle', failed:'times-circle', simulated:'flask' };
    container.innerHTML = `<table class="table table-sm">
      <thead><tr><th>Date/Time</th><th>To</th><th>Patient</th><th>Message</th><th>Provider</th><th>Status</th></tr></thead>
      <tbody>${logs.map(l => `<tr>
        <td style="white-space:nowrap;font-size:.8rem">${l.sent_at?fmtDateTime(l.sent_at):'—'}</td>
        <td>${esc(l.to_number)}</td>
        <td>${esc(l.patient_name||'—')}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.message)}">${esc(l.message)}</td>
        <td>${esc(l.provider||'—')}</td>
        <td><span class="${statusClass[l.status]||''}"><i class="fas fa-${statusIcon[l.status]||'question'} me-1"></i>${l.status}</span>${l.error_message?`<br/><small class="text-danger">${esc(l.error_message)}</small>`:''}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  } catch(e) { container.innerHTML = `<div class="alert alert-danger m-2">${e.message}</div>`; }
}

async function clearSmsLog() {
  confirm('Clear all SMS log entries?', async () => {
    try { await del('/api/sms/logs'); toast('SMS log cleared'); loadSmsLog(); }
    catch(e) { toast(e.message, 'error'); }
  });
}

async function sendTestSmsPrompt() {
  const phone = prompt('Enter phone number for test SMS (e.g. +968-94055999):');
  if (!phone) return;
  try {
    const r = await post('/api/sms/send', { to: phone, message: `Test SMS from ${SETTINGS.clinic_name||'Dental Clinic'} — system working correctly.` });
    if (r.simulated) toast('Test logged (Test Mode — not actually sent)', 'info');
    else toast('Test SMS sent to ' + phone);
    loadSmsLog();
  } catch(e) { toast('Test failed: ' + e.message, 'error'); }
}

// ─── helper: save a Blob — shows OS "Save As" dialog when API is available ────
async function _saveBlob(blob, suggestedName, fileTypes) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: fileTypes });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true; // saved via dialog
    } catch (err) {
      if (err.name === 'AbortError') return null; // user cancelled
      // any other error → fall through to regular download
    }
  }
  // Fallback: browser Downloads folder
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = suggestedName;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
  return false; // saved via fallback
}

async function createBackup() {
  try {
    toast('Preparing backup…', 'info');
    const data = await get('/api/backup/export');
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const name = `dental-backup-${today()}.json`;

    const result = await _saveBlob(blob, name, [{
      description: 'Dental Clinic Backup (.json)',
      accept: { 'application/json': ['.json'] }
    }]);

    if (result === null) return; // cancelled
    toast(result
      ? 'Backup saved — location chosen by you.'
      : 'Backup downloaded to your Downloads folder.', 'success');
  } catch (e) {
    toast('Backup failed: ' + e.message, 'error');
  }
}

async function downloadDatabase() {
  try {
    toast('Preparing database file…', 'info');
    const response = await fetch('/api/backup/download-db');
    if (!response.ok) throw new Error('Server error: ' + response.statusText);
    const blob = await response.blob();
    const name = `dental-db-${today()}.db`;

    const result = await _saveBlob(blob, name, [{
      description: 'SQLite Database (.db)',
      accept: { 'application/octet-stream': ['.db'] }
    }]);

    if (result === null) return;
    toast(result
      ? 'Database file saved — location chosen by you.'
      : 'Database downloaded to your Downloads folder.', 'success');
  } catch (e) {
    toast('Database download failed: ' + e.message, 'error');
  }
}

async function restoreBackup() {
  const fileInput = $('backup-file');
  if (!fileInput || !fileInput.files.length) {
    toast('Please select a backup file first', 'warning');
    return;
  }

  // Parse and preview before confirming
  let data;
  try {
    const text = await fileInput.files[0].text();
    data = JSON.parse(text);
    if (!data.data) throw new Error('Not a valid backup file (missing data section).');
  } catch (e) {
    toast('Cannot read file: ' + e.message, 'error');
    return;
  }

  const d = data.data;
  const exported = data.exported_at
    ? fmtDateTime(new Date(data.exported_at))
    : 'unknown date';

  const statusEl = $('restore-status');
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="alert alert-info mt-2 py-2 small">
        <strong>File looks valid.</strong> Exported: ${esc(exported)}<br/>
        Contains: <b>${d.patients?.length||0}</b> patients,
        <b>${d.appointments?.length||0}</b> appointments,
        <b>${d.invoices?.length||0}</b> invoices,
        <b>${d.treatments?.length||0}</b> treatments,
        <b>${d.staff?.length||0}</b> staff,
        <b>${d.services?.length||0}</b> services.
      </div>`;
  }

  confirm(
    `RESTORE BACKUP?\n\nThis will permanently replace ALL current clinic data with the backup from ${exported}.\n\nThis CANNOT be undone. Make sure you have a current backup before proceeding.`,
    async () => {
      try {
        toast('Restoring — please wait…', 'info');
        const result = await post('/api/backup/restore', data);
        if (!result.success) throw new Error(result.error || 'Unknown error');
        toast(
          `Restore complete! ${result.restored.patients} patients, `+
          `${result.restored.appointments} appointments, `+
          `${result.restored.invoices} invoices restored.`,
          'success'
        );
        if (statusEl) statusEl.innerHTML = '';
        fileInput.value = '';
        allPatients = []; allStaff = []; allServices = [];
        await reloadSettings();
        setTimeout(() => navigate('dashboard'), 1500);
      } catch (e) {
        toast('Restore failed: ' + e.message, 'error');
      }
    },
    'Yes, Restore Now',
    'danger'
  );
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
function updateClock() {
  const el = $('current-datetime');
  if (el) {
    const locale = currentLang === 'ar' ? 'ar-SA' : 'en-US';
    el.textContent = new Date().toLocaleString(locale, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }
}

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════
function showLoginScreen() {
  const ls = $('login-screen');
  if (ls) ls.style.display = 'flex';
  if ($('topbar-user'))  $('topbar-user').style.display  = 'none';
  if ($('logout-btn'))   $('logout-btn').style.display   = 'none';
  // Clear fields and hide any previous error
  const u = $('login-username'), p = $('login-password'), e = $('login-error');
  if (u) { u.value = ''; }
  if (p) { p.value = ''; }
  if (e) { e.style.display = 'none'; e.textContent = ''; }
  // Focus username field after a short delay (screen animation)
  setTimeout(() => { $('login-username')?.focus(); }, 150);
}
function hideLoginScreen() {
  const ls = $('login-screen');
  if (ls) ls.style.display = 'none';
  if (_currentUser) {
    if ($('topbar-username')) $('topbar-username').textContent = _currentUser.full_name;
    if ($('topbar-user'))  $('topbar-user').style.display  = '';
    if ($('logout-btn'))   $('logout-btn').style.display   = '';
  }
  applyPermissions();
}

function hasPermission(perm) {
  if (!_currentUser) return false;
  if (_currentUser.role === 'admin') return true;
  const perms = _currentUser.permissions || [];
  return perms.includes('all') || perms.includes(perm);
}

function applyPermissions() {
  const map = { patients:'patients', appointments:'appointments', treatments:'treatments', invoices:'billing', reports:'reports', settings:'settings', about:'about', dashboard:'dashboard' };
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    const section = link.dataset.section;
    if (section === 'dashboard' || section === 'about') return;
    if (section === 'settings') { link.closest('li').style.display = _currentUser?.role==='admin' ? '' : 'none'; return; }
    link.closest('li').style.display = hasPermission(map[section]||section) ? '' : 'none';
  });
}

async function doLogin() {
  const btn = $('login-btn');
  const errEl = $('login-error');
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Please enter username and password.'; errEl.style.display=''; return; }
  btn.textContent = 'Signing in…'; btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Login failed');
    _authToken   = data.token;
    _currentUser = data.user;
    sessionStorage.setItem('clinic_token', _authToken);
    hideLoginScreen();
    await initApp();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  } finally {
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method:'POST', headers:{'x-session-token':_authToken||''} }); } catch(e) {}
  _authToken = null; _currentUser = null;
  sessionStorage.removeItem('clinic_token');
  showLoginScreen();
}

async function initApp() {
  // Confirm button
  const okBtn = $('confirm-ok-btn');
  if (okBtn && !okBtn._bound) {
    okBtn._bound = true;
    okBtn.addEventListener('click', () => {
      if (confirmCallback) { confirmCallback(); confirmCallback = null; }
      bootstrap.Modal.getInstance($('confirmModal'))?.hide();
    });
  }
  updateClock();
  try {
    await reloadSettings();
    allStaff    = await get('/api/staff?active=1');
    allServices = await get('/api/services?active=1');
  } catch(e) { console.warn('Settings load:', e.message); }
  navigate('dashboard');
}

// ═══════════════════════════════════════════
// USER MANAGEMENT (admin)
// ═══════════════════════════════════════════
const ALL_PERMISSIONS = [
  { key:'patients',     label:'Patients' },
  { key:'appointments', label:'Appointments' },
  { key:'treatments',   label:'Treatments' },
  { key:'billing',      label:'Billing' },
  { key:'reports',      label:'Reports' },
];

async function loadUsersTab() {
  const el = $('users-tab-content');
  if (!el) return;
  try {
    const users = await get('/api/users');
    el.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h6 class="mb-0"><i class="fas fa-users me-2 text-primary"></i>System Users</h6>
        <button class="btn btn-primary btn-sm" onclick="openUserModal()"><i class="fas fa-plus me-1"></i>Add User</button>
      </div>
      <div class="table-responsive">
        <table class="table table-sm">
          <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Permissions</th><th>Last Login</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${users.map(u=>`<tr>
            <td><strong>${esc(u.username)}</strong></td>
            <td>${esc(u.full_name)}</td>
            <td><span class="badge ${u.role==='admin'?'bg-danger':'bg-secondary'}">${u.role}</span></td>
            <td style="font-size:.75rem">${u.role==='admin'?'<span class="text-success">All Access</span>':JSON.parse(u.permissions||'[]').join(', ')||'—'}</td>
            <td style="font-size:.78rem">${u.last_login?fmtDateTime(u.last_login):'Never'}</td>
            <td>${u.active?'<span class="badge bg-success">Active</span>':'<span class="badge bg-secondary">Inactive</span>'}</td>
            <td class="action-btns">
              <button class="btn btn-sm btn-outline-primary" onclick="openUserModal(${u.id})" title="Edit"><i class="fas fa-edit"></i></button>
              ${u.id!==_currentUser?.id?`<button class="btn btn-sm btn-outline-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')" title="Delete"><i class="fas fa-trash"></i></button>`:''}
            </td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch(e) { el.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function _permCheckboxes(selectedPerms) {
  return ALL_PERMISSIONS.map(p=>`
    <div class="form-check form-check-inline">
      <input class="form-check-input" type="checkbox" id="perm-${p.key}" value="${p.key}" ${selectedPerms.includes(p.key)?'checked':''}
        style="width:1.3em;height:1.3em;border:2px solid #1a56db;cursor:pointer;">
      <label class="form-check-label" for="perm-${p.key}">${p.label}</label>
    </div>`).join('');
}

let _editingUserId = null;
async function openUserModal(id=null) {
  _editingUserId = id;
  let u = null;
  if (id) { try { const list = await get('/api/users'); u = list.find(x=>x.id==id); } catch(e){} }
  const perms = u ? JSON.parse(u.permissions||'[]') : [];
  const html = `
    <div class="mb-3"><label class="form-label fw-semibold">Username <span class="req">*</span></label>
      <input class="form-control" id="um-username" value="${esc(u?.username||'')}" ${id?'readonly':''}></div>
    <div class="mb-3"><label class="form-label fw-semibold">Full Name <span class="req">*</span></label>
      <input class="form-control" id="um-fullname" value="${esc(u?.full_name||'')}"></div>
    <div class="mb-3"><label class="form-label fw-semibold">Password ${id?'(leave blank to keep)':' <span class="req">*</span>'}</label>
      <input class="form-control" type="password" id="um-password" placeholder="${id?'New password (optional)':'Set password'}"></div>
    <div class="mb-3"><label class="form-label fw-semibold">Role <span class="req">*</span></label>
      <select class="form-select" id="um-role" onchange="togglePermSection()">
        <option value="user" ${u?.role==='user'?'selected':''}>User</option>
        <option value="admin" ${u?.role==='admin'?'selected':''}>Admin</option>
      </select></div>
    <div id="um-perms-section" style="${u?.role==='admin'?'display:none':''}">
      <label class="form-label fw-semibold">Permissions</label>
      <div class="border rounded p-3 bg-light">${_permCheckboxes(perms)}</div>
    </div>
    <div class="mt-3"><div class="form-check form-switch">
      <input class="form-check-input" type="checkbox" id="um-active" ${(u?.active??1)?'checked':''}>
      <label class="form-check-label" for="um-active">Active</label>
    </div></div>`;
  $('user-modal-title').textContent = id ? 'Edit User' : 'Add New User';
  $('user-modal-body').innerHTML = html;
  showModal('userModal');
}

function togglePermSection() {
  const sec = $('um-perms-section');
  if (sec) sec.style.display = $('um-role')?.value === 'admin' ? 'none' : '';
}

async function saveUser() {
  const username  = $('um-username')?.value.trim();
  const full_name = $('um-fullname')?.value.trim();
  const password  = $('um-password')?.value;
  const role      = $('um-role')?.value;
  const active    = $('um-active')?.checked ? 1 : 0;
  const perms     = role === 'admin' ? ['all'] : ALL_PERMISSIONS.filter(p=>$(`perm-${p.key}`)?.checked).map(p=>p.key);
  if (!username || !full_name) { toast('Username and full name are required','warning'); return; }
  if (!_editingUserId && !password) { toast('Password is required for new users','warning'); return; }
  try {
    const data = { username, full_name, role, permissions: perms, active };
    if (password) data.password = password;
    if (_editingUserId) { await put(`/api/users/${_editingUserId}`, data); toast('User updated'); }
    else { await post('/api/users', data); toast('User created'); }
    hideModal('userModal');
    loadUsersTab();
  } catch(e) { toast(e.message,'error'); }
}

function deleteUser(id, username) {
  confirm(`Delete user "${username}"? This cannot be undone.`, async () => {
    try { await del(`/api/users/${id}`); toast('User deleted'); loadUsersTab(); }
    catch(e) { toast(e.message,'error'); }
  });
}

// ═══════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════
let _currentInventoryItem = null;

function _searchInventory(val) { loadInventory(val); }
function loadInventoryTab(search='') { loadInventory(search); }  // backward compat

async function loadInventory(search='') {
  const prevSearch = search || $('inv-search-main')?.value || '';
  $('content-area').innerHTML = `<div class="d-flex justify-content-center py-5"><div class="spinner-border" style="color:#7c3aed"></div></div>`;
  try {
    const url = prevSearch ? `/api/inventory?search=${encodeURIComponent(prevSearch)}` : '/api/inventory';
    const [items, lowStock] = await Promise.all([get(url), get('/api/inventory/low-stock')]);
    const lowIds = new Set(lowStock.map(i=>i.id));
    const totalVal = items.reduce((s,i)=>s+(i.value||0),0);
    $('content-area').innerHTML = `
      <div class="section-header d-flex justify-content-between align-items-start flex-wrap gap-2">
        <div><h4>Inventory</h4><p>Manage clinic supplies and stock levels</p></div>
        <button class="btn btn-primary" onclick="openInventoryItemModal()"><i class="fas fa-plus me-1"></i>Add Item</button>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-sm-4"><div class="stat-card"><div class="stat-icon" style="background:linear-gradient(135deg,#7c3aed,#6d28d9)"><i class="fas fa-boxes"></i></div><div><div class="stat-value">${items.length}</div><div class="stat-label">Total Items</div></div></div></div>
        <div class="col-sm-4"><div class="stat-card"><div class="stat-icon red"><i class="fas fa-exclamation-triangle"></i></div><div><div class="stat-value">${lowStock.length}</div><div class="stat-label">Low Stock Alerts</div></div></div></div>
        <div class="col-sm-4"><div class="stat-card"><div class="stat-icon green"><i class="fas fa-dollar-sign"></i></div><div><div class="stat-value">${fmt(totalVal)}</div><div class="stat-label">Total Value</div></div></div></div>
      </div>
      <div class="table-card">
        <div class="table-toolbar flex-wrap gap-2">
          ${_searchBox('inv-search-main','Type to search · Enter to scan barcode','_searchInventory','_searchInventory')}
          ${lowStock.length ? `<span class="badge bg-danger ms-1"><i class="fas fa-exclamation-triangle me-1"></i>${lowStock.length} Low Stock</span>` : ''}
          <span class="badge bg-secondary">${items.length} items</span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover">
            <thead class="table-light"><tr>
              <th>Code</th><th>Name</th><th>Category</th><th>Unit</th>
              <th>Stock</th><th>Min</th><th>Unit Cost</th><th>Value</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${items.map(i=>`<tr class="${lowIds.has(i.id)?'table-danger':''}">
                <td><small class="text-muted">${esc(i.item_code)}</small></td>
                <td><strong>${esc(i.name)}</strong>${lowIds.has(i.id)?` <span class="badge bg-danger">Low</span>`:''}
                  ${i.notes?`<br><small class="text-muted">${esc(i.notes)}</small>`:''}</td>
                <td>${esc(i.category||'—')}</td>
                <td>${esc(i.unit||'pcs')}</td>
                <td class="${lowIds.has(i.id)?'fw-bold text-danger':''}">${parseFloat(i.current_stock||0).toFixed(2)}</td>
                <td>${parseFloat(i.min_stock||0).toFixed(2)}</td>
                <td>${fmt(i.unit_cost)}</td>
                <td>${fmt(i.value||0)}</td>
                <td class="action-btns">
                  <button class="btn btn-xs btn-outline-primary" onclick="openStockModal(${i.id},'${esc(i.name)}')" title="Stock Transaction"><i class="fas fa-exchange-alt"></i></button>
                  <button class="btn btn-xs btn-outline-secondary ms-1" onclick="openInventoryItemModal(${i.id})" title="Edit"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-xs btn-outline-danger ms-1" onclick="deleteInventoryItem(${i.id},'${esc(i.name)}')" title="Delete"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('')||'<tr><td colspan="9" class="text-center text-muted py-4">No inventory items</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
    if (prevSearch && $('inv-search-main')) { $('inv-search-main').value = prevSearch; _showClear('inv-search-main', prevSearch); }
  } catch(e) { $('content-area').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function openInventoryItemModal(id=null) {
  $('invItemModalTitle').textContent = id ? 'Edit Inventory Item' : 'Add Inventory Item';
  $('inv-item-id').value = id || '';
  $('inv-item-name').value = ''; $('inv-item-unit').value = 'pcs';
  $('inv-item-category').value = ''; $('inv-item-stock').value = '0';
  $('inv-item-min-stock').value = '0'; $('inv-item-cost').value = '0';
  $('inv-item-supplier').value = ''; $('inv-item-location').value = '';
  $('inv-item-notes').value = '';
  if (id) {
    try {
      const item = await get(`/api/inventory/${id}`);
      _currentInventoryItem = item;
      $('inv-item-name').value     = item.name || '';
      $('inv-item-unit').value     = item.unit || 'pcs';
      $('inv-item-category').value = item.category || '';
      $('inv-item-stock').value    = item.current_stock ?? 0;
      $('inv-item-min-stock').value= item.min_stock ?? 0;
      $('inv-item-cost').value     = item.unit_cost ?? 0;
      $('inv-item-supplier').value = item.supplier || '';
      $('inv-item-location').value = item.location || '';
      $('inv-item-notes').value    = item.notes || '';
    } catch(e) { toast(e.message,'error'); return; }
  } else { _currentInventoryItem = null; }
  showModal('inventoryItemModal');
}

async function saveInventoryItem() {
  const id   = $('inv-item-id').value;
  const name = $('inv-item-name').value.trim();
  if (!name) { toast('Item name is required','warning'); return; }
  const data = {
    name, category: $('inv-item-category').value||null,
    unit: $('inv-item-unit').value||'pcs',
    current_stock: parseFloat($('inv-item-stock').value)||0,
    min_stock: parseFloat($('inv-item-min-stock').value)||0,
    unit_cost: parseFloat($('inv-item-cost').value)||0,
    supplier: $('inv-item-supplier').value||null,
    location: $('inv-item-location').value||null,
    notes: $('inv-item-notes').value||null,
  };
  try {
    if (id) { await put(`/api/inventory/${id}`, data); toast('Item updated'); }
    else     { await post('/api/inventory', data); toast('Item added'); }
    hideModal('inventoryItemModal');
    loadInventory();
  } catch(e) { toast(e.message,'error'); }
}

function openStockModal(id, name) {
  $('stock-item-id').value = id;
  $('stock-item-name').value = name;
  $('stock-type').value = 'in';
  $('stock-qty').value = '';
  $('stock-date').value = today();
  $('stock-unit-cost').value = '';
  $('stock-notes').value = '';
  showModal('stockTransactionModal');
}

async function submitStockTransaction() {
  const id   = $('stock-item-id').value;
  const type = $('stock-type').value;
  const qty  = parseFloat($('stock-qty').value);
  if (!qty || qty <= 0) { toast('Enter a valid quantity','warning'); return; }
  const data = {
    transaction_type: type,
    quantity: qty,
    transaction_date: $('stock-date').value || today(),
    unit_cost: parseFloat($('stock-unit-cost').value)||null,
    notes: $('stock-notes').value||null,
  };
  try {
    await post(`/api/inventory/${id}/transaction`, data);
    toast(`Stock ${type} recorded`);
    hideModal('stockTransactionModal');
    loadInventory();
  } catch(e) { toast(e.message,'error'); }
}

function deleteInventoryItem(id, name) {
  confirm(`Delete inventory item "${name}"?`, async () => {
    try { await del(`/api/inventory/${id}`); toast('Item deleted'); loadInventory(); }
    catch(e) { toast(e.message,'error'); }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // Sidebar toggle
  $('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    document.getElementById('main-wrapper').classList.toggle('expanded');
  });

  // Nav links
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    link.addEventListener('click', e => { e.preventDefault(); navigate(link.dataset.section); });
  });

  // Appointment service auto-fill duration
  $('appt-service-id')?.addEventListener('change', function() {
    const svc = allServices.find(s=>s.id==this.value);
    if (svc) $('appt-duration').value = svc.duration;
  });

  // Clock
  updateClock();
  setInterval(updateClock, 60000);

  // Confirm button
  $('confirm-ok-btn').addEventListener('click', () => {
    if (confirmCallback) { confirmCallback(); confirmCallback = null; }
    bootstrap.Modal.getInstance($('confirmModal'))?.hide();
  });

  // Try to restore existing session
  if (_authToken) {
    try {
      const r = await fetch('/api/auth/me', { headers:{'x-session-token':_authToken} });
      if (r.ok) {
        _currentUser = await r.json();
        hideLoginScreen();
        await initApp();
        return;
      }
    } catch(e) {}
    sessionStorage.removeItem('clinic_token');
    _authToken = null;
  }
  showLoginScreen();
});

