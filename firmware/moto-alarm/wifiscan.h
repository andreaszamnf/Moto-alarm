// Nearby Wi-Fi access points, for a rough position when the GPS cannot see the sky (a garage, a van).
// The board does not connect to any of them: it only listens for their addresses.
#pragma once
#include <Arduino.h>

struct AccessPoint {
  uint8_t bssid[6];
  int8_t rssi;  // dBm
};

constexpr uint8_t MAX_ACCESS_POINTS = 10;

// Listens on every channel (about 2 seconds), keeps the strongest access points worth sending and
// switches the Wi-Fi radio off again. Returns how many it kept.
uint8_t scanAccessPoints(AccessPoint* out, uint8_t max);

// "aa:bb:cc:dd:ee:ff"
String macText(const uint8_t* mac);
