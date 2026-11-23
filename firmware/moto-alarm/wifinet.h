// Reports over a known Wi-Fi network (home, a neighbour's by the parking spot) instead of 4G:
// faster, cheaper on the battery, and it works where 4G does not reach. The networks and their
// passwords come from wifi.h, made by  node tools/set-wifi.mjs  and kept out of git. Without
// wifi.h everything goes over 4G.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

bool wifiConfigured();
// Joins a known network: the ones that worked the last two times first, by name, else the strongest
// known one a scan finds. Tries once per wake: where none is in reach, the next try goes straight to 4G.
bool wifiConnect();
bool wifiConnected();
// POSTs JSON over HTTPS. Returns the HTTP status, or -1 when it did not get through.
int wifiPost(const char* url, const char* bearer, const String& json, String& response);

// Why reporting over Wi-Fi did not work this wake (1.8.1). It goes with the 4G report, so the app can
// say it: no known network in reach, the password refused, joined without an address, or joined
// but the server not reached (no internet, or a login page answering in its place).
enum class WifiFail : uint8_t { None, NotFound, Password, Join, NoAddress, NoServer };
struct WifiAttempt {
  WifiFail fail = WifiFail::None;
  String ssid;        // the known network it tried (the strongest one in reach)
  int8_t rssi = 0;    // that network's signal in the scan, dBm
  int16_t code = 0;   // the Wi-Fi disconnect reason, or the HTTP status or error for NoServer
  int16_t seen = -1;  // networks the scan found in all, -1 when it did not scan
  // The networks kept from earlier wakes, tried by name before the scan (1.8.7): the driver's reason
  // for each that did not join (201 = not found, 0 = no answer in time), -1 when not tried.
  int16_t keptReason[2] = {-1, -1};
};
const WifiAttempt& wifiLastAttempt();
const char* wifiFailName(WifiFail fail);  // as the report says it: "notfound", "password", ...
// Something other than our server answered over Wi-Fi (a login page): the network is no use here,
// so it is dropped for this wake and the report goes over 4G.
void wifiNoServer(int code);
// GETs a binary answer into `out` (at most `max` bytes). Returns its length, or -1.
int wifiGet(const String& url, const char* bearer, uint8_t* out, size_t max);
void wifiOff();
String wifiName();  // the network it is connected to, "" when none
int wifiRssi();     // its signal in dBm, 0 when not connected
// Networks added in the app arrive with a server reply as {"v": version, "nets": [[ssid, password], ...]}
// and are kept in flash. The board sends the version it has, so the list comes only when it changed.
uint32_t wifiListVersion();
void wifiSaveList(uint32_t version, JsonArrayConst list);
