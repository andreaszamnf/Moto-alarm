#include "accel.h"

#include <Wire.h>
#include <math.h>

#include "config.h"
#include "util.h"

namespace {

constexpr uint8_t REG_DEVID = 0x00;
constexpr uint8_t REG_THRESH_ACT = 0x24;     // 62.5 mg per step
constexpr uint8_t REG_ACT_INACT_CTL = 0x27;
constexpr uint8_t REG_BW_RATE = 0x2C;
constexpr uint8_t REG_POWER_CTL = 0x2D;
constexpr uint8_t REG_INT_ENABLE = 0x2E;
constexpr uint8_t REG_INT_MAP = 0x2F;
constexpr uint8_t REG_INT_SOURCE = 0x30;
constexpr uint8_t REG_DATA_FORMAT = 0x31;
constexpr uint8_t REG_DATAX0 = 0x32;
constexpr uint8_t REG_FIFO_CTL = 0x38;

constexpr uint8_t DEVICE_ID = 0xE5;
constexpr uint8_t ACTIVITY = 0x10;              // INT_ENABLE / INT_SOURCE bit
constexpr uint8_t ACTIVITY_AC_XYZ = 0xF0;       // activity on x, y and z, compared with a reference
constexpr uint8_t MEASURE = 0x08;
constexpr uint8_t FULL_RES_2G = 0x08;           // full resolution, +-2 g, interrupts active high
constexpr uint8_t RATE_LOW_POWER_25HZ = 0x18;   // about 40 uA while the board sleeps
constexpr uint8_t RATE_100HZ = 0x0A;
constexpr float G_PER_STEP = 0.0039f;

struct Profile {
  uint8_t wakeSteps;    // wake-up threshold, in 62.5 mg steps
  float shakeG;         // shaking stronger than this in a tenth of a second counts
  uint8_t motionTenths; // this many shaky tenths (out of 30) = real movement
  float tiltDeg;        // leaning this much more than when parked = real movement
};

// 1 low, 2 medium, 3 high. To be tuned on the bike.
const Profile PROFILES[] = {
    {6, 0.20f, 12, 15.0f},
    {4, 0.12f, 8, 10.0f},
    {3, 0.08f, 5, 6.0f},
};

const Profile& profile(uint8_t sensitivity) {
  const uint8_t level = sensitivity < 1 ? 1 : sensitivity > 3 ? 3 : sensitivity;
  return PROFILES[level - 1];
}

bool normalize(const float in[3], float out[3]) {
  const float length = sqrtf(in[0] * in[0] + in[1] * in[1] + in[2] * in[2]);
  if (length < 0.2f) return false;  // no sensible reading
  for (int k = 0; k < 3; k++) out[k] = in[k] / length;
  return true;
}

}  // namespace

bool Accel::write(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr_);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

uint8_t Accel::read(uint8_t reg) {
  Wire.beginTransmission(addr_);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(addr_, static_cast<uint8_t>(1)) != 1) return 0;
  return static_cast<uint8_t>(Wire.read());
}

bool Accel::readXYZ(float v[3]) {
  Wire.beginTransmission(addr_);
  Wire.write(REG_DATAX0);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr_, static_cast<uint8_t>(6)) != 6) return false;
  for (int k = 0; k < 3; k++) {
    const uint8_t low = static_cast<uint8_t>(Wire.read());
    const uint8_t high = static_cast<uint8_t>(Wire.read());
    v[k] = static_cast<int16_t>(low | (high << 8)) * G_PER_STEP;
  }
  return true;
}

bool Accel::begin(uint8_t sensitivity) {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 100000);
  addr_ = 0;
  for (uint8_t candidate : {0x53, 0x1D}) {  // SDO to GND, or SDO to 3.3 V
    addr_ = candidate;
    if (read(REG_DEVID) == DEVICE_ID) break;
    addr_ = 0;
  }
  if (!addr_) return false;

  // Already set up on an earlier wake: leave it, so the record of movement is kept.
  if (read(REG_POWER_CTL) == MEASURE && read(REG_INT_ENABLE) == ACTIVITY && read(REG_BW_RATE) == RATE_LOW_POWER_25HZ &&
      read(REG_THRESH_ACT) == profile(sensitivity).wakeSteps) {
    return true;
  }
  write(REG_POWER_CTL, 0);  // standby while setting up
  write(REG_DATA_FORMAT, FULL_RES_2G);
  write(REG_FIFO_CTL, 0);
  write(REG_BW_RATE, RATE_LOW_POWER_25HZ);
  write(REG_THRESH_ACT, profile(sensitivity).wakeSteps);
  write(REG_ACT_INACT_CTL, ACTIVITY_AC_XYZ);
  write(REG_INT_MAP, 0);  // every interrupt on INT1
  write(REG_INT_ENABLE, ACTIVITY);
  write(REG_POWER_CTL, MEASURE);
  delay(60);
  read(REG_INT_SOURCE);
  return true;
}

void Accel::setSensitivity(uint8_t sensitivity) {
  if (ok()) write(REG_THRESH_ACT, profile(sensitivity).wakeSteps);
}

// Restarting activity detection makes the next sample the reference that later ones are
// compared with, so a bike that now leans a little differently does not keep waking the board.
void Accel::rearm() {
  write(REG_INT_ENABLE, 0);
  write(REG_ACT_INACT_CTL, 0);
  write(REG_ACT_INACT_CTL, ACTIVITY_AC_XYZ);
  write(REG_INT_ENABLE, ACTIVITY);
  delay(60);  // one sample at 25 Hz
  read(REG_INT_SOURCE);
}

bool Accel::consumeMovement() {
  if (!ok()) return false;
  const bool moved = (read(REG_INT_SOURCE) & ACTIVITY) != 0;
  rearm();
  return moved;
}

void Accel::clearInterrupt() {
  if (ok()) read(REG_INT_SOURCE);
}

bool Accel::gravity(float out[3]) {
  if (!ok()) return false;
  write(REG_BW_RATE, RATE_100HZ);
  delay(30);
  float sum[3] = {0, 0, 0};
  int samples = 0;
  for (int i = 0; i < 50; i++) {
    float v[3];
    if (readXYZ(v)) {
      for (int k = 0; k < 3; k++) sum[k] += v[k];
      samples++;
    }
    delay(10);
  }
  write(REG_BW_RATE, RATE_LOW_POWER_25HZ);
  return samples >= 10 && normalize(sum, out);
}

bool Accel::sampleGravity(float out[3], uint8_t samples) {
  if (!ok()) return false;
  float sum[3] = {0, 0, 0};
  uint8_t got = 0;
  for (uint8_t i = 0; i < samples; i++) {
    float v[3];
    if (readXYZ(v)) {
      for (int k = 0; k < 3; k++) sum[k] += v[k];
      got++;
    }
    delay(45);  // a new sample every 40 ms
  }
  return got >= samples / 2 && normalize(sum, out);
}

MotionResult Accel::classify(const float ref[3], bool haveRef, uint8_t sensitivity) {
  MotionResult result;
  if (!ok()) return result;
  const Profile& p = profile(sensitivity);
  write(REG_BW_RATE, RATE_100HZ);
  delay(20);

  constexpr int SAMPLES = 300;  // 3 seconds at 100 Hz
  float slow[3] = {0, 0, 0};    // slowly following average, about gravity
  bool primed = false;
  float peak = 0;
  float tail[3] = {0, 0, 0};    // sum of the last half second, for the final lean
  int tailSamples = 0;
  bool earlyExit = false;
  uint32_t due = millis();
  for (int i = 0; i < SAMPLES; i++) {
    due += 10;
    float v[3];
    if (readXYZ(v)) {
      if (!primed) {
        for (int k = 0; k < 3; k++) slow[k] = v[k];
        primed = true;
      }
      float shake2 = 0;
      for (int k = 0; k < 3; k++) {
        slow[k] += 0.1f * (v[k] - slow[k]);
        const float d = v[k] - slow[k];
        shake2 += d * d;
      }
      peak = fmaxf(peak, sqrtf(shake2));
      if (i >= SAMPLES - 50) {
        for (int k = 0; k < 3; k++) tail[k] += v[k];
        tailSamples++;
      }
    }
    if (i % 10 == 9) {
      if (peak > p.shakeG) result.shakyTenths++;
      peak = 0;
    }
    // Clearly real movement already: decide now instead of after the full 3 seconds, so the alarm
    // goes out sooner. The lean then comes from the slowly following average.
    if (result.shakyTenths >= p.motionTenths) {
      earlyExit = true;
      break;
    }
    esp_task_wdt_reset();
    while (static_cast<int32_t>(millis() - due) < 0) delay(1);
  }
  write(REG_BW_RATE, RATE_LOW_POWER_25HZ);

  float g[3];
  if (earlyExit) {
    float s[3] = {slow[0], slow[1], slow[2]};
    if (haveRef && primed && normalize(s, g)) result.tiltDeg = angleDeg(g, ref);
  } else if (haveRef && tailSamples >= 10 && normalize(tail, g)) {
    result.tiltDeg = angleDeg(g, ref);
  }
  result.kind = result.tiltDeg >= p.tiltDeg || result.shakyTenths >= p.motionTenths ? MotionKind::Motion
                                                                                       : MotionKind::Touch;
  return result;
}

float Accel::tiltLimit(uint8_t sensitivity) { return profile(sensitivity).tiltDeg; }

float Accel::angleDeg(const float a[3], const float b[3]) {
  float dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;
  return acosf(dot) * 57.29578f;
}
