// Battery: voltage from the board's divider on GPIO35, and a rough charge for an 18650 cell.
#pragma once
#include <Arduino.h>

#include "config.h"

struct Battery {
  uint16_t mv = 0;
  int8_t pct = -1;        // -1 when unknown
  bool external = false;   // the board's divider reads 0 V (on USB, says LilyGO): charge unknown
  bool fromModem = false;  // the charge comes from the modem's voltage reading instead
  uint16_t adcMv = 0;      // what the board's divider gave, sent along for diagnosis
  bool usb = false;        // powered over USB, i.e. by the bike's 5 V converter (kept even when
                           // the modem's voltage stands in for the charge)
};

// Resting voltage to charge, roughly, for a Li-ion cell.
inline int8_t batteryPercent(uint16_t mv) {
  static const uint16_t MV[] = {3300, 3500, 3600, 3650, 3700, 3750, 3800, 3900, 4000, 4100, 4200};
  static const uint8_t PCT[] = {0, 3, 6, 10, 18, 32, 45, 64, 78, 90, 100};
  if (mv <= MV[0]) return 0;
  for (size_t i = 1; i < sizeof MV / sizeof MV[0]; i++) {
    if (mv < MV[i]) {
      return PCT[i - 1] + (PCT[i] - PCT[i - 1]) * (mv - MV[i - 1]) / (MV[i] - MV[i - 1]);
    }
  }
  return 100;
}

// Read before the modem is switched on: under load the voltage dips and the charge looks lower.
inline Battery readBattery() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogReadMilliVolts(BATTERY_ADC_PIN);
    delay(2);
  }
  Battery b;
  b.mv = sum / 16 * 2;  // the board halves the voltage before the ADC
  b.external = b.mv < 2500;
  b.pct = b.external ? -1 : batteryPercent(b.mv);
  b.adcMv = b.mv;
  b.usb = b.external;  // LilyGO: with USB connected the divider is cut off and reads ~0
  return b;
}

// When the divider reads nothing, the modem's supply voltage (AT+CBC) stands in. On battery
// alone that is the cell's voltage, a little lower while the modem is busy.
inline void useModemVoltage(Battery& b, uint16_t modemMv) {
  if (!b.external || modemMv < 3000 || modemMv > 4500) return;
  b.mv = modemMv;
  b.pct = batteryPercent(modemMv + 50);  // roughly what the modem's load takes off
  b.external = false;
  b.fromModem = true;
}
