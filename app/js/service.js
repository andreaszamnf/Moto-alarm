// Service book of the bike: every service, where each regular job stands, and the intervals for
// the reminders. The server works out what is due (server/src/service.js); this file shows it.
import { api, AuthError } from './api.js';

const RELOAD_MS = 30 * 60_000; // when the app comes back to the screen, at most this often
const STALE_KM_DAYS = 45; // kilometres older than this: ask for today's

const ERRORS = {
  bad_date: 'Η ημερομηνία δεν είναι σωστή.',
  bad_km: 'Τα χιλιόμετρα θέλουν έναν ακέραιο αριθμό, π.χ. 12.400.',
  bad_cost: 'Το κόστος θέλει ένα ποσό σε ευρώ, π.χ. 85,50.',
  bad_items: 'Κάποια δουλειά δεν αναγνωρίστηκε. Ξαναδοκίμασε.',
  no_items: 'Διάλεξε τι έγινε, ή γράψ’ το στο «Κάτι άλλο».',
  too_long: 'Κάποιο κείμενο είναι πολύ μεγάλο.',
  bad_text: 'Κάποιο κείμενο δεν είναι σωστό.',
  service_not_found: 'Αυτό το σέρβις δεν υπάρχει πια. Ίσως σβήστηκε από άλλη συσκευή.',
  too_many_services: 'Το βιβλίο σέρβις γέμισε (1.000 καταχωρίσεις).',
  km_below_service: 'Είναι λιγότερα από τα χιλιόμετρα ενός σέρβις που έχεις γράψει. Έλεγξε τον αριθμό, ή διόρθωσε εκείνο το σέρβις.',
  bad_interval: 'Τα χιλιόμετρα θέλουν από 100 έως 200.000 και οι μήνες από 1 έως 120.',
  bad_next: 'Η «Επόμενη φορά» θέλει χιλιόμετρα πάνω από του σέρβις και ημερομηνία μετά από αυτό.',
  not_found: 'Ο server δεν έχει ακόμα το βιβλίο σέρβις.',
};
const LEAVE_FORM = 'Να φύγεις χωρίς να αποθηκεύσεις;';

const $ = (id) => document.getElementById(id);

// A small element builder: text always as text, never as HTML (shop names and notes are typed by hand).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'onclick') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// ---------- formatting ----------
const countFmt = new Intl.NumberFormat('el-GR', { maximumFractionDigits: 0 });
const shortFmt = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'short', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'long', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('el-GR', { month: 'short' });

const asDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shortDate = (ymd) => shortFmt.format(asDate(ymd));
const km = (n) => `${countFmt.format(n)} χλμ`;
const euro = (n) =>
  new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
const lowerFirst = (text) => text.charAt(0).toLocaleLowerCase('el') + text.slice(1);

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The same day n months later, or the month's last day (as on the server).
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = y * 12 + m - 1 + n;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const day = Math.min(d, new Date(year, month + 1, 0).getDate());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const daysSince = (ymd) => Math.round((asDate(todayLocal()) - asDate(ymd)) / 86_400_000);

// "12 μέρες", "3 μήνες", "2 χρόνια"
function spanText(days) {
  if (days < 45) return `${days} μέρ${days === 1 ? 'α' : 'ες'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} μήν${months === 1 ? 'α' : 'ες'}`;
  return `${Math.round(months / 12)} χρόνια`;
}

const agoText = (days) => (days <= 0 ? 'σήμερα' : days === 1 ? 'χθες' : `πριν ${spanText(days)}`);

// How far off a job is, by whichever comes first: "σε 400 χλμ" or "σε 2 μήνες".
function leftText(r) {
  if (r.status === 'due') return 'Ήρθε η ώρα';
  if (r.status === 'unknown') return 'λείπουν τα χλμ';
  const byKm = r.left?.km != null ? r.left.km / Math.max(1, r.span?.km ?? 1000) : Infinity;
  const byTime = r.left?.days != null ? r.left.days / Math.max(1, r.span?.days ?? 30) : Infinity;
  if (byKm === Infinity && byTime === Infinity) return '';
  return `σε ${byKm <= byTime ? km(r.left.km) : spanText(r.left.days)}`;
}

function nextText(r) {
  const parts = [];
  if (r.next?.km != null) parts.push(`στα ${km(r.next.km)}`);
  if (r.next?.date) parts.push(`ως ${shortDate(r.next.date)}`);
  if (!parts.length) return '';
  return `${r.status === 'due' ? 'Έπρεπε να γίνει' : 'Επόμενη'} ${parts.join(' ή ')}`;
}

function lastText(r) {
  const parts = [shortDate(r.last.date)];
  if (r.last.km != null) parts.push(`στα ${km(r.last.km)}`);
  if (r.ago.km != null) parts.push(`${km(r.ago.km)} από τότε`);
  else parts.push(agoText(r.ago.days));
  return `Τελευταία ${parts.join(' · ')}`;
}

// "1.250" or "1250" -> 1250; empty -> null; anything else -> NaN
function parseCount(text) {
  const t = String(text ?? '').replace(/[\s.,]/g, '');
  if (!t) return null;
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

// Greek or plain: "85,50", "1.250,00", "85.5", "1.250" -> number; empty -> null; anything else -> NaN
function parseCost(text) {
  let t = String(text ?? '').replace(/[\s€]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
}

const costInput = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));

// ---------- state ----------
const state = {
  view: null,
  loadedAt: 0,
  page: 'book',
  entryId: null,
  editing: false,
  nextDraft: {}, // the form's "next time" per job: { km, date, autoKm, autoDate }
  dirty: false,
  saving: false,
};
let deps = { errorText: (err) => err?.message ?? '', onAuthError: () => {} };

const dialog = () => $('service');
const say = (text) => {
  $('svc-msg').textContent = text;
};
const itemLabel = (id) => state.view?.items.find((i) => i.id === id)?.label ?? id;
const currentEntry = () => state.view?.entries.find((e) => e.id === state.entryId) ?? null;

function authFailed() {
  state.dirty = false;
  if (dialog().open) dialog().close();
  deps.onAuthError();
}

function fail(err, prefix) {
  if (err instanceof AuthError) return authFailed();
  const text = ERRORS[err?.message] ?? (err instanceof TypeError ? 'Δεν υπάρχει σύνδεση με τον server.' : deps.errorText(err));
  say(`${prefix}: ${text}`);
}

// ---------- the row on the main screen ----------
function renderRow() {
  const view = state.view;
  const row = $('btn-service');
  const line = $('service-line');
  const line2 = $('service-line2');
  row.classList.remove('is-due', 'is-soon');
  line2.hidden = true;
  if (!view) return;
  if (!view.entries.length) {
    line.textContent = 'Γράψε εδώ τα σέρβις της μηχανής';
    return;
  }
  const due = view.reminders.filter((r) => r.status === 'due');
  const soon = view.reminders.filter((r) => r.status === 'soon');
  const ok = view.reminders.find((r) => r.status === 'ok');
  let about = null;
  if (due.length) {
    row.classList.add('is-due');
    line.textContent = `Ήρθε η ώρα: ${due.map((r) => lowerFirst(r.label)).join(', ')}`;
    about = due.length === 1 ? due[0].item : null;
  } else if (soon.length) {
    row.classList.add('is-soon');
    line.textContent = `${soon[0].label} ${leftText(soon[0])}`;
    about = soon[0].item;
  } else if (ok) {
    line.textContent = `${ok.label} ${leftText(ok)}`;
    about = ok.item;
  } else {
    line.textContent = `Τελευταίο σέρβις ${shortDate(view.entries[0].date)}`;
  }
  // The oil, unless the first line already talks about it.
  const oil = view.reminders.find((r) => r.item === 'oil');
  if (oil && about !== 'oil' && !(due.length > 1 && due.includes(oil))) {
    line2.textContent = oil.ago.km != null ? `Λάδια: ${km(oil.ago.km)} από την αλλαγή` : `Λάδια: άλλαξαν ${agoText(oil.ago.days)}`;
    line2.hidden = false;
  } else if (view.odometer?.gps > 0) {
    line2.textContent = `Κοντέρ περίπου ${km(view.odometer.km)} (με GPS)`;
    line2.hidden = false;
  }
}

// ---------- the book ----------
function reminderRow(r) {
  const withBar = r.progress != null;
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: `svc-rem is-${r.status}`, onclick: () => showPage('entry', r.last.id) },
      el(
        'span',
        { class: 'svc-rem-head' },
        el('span', { class: 'svc-dot', 'aria-hidden': 'true' }),
        el('strong', { text: r.label }),
        el('span', { class: 'svc-rem-left', text: r.status === 'none' ? agoText(r.ago.days) : leftText(r) }),
      ),
      withBar && el('span', { class: 'svc-bar', 'aria-hidden': 'true' }, barFill(r.progress)),
      el('small', { text: lastText(r) }),
      r.next && nextText(r) && el('small', { text: nextText(r) }),
    ),
  );
}

function barFill(share) {
  const fill = el('span');
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
  return fill;
}

function entryRow(e) {
  const d = asDate(e.date);
  const jobs = [...e.items.map(itemLabel), e.other].filter(Boolean);
  const title = jobs.map((text, i) => (i ? lowerFirst(text) : text)).join(', ');
  const sub = [e.km != null ? km(e.km) : null, e.shop || null].filter(Boolean).join(' · ');
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: 'svc-entry', onclick: () => showPage('entry', e.id) },
      el('span', { class: 'svc-date', 'aria-hidden': 'true' }, el('b', { text: String(d.getDate()) }), el('small', { text: monthFmt.format(d) })),
      el(
        'span',
        { class: 'svc-entry-main' },
        el('span', { class: 'visually-hidden', text: shortDate(e.date) }),
        el('strong', { text: title }),
        sub && el('small', { text: sub }),
      ),
      e.cost != null && el('span', { class: 'svc-entry-cost', text: euro(e.cost) }),
    ),
  );
}

function renderBook() {
  const view = state.view;
  if (!view) return;
  const thisYear = Number(view.today.slice(0, 4));
  const has = view.entries.length > 0;

  $('btn-svc-new').disabled = false;
  $('svc-odo-km').textContent = view.odometer ? km(view.odometer.km) : '—';
  const odo = view.odometer;
  $('svc-odo-date').textContent = !odo ? 'Πάτα για να τα γράψεις' : odo.gps > 0 ? 'εκτίμηση με GPS' : `στις ${shortDate(odo.date)}`;
  $('svc-odo-gps').hidden = !(odo?.gps > 0);
  if (odo?.gps > 0) {
    $('svc-odo-gps').textContent = `Περίπου: τα ${km(odo.measured)} ${odo.src === 'reading' ? 'που έγραψες' : 'του σέρβις'} στις ${shortDate(odo.date)}, και ${km(odo.gps)} από τις διαδρομές με GPS μετά. Το GPS χάνει λίγα σε στροφές και όπου δεν έχει σήμα. Γράψε ξανά το κοντέρ και διορθώνεται.`;
  }
  const year = view.years.find((y) => y.year === thisYear);
  $('svc-year-cost').textContent = euro(year?.cost ?? 0);
  $('svc-year-count').textContent = year ? `${year.count} σέρβις το ${thisYear}` : `κανένα σέρβις το ${thisYear}`;

  // Reminders by kilometres need today's kilometres.
  const byKm = view.reminders.some((r) => r.next?.km != null);
  const hint = $('svc-odo-hint');
  hint.hidden = true;
  if (has && !view.odometer) {
    hint.textContent = 'Πάτα «Χιλιόμετρα» και γράψε τι δείχνει το κοντέρ, για να βλέπεις πόσα έκανες από κάθε σέρβις.';
    hint.hidden = false;
  } else if (byKm && view.odometer && !view.odometer.gps && daysSince(view.odometer.date) > STALE_KM_DAYS) {
    hint.textContent = `Τα χιλιόμετρα είναι από ${shortDate(view.odometer.date)}. Γράψε τα σημερινά για σωστές υπενθυμίσεις.`;
    hint.hidden = false;
  }

  $('svc-intro').hidden = has;
  const next = view.reminders.filter((r) => r.status !== 'none');
  const worn = view.reminders.filter((r) => r.status === 'none');
  $('svc-next').replaceChildren(...next.map(reminderRow));
  $('svc-next').hidden = !next.length;
  $('svc-untracked').hidden = !view.untracked.length;
  $('svc-untracked').textContent = `${next.length ? 'Δεν έχουν γραφτεί ακόμα' : 'Δεν έχουν γραφτεί ακόμα οι δουλειές με υπενθύμιση'}: ${view.untracked
    .map((id) => lowerFirst(itemLabel(id)))
    .join(', ')}. Γράψε πότε έγιναν τελευταία φορά, για να σου θυμίζει και αυτά.`;
  $('svc-next-wrap').hidden = !has;
  $('svc-worn').replaceChildren(...worn.map(reminderRow));
  $('svc-worn-wrap').hidden = !worn.length;

  // Every entry, newest first, grouped by year with that year's cost.
  const groups = new Map();
  for (const e of view.entries) {
    const y = Number(e.date.slice(0, 4));
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(e);
  }
  $('svc-history').replaceChildren(
    ...[...groups].map(([y, entries]) => {
      const total = view.years.find((row) => row.year === y);
      return el(
        'section',
        { class: 'svc-year', 'aria-label': String(y) },
        el(
          'div',
          { class: 'svc-year-head' },
          el('strong', { text: String(y) }),
          el('span', { text: `${total.count} σέρβις${total.cost ? ` · ${euro(total.cost)}` : ''}` }),
        ),
        el('ul', { class: 'svc-list' }, entries.map(entryRow)),
      );
    }),
  );
  $('svc-history-wrap').hidden = !has;

  // Cost per year, once there is more than one year to compare.
  const top = Math.max(0, ...view.years.map((y) => y.cost));
  $('svc-years-wrap').hidden = view.years.length < 2 || !top;
  $('svc-years').replaceChildren(
    ...view.years.map((y) => {
      const bar = el('span', { class: 'svc-ybar', 'aria-hidden': 'true' }, barFill(top ? y.cost / top : 0));
      return el('li', {}, el('span', { text: String(y.year) }), bar, el('span', { text: euro(y.cost) }));
    }),
  );
  const first = view.years[view.years.length - 1]?.year;
  $('svc-total').textContent = has ? `Σύνολο ${euro(view.total.cost)} σε ${view.total.count} σέρβις από το ${first}.` : '';
}

// ---------- one entry ----------
function renderEntry() {
  const entry = currentEntry();
  if (!entry) return false;
  $('svc-title').textContent = shortDate(entry.date);
  $('svc-e-items').replaceChildren(...entry.items.map((id) => el('li', { text: itemLabel(id) })));
  $('svc-e-items').hidden = !entry.items.length;
  const facts = [
    ['Ημερομηνία', longFmt.format(asDate(entry.date))],
    ['Χιλιόμετρα', entry.km != null ? km(entry.km) : null],
    ['Κάτι άλλο', entry.other || null],
    ['Συνεργείο', entry.shop || null],
    ['Κόστος', entry.cost != null ? euro(entry.cost) : null],
  ].filter(([, value]) => value);
  $('svc-e-facts').replaceChildren(...facts.map(([name, value]) => el('div', {}, el('dt', { text: name }), el('dd', { text: value }))));
  const next = entry.items
    .map((id) => {
      const r = state.view.reminders.find((x) => x.item === id && x.last.id === entry.id);
      const n = entry.next?.[id] ?? (r && !r.own ? r.next : null);
      const parts = [];
      if (n?.km != null) parts.push(`στα ${km(n.km)}`);
      if (n?.date) parts.push(`ως ${shortDate(n.date)}`);
      return parts.length ? [itemLabel(id), parts.join(' ή ')] : null;
    })
    .filter(Boolean);
  $('svc-e-next').replaceChildren(...next.map(([name, value]) => el('div', {}, el('dt', { text: name }), el('dd', { text: value }))));
  $('svc-e-next-wrap').hidden = !next.length;
  $('svc-e-notes').textContent = entry.notes;
  $('svc-e-notes-wrap').hidden = !entry.notes;
  return true;
}

// ---------- new entry or a change ----------
const field = (name) => $('svc-form').elements.namedItem(name);

function renderJobs(checked) {
  const groups = new Map();
  for (const item of state.view.items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  $('svc-jobs').replaceChildren(
    ...[...groups].map(([name, items]) =>
      el(
        'div',
        { class: 'svc-group', role: 'group', 'aria-label': name },
        el('span', { class: 'svc-group-name', 'aria-hidden': 'true', text: name }),
        el(
          'div',
          { class: 'chips' },
          items.map((item) =>
            el(
              'label',
              { class: 'chip' },
              el('input', { type: 'checkbox', name: 'items', value: item.id, checked: checked.includes(item.id) }),
              el('span', { text: item.label }),
            ),
          ),
        ),
      ),
    ),
  );
}

// "Next time" for each ticked job: filled in from the suggestions until the owner types in it.
function suggestNext(id) {
  const interval = state.view.intervals[id] ?? {};
  const entryKm = parseCount(field('km').value);
  const date = field('date').value;
  return {
    km: interval.km && Number.isInteger(entryKm) ? countFmt.format(entryKm + interval.km) : '',
    date: interval.months && date ? addMonths(date, interval.months) : '',
  };
}

function renderNextRows() {
  const ticked = [...$('svc-form').querySelectorAll('input[name="items"]:checked')].map((input) => input.value);
  for (const id of ticked) {
    if (!state.nextDraft[id]) state.nextDraft[id] = { ...suggestNext(id), autoKm: true, autoDate: true };
  }
  $('svc-next-set').hidden = !ticked.length;
  $('svc-next-rows').replaceChildren(
    ...ticked.map((id) => {
      const draft = state.nextDraft[id];
      const kmInput = el('input', {
        type: 'text',
        inputmode: 'numeric',
        maxlength: 9,
        placeholder: 'χλμ',
        autocomplete: 'off',
        value: draft.km,
        'aria-label': `${itemLabel(id)}: στα πόσα χιλιόμετρα`,
      });
      const dateInput = el('input', { type: 'date', value: draft.date, 'aria-label': `${itemLabel(id)}: ως πότε` });
      kmInput.addEventListener('input', () => Object.assign(draft, { km: kmInput.value, autoKm: false }));
      for (const type of ['input', 'change']) dateInput.addEventListener(type, () => Object.assign(draft, { date: dateInput.value, autoDate: false }));
      return el(
        'div',
        { class: 'svc-next-row' },
        el('span', { class: 'svc-next-name', text: itemLabel(id) }),
        el('label', {}, el('small', { class: 'muted', text: 'στα χλμ' }), kmInput),
        el('label', {}, el('small', { class: 'muted', text: 'ή ως' }), dateInput),
      );
    }),
  );
}

// The entry's km or date changed: suggestions the owner has not touched follow along.
function refreshSuggestions() {
  for (const [id, draft] of Object.entries(state.nextDraft)) {
    const s = suggestNext(id);
    if (draft.autoKm) draft.km = s.km;
    if (draft.autoDate) draft.date = s.date;
  }
  renderNextRows();
}

function openForm(entry = null) {
  if (!state.view) return;
  const form = $('svc-form');
  form.reset();
  state.editing = Boolean(entry);
  state.entryId = entry?.id ?? null;
  renderJobs(entry?.items ?? []);
  state.nextDraft = {};
  field('date').value = entry?.date ?? todayLocal();
  field('date').max = todayLocal();
  field('km').value = entry?.km != null ? countFmt.format(entry.km) : '';
  field('km').placeholder = state.view.odometer ? `π.χ. ${countFmt.format(state.view.odometer.km)}` : 'π.χ. 12.400';
  field('other').value = entry?.other ?? '';
  field('shop').value = entry?.shop ?? '';
  field('cost').value = entry?.cost != null ? costInput(entry.cost) : '';
  field('notes').value = entry?.notes ?? '';
  $('svc-shops').replaceChildren(...state.view.shops.map((shop) => el('option', { value: shop })));
  // An entry saved with its own "next time" keeps it; an older one shows what its reminder uses.
  for (const id of entry?.items ?? []) {
    const own = entry.next?.[id];
    const r = own ? null : state.view.reminders.find((x) => x.item === id && x.last.id === entry.id);
    const n = own ?? r?.next ?? null;
    if (n) state.nextDraft[id] = { km: n.km != null ? countFmt.format(n.km) : '', date: n.date ?? '', autoKm: false, autoDate: false };
  }
  renderNextRows();
  state.dirty = false;
  showPage('form', state.entryId);
}

function leaveForm() {
  if (state.dirty && !confirm(LEAVE_FORM)) return;
  state.dirty = false;
  showPage(state.editing && currentEntry() ? 'entry' : 'book');
}

async function saveEntry() {
  if (state.saving) return;
  const kmValue = parseCount(field('km').value);
  const cost = parseCost(field('cost').value);
  const items = [...$('svc-form').querySelectorAll('input[name="items"]:checked')].map((input) => input.value);
  const body = {
    date: field('date').value,
    km: kmValue,
    items,
    other: field('other').value,
    shop: field('shop').value,
    cost,
    notes: field('notes').value,
  };
  if (!body.date) return say(ERRORS.bad_date);
  if (Number.isNaN(kmValue)) return say(ERRORS.bad_km);
  if (Number.isNaN(cost)) return say(ERRORS.bad_cost);
  if (!items.length && !body.other.trim()) return say(ERRORS.no_items);
  const next = {};
  for (const id of items) {
    const draft = state.nextDraft[id] ?? { km: '', date: '' };
    const nextKm = parseCount(draft.km);
    if (Number.isNaN(nextKm)) return say(ERRORS.bad_next);
    next[id] = { km: nextKm, date: draft.date || null };
  }
  body.next = next;
  if (state.editing) body.id = state.entryId;
  const done = state.editing ? 'Οι αλλαγές αποθηκεύτηκαν.' : 'Το σέρβις αποθηκεύτηκε.';

  state.saving = true;
  $('svc-save').disabled = true;
  say('Αποθήκευση…');
  try {
    const view = await api('service', { method: 'POST', body });
    state.dirty = false;
    show(view);
    showPage('entry', view.id);
    say(done);
  } catch (err) {
    fail(err, 'Δεν αποθηκεύτηκε');
  } finally {
    state.saving = false;
    $('svc-save').disabled = false;
  }
}

// ---------- intervals and the reminder switch ----------
function renderIntervals() {
  const view = state.view;
  if (!view) return;
  if (document.activeElement !== $('svc-notify')) $('svc-notify').checked = view.notify;
  const list = $('svc-intervals');
  const value = (n) => (n != null ? countFmt.format(n) : '');
  if (list.children.length !== view.items.length) {
    list.replaceChildren(
      ...view.items.map((item) => {
        const input = (kind, name, max) =>
          el('input', {
            type: 'text',
            inputmode: 'numeric',
            maxlength: max,
            placeholder: '—',
            autocomplete: 'off',
            'aria-label': `${item.label}: ${name}`,
            dataset: { item: item.id, kind },
          });
        return el('li', {}, el('span', { text: item.label }), input('km', 'χιλιόμετρα', 7), input('months', 'μήνες', 3));
      }),
    );
  }
  // Fill in the saved values, except in the box being typed in.
  for (const input of list.querySelectorAll('input')) {
    if (document.activeElement !== input) input.value = value(view.intervals[input.dataset.item]?.[input.dataset.kind]);
  }
}

async function savePrefs(body, doneText) {
  try {
    show(await api('service/prefs', { method: 'POST', body }));
    say(doneText);
  } catch (err) {
    fail(err, 'Δεν αποθηκεύτηκε');
    renderIntervals();
  }
}

// ---------- kilometres today ----------
function toggleOdometer(open) {
  const box = $('svc-odo-edit');
  box.hidden = !open;
  $('svc-odo').setAttribute('aria-expanded', String(open));
  if (open) {
    const input = $('svc-odo-input');
    input.value = '';
    input.placeholder = state.view?.odometer ? countFmt.format(state.view.odometer.km) : 'π.χ. 12.400';
    input.focus();
  }
}

async function saveOdometer() {
  const value = parseCount($('svc-odo-input').value);
  if (value === null) return say('Γράψε πρώτα τα χιλιόμετρα.');
  if (Number.isNaN(value)) return say(ERRORS.bad_km);
  try {
    show(await api('service/odometer', { method: 'POST', body: { km: value } }));
    toggleOdometer(false);
    say('Τα χιλιόμετρα αποθηκεύτηκαν.');
  } catch (err) {
    fail(err, 'Δεν αποθηκεύτηκαν');
  }
}

// ---------- pages ----------
const TITLES = { book: 'Σέρβις', intervals: 'Προτάσεις' };

function showPage(page, entryId = state.entryId) {
  state.entryId = entryId;
  if (page === 'entry' && !currentEntry()) page = 'book'; // deleted meanwhile
  state.page = page;
  for (const section of dialog().querySelectorAll('.svc-page')) section.hidden = section.dataset.page !== page;
  $('svc-back').hidden = page === 'book' || page === 'form';
  $('svc-cancel').hidden = page !== 'form';
  $('svc-save').hidden = page !== 'form';
  $('svc-close').hidden = page === 'form';
  $('svc-title').textContent = page === 'form' ? (state.editing ? 'Αλλαγή σέρβις' : 'Νέο σέρβις') : TITLES[page] ?? 'Σέρβις';
  if (page === 'entry') renderEntry();
  if (page === 'intervals') renderIntervals();
  if (page !== 'book') toggleOdometer(false);
  say('');
  dialog().scrollTop = 0;
}

// A fresh copy of the book from the server: draw everything that shows it.
function show(view) {
  state.view = view;
  state.loadedAt = Date.now();
  renderRow();
  renderBook();
  if (state.page === 'entry' && !renderEntry()) showPage('book');
  if (state.page === 'intervals') renderIntervals();
}

export async function loadService() {
  try {
    show(await api('service'));
  } catch (err) {
    if (err instanceof AuthError) return authFailed();
    if (!state.view) $('service-line').textContent = 'Δεν φορτώθηκε ακόμα';
  }
}

export function initService(options) {
  deps = { ...deps, ...options };

  $('btn-service').addEventListener('click', () => {
    showPage('book');
    dialog().showModal();
    loadService();
  });
  $('svc-close').addEventListener('click', () => dialog().close());
  $('svc-back').addEventListener('click', () => showPage('book'));
  $('svc-cancel').addEventListener('click', leaveForm);
  $('svc-save').addEventListener('click', saveEntry);
  $('btn-svc-new').addEventListener('click', () => openForm());
  $('btn-svc-edit').addEventListener('click', () => openForm(currentEntry()));
  $('btn-svc-delete').addEventListener('click', async () => {
    const entry = currentEntry();
    if (!entry || !confirm(`Να διαγραφεί το σέρβις της ${fullFmt.format(asDate(entry.date))}; Δεν γυρίζει πίσω.`)) return;
    try {
      show(await api('service/delete', { method: 'POST', body: { id: entry.id } }));
      showPage('book');
      say('Το σέρβις διαγράφηκε.');
    } catch (err) {
      fail(err, 'Δεν διαγράφηκε');
    }
  });
  for (const link of dialog().querySelectorAll('[data-svc-go]')) {
    link.addEventListener('click', () => showPage(link.dataset.svcGo));
  }

  $('svc-odo').addEventListener('click', () => toggleOdometer($('svc-odo-edit').hidden));
  $('btn-svc-odo').addEventListener('click', saveOdometer);
  $('svc-odo-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveOdometer();
  });

  const form = $('svc-form');
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('input', () => {
    state.dirty = true;
  });
  form.addEventListener('change', (event) => {
    state.dirty = true;
    if (event.target.name === 'items') renderNextRows();
    if (event.target === field('date')) refreshSuggestions();
  });
  field('km').addEventListener('input', refreshSuggestions);

  $('svc-notify').addEventListener('change', (event) => {
    const on = event.currentTarget.checked;
    savePrefs({ notify: on }, on ? 'Θα σε ειδοποιεί για το σέρβις.' : 'Δεν θα σε ειδοποιεί για το σέρβις.');
  });
  $('svc-intervals').addEventListener('change', (event) => {
    const row = event.target.closest('li');
    if (!row) return;
    const [kmValue, months] = [...row.querySelectorAll('input')].map((input) => parseCount(input.value));
    if (Number.isNaN(kmValue) || Number.isNaN(months)) return say(ERRORS.bad_interval);
    savePrefs({ intervals: { [event.target.dataset.item]: { km: kmValue, months } } }, 'Αποθηκεύτηκε.');
  });
  $('btn-svc-reset').addEventListener('click', () => {
    if (confirm('Να γυρίσουν όλα τα διαστήματα στις τιμές της Honda;')) savePrefs({ reset: true }, 'Τα διαστήματα γύρισαν στις τιμές της Honda.');
  });

  // Escape (on a computer) leaves the form only after asking, like «Ακύρωση».
  dialog().addEventListener('cancel', (event) => {
    if (state.page === 'form' && state.dirty && !confirm(LEAVE_FORM)) event.preventDefault();
  });
  dialog().addEventListener('close', () => {
    state.dirty = false;
    state.page = 'book';
    toggleOdometer(false);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view && Date.now() - state.loadedAt > RELOAD_MS) loadService();
  });
}
