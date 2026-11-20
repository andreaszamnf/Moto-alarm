// Three smaller features with their own settings pages:
//   - lent out (workshop, friend): no alarm, but the rides are followed (server/src/loan.js)
//   - theft folder: the bike's details and photos, and a link for the police (server/src/folder.js)
//   - morning summary: a quiet note about the night (server/src/morning.js)
import { api, AuthError, getToken } from './api.js';

const $ = (id) => document.getElementById(id);
const num1 = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clockFmt = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('el-GR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const km = (m) => `${num1.format((m ?? 0) / 1000)} χλμ`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function since(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? clockFmt.format(d) : dayFmt.format(d);
}

let ctx = null; // helpers from main.js
let snap = null;

export function initExtras(helpers) {
  ctx = helpers;
  setupLoan();
  setupFolder();
  setupMorning();
}

/** Called from main.js after each render. */
export function renderExtras(state) {
  snap = state;
  if (!snap) return;
  renderLoan();
  renderMorning();
}

/** Called when a settings page opens. */
export function onSettingsPage(page) {
  if (page === 'folder') loadBike();
}

export function extraEventText(e) {
  switch (e.type) {
    case 'loan':
      if (e.data?.on) return 'Η μηχανή δόθηκε (δανεική)';
      return `Τέλος δανεικού: ${plural(e.data?.rides ?? 0, 'διαδρομή', 'διαδρομές')}, ${km(e.data?.m)}`;
    case 'folder': return `Σύνδεσμος φακέλου κλοπής για ${e.data?.days} μέρες`;
    case 'folder_stop': return 'Σταμάτησε ο σύνδεσμος του φακέλου κλοπής';
    default: return null;
  }
}

// ---------- lent out ----------

function loanText(loan) {
  const parts = [`Από ${since(loan.since)}`];
  if (!loan.rides) parts.push('δεν έχει κινηθεί ακόμα');
  else parts.push(plural(loan.rides, 'διαδρομή', 'διαδρομές'), km(loan.m), `μέγιστη ${Math.round(loan.max)} χλμ/ώ`);
  if (loan.riding) parts.push('κινείται τώρα');
  return parts.join(' · ');
}

function renderLoan() {
  const loan = snap.loan;
  $('loan-card').hidden = !loan;
  $('ride-card').querySelector('h2').textContent = loan ? 'Η δανεική κινείται' : 'Οδηγείς τώρα';
  $('sum-loan').textContent = loan ? `Δανεική από ${since(loan.since)}` : 'Κλειστό';
  $('btn-loan').textContent = loan ? 'Επέστρεψε: τέλος δανεικού' : 'Η μηχανή φεύγει: ξεκίνα';
  $('btn-loan').classList.toggle('primary', !loan);
  if (document.activeElement !== $('set-loan-speed')) $('set-loan-speed').value = String(loan?.speedLimit ?? 0);
  $('loan-state').textContent = loan ? loanText(loan) : '';
  if (!loan) return;
  $('loan-text').textContent = loanText(loan);
  $('loan-limit').textContent = loan.speedLimit ? `Ειδοποίηση πάνω από ${loan.speedLimit} χλμ/ώ.` : '';
  $('arm-sub').textContent = 'Δανεική: δεν χτυπάει συναγερμός, αλλά βλέπεις πού πάει και πόσο γρήγορα.';
}

function setLoan(on) {
  const speedLimit = Number($('set-loan-speed').value) || 0;
  return ctx.act(
    () => api('loan', { method: 'POST', body: { on, speedLimit } }),
    on ? 'Δανεική: χωρίς συναγερμό, με ειδοποίηση όταν ξεκινάει.' : 'Τέλος δανεικού. Όπλισε τον συναγερμό όταν την αφήσεις.',
  );
}

function setupLoan() {
  $('btn-loan').addEventListener('click', () => setLoan(!snap?.loan));
  $('btn-loan-end').addEventListener('click', () => setLoan(false));
  $('set-loan-speed').addEventListener('change', () => {
    if (snap?.loan) setLoan(true); // changes the limit of the loan under way
  });
}

/** The arm button while lent out: arming ends it, so ask first. */
export function confirmArmWhileLent() {
  return !snap?.loan || confirm('Ο οπλισμός τελειώνει τη λειτουργία «δανεική». Να οπλίσει;');
}

// ---------- morning summary ----------

function renderMorning() {
  const m = snap.settings?.morning ?? { on: true, time: '08:00' };
  if (document.activeElement !== $('set-morning')) $('set-morning').checked = Boolean(m.on);
  if (document.activeElement !== $('set-morning-time')) $('set-morning-time').value = m.time ?? '08:00';
  $('set-morning-time').disabled = !m.on;
  $('sum-morning').textContent = m.on ? `Κάθε πρωί στις ${m.time}` : 'Κλειστή';
}

function setupMorning() {
  for (const id of ['set-morning', 'set-morning-time']) {
    $(id).addEventListener('change', () => {
      const time = $('set-morning-time').value;
      ctx.saveSettings({ morning: { on: $('set-morning').checked, ...(time ? { time } : {}) } });
    });
  }
}

// ---------- theft folder ----------

const FIELDS = ['plate', 'vin', 'model', 'color', 'notes'];
const MAX_SIDE = 1280; // pixels: plenty for a photo of the bike, small enough to send quickly
const MAX_BYTES = 650 * 1024;
let bike = null;

const folderUrl = (share) => `${location.origin}/f/${share.token}`;

function folderMsg(text) {
  $('settings-msg').textContent = text;
}

async function guarded(work, failText) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AuthError) return ctx.onAuthError();
    folderMsg(`${failText}: ${ctx.errorText(err)}`);
    return null;
  }
}

function renderBike() {
  if (!bike) return;
  for (const f of FIELDS) {
    const el = $(`bk-${f}`);
    if (document.activeElement !== el) el.value = bike.bike?.[f] ?? '';
  }
  $('sum-folder').textContent = bike.bike?.plate ? `Πινακίδα ${bike.bike.plate}` : 'Στοιχεία, φωτογραφίες, σύνδεσμος';

  const grid = $('bike-photos');
  grid.replaceChildren();
  bike.photos.forEach((photo, slot) => {
    const cell = document.createElement('div');
    cell.className = 'photo-slot';
    if (photo) {
      const img = document.createElement('img');
      img.src = photo;
      img.alt = `Φωτογραφία ${slot + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Αφαίρεση';
      remove.addEventListener('click', () => removePhoto(slot));
      cell.append(img, remove);
    } else {
      const label = document.createElement('label');
      label.className = 'photo-add';
      label.textContent = '+ Φωτογραφία';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.className = 'visually-hidden';
      input.addEventListener('change', () => input.files?.[0] && addPhoto(slot, input.files[0]));
      label.append(input);
      cell.append(label);
    }
    grid.append(cell);
  });

  const share = bike.share;
  $('folder-new').hidden = Boolean(share);
  $('folder-active').hidden = !share;
  if (share) {
    $('folder-url').value = folderUrl(share);
    $('folder-expires').textContent = dayFmt.format(new Date(share.expires));
    $('folder-from').textContent = share.from
      ? `Η διαδρομή ξεκινά από τον συναγερμό της ${dayFmt.format(new Date(share.from))}.`
      : 'Δεν υπάρχει συναγερμός ακόμα: η διαδρομή θα ξεκινά από τον επόμενο.';
  }
}

async function loadBike() {
  const data = await guarded(() => api('bike'), 'Δεν φορτώθηκαν τα στοιχεία');
  if (data) {
    bike = data;
    renderBike();
  }
}

// Shrinks a photo on the phone to a JPEG of at most 1280 pixels per side (and well under 650 KB).
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  let side = MAX_SIDE;
  let quality = 0.78;
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_BYTES) return blob;
    side = Math.round(side * 0.8);
    quality -= 0.1;
  }
  throw new Error('photo_too_large');
}

async function addPhoto(slot, file) {
  folderMsg('Ανεβαίνει η φωτογραφία…');
  const data = await guarded(async () => {
    const blob = await shrink(file);
    const res = await fetch(`api/bike/photo?slot=${slot}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }, 'Δεν ανέβηκε');
  if (data) {
    bike = data;
    renderBike();
    folderMsg('Η φωτογραφία αποθηκεύτηκε.');
  }
}

async function removePhoto(slot) {
  const data = await guarded(() => api('bike/photo/remove', { method: 'POST', body: { slot } }), 'Δεν αφαιρέθηκε');
  if (data) {
    bike = data;
    renderBike();
  }
}

function setupFolder() {
  $('btn-bike-save').addEventListener('click', async () => {
    const body = Object.fromEntries(FIELDS.map((f) => [f, $(`bk-${f}`).value]));
    const data = await guarded(() => api('bike', { method: 'POST', body }), 'Δεν αποθηκεύτηκε');
    if (data) {
      bike = data;
      renderBike();
      folderMsg('Τα στοιχεία αποθηκεύτηκαν.');
    }
  });
  $('btn-folder-start').addEventListener('click', async () => {
    const days = Number($('folder-days').value);
    const data = await guarded(() => api('folder', { method: 'POST', body: { days } }), 'Δεν έγινε');
    if (data) {
      bike = data;
      renderBike();
      folderMsg('Ο σύνδεσμος είναι έτοιμος.');
    }
  });
  $('btn-folder-send').addEventListener('click', async () => {
    const url = $('folder-url').value;
    const plate = bike?.bike?.plate ? ` ${bike.bike.plate}` : '';
    if (navigator.share) {
      try {
        await navigator.share({ title: `Φάκελος κλοπής μοτοσυκλέτας${plate}`, text: `Κλεμμένη μοτοσυκλέτα${plate}: στοιχεία και διαδρομή`, url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    ctx.copyText(url, $('btn-folder-send'), $('folder-url'));
  });
  $('btn-folder-copy').addEventListener('click', (event) => ctx.copyText($('folder-url').value, event.currentTarget, $('folder-url')));
  $('btn-folder-open').addEventListener('click', () => window.open($('folder-url').value, '_blank', 'noopener'));
  $('btn-folder-stop').addEventListener('click', async () => {
    const data = await guarded(() => api('folder/stop', { method: 'POST' }), 'Δεν σταμάτησε');
    if (data) {
      bike = data;
      renderBike();
      folderMsg('Ο σύνδεσμος δεν ανοίγει πια.');
    }
  });
  $('btn-folder-alarm').addEventListener('click', () => ctx.openSettingsPage('folder'));
}
