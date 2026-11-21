#include "modem.h"

#include <driver/gpio.h>
#include <math.h>

#include "config.h"
#include "util.h"

namespace {

// "3113.330650" (ddmm.mmmmmm) -> 31.222178 degrees
double nmeaDegrees(const String& value) {
  const double v = value.toDouble();
  const int degrees = static_cast<int>(v / 100);
  return degrees + (v - degrees * 100.0) / 60.0;
}

// GPS date "131117" (ddmmyy) and time "091918.0" (hhmmss.s) -> unix seconds, 0 when missing.
uint32_t unixTime(const String& date, const String& clock) {
  if (date.length() < 6 || clock.length() < 6) return 0;
  const int day = date.substring(0, 2).toInt();
  const int month = date.substring(2, 4).toInt();
  int year = 2000 + date.substring(4, 6).toInt();
  if (day < 1 || day > 31 || month < 1 || month > 12) return 0;
  // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
  year -= month <= 2 ? 1 : 0;
  const int era = year / 400;
  const int yoe = year - era * 400;
  const int doy = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;
  const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const long days = era * 146097L + doe - 719468L;
  const long seconds = clock.substring(0, 2).toInt() * 3600L + clock.substring(2, 4).toInt() * 60L +
                       clock.substring(4, 6).toInt();
  return static_cast<uint32_t>(days * 86400L + seconds);
}

// UTF-8 text -> the hex UCS-2 that AT+CSCS="UCS2" expects ("Σ" -> "03A3").
// Characters outside the basic plane (emoji) are left out.
String toUcs2Hex(const String& text) {
  String out;
  const uint8_t* s = reinterpret_cast<const uint8_t*>(text.c_str());
  const size_t n = text.length();
  size_t i = 0;
  while (i < n) {
    uint32_t cp;
    const uint8_t c = s[i];
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if ((c & 0xE0) == 0xC0 && i + 1 < n) {
      cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
      i += 2;
    } else if ((c & 0xF0) == 0xE0 && i + 2 < n) {
      cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F);
      i += 3;
    } else {
      i += (c & 0xF8) == 0xF0 ? 4 : 1;
      continue;
    }
    char unit[5];
    snprintf(unit, sizeof unit, "%04X", static_cast<unsigned>(cp));
    out += unit;
  }
  return out;
}

}  // namespace

// "2,09,05,00,3113.330650,N,12121.262554,E,131117,091918.0,32.9,0.0,255.0,1.1,0.8,0.7"
// Firmware versions differ in how many satellite counts come first, so the position is found by
// its N/S marker. After it: lon, E/W, date, time, altitude, speed (knots), course, PDOP, HDOP, VDOP.
bool parseGnssInfo(const String& line, Fix& fix) {
  constexpr int MAX_FIELDS = 24;
  String field[MAX_FIELDS];
  int count = 0;
  int from = 0;
  while (count < MAX_FIELDS) {
    const int comma = line.indexOf(',', from);
    field[count] = line.substring(from, comma < 0 ? line.length() : static_cast<unsigned>(comma));
    field[count].trim();
    count++;
    if (comma < 0) break;
    from = comma + 1;
  }
  for (int i = 1; i + 4 < count; i++) {
    if (field[i] != "N" && field[i] != "S") continue;
    if (field[i + 2] != "E" && field[i + 2] != "W") continue;
    double lat = nmeaDegrees(field[i - 1]);
    double lon = nmeaDegrees(field[i + 1]);
    if (lat == 0 && lon == 0) return false;
    if (field[i] == "S") lat = -lat;
    if (field[i + 2] == "W") lon = -lon;
    fix.valid = true;
    fix.lat = lat;
    fix.lon = lon;
    fix.time = unixTime(field[i + 3], field[i + 4]);
    fix.speedKmh = i + 6 < count ? field[i + 6].toFloat() * 1.852f : 0;
    const float hdop = i + 9 < count ? field[i + 9].toFloat() : 0;
    fix.acc = hdop > 0 ? fmaxf(5.0f, hdop * 5.0f) : 25.0f;
    return true;
  }
  return false;
}

void Modem::begin() {
  // The pins were held through deep sleep. Set the same levels first, then let go, so a sleeping
  // modem sees no glitch: flight pin high (radio on), DTR high (may sleep), power key not pressed.
  pinMode(MODEM_PWRKEY_PIN, OUTPUT);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  pinMode(MODEM_FLIGHT_PIN, OUTPUT);
  digitalWrite(MODEM_FLIGHT_PIN, HIGH);
  pinMode(MODEM_DTR_PIN, OUTPUT);
  digitalWrite(MODEM_DTR_PIN, HIGH);
  for (const int pin : {MODEM_PWRKEY_PIN, MODEM_FLIGHT_PIN, MODEM_DTR_PIN}) {
    gpio_hold_dis(static_cast<gpio_num_t>(pin));
  }
  port_.setRxBufferSize(4096);  // room for one 2 KB piece of a firmware download
  port_.begin(115200, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
}

// Sends "AT<cmd>" and waits for a line equal to `expect` (or starting with it, when it starts
// with '+'). Every line received meanwhile is added to `reply`.
bool Modem::command(const String& cmd, uint32_t timeoutMs, const char* expect, String* reply) {
  while (port_.available()) port_.read();  // drop old unsolicited messages
  port_.print("AT");
  port_.print(cmd);
  port_.print("\r");
  return waitFor(expect, timeoutMs, reply);
}

bool Modem::waitFor(const char* expect, uint32_t timeoutMs, String* reply) {
  const bool prefix = expect[0] == '+';
  String line;
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (port_.available()) {
      const char c = static_cast<char>(port_.read());
      if (c == '\r') continue;
      if (c != '\n') {
        line += c;
        continue;
      }
      line.trim();
      if (line.length()) {
        if (reply) {
          *reply += line;
          *reply += '\n';
        }
        if (prefix ? line.startsWith(expect) : line == expect) return true;
        if (line == "ERROR" || line.startsWith("+CME ERROR")) return false;
      }
      line = "";
    }
    esp_task_wdt_reset();
    delay(5);
  }
  return false;
}

// The modem asks for the SMS text with "> " and no line end, so this looks for the '>' itself.
bool Modem::waitForPrompt(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (port_.available()) {
      if (port_.read() == '>') return true;
    }
    esp_task_wdt_reset();
    delay(5);
  }
  return false;
}

bool Modem::answers(uint8_t tries) {
  for (uint8_t i = 0; i < tries; i++) {
    if (command("", 500)) return true;
  }
  return false;
}

void Modem::pressPowerKey(uint32_t ms) {
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
  pause(ms);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
}

// Keeps the levels while the ESP32 sleeps: power key not pressed, radio on, DTR as given
// (high lets a modem with AT+CSCLK=1 sleep).
void Modem::holdPins(bool dtrHigh) {
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  digitalWrite(MODEM_FLIGHT_PIN, HIGH);
  digitalWrite(MODEM_DTR_PIN, dtrHigh ? HIGH : LOW);
  for (const int pin : {MODEM_PWRKEY_PIN, MODEM_FLIGHT_PIN, MODEM_DTR_PIN}) {
    gpio_hold_en(static_cast<gpio_num_t>(pin));
  }
  gpio_deep_sleep_hold_en();
}

bool Modem::powerOn() {
  if (on_) return true;
  digitalWrite(MODEM_FLIGHT_PIN, HIGH);
  digitalWrite(MODEM_DTR_PIN, LOW);  // wakes a sleeping modem and keeps it awake
  pause(100);

  // The modem is often still on: asleep on the network, or after a restart of the ESP32.
  // Pressing the key then would switch it off.
  bool up = answers(3);
  warm_ = up;
  if (warm_) Serial.println("modem: awake, still on the network");
  for (uint8_t attempt = 0; !up && attempt < 2; attempt++) {
    Serial.println("modem: power on");
    pressPowerKey(500);
    up = answers(40);  // it takes up to ~15 s to start
  }
  if (!up) {
    Serial.println("modem: no answer");
    return false;
  }
  on_ = true;
  poweredAt_ = millis();  // the modem looks for the network from now on
  registerMs_ = 0;
  command("E0");       // no echo
  command("+CMEE=2");  // readable errors
  if (!warm_) lteOnly();

  for (uint8_t i = 0; i < 10; i++) {
    String reply;
    command("+CPIN?", 2000, "OK", &reply);
    if (reply.indexOf("READY") >= 0) return true;
    if (reply.indexOf("SIM PIN") >= 0) {
      // Entering a wrong PIN on every wake would lock the SIM, so a PIN is not supported.
      Serial.println("modem: the SIM asks for a PIN. Turn the PIN off in a phone.");
      return true;
    }
    pause(1000);
  }
  Serial.println("modem: SIM not ready");
  return true;
}

// 4G only. On 2G (GSM) the modem transmits in bursts of up to 2 A, and on a battery that drops the
// voltage so far that the board restarts or its protection cuts the power until the switch is
// turned off and on (seen on 2026-11-19). The setting is kept by the modem, so it is set once.
void Modem::lteOnly() {
  String reply;
  command("+CNMP?", 1000, "OK", &reply);
  if (reply.indexOf("+CNMP: 38") >= 0) return;
  if (command("+CNMP=38", 5000)) Serial.println("modem: set to 4G only");
}

void Modem::sleep() {
  if (on_) {
    gpsOff();  // the GPS and its antenna would draw far more than the sleeping modem
    command("+CSCLK=1");  // sleep whenever DTR is high
    on_ = false;
    Serial.println("modem: sleeping on the network");
  }
  // When it was not woken this time it is still asleep (or off), and stays so.
  holdPins(true);
}

uint16_t Modem::readVoltageMv() {
  if (!on_) return 0;
  String reply;
  if (!command("+CBC", 2000, "OK", &reply)) return 0;
  const int at = reply.indexOf("+CBC:");
  if (at < 0) return 0;
  // "+CBC: 3.912V" on the SIM7600; "+CBC: 0,80,3912" (millivolts last) on older modems.
  String value = reply.substring(at + 5, reply.indexOf('\n', at));
  value.trim();
  const int comma = value.lastIndexOf(',');
  if (comma >= 0) return static_cast<uint16_t>(value.substring(comma + 1).toInt());
  return static_cast<uint16_t>(lroundf(value.toFloat() * 1000.0f));
}

void Modem::powerOff() {
  digitalWrite(MODEM_DTR_PIN, LOW);  // a sleeping modem must wake to hear the power-off
  pause(100);
  // After a restart, or when it slept through this wake, `on_` is false although the modem is
  // on, so ask it.
  if (on_ || answers(2)) {
    gpsOff();
    command("+CPOF", 3000);
    bool off = false;
    for (uint8_t i = 0; i < 20 && !off; i++) {
      pause(500);
      off = !answers(1);
    }
    if (!off) {
      Serial.println("modem: forcing power off");
      pressPowerKey(3000);
    }
    on_ = false;
    gps_ = false;
  }
  holdPins(false);
}

bool Modem::registered() {
  for (const char* tag : {"+CEREG", "+CGREG"}) {
    String reply;
    command(String(tag) + "?", 1000, "OK", &reply);
    const int at = reply.indexOf(tag);
    if (at < 0) continue;
    const int comma = reply.indexOf(',', at);
    if (comma < 0) continue;
    const int status = reply.substring(comma + 1).toInt();  // "+CEREG: 0,1": 1 home, 5 roaming
    if (status == 1 || status == 5) return true;
  }
  return false;
}

int Modem::readSignal() {
  String reply;
  if (!command("+CSQ", 1000, "OK", &reply)) return 0;
  const int at = reply.indexOf("+CSQ: ");
  if (at < 0) return 0;
  const int rssi = reply.substring(at + 6).toInt();
  if (rssi == 99) return 0;  // unknown
  return -113 + 2 * rssi;
}

bool Modem::waitForNetwork(const char* apn, uint32_t timeoutMs) {
  if (!on_) return false;
  if (apn && *apn) command(String("+CGDCONT=1,\"IP\",\"") + apn + "\"");
  const uint32_t start = millis();
  while (!registered()) {
    if (millis() - start > timeoutMs) {
      Serial.println("modem: no network");
      return false;
    }
    pause(2000);
  }
  signal_ = readSignal();
  if (!registerMs_) registerMs_ = max<uint32_t>(1, millis() - poweredAt_);
  Serial.printf("modem: on the network after %u s, %d dBm\n", static_cast<unsigned>(registerMs_ / 1000), signal_);
  return true;
}

// "+COPS: 0,0,"COSMOTE",7" gives the operator and the radio (7 = LTE). For LTE,
// "+CPSI: LTE,Online,202-01,0x1F2E,12345678,123,EUTRAN-BAND3,1300,5,5,-10,-95,-65,15"
// gives RSRQ, RSRP, RSSI and SNR as its 11th to 14th fields.
bool Modem::readNetInfo(NetInfo& info) {
  if (!on_) return false;
  String reply;
  if (command("+COPS?", 3000, "OK", &reply)) {
    const int q1 = reply.indexOf('"');
    const int q2 = q1 < 0 ? -1 : reply.indexOf('"', q1 + 1);
    if (q2 > q1) {
      info.op = reply.substring(q1 + 1, q2);
      const int act = reply.substring(q2 + 2).toInt();  // after the closing quote and the comma
      info.tech = act == 7 ? "LTE" : (act == 0 || act == 1 || act == 3) ? "GSM" : (act >= 2 && act <= 6) ? "3G" : "";
    }
  }
  reply = "";
  if (command("+CPSI?", 3000, "OK", &reply)) {
    const int at = reply.indexOf("+CPSI: ");
    const int end = at < 0 ? -1 : reply.indexOf('\n', at);
    const String line = at < 0 ? String() : reply.substring(at + 7, end < 0 ? reply.length() : static_cast<unsigned>(end));
    if (line.startsWith("LTE")) {
      String field[16];
      int count = 0;
      int from = 0;
      while (count < 16) {
        const int comma = line.indexOf(',', from);
        field[count++] = line.substring(from, comma < 0 ? line.length() : static_cast<unsigned>(comma));
        if (comma < 0) break;
        from = comma + 1;
      }
      if (count >= 14) {
        info.rsrq = field[10].toInt();
        info.rsrp = field[11].toInt();
        info.snr = field[13].toInt();
      }
      if (!info.tech.length()) info.tech = "LTE";
    }
  }
  return info.op.length() > 0;
}

// The length in a "+HTTPREAD:" line. The SIM7600 writes "+HTTPREAD: DATA,<n>" (other SIMCom modems
// "+HTTPREAD: <n>"), and a length of 0 at the end. Up to 1.8.5 only "<n>" was read, so " DATA,2048"
// read as 0, the end, and a download over 4G never got a byte: on 2026-11-21 the board asked six
// times for the first part of 1.8.4. -1: no length there.
static long httpReadLength(const String& line) {
  unsigned i = 10;  // after "+HTTPREAD:"
  while (i < line.length() && line[i] == ' ') i++;
  if (line.startsWith("DATA,", i)) i += 5;
  if (i >= line.length() || !isDigit(line[i])) return -1;
  return line.substring(i).toInt();
}

String Modem::readBody(int length) {
  String raw;
  port_.printf("AT+HTTPREAD=0,%d\r", length);
  const uint32_t start = millis();
  while (millis() - start < 10000) {
    while (port_.available()) raw += static_cast<char>(port_.read());
    if (raw.indexOf("+HTTPREAD: 0") >= 0 || raw.indexOf("+HTTPREAD:0") >= 0) break;
    esp_task_wdt_reset();
    delay(10);
  }
  // The "+HTTPREAD" lines without the data, so the server sees how this modem frames an answer.
  String seen;
  for (int at = raw.indexOf("+HTTPREAD"); at >= 0 && seen.length() < 40; at = raw.indexOf("+HTTPREAD", at + 1)) {
    int end = at;
    while (end < static_cast<int>(raw.length()) && end - at < 22 && raw[end] != '\r' && raw[end] != '\n' && raw[end] != '{') end++;
    if (seen.length()) seen += '|';
    seen += raw.substring(at, end);
  }
  strlcpy(framing_, seen.c_str(), sizeof framing_);
  // The body sits between "+HTTPREAD: <len>" and "+HTTPREAD: 0"; the server only sends JSON.
  const int open = raw.indexOf('{');
  const int close = raw.lastIndexOf('}');
  return open >= 0 && close > open ? raw.substring(open, close + 1) : String();
}

// Starts an HTTP(S) session.
bool Modem::openHttp() {
  command("+HTTPTERM", 2000);  // a session left over from an earlier failure
  if (!command("+HTTPINIT", 10000)) {
    command("+CGACT=1,1", 30000);  // some firmware wants the data connection opened first
    if (!command("+HTTPINIT", 10000)) return false;
  }
  // Cloudflare needs SNI. The server certificate is not checked: there is no CA store in the
  // modem. The device key can only post reports, and new firmware must carry our signature.
  command("+CSSLCFG=\"sslversion\",0,3");
  command("+CSSLCFG=\"authmode\",0,0");
  command("+CSSLCFG=\"enableSNI\",0,1");
  return true;
}

int Modem::post(const char* url, const char* bearer, const String& json, String& response) {
  response = "";
  if (!on_ || !openHttp()) return -1;

  int status = -1;
  String reply;
  bool ok = command(String("+HTTPPARA=\"URL\",\"") + url + "\"", 3000) &&
            command("+HTTPPARA=\"CONTENT\",\"application/json\"", 3000) &&
            command(String("+HTTPPARA=\"USERDATA\",\"Authorization: Bearer ") + bearer + "\"", 3000) &&
            command(String("+HTTPDATA=") + json.length() + ",10000", 10000, "DOWNLOAD");
  if (ok) {
    port_.print(json);
    ok = waitFor("OK", 10000) && command("+HTTPACTION=1", 3000) && waitFor("+HTTPACTION:", 120000, &reply);
  }
  if (ok) {
    // "+HTTPACTION: 1,200,57": method, status, body length
    const int at = reply.lastIndexOf("+HTTPACTION:");
    const int c1 = reply.indexOf(',', at);
    const int c2 = c1 < 0 ? -1 : reply.indexOf(',', c1 + 1);
    if (c1 > 0 && c2 > 0) {
      status = reply.substring(c1 + 1, c2).toInt();
      const int length = reply.substring(c2 + 1).toInt();
      if (length > 0 && length < 2048) response = readBody(length);
    }
  }
  command("+HTTPTERM", 2000);
  return status;
}

void Modem::noteLine(const char* what, const String& line) {
  snprintf(note_, sizeof note_, "%s: %s", what, line.length() ? line.c_str() : "-");
}

// Reads up to `want` bytes of the last HTTP answer, from `offset`, without treating them as text:
// a "+HTTPREAD:" line with a length, exactly that many raw bytes, and so on until the length 0.
// Returns how many bytes came (the modem may send fewer than asked), or -1.
int Modem::readBinary(size_t offset, uint8_t* out, size_t want) {
  while (port_.available()) port_.read();
  port_.printf("AT+HTTPREAD=%u,%u\r", static_cast<unsigned>(offset), static_cast<unsigned>(want));
  String line;
  size_t got = 0;
  size_t blockEnd = 0;
  bool inData = false;
  const uint32_t start = millis();
  while (millis() - start < 15000) {
    while (port_.available()) {
      const int c = port_.read();
      if (inData) {
        out[got++] = static_cast<uint8_t>(c);
        if (got == blockEnd) inData = false;
        continue;
      }
      if (c == '\r') continue;
      if (c != '\n') {
        if (line.length() < 40) line += static_cast<char>(c);
        continue;
      }
      line.trim();
      if (line.startsWith("+HTTPREAD:")) {
        const long n = httpReadLength(line);
        if (n == 0) {
          if (got) return static_cast<int>(got);
          noteLine("nothing", line);
          return -1;
        }
        if (n < 0 || got + static_cast<size_t>(n) > want) {
          noteLine("odd", line);
          return -1;
        }
        blockEnd = got + static_cast<size_t>(n);
        inData = true;
      } else if (line == "ERROR" || line.startsWith("+CME ERROR")) {
        noteLine("read", line);
        return -1;
      }
      line = "";
    }
    esp_task_wdt_reset();
    delay(2);
  }
  if (got && !inData) return static_cast<int>(got);  // no end line, but whole blocks
  snprintf(note_, sizeof note_, "slow: %u of %u", static_cast<unsigned>(got), static_cast<unsigned>(want));
  return -1;
}

int Modem::get(const String& url, const char* bearer, uint8_t* out, size_t max) {
  note_[0] = '\0';
  if (!on_ || !openHttp()) {
    strlcpy(note_, on_ ? "no http" : "modem off", sizeof note_);
    return -1;
  }
  int length = -1;
  String reply;
  // Which step failed goes into the note (never the command itself: it holds the device key).
  const char* step = "url";
  bool ok = command(String("+HTTPPARA=\"URL\",\"") + url + "\"", 3000);
  if (ok) {
    step = "key";
    ok = command(String("+HTTPPARA=\"USERDATA\",\"Authorization: Bearer ") + bearer + "\"", 3000);
  }
  if (ok) {
    step = "get";
    ok = command("+HTTPACTION=0", 3000) && waitFor("+HTTPACTION:", 120000, &reply);
  }
  if (!ok) {
    reply.trim();
    const int last = reply.lastIndexOf('\n');
    noteLine(step, last >= 0 ? reply.substring(last + 1) : reply);
  } else {
    // "+HTTPACTION: 0,200,16384": method, status, body length
    const int at = reply.lastIndexOf("+HTTPACTION:");
    const int c1 = reply.indexOf(',', at);
    const int c2 = c1 < 0 ? -1 : reply.indexOf(',', c1 + 1);
    const int status = c1 > 0 && c2 > 0 ? reply.substring(c1 + 1, c2).toInt() : -1;
    const long size = c2 > 0 ? reply.substring(c2 + 1).toInt() : 0;
    if (status == 200 && size > 0 && static_cast<size_t>(size) <= max) {
      constexpr size_t PIECE = 2048;
      size_t done = 0;
      while (done < static_cast<size_t>(size)) {
        const size_t piece = static_cast<size_t>(size) - done < PIECE ? static_cast<size_t>(size) - done : PIECE;
        const int n = readBinary(done, out + done, piece);
        if (n <= 0) break;
        done += static_cast<size_t>(n);
      }
      if (done == static_cast<size_t>(size)) {
        length = static_cast<int>(size);
      } else if (!note_[0]) {
        snprintf(note_, sizeof note_, "short: %u of %ld", static_cast<unsigned>(done), size);
      }
    } else {
      snprintf(note_, sizeof note_, "answer %d, %ld bytes", status, size);
    }
  }
  command("+HTTPTERM", 2000);
  return length;
}

void Modem::gpsOn() {
  if (!on_ || gps_) return;
  command("+CVAUXV=2800");  // power for the active GPS antenna (LilyGO's "AUXVDD")
  command("+CVAUXS=1");
  String reply;
  command("+CGPS?", 2000, "OK", &reply);
  gps_ = reply.indexOf("+CGPS: 1") >= 0 || command("+CGPS=1,1", 5000);
}

void Modem::gpsOff() {
  if (!on_ || !gps_) return;
  if (command("+CGPS=0", 5000)) waitFor("+CGPS: 0", 5000);
  command("+CVAUXS=0");
  gps_ = false;
}

bool Modem::readFix(Fix& fix) {
  String reply;
  if (!command("+CGNSSINFO", 2000, "OK", &reply)) return false;
  const int at = reply.indexOf("+CGNSSINFO:");
  if (at < 0) return false;
  const int end = reply.indexOf('\n', at);
  return parseGnssInfo(reply.substring(at + 11, end < 0 ? reply.length() : static_cast<unsigned>(end)), fix);
}

bool Modem::waitForFix(Fix& fix, uint32_t timeoutMs) {
  gpsOn();
  Fix best;
  const uint32_t start = millis();
  while (gps_ && millis() - start < timeoutMs) {
    Fix current;
    if (readFix(current) && (!best.valid || current.acc < best.acc)) best = current;
    // Good enough, or a usable one after most of the wait.
    if (best.valid && (best.acc <= 15 || millis() - start > timeoutMs * 2 / 3)) break;
    pause(2000);
  }
  fix = best;
  if (best.valid) Serial.printf("gps: %.6f, %.6f (~%.0f m)\n", best.lat, best.lon, best.acc);
  return best.valid;
}

// Text mode with UCS-2, so Greek arrives intact: number and text both go as hex UCS-2.
bool Modem::sendSms(const char* number, const String& text) {
  if (!on_ || !number || !*number) return false;
  Serial.printf("modem: SMS to %s\n", number);
  bool ok = command("+CMGF=1", 2000) && command("+CSCS=\"UCS2\"", 2000) && command("+CSMP=17,167,0,8", 2000);
  if (ok) {
    while (port_.available()) port_.read();
    port_.print("AT+CMGS=\"");
    port_.print(toUcs2Hex(String(number)));
    port_.print("\"\r");
    ok = waitForPrompt(10000);
  }
  if (ok) {
    port_.print(toUcs2Hex(text));
    port_.write(static_cast<uint8_t>(0x1A));  // Ctrl-Z: send
    ok = waitFor("+CMGS:", 60000);
    waitFor("OK", 2000);
  } else {
    port_.write(static_cast<uint8_t>(0x1B));  // Esc: drop a half-written message
  }
  command("+CSCS=\"IRA\"", 2000);  // back to plain text for every other command
  Serial.println(ok ? "modem: SMS sent" : "modem: SMS failed");
  return ok;
}
