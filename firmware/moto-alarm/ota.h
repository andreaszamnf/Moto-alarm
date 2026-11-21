// New firmware from a distance, over a known Wi-Fi or 4G (4G from 1.8.6 on). The server offers a
// version; the board downloads it in parts, checks that we signed it, writes it to the spare program
// slot and restarts into it. If the new program cannot reach the server on its first start, the
// board goes back to the old one by itself.
#pragma once
#include <Arduino.h>

#include "modem.h"

struct FirmwareOffer {
  String version;
  uint32_t size = 0;
  String signature;  // ECDSA P-256 over the SHA-256 of the image, DER, in hex
};

// Downloads, checks and installs. Returns true when the board should restart into the new program;
// false keeps the running one (no space, download failed, bad signature).
bool installFirmware(Modem& modem, const FirmwareOffer& offer);
// Why the last try failed ("1.8.7 4g@16384 odd: +HTTPREAD: X"), kept through sleep until a report
// has carried it to the server; "" when there is nothing to tell.
const char* firmwareNote();
void clearFirmwareNote();

// First start of a new program: true until it proves it can talk to the server.
bool firmwareOnTrial();
// It reached the server: keep it.
void keepNewFirmware();
// It could not: go back to the previous program. Does not return.
void revertFirmware();
