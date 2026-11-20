// Motorcycle alarm: LilyGO T-SIM7600E-L1C (ESP32 + SIM7600 4G + GPS) and an ADXL345.
// Everything happens in app.cpp. Every wake-up ends in deep sleep, so loop() never runs.
#include "app.h"

void setup() { runOnce(); }

void loop() {}
