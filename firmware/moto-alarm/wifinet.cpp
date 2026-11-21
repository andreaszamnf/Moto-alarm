#include "wifinet.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_attr.h>

#include "config.h"
#include "util.h"

#if __has_include("wifi.h")
#include "wifi.h"
#endif

namespace {

struct BuiltIn {
  const char* ssid;
  const char* password;
};

// wifi.h lists networks as WIFI_NETWORKS {{"name", "password"}, ...}; older ones had one network
// as WIFI_SSID / WIFI_PASSWORD. The ones added in the app come from the server and are kept in
// flash (Preferences "wifi").
#if defined(WIFI_NETWORKS)
const BuiltIn BUILT_IN[] = WIFI_NETWORKS;
constexpr int BUILT_IN_COUNT = sizeof BUILT_IN / sizeof BUILT_IN[0];
#elif defined(WIFI_SSID)
const BuiltIn BUILT_IN[] = {{WIFI_SSID, WIFI_PASSWORD}};
constexpr int BUILT_IN_COUNT = 1;
#else
const BuiltIn BUILT_IN[] = {{"", ""}};
constexpr int BUILT_IN_COUNT = 0;
#endif

constexpr int MAX_FROM_APP = 5;
constexpr int MAX_NETWORKS = (BUILT_IN_COUNT > 0 ? BUILT_IN_COUNT : 0) + MAX_FROM_APP;

struct Network {
  String ssid;
  String password;
};

Network networks[MAX_NETWORKS];
int networkCount = 0;
bool loaded = false;

// The network that worked last time: tried first, straight away without a scan. The driver then
// looks for it more patiently than our quick scan, which often misses a weak network (the
// neighbour's by the parking spot). Kept in flash too (1.8.3): a restart (an update, a brownout)
// clears this memory, and the board then went over 4G until a scan happened to see the network.
RTC_DATA_ATTR char lastSsid[33] = "";
RTC_DATA_ATTR bool lastInFlash = false;  // lastSsid is also in flash
bool tried = false;                      // once per wake
WifiAttempt attempt;                   // what went wrong this wake, for the 4G report

// Filled in by the Wi-Fi driver's events while joining (they come from another task).
volatile uint8_t lastReason = 0;  // why the network turned it away
volatile bool associated = false;  // joined the network (password accepted), maybe without an address yet
bool watching = false;

void watchEvents() {
  if (watching) return;
  watching = true;
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    lastReason = info.wifi_sta_disconnected.reason;
    associated = false;
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t) { associated = true; }, ARDUINO_EVENT_WIFI_STA_CONNECTED);
}

// A wrong password ends the key exchange with one of these; anything else is mostly a weak signal
// or a router that turned it away.
WifiFail failOf(uint8_t reason, bool joined) {
  if (joined) return WifiFail::NoAddress;  // in, but the router gave no address in time
  switch (reason) {
    case WIFI_REASON_MIC_FAILURE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
      return WifiFail::Password;
    default:
      return WifiFail::Join;
  }
}

struct JoinResult {
  WifiFail fail;
  uint8_t reason;
};

void add(const String& ssid, const String& password) {
  if (!ssid.length()) return;
  for (int i = 0; i < networkCount; i++) {
    if (networks[i].ssid == ssid) {
      networks[i].password = password;  // the app's password wins over the built-in one
      return;
    }
  }
  if (networkCount < MAX_NETWORKS) networks[networkCount++] = {ssid, password};
}

void load() {
  if (loaded) return;
  loaded = true;
  for (int i = 0; i < BUILT_IN_COUNT; i++) add(BUILT_IN[i].ssid, BUILT_IN[i].password);
  Preferences prefs;
  if (prefs.begin("wifi", true)) {
    const int n = prefs.getUChar("n", 0);
    for (int i = 0; i < n && i < MAX_FROM_APP; i++) {
      add(prefs.getString((String("s") + i).c_str(), ""), prefs.getString((String("p") + i).c_str(), ""));
    }
    prefs.end();
  }
}

// After a restart the copy in RTC memory is gone: the one in flash stands in.
void loadLast() {
  if (lastSsid[0]) return;
  Preferences prefs;
  if (!prefs.begin("wifilast", true)) return;  // nothing kept yet
  prefs.getString("ssid", lastSsid, sizeof lastSsid);
  prefs.end();
  lastInFlash = lastSsid[0] != '\0';
}

// Flash is written only when the network changes, not at every report.
void rememberLast(const String& ssid) {
  if (lastInFlash && ssid == lastSsid) return;
  strlcpy(lastSsid, ssid.c_str(), sizeof lastSsid);
  Preferences prefs;
  if (!prefs.begin("wifilast", false)) return;
  prefs.putString("ssid", lastSsid);
  prefs.end();
  lastInFlash = true;
}

JoinResult join(int index, uint32_t timeoutMs, int32_t channel = 0, const uint8_t* bssid = nullptr) {
  watchEvents();
  lastReason = 0;
  associated = false;
  WiFi.begin(networks[index].ssid.c_str(), networks[index].password.c_str(), channel, bssid);
  const uint32_t start = millis();
  while (!wifiConnected() && millis() - start < timeoutMs) pause(50);
  if (!wifiConnected()) {
    // Read before disconnecting: that brings an event of its own.
    const JoinResult result{failOf(lastReason, associated), lastReason};
    WiFi.disconnect(false, true);
    Serial.printf("wifi: network %d of %d failed, %s (reason %u)\n", index + 1, networkCount,
                  wifiFailName(result.fail), static_cast<unsigned>(result.reason));
    return result;
  }
  rememberLast(networks[index].ssid);
  Serial.printf("wifi: network %d of %d connected after %u ms, %d dBm\n", index + 1, networkCount,
                static_cast<unsigned>(millis() - start), static_cast<int>(WiFi.RSSI()));
  return {WifiFail::None, 0};
}

// Looks around once and joins the strongest known network in reach. When none works, `attempt` says
// why, about the strongest known one (it says the most). It listens on each channel for 300 ms
// (about 4 s in all), long enough to hear a network's beacon two or three times: the quick scan of
// up to 1.8.3 (100 ms, asking instead of listening) kept missing the neighbour's weak Wi-Fi at the
// parking spot, and the board went over 4G there (2026-11-21).
bool scanAndJoin() {
  const int16_t found = WiFi.scanNetworks(false, false, true, 300);
  attempt.seen = found > 0 ? found : 0;
  int best[MAX_NETWORKS];  // scan entry of each known network, -1 when it is not in reach
  for (int n = 0; n < networkCount; n++) best[n] = -1;
  for (int16_t i = 0; i < found; i++) {
    const String ssid = WiFi.SSID(i);
    for (int n = 0; n < networkCount; n++) {
      if (ssid == networks[n].ssid && (best[n] < 0 || WiFi.RSSI(i) > WiFi.RSSI(best[n]))) best[n] = i;
    }
  }
  bool joined = false;
  bool triedOne = false;
  while (!joined) {
    int pick = -1;  // the strongest one not tried yet
    for (int n = 0; n < networkCount; n++) {
      if (best[n] >= 0 && (pick < 0 || WiFi.RSSI(best[n]) > WiFi.RSSI(best[pick]))) pick = n;
    }
    if (pick < 0) break;
    const int entry = best[pick];
    best[pick] = -1;
    uint8_t bssid[6];
    memcpy(bssid, WiFi.BSSID(entry), 6);
    const int8_t rssi = static_cast<int8_t>(WiFi.RSSI(entry));
    const JoinResult result = join(pick, WIFI_CONNECT_MS, WiFi.channel(entry), bssid);
    joined = result.fail == WifiFail::None;
    if (!joined && !triedOne) {
      attempt.fail = result.fail;
      attempt.ssid = networks[pick].ssid;
      attempt.rssi = rssi;
      attempt.code = result.reason;
    }
    triedOne = true;
  }
  if (!triedOne) attempt.fail = WifiFail::NotFound;
  WiFi.scanDelete();
  return joined;
}

}  // namespace

bool wifiConfigured() {
  load();
  return networkCount > 0;
}

bool wifiConnected() { return WiFi.status() == WL_CONNECTED; }

bool wifiConnect() {
  if (!wifiConfigured()) return false;
  if (wifiConnected()) return true;
  if (tried) return false;
  tried = true;
  attempt = WifiAttempt();
  WiFi.persistent(false);  // the networks live in the program and in our own flash keys
  WiFi.mode(WIFI_STA);
  // Usually the bike stands where it stood last time: that network straight away.
  loadLast();
  for (int n = 0; n < networkCount; n++) {
    if (networks[n].ssid == lastSsid) {
      if (join(n, WIFI_QUICK_CONNECT_MS).fail == WifiFail::None) return true;
      break;
    }
  }
  if (scanAndJoin()) {
    attempt = WifiAttempt();
    return true;
  }
  Serial.printf("wifi: %s, using 4G\n", wifiFailName(attempt.fail));
  wifiOff();
  return false;
}

const WifiAttempt& wifiLastAttempt() { return attempt; }

const char* wifiFailName(WifiFail fail) {
  switch (fail) {
    case WifiFail::NotFound: return "notfound";
    case WifiFail::Password: return "password";
    case WifiFail::Join: return "join";
    case WifiFail::NoAddress: return "noip";
    case WifiFail::NoServer: return "noserver";
    default: return "none";
  }
}

void wifiNoServer(int code) {
  attempt.fail = WifiFail::NoServer;
  attempt.ssid = WiFi.SSID();
  attempt.rssi = static_cast<int8_t>(WiFi.RSSI());
  attempt.code = static_cast<int16_t>(code);
  attempt.seen = -1;
  Serial.printf("wifi: joined but the server did not answer (%d), using 4G\n", code);
  wifiOff();  // tried stays set: the rest of this wake goes straight to 4G
}

String wifiName() { return wifiConnected() ? WiFi.SSID() : String(); }

int wifiRssi() { return wifiConnected() ? static_cast<int>(WiFi.RSSI()) : 0; }

uint32_t wifiListVersion() {
  Preferences prefs;
  if (!prefs.begin("wifi", true)) return 0;
  const uint32_t v = prefs.getULong("v", 0);
  prefs.end();
  return v;
}

void wifiSaveList(uint32_t version, JsonArrayConst list) {
  if (version == 0 || version == wifiListVersion()) return;
  Preferences prefs;
  if (!prefs.begin("wifi", false)) return;
  prefs.clear();
  uint8_t n = 0;
  for (JsonArrayConst net : list) {
    if (n >= MAX_FROM_APP) break;
    const char* ssid = net[0] | "";
    const char* password = net[1] | "";
    if (!*ssid || strlen(ssid) > 32 || strlen(password) > 63) continue;
    prefs.putString((String("s") + n).c_str(), ssid);
    prefs.putString((String("p") + n).c_str(), password);
    n++;
  }
  prefs.putUChar("n", n);
  prefs.putULong("v", version);
  prefs.end();
  loaded = false;  // read again next time
  networkCount = 0;
  Serial.printf("wifi: %u networks from the app saved (list %u)\n", static_cast<unsigned>(n), static_cast<unsigned>(version));
}


// The server certificate is not checked, as with the modem: the device key can only post reports,
// and new firmware must carry our signature.
int wifiPost(const char* url, const char* bearer, const String& json, String& response) {
  response = "";
  if (!wifiConnect()) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  if (!http.begin(client, url)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + bearer);
  const uint32_t start = millis();
  const int status = http.POST(json);
  if (status > 0) response = http.getString();
  http.end();
  Serial.printf("wifi: post took %u ms\n", static_cast<unsigned>(millis() - start));
  if (status <= 0) {
    wifiNoServer(status);  // joined, but no way out to the server (no internet)
    return -1;
  }
  return status;
}

int wifiGet(const String& url, const char* bearer, uint8_t* out, size_t max) {
  if (!wifiConnect()) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  if (!http.begin(client, url)) return -1;
  http.addHeader("Authorization", String("Bearer ") + bearer);
  const int status = http.GET();
  const int size = http.getSize();
  int length = -1;
  if (status == 200 && size > 0 && static_cast<size_t>(size) <= max) {
    WiFiClient* stream = http.getStreamPtr();
    size_t got = 0;
    uint32_t last = millis();
    while (got < static_cast<size_t>(size) && millis() - last < 15000) {
      const int n = stream->read(out + got, size - got);
      if (n > 0) {
        got += n;
        last = millis();
      } else {
        pause(5);
      }
    }
    if (got == static_cast<size_t>(size)) length = size;
  }
  http.end();
  return length;
}

void wifiOff() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}
