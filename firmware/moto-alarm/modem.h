// SIM7600 modem with plain AT commands: power, network, HTTPS POST, GPS and SMS.
#pragma once
#include <Arduino.h>

struct Fix {
  bool valid = false;
  double lat = 0;
  double lon = 0;
  float acc = 0;       // metres, estimated from HDOP
  float speedKmh = 0;
  uint32_t time = 0;   // unix seconds (UTC) from the satellites, 0 when unknown
};

// Which network the modem is on, and how well it hears it (for the signal test in the app).
struct NetInfo {
  String op;    // operator name, e.g. "COSMOTE"
  String tech;  // "LTE", "3G" or "GSM"
  int rsrp = 0; // LTE signal power in dBm (about -80 strong, -115 very weak); 0 when unknown
  int rsrq = 0; // LTE signal quality in dB; 0 when unknown
  int snr = 0;  // LTE signal-to-noise in dB; 0 when unknown
};

// Reads the text after "+CGNSSINFO:". Public so it can be checked on its own.
bool parseGnssInfo(const String& line, Fix& fix);

class Modem {
 public:
  explicit Modem(HardwareSerial& port) : port_(port) {}

  void begin();
  bool isOn() const { return on_; }
  bool powerOn();
  void powerOff();
  // Leaves the modem on the network in its low-power sleep while the ESP32 sleeps, so the next
  // report goes out in seconds instead of after a new search for the network.
  void sleep();
  bool wasAwake() const { return warm_; }  // it was still on when powerOn() was called
  // Registered on the network (asks the modem when it was only used for the GPS this time).
  bool onNetwork() { return on_ && (registerMs_ != 0 || registered()); }
  uint16_t readVoltageMv();                // the modem's supply voltage (AT+CBC), 0 when unknown
  // Waits until the modem is registered on the network (it searches by itself once on).
  bool waitForNetwork(const char* apn, uint32_t timeoutMs);
  int signal() const { return signal_; }  // dBm when last connected, 0 when unknown
  uint32_t registerMs() const { return registerMs_; }  // how long finding the network took
  bool readNetInfo(NetInfo& info);
  // POSTs JSON over HTTPS. Returns the HTTP status (-1 when it did not get through).
  int post(const char* url, const char* bearer, const String& json, String& response);
  // GETs a binary answer over HTTPS into `out` (at most `max` bytes). Returns its length, or -1.
  int get(const String& url, const char* bearer, uint8_t* out, size_t max);
  // Why the last get() failed, in a few words ("" when it worked).
  const char* getNote() const { return note_; }
  // The "+HTTPREAD" lines of the last post() answer, without the data: the modem's own format.
  const char* framing() const { return framing_; }
  void gpsOn();
  void gpsOff();
  bool readFix(Fix& fix);
  // Waits for a fix, preferring an accurate one. Returns false if none came in time.
  bool waitForFix(Fix& fix, uint32_t timeoutMs);
  // Sends one SMS (up to 70 characters, Greek allowed). Returns true when the network took it.
  bool sendSms(const char* number, const String& text);

 private:
  bool command(const String& cmd, uint32_t timeoutMs = 1000, const char* expect = "OK", String* reply = nullptr);
  bool waitFor(const char* expect, uint32_t timeoutMs, String* reply = nullptr);
  bool waitForPrompt(uint32_t timeoutMs);
  bool answers(uint8_t tries);
  bool registered();
  int readSignal();
  void pressPowerKey(uint32_t ms);
  void holdPins(bool dtrHigh);
  void lteOnly();
  String readBody(int length);
  bool openHttp();
  int readBinary(size_t offset, uint8_t* out, size_t want);
  void noteLine(const char* what, const String& line);

  HardwareSerial& port_;
  char note_[64] = "";
  char framing_[48] = "";
  bool on_ = false;
  bool gps_ = false;
  bool warm_ = false;
  int signal_ = 0;
  uint32_t poweredAt_ = 0;
  uint32_t registerMs_ = 0;
};
