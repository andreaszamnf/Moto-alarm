// Builds the script the user pastes into the Scriptable app (iPhone) for home-screen and lock-screen
// widgets: armed or not, a mini map (medium and large sizes), battery with forecast, signal and last
// contact. Tapping a widget opens Scriptable with a menu to arm or disarm (iOS does not let Scriptable
// act without opening); one-tap buttons come from the Shortcuts app instead.
// The script is plain string concatenation: no template literals, so it fits in String.raw below.
const TEMPLATE = String.raw`// Hornet 750: widget με χάρτη, μπαταρία και σήμα για το Scriptable
const ORIGIN = '__ORIGIN__';
const QUICK = ORIGIN + '/api/quick?key=__KEY__';
const ZOOM = 16;
const TILE = 128; // points per map tile: 256-pixel tiles drawn at half size stay sharp

const C = {
  bg: Color.dynamic(new Color('#ffffff'), new Color('#131924')),
  alarmBg: new Color('#991b1b'),
  text: Color.dynamic(new Color('#111827'), new Color('#e6e8eb')),
  muted: Color.dynamic(new Color('#5b6472'), new Color('#9aa3b0')),
  armed: Color.dynamic(new Color('#dc2626'), new Color('#f87171')),
  disarmed: Color.dynamic(new Color('#15803d'), new Color('#4ade80')),
  white: Color.white(),
};

async function call(action, method) {
  const req = new Request(QUICK + '&action=' + action + '&format=json');
  req.method = method || 'GET';
  req.timeoutInterval = 20;
  return await req.loadJSON();
}

async function status() {
  try {
    const s = await call('status');
    return s.error ? { problem: s.text } : s;
  } catch (e) {
    return { problem: 'Δεν απαντά ο server.' };
  }
}

// OpenStreetMap tiles, kept on the phone for a month, so each one is downloaded only once.
async function tile(x, y) {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), 'hornet-tiles');
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, ZOOM + '-' + x + '-' + y + '.png');
  if (fm.fileExists(path) && Date.now() - fm.modificationDate(path).getTime() < 30 * 86400000) {
    return fm.readImage(path);
  }
  const req = new Request('https://tile.openstreetmap.org/' + ZOOM + '/' + x + '/' + y + '.png');
  req.headers = { 'User-Agent': 'HornetAlarmWidget/1.0 (Scriptable, personal use)' };
  const img = await req.loadImage();
  fm.writeImage(path, img);
  return img;
}

function worldX(lon) {
  return ((lon + 180) / 360) * Math.pow(2, ZOOM) * TILE;
}

function worldY(lat) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, ZOOM) * TILE;
}

// Map around the bike: the parking circle when armed, and the bike as a dot in the middle.
async function miniMap(s, width, height) {
  const left = worldX(s.position.lon) - width / 2;
  const top = worldY(s.position.lat) - height / 2;
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = true;
  dc.respectScreenScale = true;
  dc.setFillColor(new Color('#e5e7eb'));
  dc.fillRect(new Rect(0, 0, width, height));
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
      try {
        dc.drawImageInRect(await tile(tx, ty), new Rect(tx * TILE - left, ty * TILE - top, TILE, TILE));
      } catch (e) {
        // no tile: that square stays grey
      }
    }
  }
  dc.setFillColor(new Color('#ffffff', 0.2)); // softer colours, less clutter
  dc.fillRect(new Rect(0, 0, width, height));
  if (s.park) {
    const metresPerPoint = (40075016.686 * Math.cos((s.park.lat * Math.PI) / 180)) / (Math.pow(2, ZOOM) * TILE);
    const r = s.parkRadius / metresPerPoint;
    const px = worldX(s.park.lon) - left;
    const py = worldY(s.park.lat) - top;
    dc.setStrokeColor(new Color('#dc2626'));
    dc.setLineWidth(2);
    dc.strokeEllipse(new Rect(px - r, py - r, 2 * r, 2 * r));
  }
  const dot = new Rect(width / 2 - 7, height / 2 - 7, 14, 14);
  dc.setFillColor(new Color(s.alarm ? '#dc2626' : '#ea580c'));
  dc.fillEllipse(dot);
  dc.setStrokeColor(Color.white());
  dc.setLineWidth(3);
  dc.strokeEllipse(dot);
  dc.setFont(Font.systemFont(7));
  dc.setTextColor(new Color('#374151'));
  dc.drawText('© OpenStreetMap', new Point(4, height - 11));
  return dc.getImage();
}

function stateLabel(s) {
  if (s.problem) return 'Χωρίς σύνδεση';
  if (s.alarm) return 'ΣΥΝΑΓΕΡΜΟΣ';
  return s.armed ? 'Οπλισμένος' : 'Αφοπλισμένος';
}

function stateSymbol(s) {
  if (s.problem) return 'wifi.exclamationmark';
  if (s.alarm) return 'exclamationmark.triangle.fill';
  return s.armed ? 'lock.fill' : 'lock.open.fill';
}

function batterySymbol(pct) {
  if (pct >= 88) return 'battery.100';
  if (pct >= 63) return 'battery.75';
  if (pct >= 38) return 'battery.50';
  if (pct >= 13) return 'battery.25';
  return 'battery.0';
}

function contact(s) {
  return s.lastSeen ? s.lastSeenText.replace(/^επαφή /, '') : 'καμία επαφή';
}

// One row: a symbol and a short text.
function row(stack, symbol, text, color, size, bold) {
  const r = stack.addStack();
  r.layoutHorizontally();
  r.centerAlignContent();
  const icon = r.addImage(SFSymbol.named(symbol).image);
  icon.imageSize = new Size(size + 2, size + 2);
  icon.tintColor = color;
  r.addSpacer(5);
  const t = r.addText(text);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return r;
}

function title(stack, onRed) {
  const t = stack.addText('Hornet 750');
  t.font = Font.semiboldSystemFont(11);
  t.textColor = onRed ? C.white : C.muted;
}

function details(stack, s, size, onRed) {
  const stateColor = onRed ? C.white : s.armed ? C.armed : C.disarmed;
  row(stack, stateSymbol(s), stateLabel(s), stateColor, size + 3, true);
  if (s.problem) {
    stack.addSpacer(4);
    const t = stack.addText(s.problem);
    t.font = Font.systemFont(size);
    t.textColor = onRed ? C.white : C.muted;
    return;
  }
  stack.addSpacer(5);
  const text = onRed ? C.white : C.text;
  if (s.charging) {
    row(stack, 'battery.100.bolt', 'Φορτίζει', text, size, false);
    stack.addSpacer(3);
  } else if (s.battery !== null) {
    const forecast = s.forecast ? ' · ' + s.forecast.replace('περίπου ', '~') : '';
    row(stack, batterySymbol(s.battery), s.battery + '%' + forecast, text, size, false);
    stack.addSpacer(3);
  }
  if (s.signal) {
    row(stack, 'antenna.radiowaves.left.and.right', 'Σήμα ' + s.signal, text, size, false);
    stack.addSpacer(3);
  }
  row(stack, 'clock', contact(s), onRed ? C.white : C.muted, size, false);
}

async function widgetFor(s, family) {
  const w = new ListWidget();
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const onRed = Boolean(s.alarm);
  w.backgroundColor = onRed ? C.alarmBg : C.bg;

  // Lock screen
  if (family === 'accessoryInline') {
    w.addText(stateLabel(s) + (s.charging ? ' · φορτίζει' : s.battery !== null ? ' · ' + s.battery + '%' : ''));
    return w;
  }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const icon = w.addImage(SFSymbol.named(stateSymbol(s)).image);
    icon.imageSize = new Size(20, 20);
    icon.centerAlignImage();
    if (s.charging || s.battery !== null) {
      const t = w.addText(s.charging ? 'φορτίζει' : s.battery + '%');
      t.font = Font.boldSystemFont(11);
      t.minimumScaleFactor = 0.6;
      t.centerAlignText();
    }
    return w;
  }
  if (family === 'accessoryRectangular') {
    const t = w.addText(stateLabel(s));
    t.font = Font.boldSystemFont(14);
    const b = w.addText((s.charging ? 'Φορτίζει · ' : s.battery !== null ? 'Μπαταρία ' + s.battery + '% · ' : '') + contact(s));
    b.font = Font.systemFont(12);
    b.minimumScaleFactor = 0.7;
    return w;
  }

  // Home screen
  const withMap = Boolean(s.position) && family !== 'small';
  if (withMap && family === 'medium') {
    w.setPadding(10, 10, 10, 12);
    const r = w.addStack();
    r.layoutHorizontally();
    r.centerAlignContent();
    const map = r.addImage(await miniMap(s, 135, 135));
    map.imageSize = new Size(135, 135);
    map.cornerRadius = 12;
    r.addSpacer(12);
    const col = r.addStack();
    col.layoutVertically();
    title(col, onRed);
    col.addSpacer(4);
    details(col, s, 12, onRed);
    return w;
  }
  if (withMap) {
    w.setPadding(12, 12, 12, 12);
    title(w, onRed);
    w.addSpacer(6);
    const map = w.addImage(await miniMap(s, 300, 190));
    map.imageSize = new Size(300, 190);
    map.cornerRadius = 14;
    map.centerAlignImage();
    w.addSpacer(10);
    details(w, s, 14, onRed);
    return w;
  }
  title(w, onRed);
  w.addSpacer(6);
  details(w, s, 12, onRed);
  w.addSpacer();
  return w;
}

const s = await status();
if (config.runsInWidget) {
  Script.setWidget(await widgetFor(s, config.widgetFamily));
} else {
  const menu = new Alert();
  menu.title = 'Hornet 750';
  menu.message = s.problem || s.text;
  const actions = [];
  if (!s.problem) {
    menu.addAction(s.armed ? 'Αφόπλισε' : 'Όπλισε');
    actions.push(s.armed ? 'disarm' : 'arm');
  }
  menu.addAction('Άνοιξε την εφαρμογή');
  actions.push('open');
  menu.addAction('Δες το widget');
  actions.push('preview');
  menu.addCancelAction('Κλείσιμο');

  const choice = actions[await menu.presentSheet()];
  if (choice === 'arm' || choice === 'disarm') {
    let text;
    try {
      text = (await call(choice, 'POST')).text;
    } catch (e) {
      text = 'Δεν έγινε: δεν απαντά ο server.';
    }
    const done = new Alert();
    done.title = text;
    done.addAction('OK');
    await done.present();
  } else if (choice === 'open') {
    Safari.open(ORIGIN);
  } else if (choice === 'preview') {
    await (await widgetFor(s, 'medium')).presentMedium();
  }
}
Script.complete();
`;

export function scriptableScript(origin, key) {
  return TEMPLATE.replaceAll('__ORIGIN__', origin).replace('__KEY__', key);
}
