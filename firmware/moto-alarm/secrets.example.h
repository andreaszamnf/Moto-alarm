// Template for secrets.h. Easiest: node tools/make-firmware-secrets.mjs writes secrets.h for you.
#pragma once
#define SERVER_URL "https://your-worker.workers.dev/api/device/report"
#define DEVICE_KEY "the-device-key"
#define SIM_APN ""  // empty: the network's default; otherwise your carrier's APN
