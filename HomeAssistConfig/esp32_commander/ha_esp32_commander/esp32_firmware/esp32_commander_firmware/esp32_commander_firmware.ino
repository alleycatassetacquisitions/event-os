/**
 * ESP32 Commander - Device Firmware Template
 * ============================================
 * Connects to WiFi + MQTT broker, subscribes to command topics,
 * and publishes status. Handles: message display, LED control, haptic motor.
 *
 * Payload format: Protocol Buffers (nanopb) binary — NOT JSON.
 * Schema:  proto/esp32_commander.proto
 * Generated headers: esp32_commander.pb.h / esp32_commander.pb.c  (in this src/ dir)
 *
 * Dependencies (add to platformio.ini lib_deps):
 *   - nanopb/Nanopb        >= 0.4.8
 *   - knolleary/PubSubClient >= 2.8
 *
 * Hardware connections (adjust pin numbers to your wiring):
 *   LED      → GPIO 2  (built-in LED, or NeoPixel data pin)
 *   Haptic   → GPIO 4  (motor driver IN pin, e.g. DRV2605 or simple transistor)
 *   Display  → I2C SDA/SCL (optional OLED via Adafruit SSD1306)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include "esp32_commander.pb.h"

// ── CONFIGURATION ──────────────────────────────────────────────────────────
// Change these values for each device!

const char* DEVICE_ID     = "esp32-device-01";   // Unique per device
const char* WIFI_SSID     = "H@ck_IOT";
const char* WIFI_PASSWORD = "IOTadmin";
const char* MQTT_HOST     = "192.168.1.162";        // Your HA/Mosquitto IP
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "mqtt_esp32";                    // Leave blank if no auth
const char* MQTT_PASS     = "IOTadmin";

const char* FIRMWARE_VERSION = "1.0.0";

// ── PIN DEFINITIONS ────────────────────────────────────────────────────────
#define LED_PIN      2    // GPIO for LED (PWM capable recommended)
#define HAPTIC_PIN   4    // GPIO for haptic motor driver
// #define SDA_PIN   21  // Uncomment if using I2C display
// #define SCL_PIN   22

// ── MQTT TOPIC TEMPLATES ──────────────────────────────────────────────────
// Topics use device ID so each device has its own namespace:
//   Commands:  esp32/{DEVICE_ID}/cmd/{action}
//   Status:    esp32/{DEVICE_ID}/status

String topicCmdMessage;
String topicCmdLED;
String topicCmdHaptic;
String topicCmdRaw;
String topicStatus;
String topicCmdBase;

// ── GLOBALS ───────────────────────────────────────────────────────────────
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastStatusPublish = 0;
const unsigned long STATUS_INTERVAL_MS = 30000;  // Publish status every 30s

bool ledState = false;
int  ledBrightness = 255;

// ── FORWARD DECLARATIONS ──────────────────────────────────────────────────
void handleMessage(const MessageCmd& cmd);
void handleLED(const LedCmd& cmd);
void handleHaptic(const HapticCmd& cmd);
void handleRaw(const String& topic, const RawCmd& cmd);
void publishStatus();

// ── WIFI SETUP ────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
}

// ── MQTT CALLBACK ─────────────────────────────────────────────────────────
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String topicStr(topic);
  Serial.printf("[MQTT] ← %s (%u bytes binary)\n", topic, length);

  if (topicStr.endsWith("/cmd/message")) {
    MessageCmd cmd = MessageCmd_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(payload, length);
    if (!pb_decode(&stream, MessageCmd_fields, &cmd)) {
      Serial.println("[MQTT] Failed to decode MessageCmd");
      return;
    }
    handleMessage(cmd);

  } else if (topicStr.endsWith("/cmd/led")) {
    LedCmd cmd = LedCmd_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(payload, length);
    if (!pb_decode(&stream, LedCmd_fields, &cmd)) {
      Serial.println("[MQTT] Failed to decode LedCmd");
      return;
    }
    handleLED(cmd);

  } else if (topicStr.endsWith("/cmd/haptic")) {
    HapticCmd cmd = HapticCmd_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(payload, length);
    if (!pb_decode(&stream, HapticCmd_fields, &cmd)) {
      Serial.println("[MQTT] Failed to decode HapticCmd");
      return;
    }
    handleHaptic(cmd);

  } else {
    // Generic/raw command — decode RawCmd wrapper, pass payload_json to handler
    RawCmd cmd = RawCmd_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(payload, length);
    if (!pb_decode(&stream, RawCmd_fields, &cmd)) {
      Serial.println("[MQTT] Failed to decode RawCmd");
      return;
    }
    handleRaw(topicStr, cmd);
  }
}

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────

/**
 * Handle: send_message
 * Proto: MessageCmd { text, duration, scroll }
 */
void handleMessage(const MessageCmd& cmd) {
  const char* text = cmd.text;
  int duration     = cmd.duration ? cmd.duration : 5;
  bool scroll      = cmd.scroll;

  Serial.printf("[MSG] Display: \"%s\" (duration=%ds, scroll=%d)\n", text, duration, scroll);

  // ── YOUR DISPLAY CODE HERE ───────────────────────────────────────────
  // Example with Adafruit SSD1306 (add #include and setup separately):
  //
  // display.clearDisplay();
  // display.setTextSize(1);
  // display.setTextColor(SSD1306_WHITE);
  // display.setCursor(0, 0);
  // display.print(text);
  // display.display();
  // if (duration > 0) {
  //   delay(duration * 1000);
  //   display.clearDisplay();
  //   display.display();
  // }
  // ─────────────────────────────────────────────────────────────────────

  publishStatus();
}

/**
 * Handle: set_led
 * Proto: LedCmd { state, brightness, r, g, b, effect }
 */
void handleLED(const LedCmd& cmd) {
  ledState      = cmd.state;
  ledBrightness = cmd.brightness ? cmd.brightness : 255;
  String effect = strlen(cmd.effect) > 0 ? String(cmd.effect) : "solid";

  if (ledState) {
    analogWrite(LED_PIN, ledBrightness);
  } else {
    analogWrite(LED_PIN, 0);
  }

  // ── NEOPIXEL EXAMPLE (uncomment + add Adafruit_NeoPixel library) ─────
  // int r = cmd.r ? cmd.r : 255;
  // int g = cmd.g ? cmd.g : 255;
  // int b = cmd.b ? cmd.b : 255;
  // uint32_t color = strip.Color(
  //   (r * ledBrightness) / 255,
  //   (g * ledBrightness) / 255,
  //   (b * ledBrightness) / 255
  // );
  // if (!ledState) color = 0;
  // for (int i = 0; i < strip.numPixels(); i++) strip.setPixelColor(i, color);
  // strip.show();
  // ─────────────────────────────────────────────────────────────────────

  Serial.printf("[LED] state=%d brightness=%d effect=%s\n", ledState, ledBrightness, effect.c_str());
  publishStatus();
}

/**
 * Handle: trigger_haptic
 * Proto: HapticCmd { pattern, intensity, duration_ms, repeat }
 */
void handleHaptic(const HapticCmd& cmd) {
  String pattern  = strlen(cmd.pattern) > 0 ? String(cmd.pattern) : "short";
  int intensity   = cmd.intensity   ? cmd.intensity   : 200;
  int duration_ms = cmd.duration_ms ? cmd.duration_ms : 200;
  int repeat      = cmd.repeat      ? cmd.repeat      : 1;

  Serial.printf("[HAPTIC] pattern=%s intensity=%d duration=%dms repeat=%d\n",
    pattern.c_str(), intensity, duration_ms, repeat);

  struct Pulse { int on_ms; int off_ms; int count; };
  Pulse pulse = { duration_ms, 100, 1 };

  if      (pattern == "short")  pulse = { 100, 100, 1 };
  else if (pattern == "long")   pulse = { 600, 0,   1 };
  else if (pattern == "double") pulse = { 150, 100, 2 };
  else if (pattern == "sos") {
    int sos[][2] = {{100,80},{100,80},{100,200},{400,80},{400,80},{400,200},{100,80},{100,80},{100,0}};
    for (auto& p : sos) {
      analogWrite(HAPTIC_PIN, intensity);
      delay(p[0]);
      analogWrite(HAPTIC_PIN, 0);
      delay(p[1]);
    }
    return;
  }

  for (int r = 0; r < repeat; r++) {
    for (int i = 0; i < pulse.count; i++) {
      analogWrite(HAPTIC_PIN, intensity);
      delay(pulse.on_ms);
      analogWrite(HAPTIC_PIN, 0);
      if (pulse.off_ms > 0) delay(pulse.off_ms);
    }
    if (r < repeat - 1) delay(200);
  }
}

/**
 * Handle: raw / unknown command
 * Proto: RawCmd { payload_json } — payload_json is an arbitrary JSON string.
 * Extend this as you add more features.
 */
void handleRaw(const String& topic, const RawCmd& cmd) {
  Serial.printf("[RAW] Topic: %s | payload: %s\n", topic.c_str(), cmd.payload_json);
  // Add your custom handlers here
}

// ── STATUS PUBLISHER ──────────────────────────────────────────────────────
/**
 * Encodes device telemetry as a StatusMsg protobuf and publishes (retained) to:
 *   esp32/{DEVICE_ID}/status
 *
 * The Last Will & Testament uses an empty (0-byte) payload on the same topic,
 * which decodes as a StatusMsg with all defaults (online=false) — signalling
 * to the HA integration that this device has gone offline.
 */
void publishStatus() {
  StatusMsg msg = StatusMsg_init_zero;

  strncpy(msg.device_id, DEVICE_ID,        sizeof(msg.device_id) - 1);
  strncpy(msg.firmware,  FIRMWARE_VERSION, sizeof(msg.firmware)  - 1);
  String ip = WiFi.localIP().toString();
  strncpy(msg.ip, ip.c_str(),              sizeof(msg.ip)        - 1);

  msg.rssi      = (int32_t)WiFi.RSSI();
  msg.uptime    = (int32_t)(millis() / 1000);
  msg.free_heap = (int32_t)ESP.getFreeHeap();
  msg.led_state = ledState;
  msg.timestamp = (int64_t)millis();
  msg.online    = true;

  uint8_t buf[StatusMsg_size];
  pb_ostream_t stream = pb_ostream_from_buffer(buf, sizeof(buf));
  if (!pb_encode(&stream, StatusMsg_fields, &msg)) {
    Serial.println("[MQTT] Failed to encode StatusMsg");
    return;
  }

  mqtt.publish(topicStatus.c_str(), buf, stream.bytes_written, true);
  Serial.printf("[MQTT] → %s (%u bytes)\n", topicStatus.c_str(), stream.bytes_written);
}

// ── MQTT CONNECT ──────────────────────────────────────────────────────────
void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.printf("[MQTT] Connecting as %s...", DEVICE_ID);

    // LWT: empty payload (0 bytes) decodes as StatusMsg with all defaults.
    // The HA integration treats an empty payload as "device offline".
    String willTopic = topicStatus;

    bool ok = (strlen(MQTT_USER) > 0)
      ? mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS,
                     willTopic.c_str(), 1, true, "")
      : mqtt.connect(DEVICE_ID,
                     willTopic.c_str(), 1, true, "");

    if (ok) {
      Serial.println(" connected!");

      String subTopic = topicCmdBase + "#";
      mqtt.subscribe(subTopic.c_str(), 1);
      Serial.printf("[MQTT] Subscribed to %s\n", subTopic.c_str());

      publishStatus();
    } else {
      Serial.printf(" failed (rc=%d), retry in 5s\n", mqtt.state());
      delay(5000);
    }
  }
}

// ── SETUP ─────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n\nESP32 Commander Firmware v%s\n", FIRMWARE_VERSION);
  Serial.printf("Device ID: %s\n\n", DEVICE_ID);

  topicCmdBase    = String("esp32/") + DEVICE_ID + "/cmd/";
  topicCmdMessage = topicCmdBase + "message";
  topicCmdLED     = topicCmdBase + "led";
  topicCmdHaptic  = topicCmdBase + "haptic";
  topicStatus     = String("esp32/") + DEVICE_ID + "/status";

  pinMode(LED_PIN, OUTPUT);
  analogWrite(LED_PIN, 0);
  pinMode(HAPTIC_PIN, OUTPUT);
  analogWrite(HAPTIC_PIN, 0);

  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1024);

  connectMQTT();
}

// ── LOOP ──────────────────────────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Reconnecting...");
    connectWiFi();
  }
  if (!mqtt.connected()) {
    connectMQTT();
  }

  mqtt.loop();

  if (millis() - lastStatusPublish >= STATUS_INTERVAL_MS) {
    lastStatusPublish = millis();
    publishStatus();
  }
}
