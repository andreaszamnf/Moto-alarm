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

RTC_DATA_ATTR char lastSsid[33] = "";  // the one that worked last time: tried first, without a scan
bool tried = false;                    // once per wake

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

bool join(int index, uint32_t timeoutMs, int32_t channel = 0, const uint8_t* bssid = nullptr) {
  WiFi.begin(networks[index].ssid.c_str(), networks[index].password.c_str(), channel, bssid);
  const uint32_t start = millis();
  while (!wifiConnected() && millis() - start < timeoutMs) pause(50);
  if (!wifiConnected()) {
    WiFi.disconnect(false, true);
    return false;
  }
  strlcpy(lastSsid, networks[index].ssid.c_str(), sizeof lastSsid);
  Serial.printf("wifi: network %d of %d connected after %u ms, %d dBm\n", index + 1, networkCount,
                static_cast<unsigned>(millis() - start), static_cast<int>(WiFi.RSSI()));
  return true;
}

// Looks around once (about 1.5 s) and joins the strongest known network in reach.
bool scanAndJoin() {
  const int16_t found = WiFi.scanNetworks(false, false, false, 100);
  int best[MAX_NETWORKS];  // scan entry of each known network, -1 when it is not in reach
  for (int n = 0; n < networkCount; n++) best[n] = -1;
  for (int16_t i = 0; i < found; i++) {
    const String ssid = WiFi.SSID(i);
    for (int n = 0; n < networkCount; n++) {
      if (ssid == networks[n].ssid && (best[n] < 0 || WiFi.RSSI(i) > WiFi.RSSI(best[n]))) best[n] = i;
    }
  }
  bool joined = false;
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
    joined = join(pick, WIFI_CONNECT_MS, WiFi.channel(entry), bssid);
  }
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
  WiFi.persistent(false);  // the networks live in the program and in our own flash keys
  WiFi.mode(WIFI_STA);
  // Usually the bike stands where it stood last time: that network straight away.
  for (int n = 0; n < networkCount; n++) {
    if (networks[n].ssid == lastSsid) {
      if (join(n, WIFI_QUICK_CONNECT_MS)) return true;
      break;
    }
  }
  if (scanAndJoin()) return true;
  Serial.println("wifi: no known network here, using 4G");
  wifiOff();
  return false;
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
  return status > 0 ? status : -1;
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
