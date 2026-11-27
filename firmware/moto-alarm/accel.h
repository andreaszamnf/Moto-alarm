// ADXL345 accelerometer on I2C. While the board sleeps it watches for movement and wakes it
// through INT1. Awake, it tells a light touch from real movement: shaking that goes on, or the
// bike leaning differently than when it was parked.
#pragma once
#include <Arduino.h>

enum class MotionKind : uint8_t { Touch, Motion };

struct MotionResult {
  MotionKind kind = MotionKind::Touch;
  float tiltDeg = 0;         // lean compared with when the bike was parked
  uint8_t shakyTenths = 0;   // tenths of a second (out of 30) with clear shaking
};

class Accel {
 public:
  bool begin(uint8_t sensitivity);  // finds and sets up the sensor; false when it is missing
  bool ok() const { return addr_ != 0; }
  // Whether begin() had to set the sensor up: a first start, or a sensor that lost its settings
  // (its power gone for a moment) while the board slept.
  bool reconfigured() const { return reconfigured_; }
  void setSensitivity(uint8_t sensitivity);
  // Whether the bike moved since the last call. Also makes the current position the new
  // reference for the wake-up interrupt.
  bool consumeMovement();
  // Whether the sensor has noted movement, without using it up: the next consumeMovement() still
  // sees it (asking clears the sensor's own note, and lets INT1 go low). 1.8.9.
  bool movementNoted();
  void clearInterrupt();       // so INT1 is low before deep sleep
  bool gravity(float out[3]);  // direction of gravity (unit vector), averaged over half a second
  // The same from the samples the sensor takes anyway (25 a second), without changing its rate:
  // a change of rate sets off the movement detection, which the riding loop would take as movement.
  bool sampleGravity(float out[3], uint8_t samples = 8);
  // Samples for up to 3 seconds after a wake-up and decides between a touch and real movement
  // (clear shaking decides sooner).
  MotionResult classify(const float ref[3], bool haveRef, uint8_t sensitivity);

  static float tiltLimit(uint8_t sensitivity);  // lean (degrees) that counts as moved
  static float angleDeg(const float a[3], const float b[3]);

 private:
  bool write(uint8_t reg, uint8_t value);
  uint8_t read(uint8_t reg);
  bool readXYZ(float v[3]);
  void rearm();

  uint8_t addr_ = 0;
  bool reconfigured_ = false;
  bool noted_ = false;  // movement read from the sensor by movementNoted(), not yet consumed
};
