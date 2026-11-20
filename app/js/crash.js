// A fall while riding (server/src/crash.js, firmware 1.8.0): the red card with «Είμαι καλά», the
// settings page with the emergency contact, and a test of the whole chain.
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const clockFmt = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

let ctx = null; // helpers from main.js
let snap = null;
let ticker = null;
const lastShown = {};

export function initCrash(helpers) {
  ctx = helpers;
  $('btn-crash-ok').addEventListener('click', () =>
    ctx.act(
      () => api('crash/ok', { method: 'POST' }),
      snap?.crash?.smsAt ? 'Εντάξει. Φεύγει SMS ότι είσαι καλά.' : 'Εντάξει, δεν στέλνεται SMS.',
    ),
  );
  $('btn-crash-save').addEventListener('click', save);
  $('set-crash').addEventListener('change', save);
  $('btn-crash-test').addEventListener('click', startTest);
}

function save() {
  ctx.saveSettings({
    crash: {
      on: $('set-crash').checked,
      name: $('set-crash-name').value,
      contact: $('set-crash-contact').value,
      phone: $('set-crash-phone').value,
    },
  });
}

async function startTest() {
  const to = $('set-crash-test-phone').value.trim();
  if (!to) {
    $('settings-msg').textContent = 'Γράψε σε ποιο κινητό να έρθει το SMS της δοκιμής.';
    return;
  }
  const ask = `Να ξεκινήσει η δοκιμή; Θα χτυπήσει η ειδοποίηση πτώσης. Αν δεν πατήσεις «Είμαι καλά» σε 90 δευτερόλεπτα, θα φύγουν 3 SMS στο ${to}.`;
  if (!confirm(ask)) return;
  $('settings').close();
  await ctx.act(() => api('crash/test', { method: 'POST', body: { to } }), 'Η δοκιμή ξεκίνησε.');
}

/** Called from main.js after each render. */
export function renderCrash(state) {
  snap = state;
  if (!snap) return;
  renderSettings();
  renderBanner();
}

// A saved value goes into its field only when it changed, so typing in another field is not lost.
function showValue(id, value, prop = 'value') {
  const el = $(id);
  if (document.activeElement === el || lastShown[id] === value) return;
  lastShown[id] = value;
  el[prop] = value;
}

function olderThan(version, wanted) {
  const a = String(version ?? '').split('.').map(Number);
  const b = wanted.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
}

function renderSettings() {
  const s = snap.settings?.crash ?? {};
  showValue('set-crash', Boolean(s.on), 'checked');
  showValue('set-crash-name', s.name ?? '');
  showValue('set-crash-contact', s.contact ?? '');
  showValue('set-crash-phone', s.phone ?? '');
  $('sum-crash').textContent = s.on && s.phone ? `Ανοιχτή · ${s.contact || s.phone}` : 'Κλειστή';
  const running = snap.firmware?.running;
  let hint = '';
  if (s.on && !s.phone) hint = 'Γράψε το κινητό της επαφής: χωρίς αυτό δεν στέλνεται τίποτα.';
  else if (s.on && running && olderThan(running, '1.8.0')) {
    hint = `Η πλακέτα τρέχει ακόμα την ${running}. Η ανίχνευση πτώσης ξεκινάει με την 1.8.0, που μπαίνει μόνη της.`;
  }
  $('crash-hint').hidden = !hint;
  $('crash-hint').textContent = hint;
}

function renderBanner() {
  const c = snap.crash;
  document.body.classList.toggle('crash-live', Boolean(c && !c.smsAt && !c.okAt));
  $('crash-banner').hidden = !c;
  clearInterval(ticker);
  ticker = null;
  if (!c) return;
  $('crash-title').textContent = c.okAt ? 'Ακύρωση' : c.test ? 'Δοκιμή: έπεσες;' : 'Έπεσες;';
  $('btn-crash-ok').hidden = Boolean(c.okAt);
  showBannerText();
  if (!c.smsAt && !c.okAt) ticker = setInterval(showBannerText, 1000); // the countdown
}

function showBannerText() {
  const c = snap?.crash;
  if (!c) return;
  const s = snap.settings?.crash ?? {};
  // A test texts the number typed for it, not the contact.
  const to = c.test ? 'στο κινητό της δοκιμής' : s.contact ? `στην επαφή σου (${s.contact})` : 'στην επαφή σου';
  let text;
  if (c.okAt) {
    text = `Είσαι καλά. Φεύγει δεύτερο SMS ${to} μόλις ξαναστείλει η συσκευή.`;
  } else if (c.smsAt && c.smsOk === false) {
    text = `Δεν έφυγε το SMS ${to}. Αν χρειάζεσαι βοήθεια, κάλεσε 112.`;
  } else if (c.smsAt) {
    text = `${c.smsOk ? 'Έφυγε' : 'Στέλνεται'} SMS ${to} με το σημείο. Αν είσαι καλά, πάτα «Είμαι καλά» και θα φύγει δεύτερο SMS.`;
  } else {
    const left = Math.max(0, Math.ceil((c.deadline - ctx.serverNow()) / 1000));
    const when = `${clockFmt.format(new Date(c.since))}${c.kmh ? `, στα ${Math.round(c.kmh)} χλμ/ώ` : ''}`;
    // At zero the SMS goes with the board's next report: every 15 seconds after a fall, up to 15
    // minutes for a test while the bike is parked.
    const sms = left > 0 ? `Σε ${left} δευτ. φεύγει SMS ${to}` : `Φεύγει SMS ${to} μόλις ξαναστείλει η συσκευή`;
    text = c.test ? `Δοκιμή από τις ${when}. ${sms}.` : `Η μηχανή έπεσε (${when}). ${sms} με το σημείο.`;
  }
  $('crash-text').textContent = text;
}

export function crashEventText(e) {
  switch (e.type) {
    case 'crash':
      if (e.data?.off) return 'Πτώση στην οδήγηση (η ειδοποίηση επαφής είναι κλειστή)';
      return `Πτώση στην οδήγηση${e.data?.kmh ? ` (${e.data.kmh} χλμ/ώ)` : ''}`;
    case 'crash_sms':
      if (e.data?.ok) return 'SMS στην επαφή ότι είσαι καλά';
      if (e.data?.local) return 'Η συσκευή έστειλε μόνη της SMS ατυχήματος';
      return e.data?.test ? 'Δοκιμή: SMS ατυχήματος' : 'SMS ατυχήματος στην επαφή';
    case 'crash_ok':
      if (e.data?.by === 'ride') return 'Ξεκίνησες ξανά: ακυρώθηκε η ειδοποίηση πτώσης';
      return `Είμαι καλά${e.data?.by === 'pushover' ? ' (Pushover)' : ''}${e.data?.test ? ' (δοκιμή)' : ''}`;
    case 'crash_test':
      return 'Δοκιμή ειδοποίησης ατυχήματος';
    default:
      return null;
  }
}
