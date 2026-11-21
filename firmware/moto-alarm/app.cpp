// The board sleeps almost all the time. It wakes when the accelerometer feels movement or when a
// timer runs out, reports to the server (over a known Wi-Fi, else 4G), and does what the server
// answers. The server knows whether the alarm is armed, so it decides whether movement is a theft or
// the owner riding. Parked by a known Wi-Fi the modem is off; elsewhere it sleeps on the 4G network.
//
// Modes, kept in RTC memory across deep sleep:
//   Parked  sleeps until movement or the next heartbeat (every 6 hours by default).
//   Riding  the server said "disarmed" after movement. While the bike moves it stays awake: a GPS
//           point every 3 seconds, sent together every 15 seconds, so the app shows the speed
//           and the route live. Once it has stood still for a minute it checks every minute, and
//           after 3 minutes it reports "parked" with the position.
//   Alarm   the server asked for tracking: a position every 30 seconds, or every 5 minutes
//           (sleeping in between) while the bike stands still.
#include "app.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_attr.h>
#include <esp_idf_version.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <math.h>
#include <sys/time.h>
#include <time.h>

#include "accel.h"
#include "battery.h"
#include "config.h"
#include "modem.h"
#include "ota.h"
#include "util.h"
#include "wifinet.h"
#include "wifiscan.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "secrets.h is missing: run  node tools/make-firmware-secrets.mjs"
#endif

namespace {

enum class Mode : uint8_t { Parked, Riding, Alarm };

struct State {
  uint32_t magic;
  Mode mode;
  bool armed;            // as last heard from the server
  bool reportTouches;    // the server also wants to hear about light touches
  bool motionPending;    // movement that could not be reported yet (no signal)
  bool haveRef;
  uint8_t sensitivity;   // 1 low, 2 medium, 3 high
  uint8_t failures;      // reports in a row that did not get through
  uint8_t burstCount;    // light touches in the current window
  uint16_t touches;      // light touches since the last report
  uint32_t heartbeatS;
  uint32_t trackS;
  uint32_t boots;
  float ref[3];          // direction of gravity when the bike was parked
  time_t nextHeartbeat;
  time_t nextRideReport;  // unused since 1.6.0 (kept so the fields after it keep their place)
  time_t lastMoved;
  time_t burstStart;
  time_t moveStart;      // alarm: when the current movement began (added last: older fields keep their place)
  uint32_t checkInS;     // a short "still here" report this often (no GPS), 0 = off
  time_t nextCheckIn;
  bool usbKnown;         // onUsb holds a reading from an earlier wake
  bool onUsb;            // powered by the bike at the last wake
  uint32_t rideS;        // riding: a live report this often
  time_t nextAlarmReport;  // alarm, standing still: the next report (a light touch does not put it off)
  bool lastViaWifi;      // the last report that got through went over a known Wi-Fi (see keepModemOnNetwork)
  time_t fastAt;         // riding: when the GPS last showed CRASH_FAST_KMH or more (0 = not lately)
  float fastKmh;         // the speed then
  bool haveUpright;      // riding: `upright` holds how gravity points when the bike is ridden upright
  float upright[3];
  uint8_t smsResult;     // the last SMS since the last report: 0 none, 1 sent, 2 failed
  char crashTo[20];      // a fall: the emergency contact, from the server ("" = detection off)
  char crashText[96];    // a fall: the board's own SMS when the server cannot be reached (+ map link)
  bool lowPower;         // «Χαμηλή κατανάλωση» in the app: the modem off while parked (1.8.2)
  time_t standingSince;  // riding: since when the GPS sees the bike standing, 0 = rolling (1.8.5)
  double standLat;       // where it stands
  double standLon;
  uint8_t uprightSamples;  // riding: readings at speed in `upright` since it was last learned anew (1.8.5)
  uint8_t oddSamples;      // riding: readings at speed in a row far from upright (1.8.5)
};

constexpr uint32_t STATE_MAGIC = 0x4D4F5431;  // "MOT1"

RTC_DATA_ATTR State st;

Modem modem(Serial1);
Accel accel;
Battery battery;
// Set when the board started without waking from its sleep: power came back (switch, USB, battery
// contact), the voltage fell too low, a crash, or the watchdog. Sent until a report gets through.
// Values of esp_reset_reason(): 1 power on, 3 software, 4 crash, 5-7 watchdog, 9 brownout.
RTC_DATA_ATTR uint8_t restartReason = 0;
// The "+HTTPREAD" lines of the last answer over 4G, for the next report: how this modem frames its
// data, which the firmware download over 4G depends on (1.8.6).
RTC_DATA_ATTR char httpFraming[48] = "";

struct Reply {
  bool ok = false;
  bool armed = false;
  bool track = false;
  bool locate = false;
  String smsTo;  // an SMS to send, when the server asks for it
  String smsText;
  String smsTexts[4];  // or several (a fall: who and when, where, the live link)
  uint8_t smsCount = 0;
  int crashWait = -1;     // a fall: seconds the server still waits for «I'm fine» (-1: none open)
  bool crashEnd = false;  // a fall: the server is done with it (cancelled, or a while after the SMS)
  FirmwareOffer update;  // new firmware, when the server offers it
};

// A fall being reported (see crashWatch): it goes with every report while it is open.
struct CrashInfo {
  bool open = false;
  time_t at = 0;      // when the board decided it was a fall: the server tells reports of one fall by it
  float kmh = 0;      // the speed shortly before
  float tilt = NAN;   // degrees from upright
  bool over = false;  // it rode on: the rider is fine
  bool local = false; // the board texted the contact itself (no server)
};
CrashInfo crashInfo;
time_t downSince = 0;  // riding: since when the bike lies on its side

// Access points heard when the GPS found nothing. They go with the next report, so the server can
// work out a rough position (a garage, a van).
AccessPoint nearby[MAX_ACCESS_POINTS];
uint8_t nearbyCount = 0;

// Riding: GPS points taken since the last report that got through. They go with the next one.
struct RidePoint {
  uint32_t t;  // unix seconds
  double lat;
  double lon;
  float kmh;
};
RidePoint ridePoints[MAX_RIDE_POINTS];
uint8_t ridePointCount = 0;

void runAlarm(bool urgent = false);
void takeReference();
void onMovement(float tilt);
void rideLive();

void listenForWifi(const Fix& fix) {
  nearbyCount = fix.valid ? 0 : scanAccessPoints(nearby, MAX_ACCESS_POINTS);
  if (!fix.valid) Serial.printf("no gps fix: %u wifi access points\n", static_cast<unsigned>(nearbyCount));
}

time_t clockNow() { return time(nullptr); }

void resetState() {
  memset(&st, 0, sizeof st);
  st.magic = STATE_MAGIC;
  st.mode = Mode::Parked;
  st.sensitivity = DEFAULT_SENSITIVITY;
  st.heartbeatS = DEFAULT_HEARTBEAT_S;
  st.trackS = DEFAULT_TRACK_S;
  st.rideS = DEFAULT_RIDE_LIVE_S;
}

// After failed reports: 5, 10, 20, 40, then every 60 minutes.
uint32_t retryDelayS() {
  static const uint16_t MINUTES[] = {5, 10, 20, 40, 60};
  uint8_t step = st.failures > 0 ? st.failures - 1 : 0;
  if (step > 4) step = 4;
  return MINUTES[step] * 60UL;
}

void startWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  const esp_task_wdt_config_t config = {WATCHDOG_S * 1000, 0, true};
  if (esp_task_wdt_reconfigure(&config) != ESP_OK) esp_task_wdt_init(&config);
#else
  esp_task_wdt_init(WATCHDOG_S, true);
#endif
  esp_task_wdt_add(nullptr);
}

String reportJson(const char* reason, const Fix* fix, bool moving, float tilt, bool viaWifi) {
  JsonDocument doc;
  doc["reason"] = reason;
  if (fix && fix->valid) {
    JsonObject f = doc["fix"].to<JsonObject>();
    f["lat"] = serialized(String(fix->lat, 6));
    f["lon"] = serialized(String(fix->lon, 6));
    f["acc"] = static_cast<int>(lroundf(fix->acc));
    f["spd"] = serialized(String(fix->speedKmh, 1));
    if (fix->time) f["t"] = fix->time;
  }
  if (ridePointCount) {
    JsonArray pts = doc["pts"].to<JsonArray>();
    for (uint8_t i = 0; i < ridePointCount; i++) {
      JsonArray p = pts.add<JsonArray>();
      p.add(ridePoints[i].t);
      p.add(serialized(String(ridePoints[i].lat, 6)));
      p.add(serialized(String(ridePoints[i].lon, 6)));
      p.add(serialized(String(ridePoints[i].kmh, 1)));
    }
  }
  if (!(fix && fix->valid) && fix && nearbyCount) {
    JsonArray wifi = doc["wifi"].to<JsonArray>();
    for (uint8_t i = 0; i < nearbyCount; i++) {
      JsonObject ap = wifi.add<JsonObject>();
      ap["m"] = macText(nearby[i].bssid);
      ap["s"] = nearby[i].rssi;
    }
  }
  JsonObject b = doc["batt"].to<JsonObject>();
  if (!battery.external) {
    b["mv"] = battery.mv;
    b["pct"] = static_cast<int>(battery.pct);
    if (battery.fromModem) b["src"] = "modem";
  }
  b["adc"] = battery.adcMv;  // the board's own reading, to see why it fails
  doc["ext"] = battery.usb;  // powered by the bike: the server notices when this goes away
  if (modem.signal()) doc["rssi"] = modem.signal();
  // Network details for the signal test in the app.
  NetInfo net;
  if (modem.readNetInfo(net)) {
    JsonObject n = doc["net"].to<JsonObject>();
    n["op"] = net.op;
    if (net.tech.length()) n["tech"] = net.tech;
    if (net.rsrp) n["rsrp"] = net.rsrp;
    if (net.rsrq) n["rsrq"] = net.rsrq;
    if (net.snr) n["snr"] = net.snr;
    n["reg"] = modem.registerMs() / 1000;  // seconds it took to find the network
    if (modem.wasAwake()) n["warm"] = true;  // it had stayed on the network while asleep
  }
  if (st.failures) doc["fails"] = st.failures;  // reports that did not get through before this one
  if (!isnan(tilt)) doc["tilt"] = serialized(String(tilt, 1));
  if (moving) doc["moving"] = true;
  // When the current movement began (server time, seconds): movement that began after the owner
  // pressed "seen" sounds the alarm again.
  if (moving && st.moveStart > 1600000000L) doc["movingSince"] = static_cast<long>(st.moveStart);
  // Riding: when it last moved, so movement from before the owner armed it (getting off, the side
  // stand) does not count as a theft.
  if (moving && !strcmp(reason, "ride") && st.lastMoved > 1600000000L) doc["lastMove"] = static_cast<long>(st.lastMoved);
  if (st.touches) doc["touches"] = st.touches;
  if (crashInfo.open) {
    JsonObject c = doc["crash"].to<JsonObject>();
    c["at"] = static_cast<long>(crashInfo.at);
    c["kmh"] = static_cast<int>(lroundf(crashInfo.kmh));
    if (!isnan(crashInfo.tilt)) c["tilt"] = static_cast<int>(lroundf(crashInfo.tilt));
    if (crashInfo.over) c["over"] = true;
    if (crashInfo.local) c["local"] = true;
  }
  if (st.smsResult) doc["smsOk"] = st.smsResult == 1;
  if (!accel.ok()) doc["sensor"] = "missing";
  if (viaWifi) {
    doc["via"] = "wifi";
    doc["wnet"] = wifiName();   // which of the known networks
    doc["wrssi"] = wifiRssi();  // how well the board hears it, dBm
  } else if (wifiLastAttempt().fail != WifiFail::None) {
    // Over 4G after the Wi-Fi did not work: why, for the app (1.8.1).
    const WifiAttempt& wa = wifiLastAttempt();
    JsonObject w = doc["wfail"].to<JsonObject>();
    w["k"] = wifiFailName(wa.fail);
    if (wa.ssid.length()) w["n"] = wa.ssid;
    if (wa.rssi) w["s"] = wa.rssi;
    if (wa.code) w["c"] = wa.code;
    if (wa.seen >= 0) w["seen"] = wa.seen;
  }
  if (st.checkInS) doc["checkin"] = st.checkInS;  // the server expects to hear from it this often
  if (st.lowPower) doc["eco"] = true;             // it keeps «Χαμηλή κατανάλωση»
  doc["fw"] = FIRMWARE_VERSION;
  doc["wifiv"] = wifiListVersion();
  if (restartReason) doc["rst"] = restartReason;  // why the board started afresh this time
  if (firmwareNote()[0]) doc["otaErr"] = firmwareNote();  // why the last update did not go in
  if (httpFraming[0]) doc["hr"] = httpFraming;
  String out;
  serializeJson(doc, out);
  return out;
}

// Switches the modem on if needed and sends one report. Takes on what the server answers.
Reply sendReport(const char* reason, const Fix* fix, bool moving, float tilt) {
  Reply reply;
  String body;
  int status = -1;
  // Full speed while reporting: the encryption (TLS) takes seconds at 80 MHz.
  setCpuFrequencyMhz(240);
  // The known Wi-Fi first (home, garage), then 4G.
  bool viaWifi = false;
  if (wifiConnect()) {
    useModemVoltage(battery, modem.readVoltageMv());  // only when the board's own reading failed
    const String json = reportJson(reason, fix, moving, tilt, true);
    Serial.printf("wifi -> %s\n", json.c_str());
    status = wifiPost(SERVER_URL, DEVICE_KEY, json, body);
    Serial.printf("<- %d %s\n", status, body.c_str());
    // Our server always answers JSON. Anything else came from the network itself (a login page of a
    // café or hotel): the report has not arrived, so it goes over 4G.
    if (status >= 0 && !body.startsWith("{")) {
      wifiNoServer(status);
      status = -1;
      body = "";
    }
    viaWifi = status >= 0;
  }
  if (status < 0 && modem.powerOn() && modem.waitForNetwork(SIM_APN, REGISTER_TIMEOUT_MS)) {
    useModemVoltage(battery, modem.readVoltageMv());
    const String json = reportJson(reason, fix, moving, tilt, false);
    Serial.printf("-> %s\n", json.c_str());
    status = modem.post(SERVER_URL, DEVICE_KEY, json, body);
    Serial.printf("<- %d %s\n", status, body.c_str());
  }
  JsonDocument doc;
  if (status != 200 || deserializeJson(doc, body)) {
    if (st.failures < 255) st.failures++;
    return reply;
  }
  reply.ok = true;
  st.lastViaWifi = viaWifi;
  keepNewFirmware();  // a new program that reached the server stays (nothing happens otherwise)
  // What this report carried has arrived. This answer's own framing goes with the next one.
  clearFirmwareNote();
  strlcpy(httpFraming, viaWifi ? "" : modem.framing(), sizeof httpFraming);
  reply.armed = doc["armed"] | false;
  reply.track = doc["track"] | false;
  reply.locate = doc["locate"] | false;
  if (doc["sms"]["to"].is<const char*>()) {
    reply.smsTo = doc["sms"]["to"].as<const char*>();
    reply.smsText = doc["sms"]["text"] | "";
    for (JsonVariantConst text : doc["sms"]["texts"].as<JsonArrayConst>()) {
      if (reply.smsCount < 4 && text.is<const char*>()) reply.smsTexts[reply.smsCount++] = text.as<const char*>();
    }
  }
  if (doc["crash"].is<JsonObjectConst>()) {
    reply.crashWait = doc["crash"]["wait"] | -1;
    reply.crashEnd = doc["crash"]["end"] | false;
  }
  // The emergency contact for a fall, so the board can text it even without the server.
  if (doc["cr"]["to"].is<const char*>()) {
    strlcpy(st.crashTo, doc["cr"]["to"].as<const char*>(), sizeof st.crashTo);
    strlcpy(st.crashText, doc["cr"]["text"] | "", sizeof st.crashText);
  }
  if (doc["update"]["v"].is<const char*>()) {
    reply.update.version = doc["update"]["v"].as<const char*>();
    reply.update.size = doc["update"]["size"] | 0UL;
    reply.update.signature = doc["update"]["sig"] | "";
  }

  // Settings the server can change without new firmware.
  const long heartbeat = doc["heartbeat"] | 0L;
  if (heartbeat >= 60 && heartbeat <= 7 * 86400L) st.heartbeatS = heartbeat;  // 2 minutes during a signal test
  const long checkIn = doc["checkin"] | -1L;
  if (checkIn == 0 || (checkIn >= 60 && checkIn <= 86400L)) st.checkInS = checkIn;
  const long track = doc["trackInterval"] | 0L;
  if (track >= 10 && track <= 3600) st.trackS = track;
  const long ride = doc["rideInterval"] | 0L;
  if (ride >= 5 && ride <= 600) st.rideS = ride;
  const int sensitivity = doc["sens"] | 0;
  if (sensitivity >= 1 && sensitivity <= 3 && sensitivity != st.sensitivity) {
    st.sensitivity = sensitivity;
    accel.setSensitivity(st.sensitivity);
  }
  if (doc["touch"].is<bool>()) st.reportTouches = doc["touch"].as<bool>();
  if (doc["eco"].is<bool>()) st.lowPower = doc["eco"].as<bool>();
  if (doc["wifi"]["v"].is<uint32_t>()) wifiSaveList(doc["wifi"]["v"].as<uint32_t>(), doc["wifi"]["nets"].as<JsonArrayConst>());
  restartReason = 0;  // told once

  // The server's clock. Times kept in RTC memory move along with it.
  const long serverTime = doc["t"] | 0L;
  if (serverTime > 1600000000L) {
    const time_t shift = static_cast<time_t>(serverTime) - clockNow();
    const timeval tv = {static_cast<time_t>(serverTime), 0};
    settimeofday(&tv, nullptr);
    st.lastMoved += shift;
    st.burstStart += shift;
    if (st.moveStart > 1600000000L) st.moveStart += shift;  // sent as movingSince: the server compares it with its own clock
    if (st.nextAlarmReport > 1600000000L) st.nextAlarmReport += shift;
  }
  st.armed = reply.armed;
  // Armed while the board thought the owner was riding (moved, then armed a moment later): it is
  // parked now. Without this it would only look once a minute and miss someone moving the bike.
  if (reply.armed && !reply.track && st.mode == Mode::Riding) {
    Serial.println("armed: parked");
    st.mode = Mode::Parked;
    takeReference();
  }
  st.touches = 0;
  st.smsResult = 0;
  st.failures = 0;
  st.nextHeartbeat = clockNow() + st.heartbeatS;
  st.nextCheckIn = clockNow() + st.checkInS;  // any report counts as one
  return reply;
}

// SMS the server asks for (the alarm's to the owner, a fall's to the emergency contact). The modem may
// be asleep or off (parked by a known Wi-Fi), and an SMS needs it on the network. The result goes with
// the next report.
void sendSmsTexts(const Reply& reply) {
  const bool ready = modem.powerOn() && modem.waitForNetwork(SIM_APN, SMS_REGISTER_MS);
  bool ok = ready;
  if (ready && reply.smsText.length()) ok = modem.sendSms(reply.smsTo.c_str(), reply.smsText) && ok;
  for (uint8_t i = 0; ready && i < reply.smsCount; i++) ok = modem.sendSms(reply.smsTo.c_str(), reply.smsTexts[i]) && ok;
  st.smsResult = ok ? 1 : 2;
}

// Extra requests in the server's answer.
void followUp(const Reply& reply, bool sentFix) {
  if (reply.smsTo.length()) sendSmsTexts(reply);
  if (reply.locate && !sentFix) {
    Fix fix;
    modem.powerOn();  // asleep or switched off after a check-in: the GPS needs it on
    modem.waitForFix(fix, FIX_TIMEOUT_MS);
    listenForWifi(fix);
    if (fix.valid || nearbyCount) sendReport("locate", &fix, false, NAN);
  }
  // New firmware: the server offers it only while the bike is parked and calm. The board restarts
  // into it, and goes back to this program if the new one cannot reach the server.
  if (reply.update.size && st.mode != Mode::Alarm && (battery.external || battery.pct >= 30)) {
    if (installFirmware(modem, reply.update)) {
      modem.powerOff();
      ESP.restart();
    }
  }
}

void takeReference() {
  st.haveRef = accel.gravity(st.ref);
  accel.consumeMovement();
}

// Takes a GPS fix (the modem looks for the network meanwhile) and reports it.
Reply reportWithFix(const char* reason, float tilt, bool moving) {
  modem.powerOn();
  modem.gpsOn();
  Fix fix;
  modem.waitForFix(fix, FIX_TIMEOUT_MS);
  listenForWifi(fix);
  const Reply reply = sendReport(reason, &fix, moving, tilt);
  if (!reply.ok) {
    st.nextHeartbeat = clockNow() + retryDelayS();
    return reply;
  }
  followUp(reply, fix.valid);
  if (reply.track) {  // e.g. the position shows that an armed bike was moved
    st.mode = Mode::Alarm;
    runAlarm();
  }
  return reply;
}

// A light touch. True when it is the third within two minutes: someone is at the bike.
bool countTouch() {
  const time_t now = clockNow();
  st.touches++;
  if (now - st.burstStart > static_cast<time_t>(TOUCH_BURST_WINDOW_S)) {
    st.burstStart = now;
    st.burstCount = 0;
  }
  if (++st.burstCount < TOUCH_BURST_COUNT) return false;
  st.burstCount = 0;
  return true;
}

// Alarm: a knock after the bike had stood still. The same 3-second look as when it is parked
// decides, so a passing lorry or a gust does not sound the alarm again after the owner has seen
// it. Light touches count only when they keep coming (three within two minutes), as when parked.
// No lean check: the movement the owner has seen may have left the bike leaning differently.
bool knockIsMovement() {
  const MotionResult m = accel.classify(st.ref, false, st.sensitivity);
  accel.consumeMovement();  // the shaking just measured, and the change of sampling rate
  Serial.printf("alarm: knock, %u shaky tenths -> %s\n", static_cast<unsigned>(m.shakyTenths),
                m.kind == MotionKind::Motion ? "movement" : "touch");
  return m.kind == MotionKind::Motion || countTouch();
}

// Alarm: notes movement since the last look. True when real movement starts anew after standing
// still for a few seconds; `moveStart` keeps when, so the server can tell it from what the owner
// has seen. Movement that goes on needs no new look.
bool noteMovement() {
  if (!accel.consumeMovement()) return false;
  const time_t now = clockNow();
  const bool fresh = now - st.lastMoved >= static_cast<time_t>(MOVED_AGAIN_AFTER_S);
  if (fresh && !knockIsMovement()) return false;  // a light touch: the bike still counts as standing
  if (fresh) st.moveStart = now;
  st.lastMoved = clockNow();
  return fresh;
}

// Alarm: reports the position every trackS seconds for as long as the server asks for it.
// Returns once the bike has stood still for a while, so the board sleeps between reports.
// `urgent`: new movement to report before anything else; the position follows in the next report.
void runAlarm(bool urgent) {
  Serial.println("alarm: tracking");
  modem.powerOn();
  modem.gpsOn();
  while (true) {
    const uint32_t started = millis();
    if (noteMovement()) urgent = true;
    Fix fix;
    if (urgent) {
      nearbyCount = 0;
      Serial.println("alarm: moved again, reporting at once");
    } else {
      modem.waitForFix(fix, TRACK_FIX_TIMEOUT_MS);
      listenForWifi(fix);
      noteMovement();  // movement during the GPS wait goes with this report
    }
    urgent = false;
    const bool moving = clockNow() - st.lastMoved < 120;
    battery = readBattery();
    const Reply reply = sendReport("track", &fix, moving, NAN);
    st.nextAlarmReport = clockNow() + ALARM_IDLE_REPORT_S;
    if (reply.ok) {
      followUp(reply, true);
      if (!reply.track) {
        Serial.println("alarm: over");
        if (reply.armed) {
          st.mode = Mode::Parked;
          takeReference();
        } else {
          st.mode = Mode::Riding;
          st.lastMoved = clockNow();
        }
        return;
      }
    }
    if (clockNow() - st.lastMoved >= static_cast<time_t>(ALARM_IDLE_AFTER_S)) return;
    if (!battery.external && battery.mv < CRITICAL_MV) return;
    const bool low = battery.pct >= 0 && battery.pct < 15;
    const uint32_t intervalS = low && st.trackS < 120 ? 120 : st.trackS;
    // Moving again after standing still: report now, so the owner hears of it at once even after
    // pressing "seen". Ongoing movement just goes with the next report.
    while (millis() - started < intervalS * 1000UL) {
      pause(250);
      if (noteMovement()) {
        urgent = true;
        break;
      }
    }
  }
}

// Real movement while parked: ask the server at once, without waiting for GPS.
// Armed: the server starts the alarm and asks for tracking. Disarmed: the owner is riding.
void onMovement(float tilt) {
  Serial.println("movement");
  st.moveStart = clockNow();  // goes as movingSince: the server tells it from movement the owner has seen
  // Asleep on the network the modem wakes in a moment, ready in case the Wi-Fi fails. Switched off
  // (parked by a known Wi-Fi) it would take about 15 s to start, so then the report goes first, over
  // the Wi-Fi, and the modem starts after it (sendReport starts it itself if the Wi-Fi fails).
  if (!st.lastViaWifi) modem.powerOn();  // the GPS waits: the position follows with the tracking reports
  const uint32_t start = millis();
  Reply reply = sendReport("motion", nullptr, true, tilt);
  // No signal. If the bike keeps moving it is leaving the dead spot, so keep trying.
  while (!reply.ok && accel.consumeMovement() && millis() - start < MOVING_RETRY_MS) {
    reply = sendReport("motion", nullptr, true, tilt);
  }
  if (!reply.ok) {
    st.motionPending = true;  // tried again after a while
    return;
  }
  st.motionPending = false;
  st.lastMoved = clockNow();
  followUp(reply, reply.track);
  if (reply.track) {
    st.mode = Mode::Alarm;
    runAlarm();
  } else if (!reply.armed) {
    st.mode = Mode::Riding;
    rideLive();
  }
}

void onTouch(const MotionResult& m) {
  if (countTouch()) {
    onMovement(m.tiltDeg);  // several touches in a short time: someone is at the bike
    return;
  }
  if (st.armed && st.reportTouches) {
    const Reply reply = sendReport("touch", nullptr, false, m.tiltDeg);
    if (reply.ok && reply.track) {
      st.mode = Mode::Alarm;
      runAlarm();
      return;
    }
  }
  // Moved again after the touch (also while the touch was being reported): the same 3-second look
  // decides at once, and a mere jump of the sensor is one more touch. On 2026-11-20 the modem's
  // transmission made the sensor jump twice within seconds, and the second jump alone sounded the alarm.
  if (!accel.consumeMovement()) return;
  const MotionResult again = accel.classify(st.ref, st.haveRef, st.sensitivity);
  accel.consumeMovement();  // the shaking just measured, and the change of sampling rate
  Serial.printf("after the touch: %u shaky tenths, tilt %.1f -> %s\n", static_cast<unsigned>(again.shakyTenths),
                again.tiltDeg, again.kind == MotionKind::Motion ? "movement" : "touch");
  if (again.kind == MotionKind::Motion) {
    st.burstCount = 0;
    onMovement(again.tiltDeg);
  } else if (countTouch()) {
    onMovement(again.tiltDeg);
  }
}

void forgetUpright(const char* why);

void park() {
  Serial.println("parked");
  takeReference();
  st.mode = Mode::Parked;
  forgetUpright("parked");  // someone may open the seat or move the board before the next ride
  reportWithFix("parked", 0.0f, false);
}

void keepRidePoint(const Fix& fix) {
  const uint32_t t = fix.time ? fix.time : static_cast<uint32_t>(clockNow());
  if (ridePointCount && ridePoints[ridePointCount - 1].t == t) return;  // the GPS has nothing newer yet
  if (ridePointCount == MAX_RIDE_POINTS) {  // no signal for a while: the oldest goes
    memmove(ridePoints, ridePoints + 1, sizeof(RidePoint) * (MAX_RIDE_POINTS - 1));
    ridePointCount--;
  }
  ridePoints[ridePointCount++] = {t, fix.lat, fix.lon, fix.speedKmh};
}

// Riding fast: how gravity points when the bike is upright. In a turn the bike leans, but for the
// sensor the push of the turn keeps it "upright", so an average over the ride is that: a plain one
// of the first readings after learning anew, then a running one.
void learnUpright() {
  float g[3];
  if (!accel.sampleGravity(g)) return;
  if (st.haveUpright && st.uprightSamples >= CRASH_LEARN_SAMPLES && Accel::angleDeg(g, st.upright) > CRASH_ODD_DEG) {
    // Far from upright at speed: the bike going down (a fall's slide must not teach it upright: two
    // such readings would take a 70° fall below CRASH_DOWN_DEG), or the board turned in its place.
    // Only the latter goes on.
    if (++st.oddSamples < CRASH_ODD_SAMPLES) return;
    forgetUpright("it turned while riding");
  }
  st.oddSamples = 0;
  if (!st.haveUpright) {
    memcpy(st.upright, g, sizeof st.upright);
    st.haveUpright = true;
    st.uprightSamples = 1;
    return;
  }
  if (st.uprightSamples < 255) st.uprightSamples++;
  const float w = st.uprightSamples < 5 ? 1.0f / st.uprightSamples : 0.2f;
  float m[3];
  for (int k = 0; k < 3; k++) m[k] = st.upright[k] * (1 - w) + g[k] * w;
  const float length = sqrtf(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  if (length < 0.5f) return;
  for (int k = 0; k < 3; k++) st.upright[k] = m[k] / length;
}

// Upright is learned anew at speed, and until then no stop counts as a fall.
void forgetUpright(const char* why) {
  if (st.haveUpright) Serial.printf("fall: learning upright again (%s)\n", why);
  st.haveUpright = false;
  st.uprightSamples = 0;
  st.oddSamples = 0;
  downSince = 0;
}

// Metres between two nearby points (flat-earth approximation, fine for a few hundred metres).
float metresApart(double lat1, double lon1, double lat2, double lon2) {
  const double dy = (lat2 - lat1) * 111320.0;
  const double dx = (lon2 - lon1) * 111320.0 * cos(lat1 * DEG_TO_RAD);
  return static_cast<float>(sqrt(dx * dx + dy * dy));
}

// Riding: a fall. Riding at speed, or right after, the bike goes down on its side (far from upright)
// and stays there for a few seconds. A hard stop, a pothole or the side stand never do all of that.
// Going over only after standing for a while is no fall from riding: on 2026-11-21 the board turned
// 113° in its place a minute after the bike was parked on a pavement, and that sounded as one; at
// the next stop, with upright still half the old one, a second followed (65°).
bool fallen(const Fix& fix) {
  const time_t now = clockNow();
  if (fix.valid && fix.speedKmh >= CRASH_FAST_KMH) {
    st.fastAt = now;
    st.fastKmh = fix.speedKmh;
    learnUpright();
  }
  if (fix.valid && fix.speedKmh >= RIDE_MOVING_KMH) {
    st.standingSince = 0;
    downSince = 0;
    return false;
  }
  // Standing, as the GPS sees it. Far from where it stood, it rolled while the board was busy (a
  // report can take many seconds over a weak 4G), so the standing starts again from here.
  if (fix.valid && (!st.standingSince ||
                    metresApart(st.standLat, st.standLon, fix.lat, fix.lon) > CRASH_ROLLED_M + fix.acc)) {
    st.standingSince = now;
    st.standLat = fix.lat;
    st.standLon = fix.lon;
  }
  if (!st.haveUpright) return false;
  float g[3];
  if (!accel.sampleGravity(g)) return false;
  const float tilt = Accel::angleDeg(g, st.upright);
  if (downSince) {  // it went down in time: only coming up again, or moving off, ends it
    if (tilt < CRASH_DOWN_DEG) {
      downSince = 0;
      return false;
    }
    if (now - downSince < static_cast<time_t>(CRASH_DOWN_S)) return false;
    downSince = 0;
    crashInfo = CrashInfo();
    crashInfo.open = true;
    crashInfo.at = now;
    crashInfo.kmh = st.fastKmh;
    crashInfo.tilt = tilt;
    return true;
  }
  if (st.standingSince && now - st.standingSince > static_cast<time_t>(CRASH_START_S)) {
    // Standing for a while, and the board lies far from upright: it turned in its place, so upright
    // no longer tells how the bike stands. The side stand is only about 10-15°.
    if (tilt > CRASH_MOVED_DEG) forgetUpright("it turned while standing");
    return false;
  }
  const bool recent = st.fastAt && now - st.fastAt <= static_cast<time_t>(CRASH_RECENT_S);
  if (recent && st.uprightSamples >= CRASH_LEARN_SAMPLES && tilt >= CRASH_DOWN_DEG) downSince = now;
  return false;
}

// The board's own SMS to the emergency contact, when the server cannot be reached.
bool textContact(const Fix& last) {
  String text = st.crashText[0] ? String(st.crashText) : String("Πιθανό ατύχημα μηχανής!");
  if (last.valid) text += " maps.google.com/?q=" + String(last.lat, 5) + "," + String(last.lon, 5);
  const bool ok = modem.powerOn() && modem.waitForNetwork(SIM_APN, SMS_REGISTER_MS) && modem.sendSms(st.crashTo, text);
  st.smsResult = ok ? 1 : 2;
  Serial.printf("fall: own SMS %s\n", ok ? "sent" : "failed");
  return ok;
}

// After a fall: the server hears of it at once, alerts the owner and waits for «I'm fine»; then it has
// the board text the emergency contact. The board reports every 15 seconds meanwhile, so the answer
// and the SMS order come quickly, and texts the contact itself if the server stays out of reach. It
// ends when the server says so, when the bike rides on, or after CRASH_WATCH_MAX_S.
void crashWatch(Fix last) {
  Serial.printf("fall: %.0f deg from upright, %.0f km/h before\n", crashInfo.tilt, crashInfo.kmh);
  modem.powerOn();
  modem.gpsOn();
  const time_t start = clockNow();
  time_t heardAt = 0;  // the last report that got through
  bool smsDone = false;
  uint8_t movingFixes = 0;
  while (clockNow() - start < static_cast<time_t>(CRASH_WATCH_MAX_S)) {
    const uint32_t began = millis();
    Fix fix;
    if (modem.readFix(fix) && fix.valid) {
      last = fix;
      movingFixes = fix.speedKmh >= CRASH_RIDE_ON_KMH ? movingFixes + 1 : 0;
      if (movingFixes >= 2) crashInfo.over = true;  // riding on: the rider is fine
    }
    battery = readBattery();
    const Reply reply = sendReport("crash", &last, crashInfo.over, NAN);
    setCpuFrequencyMhz(80);  // sendReport speeds up for the encryption
    if (reply.ok) {
      heardAt = clockNow();
      ridePointCount = 0;  // the ride so far went with it
      Serial.printf("fall: server waits %d s%s\n", reply.crashWait, reply.crashEnd ? ", done" : "");
      if (reply.smsTo.length()) smsDone = true;
      followUp(reply, true);  // the SMS to the contact, when the server sends it
      if (reply.crashEnd || crashInfo.over) break;
    } else if (!smsDone && st.crashTo[0] && clockNow() - start >= static_cast<time_t>(CRASH_LOCAL_SMS_S) &&
               clockNow() - heardAt >= 60) {
      smsDone = textContact(last);
      crashInfo.local = smsDone;  // the server hears of it when it can
    }
    if (crashInfo.over && !reply.ok && clockNow() - heardAt >= 60) break;  // riding on out of reach
    const uint32_t spent = millis() - began;
    if (spent < CRASH_REPORT_S * 1000UL) pause(CRASH_REPORT_S * 1000UL - spent);
  }
  crashInfo.open = false;
  st.fastAt = 0;  // this fall is told: only riding fast again arms the next
}

// Riding, live: a GPS point every 3 seconds and a report with them every 15, so the app can show
// the speed and the route as they happen. Each report also asks the server whether the alarm is
// still off: armed, it stops at once (see sendReport). It returns once the bike has stood still
// for a minute (a long red light, or parked: the minute checks take over, as before), or when the
// battery runs too low.
void rideLive() {
  Serial.println("riding: live");
  modem.powerOn();
  modem.gpsOn();
  ridePointCount = 0;
  nearbyCount = 0;  // no Wi-Fi scan while riding
  Fix last;
  bool moved = true;  // it moved: that is why we are here
  const uint32_t everyMs = (st.rideS >= 5 ? st.rideS : DEFAULT_RIDE_LIVE_S) * 1000UL;
  uint32_t lastSend = millis();
  // Sends the points so far. Armed meanwhile: sendReport parks the board, and the loop ends.
  auto send = [&]() {
    const Reply reply = sendReport("ride", &last, moved, NAN);
    setCpuFrequencyMhz(80);  // sendReport speeds up for the encryption; the GPS needs little
    if (!reply.ok) return;   // the points wait for the next report
    ridePointCount = 0;
    moved = false;
    followUp(reply, true);
    if (reply.track) {
      st.mode = Mode::Alarm;
      runAlarm();
    }
  };
  while (st.mode == Mode::Riding) {
    const uint32_t started = millis();
    if (accel.consumeMovement()) {
      st.lastMoved = clockNow();
      moved = true;
    }
    Fix fix;
    if (modem.readFix(fix) && fix.valid) {
      if (fix.speedKmh >= RIDE_MOVING_KMH) st.lastMoved = clockNow();
      keepRidePoint(fix);
      last = fix;
    }
    if (fallen(fix)) {
      crashWatch(last);
      lastSend = millis();
      continue;  // riding on, or standing still: the loop decides as usual
    }
    const bool still = clockNow() - st.lastMoved >= static_cast<time_t>(RIDING_CHECK_S);
    if (still || millis() - lastSend >= everyMs) {
      lastSend = millis();
      battery = readBattery();
      if (!battery.external && battery.mv < CRITICAL_MV) break;
      // Standing still: the last stretch up to where it stopped, then the minute checks.
      if (!still || ridePointCount) send();
      if (still) break;
      continue;
    }
    const uint32_t spent = millis() - started;
    if (spent < RIDE_POINT_S * 1000UL) pause(RIDE_POINT_S * 1000UL - spent);
  }
  ridePointCount = 0;
}

// Riding: once a minute, see whether the bike moved.
void ridingCheck() {
  const time_t now = clockNow();
  if (!accel.consumeMovement()) {
    if (now - st.lastMoved >= static_cast<time_t>(PARK_AFTER_S)) park();
    return;
  }
  // Moving again after standing for a minute or more: ask the server, it may be armed by now.
  const bool resumed = now - st.lastMoved > static_cast<time_t>(RIDING_CHECK_S + 30);
  st.lastMoved = now;
  if (resumed) {
    onMovement(NAN);  // still disarmed: riding live again
  } else {
    rideLive();
  }
}

// "Still here": a short report without GPS, so the app knows the board is on and how well it is
// connected. It also picks up what waits on the server (a position request, Wi-Fi networks).
void checkIn() {
  const Reply reply = sendReport("checkin", nullptr, false, NAN);
  if (!reply.ok) {
    st.nextCheckIn = clockNow() + max<uint32_t>(st.checkInS, retryDelayS());
    return;
  }
  followUp(reply, false);
  if (reply.track) {
    st.mode = Mode::Alarm;
    runAlarm();
  }
}

void heartbeat() {
  float tilt = NAN;
  if (st.mode == Mode::Parked && st.haveRef) {
    float g[3];
    if (accel.gravity(g)) tilt = Accel::angleDeg(g, st.ref);
    if (!isnan(tilt) && tilt >= Accel::tiltLimit(st.sensitivity)) {
      // Leaning differently than when it was parked, without the sensor waking us: moved quietly.
      onMovement(tilt);
      return;
    }
  }
  reportWithFix("heartbeat", tilt, false);
}

void onAccelWake() {
  if (st.mode == Mode::Alarm) {
    // Asleep between the reports of an alarm that has gone quiet, woken by a knock: the same look as
    // when parked tells whether it is news. A light touch goes with the next report; it sleeps on.
    if (noteMovement()) runAlarm(true);
    return;
  }
  if (st.mode == Mode::Riding) {
    // Movement wakes a riding board only after it has stood still for a minute (see
    // sleepUntilNext): moving off again, or someone taking the bike right after it was armed.
    // Ask the server at once.
    accel.consumeMovement();
    st.lastMoved = clockNow();
    onMovement(NAN);
    return;
  }
  const MotionResult m = accel.classify(st.ref, st.haveRef, st.sensitivity);
  accel.consumeMovement();
  Serial.printf("wake: %u shaky tenths, tilt %.1f -> %s\n", static_cast<unsigned>(m.shakyTenths), m.tiltDeg,
                m.kind == MotionKind::Motion ? "movement" : "touch");
  if (m.kind == MotionKind::Motion) {
    onMovement(m.tiltDeg);
  } else {
    onTouch(m);
  }
}

void onTimer() {
  if (st.mode == Mode::Alarm) {
    runAlarm();
    return;
  }
  if (st.motionPending) {
    onMovement(NAN);
    if (st.motionPending) return;  // still no signal: try again later
  }
  if (st.mode == Mode::Riding) ridingCheck();
  if (st.mode != Mode::Alarm && clockNow() >= st.nextHeartbeat) {
    heartbeat();
  } else if (st.mode == Mode::Parked && st.checkInS && clockNow() >= st.nextCheckIn) {
    checkIn();
  }
}

// The bike's power went away (wires cut, battery taken out) or came back: tell the server at once.
// Armed, it sounds the alarm.
void onPowerChange(bool lost) {
  Serial.println(lost ? "power: lost, on the backup battery" : "power: back");
  const Reply reply = sendReport(lost ? "power_lost" : "power_back", nullptr, false, NAN);
  if (!reply.ok) return;  // every later report carries the power state too
  followUp(reply, false);
  if (reply.track) {
    st.mode = Mode::Alarm;
    runAlarm();
  }
}

void firstStart() {
  Serial.println("first start");
  digitalWrite(LED_PIN, HIGH);  // lit until the first report is done, so you can see it working
  takeReference();
  st.mode = Mode::Parked;
  reportWithFix("boot", 0.0f, false);
  // A new program that could not reach the server goes back to the one that could.
  if (firmwareOnTrial()) revertFirmware();
}

// The modem stays on the network while the board sleeps, so movement is reported within seconds.
// It costs a few milliamps, so it is switched off when the battery runs low, and where there is no
// network (a sleeping modem that keeps searching would empty the battery).
bool keepModemOnNetwork() {
  if (st.failures) return false;
  // Parked where a known Wi-Fi carries the reports (home, the parking spot), the modem has nothing to
  // do, so it goes off. Asleep on a weak 4G network it still transmits now and then, at full power,
  // and on 2026-11-20 that twice made the sensor feel a knock (the second time it sounded the alarm).
  // The Wi-Fi carries an alarm just as fast; the modem starts with the tracking, or if the Wi-Fi fails.
  if (st.mode == Mode::Parked && st.lastViaWifi) return false;
  // «Χαμηλή κατανάλωση»: off while parked anywhere. Movement starts it again; the alarm then takes
  // 15-20 seconds longer over 4G (over a known Wi-Fi it goes as fast as ever).
  if (st.mode == Mode::Parked && st.lowPower) return false;
  if (battery.external) return true;  // on USB, or the charge is unknown
  return battery.mv >= CRITICAL_MV && battery.pct >= KEEP_ON_NETWORK_PCT;
}

[[noreturn]] void sleepFor(uint32_t seconds, bool wakeOnMovement) {
  wifiOff();
  // A modem used this time stays on only if it found the network (no SIM yet: it would keep
  // searching). One not used this time stays as it was.
  if (keepModemOnNetwork() && (!modem.isOn() || modem.onNetwork())) {
    modem.sleep();
  } else {
    modem.powerOff();
  }
  digitalWrite(LED_PIN, LOW);
  accel.clearInterrupt();
  if (wakeOnMovement && accel.ok()) {
    esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(ACCEL_INT_PIN), 1);
  }
  esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(seconds) * 1000000ULL);
  Serial.printf("sleep %u s, mode %d\n", static_cast<unsigned>(seconds), static_cast<int>(st.mode));
  Serial.flush();
  esp_deep_sleep_start();
}

[[noreturn]] void sleepUntilNext() {
  const time_t now = clockNow();
  switch (st.mode) {
    case Mode::Riding:
      // It moves all the time while riding, so no wake-up on movement: a check every minute instead.
      // Once it has stood still for a minute, movement wakes it again, so an alarm armed just after
      // stopping goes off at once rather than at the next check.
      sleepFor(RIDING_CHECK_S, now - st.lastMoved >= static_cast<time_t>(RIDING_CHECK_S));
    case Mode::Alarm: {
      // Every 5 minutes while the bike stands still, also when light touches woke it in between.
      time_t seconds = st.nextAlarmReport - now;
      if (seconds < 1) seconds = 1;
      if (seconds > static_cast<time_t>(ALARM_IDLE_REPORT_S)) seconds = ALARM_IDLE_REPORT_S;
      sleepFor(static_cast<uint32_t>(seconds), true);
    }
    case Mode::Parked:
    default: {
      time_t due = st.nextHeartbeat;
      if (st.checkInS && st.nextCheckIn < due) due = st.nextCheckIn;
      if (st.motionPending && now + static_cast<time_t>(retryDelayS()) < due) due = now + retryDelayS();
      time_t seconds = due - now;
      if (seconds < 1) seconds = 1;
      if (seconds > 24 * 3600) seconds = 24 * 3600;
      // On the bike's power, look every minute whether it is still there (costs no battery).
      if (battery.usb && seconds > static_cast<time_t>(POWER_CHECK_S)) seconds = POWER_CHECK_S;
      sleepFor(static_cast<uint32_t>(seconds), true);
    }
  }
}

}  // namespace

void runOnce() {
  setCpuFrequencyMhz(80);
  Serial.begin(115200);
  startWatchdog();
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  modem.begin();

  const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_UNDEFINED) restartReason = static_cast<uint8_t>(esp_reset_reason());
  // A new program starts afresh: it has to report at once to prove it works (see firstStart).
  const bool fresh = st.magic != STATE_MAGIC || firmwareOnTrial();
  if (fresh) resetState();
  st.boots++;
  battery = readBattery();
  // The bike's power, compared with the last wake. A board that starts afresh has nothing to
  // compare with; the server then compares its report with the one before.
  const bool powerLost = !fresh && st.usbKnown && st.onUsb && !battery.usb;
  const bool powerBack = !fresh && st.usbKnown && !st.onUsb && battery.usb;
  st.onUsb = battery.usb;
  st.usbKnown = true;
  const bool sensor = accel.begin(st.sensitivity);
  Serial.printf("\nmoto-alarm %s: wake %d, mode %d, battery %u mV (%d%%), sensor %s\n", FIRMWARE_VERSION,
                static_cast<int>(cause), static_cast<int>(st.mode), static_cast<unsigned>(battery.mv),
                static_cast<int>(battery.pct), sensor ? "ok" : "MISSING");

  if (!battery.external && battery.mv < CRITICAL_MV) {
    Serial.println("battery too low for the modem");
    sleepFor(CRITICAL_SLEEP_S, false);
  }
  if (fresh) {
    firstStart();
  } else if (cause == ESP_SLEEP_WAKEUP_EXT0) {
    onAccelWake();  // its report says the power state too
  } else if ((powerLost || powerBack) && st.mode != Mode::Alarm) {
    onPowerChange(powerLost);
  } else {
    onTimer();  // the timer, or a restart after a crash: carry on where we were
  }
  sleepUntilNext();
}
