#include "waveshare_v1_wifi.h"

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdlib.h>
#include <string.h>

#define WIFI_COMMAND_QUEUE_DEPTH 4U
#define WIFI_EVENT_QUEUE_DEPTH 8U
#define WIFI_OVERFLOW_QUEUE_DEPTH 1U
#define WIFI_TASK_STOP_TIMEOUT_MS 1000U
#define WIFI_CONNECT_TIMEOUT_MS 15000U

#if defined(CONFIG_TSX_LVGL_WIFI_STATION_ENABLED) && CONFIG_TSX_LVGL_WIFI_STATION_ENABLED
#define TSX_WIFI_STATION_CONFIGURED 1
#else
#define TSX_WIFI_STATION_CONFIGURED 0
#endif

typedef struct {
    waveshare_v1_wifi_command_t command;
    uint32_t correlation_id;
} wifi_command_t;

struct waveshare_v1_wifi {
    QueueHandle_t commands;
    QueueHandle_t events;
    QueueHandle_t overflows;
    SemaphoreHandle_t stopped;
    TaskHandle_t task;
    esp_netif_t *station;
    waveshare_v1_wifi_phase_t phase;
    uint32_t sequence;
    bool active;
    bool configured;
    volatile bool got_ip;
    volatile bool disconnected;
    uint32_t pending_connect;
    TickType_t connect_deadline;
};

static bool send_event(waveshare_v1_wifi_t *wifi, waveshare_v1_wifi_event_kind_t kind,
                       waveshare_v1_wifi_command_t command, uint32_t correlation_id,
                       const char *diagnostic_id)
{
    waveshare_v1_wifi_event_t event = {
        .kind = kind,
        .phase = wifi->phase,
        .command = command,
        .correlation_id = correlation_id,
        .sequence = ++wifi->sequence,
        .rssi_dbm = -127,
        .channel = 1,
        .auth_kind = 5,
        .diagnostic_id = diagnostic_id,
    };
    if (xQueueSend(wifi->events, &event, 0) == pdTRUE) return true;
    /* This one-item queue is a bounded, thread-safe loss notification. It
     * contains only the numeric correlation and a fixed diagnostic string. */
    event.kind = WAVESHARE_V1_WIFI_EVENT_FAILED;
    event.diagnostic_id = "wifi-event-queue-full";
    (void)xQueueOverwrite(wifi->overflows, &event);
    return false;
}

static void on_station_event(void *argument, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)event_data;
    waveshare_v1_wifi_t *wifi = argument;
    if (wifi == NULL) return;
    if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) wifi->got_ip = true;
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) wifi->disconnected = true;
}

static void connect_station(waveshare_v1_wifi_t *wifi, uint32_t correlation_id)
{
#if TSX_WIFI_STATION_CONFIGURED
    wifi_config_t config = {0};
    const size_t ssid_length = strnlen(CONFIG_TSX_LVGL_WIFI_STATION_SSID, sizeof(config.sta.ssid));
    const size_t password_length = strnlen(CONFIG_TSX_LVGL_WIFI_STATION_PASSWORD, sizeof(config.sta.password));
    if (ssid_length == 0U || ssid_length >= sizeof(config.sta.ssid) || password_length >= sizeof(config.sta.password)) {
        send_event(wifi, WAVESHARE_V1_WIFI_EVENT_FAILED, WAVESHARE_V1_WIFI_CONNECT, correlation_id, "wifi-build-config");
        return;
    }
    memcpy(config.sta.ssid, CONFIG_TSX_LVGL_WIFI_STATION_SSID, ssid_length);
    memcpy(config.sta.password, CONFIG_TSX_LVGL_WIFI_STATION_PASSWORD, password_length);
    config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    const esp_err_t set_result = esp_wifi_set_config(WIFI_IF_STA, &config);
    const esp_err_t start_result = esp_wifi_start();
    const esp_err_t connect_result = esp_wifi_connect();
    if (set_result != ESP_OK || start_result != ESP_OK || connect_result != ESP_OK) {
        memset(&config, 0, sizeof(config));
        wifi->phase = WAVESHARE_V1_WIFI_IDLE;
        send_event(wifi, WAVESHARE_V1_WIFI_EVENT_FAILED, WAVESHARE_V1_WIFI_CONNECT, correlation_id, "wifi-station-start");
        return;
    }
    memset(&config, 0, sizeof(config));
    wifi->phase = WAVESHARE_V1_WIFI_CONNECTING;
    wifi->got_ip = false;
    wifi->disconnected = false;
    wifi->pending_connect = correlation_id;
    wifi->connect_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(WIFI_CONNECT_TIMEOUT_MS);
    send_event(wifi, WAVESHARE_V1_WIFI_EVENT_STATE, WAVESHARE_V1_WIFI_CONNECT, correlation_id, NULL);
#else
    (void)wifi;
    (void)correlation_id;
    send_event(wifi, WAVESHARE_V1_WIFI_EVENT_FAILED, WAVESHARE_V1_WIFI_CONNECT, correlation_id, "wifi-disabled");
#endif
}

static void wifi_task(void *argument)
{
    waveshare_v1_wifi_t *wifi = argument;
    wifi_command_t command;
    while (wifi->active) {
        if (xQueueReceive(wifi->commands, &command, pdMS_TO_TICKS(100)) == pdTRUE) switch (command.command) {
            case WAVESHARE_V1_WIFI_SCAN:
                if (!wifi->configured) send_event(wifi, WAVESHARE_V1_WIFI_EVENT_FAILED, command.command, command.correlation_id, "wifi-disabled");
                else send_event(wifi, WAVESHARE_V1_WIFI_EVENT_SUCCEEDED, command.command, command.correlation_id, NULL);
                break;
            case WAVESHARE_V1_WIFI_CONNECT:
                connect_station(wifi, command.correlation_id);
                break;
            case WAVESHARE_V1_WIFI_DISCONNECT:
                if (wifi->configured) (void)esp_wifi_disconnect();
                wifi->pending_connect = 0U;
                wifi->phase = wifi->configured ? WAVESHARE_V1_WIFI_IDLE : WAVESHARE_V1_WIFI_DISABLED;
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_STATE, command.command, command.correlation_id, NULL);
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_SUCCEEDED, command.command, command.correlation_id, NULL);
                break;
        }
        if (wifi->pending_connect != 0U) {
            const uint32_t correlation_id = wifi->pending_connect;
            if (wifi->got_ip) {
                wifi->pending_connect = 0U;
                wifi->phase = WAVESHARE_V1_WIFI_CONNECTED;
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_STATE, WAVESHARE_V1_WIFI_CONNECT, correlation_id, NULL);
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_SUCCEEDED, WAVESHARE_V1_WIFI_CONNECT, correlation_id, NULL);
            } else if (wifi->disconnected || (int32_t)(xTaskGetTickCount() - wifi->connect_deadline) >= 0) {
                wifi->pending_connect = 0U;
                wifi->phase = WAVESHARE_V1_WIFI_IDLE;
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_STATE, WAVESHARE_V1_WIFI_CONNECT, correlation_id, NULL);
                send_event(wifi, WAVESHARE_V1_WIFI_EVENT_FAILED, WAVESHARE_V1_WIFI_CONNECT, correlation_id,
                           wifi->disconnected ? "wifi-association" : "wifi-command-timeout");
            }
        }
    }
    xSemaphoreGive(wifi->stopped);
    vTaskDelete(NULL);
}

esp_err_t waveshare_v1_wifi_create(waveshare_v1_wifi_t **out_wifi)
{
    if (out_wifi == NULL) return ESP_ERR_INVALID_ARG;
    *out_wifi = NULL;
    waveshare_v1_wifi_t *wifi = calloc(1, sizeof(*wifi));
    if (wifi == NULL) return ESP_ERR_NO_MEM;
    wifi->commands = xQueueCreate(WIFI_COMMAND_QUEUE_DEPTH, sizeof(wifi_command_t));
    wifi->events = xQueueCreate(WIFI_EVENT_QUEUE_DEPTH, sizeof(waveshare_v1_wifi_event_t));
    wifi->overflows = xQueueCreate(WIFI_OVERFLOW_QUEUE_DEPTH, sizeof(waveshare_v1_wifi_event_t));
    wifi->stopped = xSemaphoreCreateBinary();
    wifi->configured = TSX_WIFI_STATION_CONFIGURED;
    wifi->phase = wifi->configured ? WAVESHARE_V1_WIFI_IDLE : WAVESHARE_V1_WIFI_DISABLED;
    if (wifi->commands == NULL || wifi->events == NULL || wifi->overflows == NULL || wifi->stopped == NULL) { waveshare_v1_wifi_destroy(wifi); return ESP_ERR_NO_MEM; }
    const esp_err_t netif_result = esp_netif_init();
    if (netif_result != ESP_OK && netif_result != ESP_ERR_INVALID_STATE) { waveshare_v1_wifi_destroy(wifi); return netif_result; }
    const esp_err_t loop_result = esp_event_loop_create_default();
    if (loop_result != ESP_OK && loop_result != ESP_ERR_INVALID_STATE) { waveshare_v1_wifi_destroy(wifi); return loop_result; }
    wifi->station = esp_netif_create_default_wifi_sta();
    if (wifi->station == NULL) { waveshare_v1_wifi_destroy(wifi); return ESP_ERR_NO_MEM; }
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init) != ESP_OK || esp_wifi_set_storage(WIFI_STORAGE_RAM) != ESP_OK || esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK) {
        waveshare_v1_wifi_destroy(wifi); return ESP_FAIL;
    }
    if (esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_station_event, wifi) != ESP_OK ||
        esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_station_event, wifi) != ESP_OK) {
        waveshare_v1_wifi_destroy(wifi); return ESP_FAIL;
    }
    wifi->active = true;
    if (xTaskCreate(wifi_task, "tsx_wifi", 4096, wifi, 4, &wifi->task) != pdPASS) { waveshare_v1_wifi_destroy(wifi); return ESP_ERR_NO_MEM; }
    send_event(wifi, WAVESHARE_V1_WIFI_EVENT_STATE, WAVESHARE_V1_WIFI_SCAN, 0, NULL);
    *out_wifi = wifi;
    return ESP_OK;
}

void waveshare_v1_wifi_destroy(waveshare_v1_wifi_t *wifi)
{
    if (wifi == NULL) return;
    if (wifi->task != NULL) {
        wifi->active = false;
        /* The worker wakes within 100ms, signals stopped, then deletes itself.
         * Do not destroy its queues until this bounded join has succeeded. */
        if (xSemaphoreTake(wifi->stopped, pdMS_TO_TICKS(WIFI_TASK_STOP_TIMEOUT_MS)) != pdTRUE) return;
        wifi->task = NULL;
    }
    (void)esp_event_handler_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, on_station_event);
    (void)esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, on_station_event);
    (void)esp_wifi_stop();
    (void)esp_wifi_deinit();
    if (wifi->station != NULL) esp_netif_destroy_default_wifi(wifi->station);
    if (wifi->commands != NULL) vQueueDelete(wifi->commands);
    if (wifi->events != NULL) vQueueDelete(wifi->events);
    if (wifi->overflows != NULL) vQueueDelete(wifi->overflows);
    if (wifi->stopped != NULL) vSemaphoreDelete(wifi->stopped);
    free(wifi);
}

esp_err_t waveshare_v1_wifi_submit(waveshare_v1_wifi_t *wifi, waveshare_v1_wifi_command_t command,
                                   uint32_t correlation_id)
{
    if (wifi == NULL || !wifi->active || correlation_id == 0U) return ESP_ERR_INVALID_STATE;
    const wifi_command_t entry = { .command = command, .correlation_id = correlation_id };
    return xQueueSend(wifi->commands, &entry, 0) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
}

void waveshare_v1_wifi_cancel(waveshare_v1_wifi_t *wifi, uint32_t correlation_id)
{
    if (wifi != NULL && wifi->pending_connect == correlation_id) {
        wifi->pending_connect = 0U;
        (void)esp_wifi_disconnect();
    }
    /* JS completes cancellation locally. The provider never retains secrets or a caller pointer. */
}

bool waveshare_v1_wifi_take_event(waveshare_v1_wifi_t *wifi, waveshare_v1_wifi_event_t *out_event)
{
    if (wifi == NULL || out_event == NULL) return false;
    if (xQueueReceive(wifi->overflows, out_event, 0) == pdTRUE) return true;
    return xQueueReceive(wifi->events, out_event, 0) == pdTRUE;
}

waveshare_v1_wifi_event_t waveshare_v1_wifi_state(waveshare_v1_wifi_t *wifi)
{
    return (waveshare_v1_wifi_event_t) {
        .kind = WAVESHARE_V1_WIFI_EVENT_STATE,
        .phase = wifi == NULL ? WAVESHARE_V1_WIFI_DISABLED : wifi->phase,
        .command = WAVESHARE_V1_WIFI_SCAN,
        .sequence = wifi == NULL ? 0U : wifi->sequence,
        .rssi_dbm = -127,
        .channel = 1,
        .auth_kind = 5,
    };
}
