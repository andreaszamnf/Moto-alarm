// Reports over a known Wi-Fi network (home, a neighbour's by the parking spot) instead of 4G:
// faster, cheaper on the battery, and it works where 4G does not reach. The networks and their
// passwords come from wifi.h, made by  node tools/set-wifi.mjs  and kept out of git. Without
// wifi.h everything goes over 4G.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

bool wifiConfigured();
// Joins a known network: the one that worked last time first, else the strongest known one a
// scan finds. Tries once per wake: where none is in reach, the next try goes straight to 4G.
bool wifiConnect();
bool wifiConnected();
// POSTs JSON over HTTPS. Returns the HTTP status, or -1 when it did not get through.
int wifiPost(const char* url, const char* bearer, const String& json, String& response);
// GETs a binary answer into `out` (at most `max` bytes). Returns its length, or -1.
int wifiGet(const String& url, const char* bearer, uint8_t* out, size_t max);
void wifiOff();
String wifiName();  // the network it is connected to, "" when none
int wifiRssi();     // its signal in dBm, 0 when not connected
// Networks added in the app arrive with a server reply as {"v": version, "nets": [[ssid, password], ...]}
// and are kept in flash. The board sends the version it has, so the list comes only when it changed.
uint32_t wifiListVersion();
void wifiSaveList(uint32_t version, JsonArrayConst list);
