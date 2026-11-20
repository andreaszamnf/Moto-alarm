#include "wifiscan.h"

#include <WiFi.h>

namespace {

// Phone hotspots and random addresses move around, so they say nothing about where the bike is.
// A network name ending in "_nomap" asks not to be used for maps.
bool usable(const uint8_t* mac, const String& ssid) {
  if (!mac || (mac[0] & 0x03)) return false;  // multicast or locally administered
  return !ssid.endsWith("_nomap");
}

}  // namespace

String macText(const uint8_t* mac) {
  char text[18];
  snprintf(text, sizeof text, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(text);
}

uint8_t scanAccessPoints(AccessPoint* out, uint8_t max) {
  if (max == 0) return 0;
  const bool connected = WiFi.status() == WL_CONNECTED;  // reporting over Wi-Fi: stay connected
  if (!connected) WiFi.mode(WIFI_STA);
  // Wait for the result, include hidden networks, ask actively, 120 ms on each channel.
  const int16_t found = WiFi.scanNetworks(false, true, false, 120);
  uint8_t count = 0;
  for (int16_t i = 0; i < found; i++) {
    const uint8_t* mac = WiFi.BSSID(i);
    if (!usable(mac, WiFi.SSID(i))) continue;
    const int8_t rssi = static_cast<int8_t>(WiFi.RSSI(i));
    // Keep the list sorted, strongest first, with at most `max` entries.
    uint8_t at = count;
    while (at > 0 && out[at - 1].rssi < rssi) at--;
    if (at >= max) continue;
    for (uint8_t j = count < max ? count : max - 1; j > at; j--) out[j] = out[j - 1];
    memcpy(out[at].bssid, mac, 6);
    out[at].rssi = rssi;
    if (count < max) count++;
  }
  WiFi.scanDelete();
  if (!connected) WiFi.mode(WIFI_OFF);
  return count;
}
