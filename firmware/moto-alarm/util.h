// Small helpers shared by the modules.
#pragma once
#include <Arduino.h>
#include <esp_task_wdt.h>

// delay() that keeps the watchdog fed. The watchdog restarts the board only if the code hangs.
inline void pause(uint32_t ms) {
  const uint32_t start = millis();
  while (millis() - start < ms) {
    esp_task_wdt_reset();
    delay(10);
  }
}
