#include "ota.h"

#include <Update.h>
#include <esp_attr.h>
#include <esp_ota_ops.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <mbedtls/version.h>

#include "firmware_key.h"
#include "util.h"
#include "wifinet.h"

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// mbedtls 3 dropped the "_ret" names that mbedtls 2 (esp32 core 2.x) uses.
#if MBEDTLS_VERSION_MAJOR >= 3
#define SHA256_STARTS mbedtls_sha256_starts
#define SHA256_UPDATE mbedtls_sha256_update
#define SHA256_FINISH mbedtls_sha256_finish
#else
#define SHA256_STARTS mbedtls_sha256_starts_ret
#define SHA256_UPDATE mbedtls_sha256_update_ret
#define SHA256_FINISH mbedtls_sha256_finish_ret
#endif

// The Arduino core marks a new program as good as soon as it starts. We decide that ourselves,
// after the first report (see keepNewFirmware), so a program that cannot report is rolled back.
// The core declares this in C, so the override needs C linkage.
extern "C" bool verifyRollbackLater() { return true; }

namespace {

constexpr size_t PART = 16 * 1024;          // one HTTPS request
constexpr uint32_t MAX_IMAGE = 0x1E0000;    // a program slot with PartitionScheme=min_spiffs
constexpr uint8_t MAX_FAILED_PARTS = 5;

RTC_DATA_ATTR char note[72] = "";  // see firmwareNote()

void setNote(const FirmwareOffer& offer, const char* via, uint32_t at, const char* why) {
  snprintf(note, sizeof note, "%s %s@%u %s", offer.version.c_str(), via, static_cast<unsigned>(at), why);
  Serial.printf("ota: %s\n", note);
}

size_t fromHex(const String& hex, uint8_t* out, size_t max) {
  const size_t n = hex.length() / 2;
  if (hex.length() % 2 || n > max) return 0;
  for (size_t i = 0; i < n; i++) {
    char pair[3] = {hex[2 * i], hex[2 * i + 1], 0};
    char* end = nullptr;
    const long v = strtol(pair, &end, 16);
    if (*end) return 0;
    out[i] = static_cast<uint8_t>(v);
  }
  return n;
}

bool signedByUs(const uint8_t hash[32], const String& signatureHex) {
  uint8_t sig[80];
  const size_t sigLen = fromHex(signatureHex, sig, sizeof sig);
  if (!sigLen) return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  int rc = mbedtls_pk_parse_public_key(&key, reinterpret_cast<const unsigned char*>(FIRMWARE_PUBLIC_KEY),
                                       sizeof FIRMWARE_PUBLIC_KEY);
  if (rc == 0) rc = mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256, hash, 32, sig, sigLen);
  mbedtls_pk_free(&key);
  return rc == 0;
}

String firmwareUrl() {
  String url = SERVER_URL;
  url.replace("/api/device/report", "/api/device/firmware");
  return url;
}

}  // namespace

bool installFirmware(Modem& modem, const FirmwareOffer& offer) {
  if (!offer.version.length() || offer.size == 0 || offer.size > MAX_IMAGE) return false;
  Serial.printf("ota: %s, %u bytes\n", offer.version.c_str(), static_cast<unsigned>(offer.size));
  if (!Update.begin(offer.size, U_FLASH)) {
    Serial.printf("ota: %s\n", Update.errorString());
    return false;
  }
  uint8_t* buf = static_cast<uint8_t*>(malloc(PART));
  if (!buf) {
    Update.abort();
    return false;
  }
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  SHA256_STARTS(&sha, 0);

  const String base = firmwareUrl() + "?v=" + offer.version;
  uint32_t done = 0;
  uint8_t failed = 0;
  bool ok = true;
  while (done < offer.size) {
    const uint32_t want = offer.size - done < PART ? offer.size - done : PART;
    const String url = base + "&from=" + done + "&len=" + want;
    const bool viaWifi = wifiConnected();
    const int got = viaWifi ? wifiGet(url, DEVICE_KEY, buf, want) : modem.get(url, DEVICE_KEY, buf, want);
    if (got != static_cast<int>(want)) {
      if (++failed > MAX_FAILED_PARTS) {
        setNote(offer, viaWifi ? "wifi" : "4g", done, viaWifi ? "failed" : modem.getNote());
        ok = false;
        break;
      }
      pause(3000);
      continue;
    }
    failed = 0;
    SHA256_UPDATE(&sha, buf, got);
    if (Update.write(buf, got) != static_cast<size_t>(got)) {
      Serial.printf("ota: %s\n", Update.errorString());
      ok = false;
      break;
    }
    done += got;
    Serial.printf("ota: %u%%\n", static_cast<unsigned>(done * 100ULL / offer.size));
  }
  free(buf);

  uint8_t hash[32];
  SHA256_FINISH(&sha, hash);
  mbedtls_sha256_free(&sha);
  if (!ok || done != offer.size) {
    Serial.println("ota: download failed");
    Update.abort();
    return false;
  }
  if (!signedByUs(hash, offer.signature)) {
    setNote(offer, wifiConnected() ? "wifi" : "4g", done, "not signed by us");
    Update.abort();
    return false;
  }
  if (!Update.end(true)) {
    Serial.printf("ota: %s\n", Update.errorString());
    return false;
  }
  Serial.printf("ota: %s installed, restarting\n", offer.version.c_str());
  return true;
}

const char* firmwareNote() { return note; }

void clearFirmwareNote() { note[0] = '\0'; }

bool firmwareOnTrial() {
  esp_ota_img_states_t state;
  return esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
         state == ESP_OTA_IMG_PENDING_VERIFY;
}

void keepNewFirmware() {
  if (firmwareOnTrial()) {
    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("ota: new firmware kept");
  }
}

void revertFirmware() {
  Serial.println("ota: new firmware could not reach the server, going back");
  Serial.flush();
  esp_ota_mark_app_invalid_rollback_and_reboot();
  ESP.restart();  // only if there was nothing to go back to
}
