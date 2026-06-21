/**
 * ESP32 Commander — PDN Device Firmware
 * =======================================
 * ESP-IDF native implementation (no Arduino dependency).
 *
 * Hardware (PDN, from device-constants.hpp):
 *   displayLightsPin → GPIO 13  (13 WS2812 LEDs, display ring)
 *   gripLightsPin    → GPIO 21  (6  WS2812 LEDs, grip strip)
 *   motorPin         → GPIO 17  (haptic motor, LEDC PWM)
 *
 * MQTT topics:
 *   Subscribe: esp32/{DEVICE_ID}/cmd/#
 *   Publish:   esp32/{DEVICE_ID}/status  (retained, protobuf binary)
 *
 * Payload format: Protocol Buffers (nanopb) binary.
 * Schema: proto/esp32_commander.proto
 */

#include <string.h>
#include <stdio.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"

#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "mqtt_client.h"

#include "driver/ledc.h"
#include "driver/gpio.h"

#include "led_strip.h"

#include "pb_decode.h"
#include "pb_encode.h"
#include "esp32_commander.pb.h"

#include "ssd1306.h"
#include "sprites.h"

// ── CONFIGURATION ──────────────────────────────────────────────────────────

#define DEVICE_ID        "esp32-device-01"
#define WIFI_SSID        "H@ck_IOT"
#define WIFI_PASSWORD    "IOTadmin"
#define MQTT_BROKER_URI  "mqtt://192.168.1.162:1883"
#define MQTT_USERNAME    "mqtt_esp32"
#define MQTT_PASSWORD    "IOTadmin"
#define FIRMWARE_VERSION "1.0.0"

// ── PDN PIN DEFINITIONS (from device-constants.hpp) ────────────────────────

#define DISPLAY_LIGHTS_PIN   GPIO_NUM_13
#define GRIP_LIGHTS_PIN      GPIO_NUM_21
#define MOTOR_PIN            GPIO_NUM_17

#define NUM_DISPLAY_LEDS     13
#define NUM_GRIP_LEDS        6

// ── SSD1306 OLED DISPLAY (128×64, SPI) ────────────────────────────────────

#define OLED_MOSI_PIN        11   // ESP32-S3 SPI2 default MOSI
#define OLED_SCLK_PIN        12   // ESP32-S3 SPI2 default SCLK
#define OLED_CS_PIN          10   // displayCS  (device-constants.hpp)
#define OLED_DC_PIN           9   // displayDC
#define OLED_RST_PIN         14   // displayRST

#define OLED_WIDTH           128
#define OLED_HEIGHT           64
// Text overlay row: bottom quarter of the screen (row 6 of 8-pixel rows = y=48)
#define OLED_TEXT_ROW          6

// ── LEDC (haptic motor PWM) ────────────────────────────────────────────────

#define LEDC_TIMER           LEDC_TIMER_0
#define LEDC_MODE            LEDC_LOW_SPEED_MODE
#define LEDC_CHANNEL         LEDC_CHANNEL_0
#define LEDC_DUTY_RES        LEDC_TIMER_8_BIT   // 0–255
#define LEDC_FREQ_HZ         1000

// ── STATUS PUBLISH INTERVAL ────────────────────────────────────────────────

#define STATUS_INTERVAL_MS   30000

// ── LOGGING TAGS ──────────────────────────────────────────────────────────

static const char* TAG_MAIN   = "MAIN";
static const char* TAG_WIFI   = "WIFI";
static const char* TAG_MQTT   = "MQTT";
static const char* TAG_LED    = "LED";
static const char* TAG_HAPTIC = "HAPTIC";

// ── WIFI EVENT GROUP ──────────────────────────────────────────────────────

#define WIFI_CONNECTED_BIT   BIT0
#define WIFI_FAIL_BIT        BIT1

static EventGroupHandle_t s_wifi_event_group;
static int s_wifi_retry_count = 0;
#define WIFI_MAX_RETRY 10

// ── LED STATE ─────────────────────────────────────────────────────────────

static led_strip_handle_t s_display_strip = NULL;
static led_strip_handle_t s_grip_strip    = NULL;

static bool     s_led_on         = false;
static uint8_t  s_led_r          = 255;
static uint8_t  s_led_g          = 255;
static uint8_t  s_led_b          = 255;
static uint8_t  s_led_brightness = 255;
static char     s_led_effect[32] = "solid";

static TaskHandle_t s_effect_task = NULL;
static SemaphoreHandle_t s_led_mutex = NULL;

// ── OLED DISPLAY STATE ────────────────────────────────────────────────────

static SSD1306_t s_oled_dev;
static bool      s_oled_ready = false;

// ── MQTT HANDLES ──────────────────────────────────────────────────────────

static esp_mqtt_client_handle_t s_mqtt_client = NULL;

// ── TOPIC BUFFERS ─────────────────────────────────────────────────────────

static char s_topic_status[64];
static char s_topic_cmd_sub[64];

// ── FORWARD DECLARATIONS ──────────────────────────────────────────────────

static void publish_status(void);
static void set_all_leds(uint8_t r, uint8_t g, uint8_t b);
static void clear_all_leds(void);
static void start_effect_task(const char* effect);
static void stop_effect_task(void);

// ─────────────────────────────────────────────────────────────────────────
// OLED DISPLAY INIT
// ─────────────────────────────────────────────────────────────────────────

static void display_init(void) {
    spi_master_init(&s_oled_dev,
                    OLED_MOSI_PIN,
                    OLED_SCLK_PIN,
                    OLED_CS_PIN,
                    OLED_DC_PIN,
                    OLED_RST_PIN);
    ssd1306_init(&s_oled_dev, OLED_WIDTH, OLED_HEIGHT);
    ssd1306_clear_screen(&s_oled_dev, false);
    s_oled_ready = true;
    ESP_LOGI(TAG_MAIN, "OLED ready — %dx%d SPI (MOSI=%d SCLK=%d CS=%d DC=%d RST=%d)",
             OLED_WIDTH, OLED_HEIGHT,
             OLED_MOSI_PIN, OLED_SCLK_PIN,
             OLED_CS_PIN, OLED_DC_PIN, OLED_RST_PIN);
}

// Show the idle sprite — called on boot and whenever no message is active.
static void display_show_idle(void) {
    if (!s_oled_ready) return;
    ssd1306_clear_screen(&s_oled_dev, false);
    ssd1306_bitmaps(&s_oled_dev, 0, 0,
                    sprite_frame(SPRITE_IDLE),
                    OLED_WIDTH, OLED_HEIGHT,
                    false);
}

// ─────────────────────────────────────────────────────────────────────────
// LED HELPERS
// ─────────────────────────────────────────────────────────────────────────

static void set_all_leds(uint8_t r, uint8_t g, uint8_t b) {
    if (!s_display_strip || !s_grip_strip) return;
    for (int i = 0; i < NUM_DISPLAY_LEDS; i++) {
        led_strip_set_pixel(s_display_strip, i, r, g, b);
    }
    for (int i = 0; i < NUM_GRIP_LEDS; i++) {
        led_strip_set_pixel(s_grip_strip, i, r, g, b);
    }
    led_strip_refresh(s_display_strip);
    led_strip_refresh(s_grip_strip);
}

static void clear_all_leds(void) {
    if (!s_display_strip || !s_grip_strip) return;
    led_strip_clear(s_display_strip);
    led_strip_clear(s_grip_strip);
}

// Apply brightness scaling: multiply each channel by brightness/255.
static void apply_brightness(uint8_t r, uint8_t g, uint8_t b,
                              uint8_t brightness,
                              uint8_t* out_r, uint8_t* out_g, uint8_t* out_b) {
    *out_r = (uint8_t)((r * brightness) / 255);
    *out_g = (uint8_t)((g * brightness) / 255);
    *out_b = (uint8_t)((b * brightness) / 255);
}

// ─────────────────────────────────────────────────────────────────────────
// LED EFFECT TASK
// Runs in a FreeRTOS task; created/deleted on each set_led command.
// ─────────────────────────────────────────────────────────────────────────

static void effect_task(void* pvParam) {
    char effect[32];
    while (true) {
        xSemaphoreTake(s_led_mutex, portMAX_DELAY);
        strncpy(effect, s_led_effect, sizeof(effect) - 1);
        bool on         = s_led_on;
        uint8_t r       = s_led_r;
        uint8_t g       = s_led_g;
        uint8_t b       = s_led_b;
        uint8_t bright  = s_led_brightness;
        xSemaphoreGive(s_led_mutex);

        if (!on) {
            clear_all_leds();
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        uint8_t sr, sg, sb;
        apply_brightness(r, g, b, bright, &sr, &sg, &sb);

        if (strcmp(effect, "blink") == 0) {
            // Toggle at ~1 Hz
            set_all_leds(sr, sg, sb);
            vTaskDelay(pdMS_TO_TICKS(500));
            clear_all_leds();
            vTaskDelay(pdMS_TO_TICKS(500));

        } else if (strcmp(effect, "pulse") == 0) {
            // Fade in then out over ~2 s
            for (int step = 0; step <= 255; step += 5) {
                uint8_t pr = (uint8_t)((sr * step) / 255);
                uint8_t pg = (uint8_t)((sg * step) / 255);
                uint8_t pb = (uint8_t)((sb * step) / 255);
                set_all_leds(pr, pg, pb);
                vTaskDelay(pdMS_TO_TICKS(8));
            }
            for (int step = 255; step >= 0; step -= 5) {
                uint8_t pr = (uint8_t)((sr * step) / 255);
                uint8_t pg = (uint8_t)((sg * step) / 255);
                uint8_t pb = (uint8_t)((sb * step) / 255);
                set_all_leds(pr, pg, pb);
                vTaskDelay(pdMS_TO_TICKS(8));
            }

        } else if (strcmp(effect, "rainbow") == 0) {
            // Cycle hue across all pixels using HSV→RGB
            static uint16_t hue_offset = 0;
            for (int i = 0; i < NUM_DISPLAY_LEDS; i++) {
                uint16_t hue = (hue_offset + (i * 65536 / NUM_DISPLAY_LEDS)) % 65536;
                // Simple HSV→RGB with S=1 V=brightness
                uint8_t hi  = (uint8_t)((hue / 65536.0f) * 6.0f);
                float   f   = (hue / 65536.0f) * 6.0f - hi;
                uint8_t v   = bright;
                uint8_t p   = 0;
                uint8_t q   = (uint8_t)(v * (1.0f - f));
                uint8_t t   = (uint8_t)(v * f);
                uint8_t cr, cg, cb;
                switch (hi % 6) {
                    case 0: cr=v;  cg=t;  cb=p;  break;
                    case 1: cr=q;  cg=v;  cb=p;  break;
                    case 2: cr=p;  cg=v;  cb=t;  break;
                    case 3: cr=p;  cg=q;  cb=v;  break;
                    case 4: cr=t;  cg=p;  cb=v;  break;
                    default: cr=v; cg=p;  cb=q;  break;
                }
                led_strip_set_pixel(s_display_strip, i, cr, cg, cb);
            }
            for (int i = 0; i < NUM_GRIP_LEDS; i++) {
                uint16_t hue = (hue_offset + (i * 65536 / NUM_GRIP_LEDS)) % 65536;
                uint8_t hi  = (uint8_t)((hue / 65536.0f) * 6.0f);
                float   f   = (hue / 65536.0f) * 6.0f - hi;
                uint8_t v   = bright;
                uint8_t p   = 0;
                uint8_t q   = (uint8_t)(v * (1.0f - f));
                uint8_t t   = (uint8_t)(v * f);
                uint8_t cr, cg, cb;
                switch (hi % 6) {
                    case 0: cr=v;  cg=t;  cb=p;  break;
                    case 1: cr=q;  cg=v;  cb=p;  break;
                    case 2: cr=p;  cg=v;  cb=t;  break;
                    case 3: cr=p;  cg=q;  cb=v;  break;
                    case 4: cr=t;  cg=p;  cb=v;  break;
                    default: cr=v; cg=p;  cb=q;  break;
                }
                led_strip_set_pixel(s_grip_strip, i, cr, cg, cb);
            }
            led_strip_refresh(s_display_strip);
            led_strip_refresh(s_grip_strip);
            hue_offset = (hue_offset + 512) % 65536;
            vTaskDelay(pdMS_TO_TICKS(20));

        } else {
            // solid (default) — set once and sleep
            set_all_leds(sr, sg, sb);
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
}

static void start_effect_task(const char* effect) {
    stop_effect_task();
    if (xTaskCreate(effect_task, "led_effect", 3072, NULL, 5, &s_effect_task) != pdPASS) {
        ESP_LOGE(TAG_LED, "Failed to create effect task");
        s_effect_task = NULL;
    }
}

static void stop_effect_task(void) {
    if (s_effect_task) {
        vTaskDelete(s_effect_task);
        s_effect_task = NULL;
        clear_all_leds();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// HAPTIC MOTOR HELPERS
// ─────────────────────────────────────────────────────────────────────────

static void motor_set(uint8_t intensity) {
    ledc_set_duty(LEDC_MODE, LEDC_CHANNEL, intensity);
    ledc_update_duty(LEDC_MODE, LEDC_CHANNEL);
}

static void motor_pulse(int on_ms, int off_ms, int count, uint8_t intensity) {
    for (int i = 0; i < count; i++) {
        motor_set(intensity);
        vTaskDelay(pdMS_TO_TICKS(on_ms));
        motor_set(0);
        if (off_ms > 0) vTaskDelay(pdMS_TO_TICKS(off_ms));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────

static void handle_led(const LedCmd* cmd) {
    xSemaphoreTake(s_led_mutex, portMAX_DELAY);

    s_led_on         = cmd->state;
    s_led_brightness = cmd->brightness ? (uint8_t)cmd->brightness : 255;
    s_led_r          = cmd->r ? (uint8_t)cmd->r : 255;
    s_led_g          = cmd->g ? (uint8_t)cmd->g : 255;
    s_led_b          = cmd->b ? (uint8_t)cmd->b : 255;

    if (strlen(cmd->effect) > 0) {
        strncpy(s_led_effect, cmd->effect, sizeof(s_led_effect) - 1);
    } else {
        strncpy(s_led_effect, "solid", sizeof(s_led_effect) - 1);
    }

    xSemaphoreGive(s_led_mutex);

    ESP_LOGI(TAG_LED, "state=%d brightness=%d r=%d g=%d b=%d effect=%s",
             s_led_on, s_led_brightness, s_led_r, s_led_g, s_led_b, s_led_effect);

    if (!s_led_on) {
        stop_effect_task();
        clear_all_leds();
    } else {
        start_effect_task(s_led_effect);
    }

    publish_status();
}

static void handle_haptic(const HapticCmd* cmd) {
    const char* pattern  = strlen(cmd->pattern) > 0 ? cmd->pattern : "short";
    uint8_t intensity    = cmd->intensity   ? (uint8_t)cmd->intensity   : 200;
    int     duration_ms  = cmd->duration_ms ? cmd->duration_ms : 200;
    int     repeat_count = cmd->repeat      ? cmd->repeat      : 1;

    ESP_LOGI(TAG_HAPTIC, "pattern=%s intensity=%d duration=%dms repeat=%d",
             pattern, intensity, duration_ms, repeat_count);

    if (strcmp(pattern, "short") == 0) {
        for (int r = 0; r < repeat_count; r++) {
            motor_pulse(100, 100, 1, intensity);
            if (r < repeat_count - 1) vTaskDelay(pdMS_TO_TICKS(200));
        }
    } else if (strcmp(pattern, "long") == 0) {
        for (int r = 0; r < repeat_count; r++) {
            motor_pulse(600, 0, 1, intensity);
            if (r < repeat_count - 1) vTaskDelay(pdMS_TO_TICKS(200));
        }
    } else if (strcmp(pattern, "double") == 0) {
        for (int r = 0; r < repeat_count; r++) {
            motor_pulse(150, 100, 2, intensity);
            if (r < repeat_count - 1) vTaskDelay(pdMS_TO_TICKS(200));
        }
    } else if (strcmp(pattern, "sos") == 0) {
        // · · · — — — · · ·
        int sos[][2] = {
            {100,80},{100,80},{100,200},
            {400,80},{400,80},{400,200},
            {100,80},{100,80},{100,0}
        };
        for (int i = 0; i < 9; i++) {
            motor_set(intensity);
            vTaskDelay(pdMS_TO_TICKS(sos[i][0]));
            motor_set(0);
            vTaskDelay(pdMS_TO_TICKS(sos[i][1]));
        }
    } else {
        // custom — use duration_ms and repeat_count directly
        for (int r = 0; r < repeat_count; r++) {
            motor_pulse(duration_ms, 100, 1, intensity);
            if (r < repeat_count - 1) vTaskDelay(pdMS_TO_TICKS(200));
        }
    }
}

static void handle_message(const MessageCmd* cmd) {
    ESP_LOGI(TAG_MAIN, "[MSG] \"%s\" (duration=%ds scroll=%d)",
             cmd->text, cmd->duration ? cmd->duration : 5, cmd->scroll);

    if (s_oled_ready) {
        // 1. Clear the framebuffer.
        ssd1306_clear_screen(&s_oled_dev, false);

        // 2. Draw the message-background sprite behind the text.
        ssd1306_bitmaps(&s_oled_dev, 0, 0,
                        sprite_frame(SPRITE_MESSAGE),
                        OLED_WIDTH, OLED_HEIGHT,
                        false);

        // 3. Overlay the MQTT text at the bottom of the screen.
        //    Row OLED_TEXT_ROW (6) = y=48, giving a 16px text band at the base.
        char text_buf[22];  // 128px / 6px-per-char ≈ 21 chars + null
        snprintf(text_buf, sizeof(text_buf), "%s", cmd->text);
        ssd1306_display_text(&s_oled_dev, OLED_TEXT_ROW, text_buf, strlen(text_buf), false);

        // 4. After the message duration expires, return to the idle screen.
        int duration_s = cmd->duration ? cmd->duration : 5;
        vTaskDelay(pdMS_TO_TICKS(duration_s * 1000));
        display_show_idle();
    }

    publish_status();
}

static void handle_raw(const char* topic, const RawCmd* cmd) {
    ESP_LOGI(TAG_MAIN, "[RAW] topic=%s payload=%s", topic, cmd->payload_json);
}

// ─────────────────────────────────────────────────────────────────────────
// PROTOBUF ROUTING
// ─────────────────────────────────────────────────────────────────────────

static void route_mqtt_data(const char* topic, const uint8_t* data, int data_len) {
    ESP_LOGI(TAG_MQTT, "← %s (%d bytes)", topic, data_len);

    // Find the last path segment after the final '/'
    const char* suffix = strrchr(topic, '/');
    if (!suffix) return;
    suffix++; // skip the '/'

    if (strcmp(suffix, "led") == 0) {
        LedCmd cmd = LedCmd_init_zero;
        pb_istream_t stream = pb_istream_from_buffer(data, data_len);
        if (pb_decode(&stream, LedCmd_fields, &cmd)) {
            handle_led(&cmd);
        } else {
            ESP_LOGW(TAG_MQTT, "Failed to decode LedCmd");
        }

    } else if (strcmp(suffix, "haptic") == 0) {
        HapticCmd cmd = HapticCmd_init_zero;
        pb_istream_t stream = pb_istream_from_buffer(data, data_len);
        if (pb_decode(&stream, HapticCmd_fields, &cmd)) {
            handle_haptic(&cmd);
        } else {
            ESP_LOGW(TAG_MQTT, "Failed to decode HapticCmd");
        }

    } else if (strcmp(suffix, "message") == 0) {
        MessageCmd cmd = MessageCmd_init_zero;
        pb_istream_t stream = pb_istream_from_buffer(data, data_len);
        if (pb_decode(&stream, MessageCmd_fields, &cmd)) {
            handle_message(&cmd);
        } else {
            ESP_LOGW(TAG_MQTT, "Failed to decode MessageCmd");
        }

    } else {
        RawCmd cmd = RawCmd_init_zero;
        pb_istream_t stream = pb_istream_from_buffer(data, data_len);
        if (pb_decode(&stream, RawCmd_fields, &cmd)) {
            handle_raw(topic, &cmd);
        } else {
            ESP_LOGW(TAG_MQTT, "Failed to decode RawCmd for topic %s", topic);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// STATUS PUBLISHER
// ─────────────────────────────────────────────────────────────────────────

static void publish_status(void) {
    if (!s_mqtt_client) return;

    StatusMsg msg = StatusMsg_init_zero;
    strncpy(msg.device_id, DEVICE_ID,        sizeof(msg.device_id) - 1);
    strncpy(msg.firmware,  FIRMWARE_VERSION, sizeof(msg.firmware)  - 1);

    esp_netif_ip_info_t ip_info = {};
    esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_get_ip_info(netif, &ip_info);
        snprintf(msg.ip, sizeof(msg.ip), IPSTR, IP2STR(&ip_info.ip));
    }

    wifi_ap_record_t ap_info = {};
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        msg.rssi = ap_info.rssi;
    }

    msg.uptime    = (int32_t)(esp_timer_get_time() / 1000000LL);
    msg.free_heap = (int32_t)esp_get_free_heap_size();
    msg.led_state = s_led_on;
    msg.timestamp = (int64_t)(esp_timer_get_time() / 1000LL);
    msg.online    = true;

    uint8_t buf[StatusMsg_size];
    pb_ostream_t stream = pb_ostream_from_buffer(buf, sizeof(buf));
    if (!pb_encode(&stream, StatusMsg_fields, &msg)) {
        ESP_LOGE(TAG_MQTT, "Failed to encode StatusMsg");
        return;
    }

    int msg_id = esp_mqtt_client_publish(
        s_mqtt_client,
        s_topic_status,
        (const char*)buf,
        (int)stream.bytes_written,
        1,   // QoS 1
        1    // retain
    );
    ESP_LOGI(TAG_MQTT, "→ %s (%u bytes) msg_id=%d",
             s_topic_status, (unsigned)stream.bytes_written, msg_id);
}

// ─────────────────────────────────────────────────────────────────────────
// MQTT EVENT HANDLER
// ─────────────────────────────────────────────────────────────────────────

static void mqtt_event_handler(void* handler_args, esp_event_base_t base,
                               int32_t event_id, void* event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG_MQTT, "Connected to broker");
            esp_mqtt_client_subscribe(s_mqtt_client, s_topic_cmd_sub, 1);
            ESP_LOGI(TAG_MQTT, "Subscribed to %s", s_topic_cmd_sub);
            publish_status();
            break;

        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG_MQTT, "Disconnected — will retry");
            break;

        case MQTT_EVENT_DATA:
            if (event->topic && event->data) {
                // Copy topic (not null-terminated in event struct)
                char topic_buf[128] = {0};
                int tlen = event->topic_len < (int)(sizeof(topic_buf) - 1)
                           ? event->topic_len : (int)(sizeof(topic_buf) - 1);
                memcpy(topic_buf, event->topic, tlen);
                route_mqtt_data(topic_buf,
                                (const uint8_t*)event->data,
                                event->data_len);
            }
            break;

        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG_MQTT, "MQTT error");
            break;

        default:
            break;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// WIFI EVENT HANDLER
// ─────────────────────────────────────────────────────────────────────────

static void wifi_event_handler(void* arg, esp_event_base_t event_base,
                               int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();

    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_wifi_retry_count < WIFI_MAX_RETRY) {
            esp_wifi_connect();
            s_wifi_retry_count++;
            ESP_LOGW(TAG_WIFI, "Retrying WiFi (%d/%d)...", s_wifi_retry_count, WIFI_MAX_RETRY);
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            ESP_LOGE(TAG_WIFI, "Failed to connect after %d attempts", WIFI_MAX_RETRY);
        }

    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t* evt = (ip_event_got_ip_t*)event_data;
        ESP_LOGI(TAG_WIFI, "Got IP: " IPSTR, IP2STR(&evt->ip_info.ip));
        s_wifi_retry_count = 0;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// WIFI INIT
// ─────────────────────────────────────────────────────────────────────────

static void wifi_init_sta(void) {
    s_wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &instance_got_ip));

    wifi_config_t wifi_cfg = {};
    strncpy((char*)wifi_cfg.sta.ssid,     WIFI_SSID,     sizeof(wifi_cfg.sta.ssid) - 1);
    strncpy((char*)wifi_cfg.sta.password, WIFI_PASSWORD, sizeof(wifi_cfg.sta.password) - 1);
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG_WIFI, "Connecting to %s...", WIFI_SSID);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdFALSE, pdFALSE, portMAX_DELAY);
    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG_WIFI, "Connected!");
    } else {
        ESP_LOGE(TAG_WIFI, "WiFi connection failed");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// MQTT INIT
// ─────────────────────────────────────────────────────────────────────────

static void mqtt_init(void) {
    // Build LWT payload: zero-byte StatusMsg (online=false by default)
    // The HA integration treats an empty payload as device-offline.
    esp_mqtt_client_config_t cfg = {};
    cfg.broker.address.uri       = MQTT_BROKER_URI;
    cfg.credentials.username     = MQTT_USERNAME;
    cfg.credentials.authentication.password = MQTT_PASSWORD;
    cfg.credentials.client_id    = DEVICE_ID;
    cfg.session.keepalive         = 60;
    cfg.session.last_will.topic   = s_topic_status;
    cfg.session.last_will.msg     = "";
    cfg.session.last_will.msg_len = 0;
    cfg.session.last_will.qos    = 1;
    cfg.session.last_will.retain = 1;
    cfg.buffer.size              = 1024;

    s_mqtt_client = esp_mqtt_client_init(&cfg);
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(
        s_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(s_mqtt_client));
}

// ─────────────────────────────────────────────────────────────────────────
// LED STRIP INIT
// ─────────────────────────────────────────────────────────────────────────

static void led_strips_init(void) {
    led_strip_config_t display_cfg = {
        .strip_gpio_num         = DISPLAY_LIGHTS_PIN,
        .max_leds               = NUM_DISPLAY_LEDS,
        .led_model              = LED_MODEL_WS2812,          // declared before color_component_format in ESP-IDF 5.5.x
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
        .flags                  = { .invert_out = false },
    };
    led_strip_rmt_config_t display_rmt_cfg = {
        .clk_src       = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,  // 10 MHz
        .flags         = { .with_dma = false },
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&display_cfg, &display_rmt_cfg, &s_display_strip));

    led_strip_config_t grip_cfg = {
        .strip_gpio_num         = GRIP_LIGHTS_PIN,
        .max_leds               = NUM_GRIP_LEDS,
        .led_model              = LED_MODEL_WS2812,          // declared before color_component_format in ESP-IDF 5.5.x
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
        .flags                  = { .invert_out = false },
    };
    led_strip_rmt_config_t grip_rmt_cfg = {
        .clk_src       = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
        .flags         = { .with_dma = false },
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&grip_cfg, &grip_rmt_cfg, &s_grip_strip));

    led_strip_clear(s_display_strip);
    led_strip_clear(s_grip_strip);

    ESP_LOGI(TAG_LED, "LED strips ready — display(%d LEDs, GPIO%d) grip(%d LEDs, GPIO%d)",
             NUM_DISPLAY_LEDS, DISPLAY_LIGHTS_PIN,
             NUM_GRIP_LEDS, GRIP_LIGHTS_PIN);
}

// ─────────────────────────────────────────────────────────────────────────
// HAPTIC (LEDC) INIT
// ─────────────────────────────────────────────────────────────────────────

static void haptic_init(void) {
    ledc_timer_config_t timer_cfg = {
        .speed_mode      = LEDC_MODE,
        .duty_resolution = LEDC_DUTY_RES,   // must come before timer_num (ESP-IDF 5.x struct order)
        .timer_num       = LEDC_TIMER,
        .freq_hz         = LEDC_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer_cfg));

    ledc_channel_config_t channel_cfg = {
        .gpio_num   = MOTOR_PIN,
        .speed_mode = LEDC_MODE,
        .channel    = LEDC_CHANNEL,
        .timer_sel  = LEDC_TIMER,
        .duty       = 0,
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel_cfg));

    ESP_LOGI(TAG_HAPTIC, "Haptic motor ready — GPIO%d LEDC %d Hz 8-bit",
             MOTOR_PIN, LEDC_FREQ_HZ);
}

// ─────────────────────────────────────────────────────────────────────────
// STATUS LOOP TASK
// ─────────────────────────────────────────────────────────────────────────

static void status_loop_task(void* pvParam) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(STATUS_INTERVAL_MS));
        publish_status();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// APP MAIN
// ─────────────────────────────────────────────────────────────────────────

extern "C" void app_main(void) {
    ESP_LOGI(TAG_MAIN, "ESP32 Commander PDN Firmware v%s  device=%s",
             FIRMWARE_VERSION, DEVICE_ID);

    // NVS required by WiFi driver
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Build topic strings
    snprintf(s_topic_status,  sizeof(s_topic_status),  "esp32/%s/status",  DEVICE_ID);
    snprintf(s_topic_cmd_sub, sizeof(s_topic_cmd_sub), "esp32/%s/cmd/#",   DEVICE_ID);

    // Hardware init
    s_led_mutex = xSemaphoreCreateMutex();
    led_strips_init();
    haptic_init();
    display_init();
    display_show_idle();

    // Brief startup flash: white on both strips for 500 ms
    set_all_leds(20, 20, 20);
    vTaskDelay(pdMS_TO_TICKS(500));
    clear_all_leds();

    // Network + MQTT
    wifi_init_sta();
    mqtt_init();

    // Periodic status publisher
    xTaskCreate(status_loop_task, "status_loop", 4096, NULL, 4, NULL);

    ESP_LOGI(TAG_MAIN, "Init complete");
}
