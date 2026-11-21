// Pins and settings for the LilyGO T-SIM7600E-L1C (T-SIM7600X family) with an ADXL345.
#pragma once
#include <Arduino.h>

#define FIRMWARE_VERSION "1.8.6"

// Modem pins, as in LilyGO's utilities.h for LILYGO_SIM7600X.
constexpr int MODEM_RX_PIN = 26;      // the ESP32 receives from the modem here
constexpr int MODEM_TX_PIN = 27;      // the ESP32 sends to the modem here
constexpr int MODEM_PWRKEY_PIN = 4;
constexpr int MODEM_FLIGHT_PIN = 25;  // HIGH: radio on, LOW: flight mode
constexpr int MODEM_DTR_PIN = 32;     // LOW keeps the modem awake
constexpr int BATTERY_ADC_PIN = 35;   // battery voltage through a 1:2 divider
constexpr int LED_PIN = 12;

// ADXL345 on the board's expansion header.
constexpr int I2C_SDA_PIN = 21;
constexpr int I2C_SCL_PIN = 22;
constexpr int ACCEL_INT_PIN = 39;  // ADXL345 INT1. An RTC pin, so it can wake the ESP32.

// Timing. The heartbeat and the tracking interval are replaced by what the server sends.
constexpr uint32_t DEFAULT_HEARTBEAT_S = 6 * 3600;
constexpr uint32_t DEFAULT_TRACK_S = 30;
constexpr uint8_t DEFAULT_SENSITIVITY = 2;        // 1 low, 2 medium, 3 high
constexpr uint32_t RIDING_CHECK_S = 60;           // riding: how often to look for stillness
constexpr uint32_t PARK_AFTER_S = 3 * 60;         // riding: still this long means parked
constexpr uint32_t DEFAULT_RIDE_LIVE_S = 15;      // riding: a live report this often (the server can change it)
constexpr uint32_t RIDE_POINT_S = 3;              // riding: a GPS point this often, sent with the next report
constexpr uint8_t MAX_RIDE_POINTS = 40;           // points kept while reports do not get through
constexpr float RIDE_MOVING_KMH = 5;              // riding: GPS speed that counts as moving
constexpr uint32_t ALARM_IDLE_AFTER_S = 10 * 60;  // alarm: still this long, report less often
constexpr uint32_t ALARM_IDLE_REPORT_S = 5 * 60;
constexpr uint32_t POWER_CHECK_S = 60;            // parked on the bike's power: look this often whether it is still there
constexpr uint32_t MOVED_AGAIN_AFTER_S = 5;       // alarm: still this long, then moved = new movement, reported at once
constexpr uint32_t TOUCH_BURST_WINDOW_S = 120;    // this many light touches within this window
constexpr uint8_t TOUCH_BURST_COUNT = 3;          // count as real movement
// A fall while riding (1.8.0): soon after moving at speed the bike lies on its side and stays still.
constexpr float CRASH_FAST_KMH = 20;              // it moved at least this fast ...
constexpr uint32_t CRASH_RECENT_S = 180;          // ... at most this long before
constexpr float CRASH_DOWN_DEG = 50;              // fallen: this far from upright (on its side about 70-90)
constexpr uint32_t CRASH_DOWN_S = 10;             // still down and still after this long: a fall
// Going over only after standing longer than this (GPS) is no fall from riding (1.8.5): the board
// turned 113° in its place a minute after the bike was parked on 2026-11-21.
constexpr uint32_t CRASH_START_S = 15;
constexpr float CRASH_ROLLED_M = 15;              // standing: further than this from where it stood, it rolled meanwhile
constexpr float CRASH_MOVED_DEG = 30;             // standing that long, this far from upright: the board turned in its place
constexpr uint8_t CRASH_LEARN_SAMPLES = 3;        // readings at speed before a newly learned upright counts
constexpr float CRASH_ODD_DEG = 45;               // at speed, further than this from upright: not learned (a fall's slide) ...
constexpr uint8_t CRASH_ODD_SAMPLES = 4;          // ... unless it goes on this many times: the board turned, learned anew
constexpr float CRASH_RIDE_ON_KMH = 15;           // moving off again this fast: the rider is fine
constexpr uint32_t CRASH_REPORT_S = 15;           // after a fall: a report this often
constexpr uint32_t CRASH_LOCAL_SMS_S = 150;       // no server by then: the board texts the contact itself
constexpr uint32_t CRASH_WATCH_MAX_S = 15 * 60;   // after a fall: reports for at most this long
constexpr uint32_t SMS_REGISTER_MS = 60000;       // finding the network for an SMS
constexpr uint32_t REGISTER_TIMEOUT_MS = 120000;  // looking for the network
constexpr uint32_t WIFI_CONNECT_MS = 8000;        // joining a known Wi-Fi network found by a scan
constexpr uint32_t WIFI_QUICK_CONNECT_MS = 4000;  // trying the one that worked last time, without a scan
constexpr uint32_t FIX_TIMEOUT_MS = 90000;        // waiting for GPS
constexpr uint32_t TRACK_FIX_TIMEOUT_MS = 15000;  // waiting for GPS between tracking reports
constexpr uint32_t MOVING_RETRY_MS = 10 * 60000;  // no signal while the bike moves: keep trying this long
constexpr uint16_t CRITICAL_MV = 3400;  // below this the modem's current peaks would reset the board
constexpr uint32_t CRITICAL_SLEEP_S = 6 * 3600;
constexpr int8_t KEEP_ON_NETWORK_PCT = 15;  // below this the modem is switched off while asleep
constexpr uint32_t WATCHDOG_S = 90;  // restarts the board if the code hangs this long
