#include "waveshare_v1_sensors.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdlib.h>

#define QMI_HIGH 0x6BU
#define QMI_LOW 0x6AU
#define QMI_ID 0x00U
#define QMI_ID_VALUE 0x05U
#define QMI_DATA 0x35U
#define QMI_TIMEOUT_MS 100
#define PERIOD_MS 20
struct waveshare_v1_sensors { i2c_master_dev_handle_t device; SemaphoreHandle_t lock; TaskHandle_t task; volatile bool stopping; waveshare_v1_motion_frame_t frame; };
static int16_t sample(const uint8_t *raw, size_t offset) { return (int16_t)((uint16_t)raw[offset] | ((uint16_t)raw[offset + 1U] << 8U)); }
static esp_err_t write_reg(waveshare_v1_sensors_t *p, uint8_t reg, uint8_t value) { const uint8_t bytes[] = {reg, value}; return i2c_master_transmit(p->device, bytes, sizeof(bytes), QMI_TIMEOUT_MS); }
static esp_err_t configure(waveshare_v1_sensors_t *p, i2c_master_bus_handle_t bus) {
  const uint8_t addresses[] = {QMI_HIGH, QMI_LOW};
  for (size_t i = 0; i < sizeof(addresses); i++) { if (i2c_master_probe(bus, addresses[i], QMI_TIMEOUT_MS) != ESP_OK) continue;
    const i2c_device_config_t config = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addresses[i], .scl_speed_hz = 400000U };
    if (i2c_master_bus_add_device(bus, &config, &p->device) != ESP_OK) continue; uint8_t id = 0;
    if (i2c_master_transmit_receive(p->device, &(uint8_t){QMI_ID}, 1, &id, 1, QMI_TIMEOUT_MS) != ESP_OK || id != QMI_ID_VALUE) { (void)i2c_master_bus_rm_device(p->device); p->device = NULL; continue; }
    if (write_reg(p, 0x60U, 0xB0U) == ESP_OK) { vTaskDelay(pdMS_TO_TICKS(20)); if (write_reg(p, 0x02U, 0x60U) == ESP_OK && write_reg(p, 0x03U, 0x15U) == ESP_OK && write_reg(p, 0x04U, 0x45U) == ESP_OK && write_reg(p, 0x08U, 0x03U) == ESP_OK) return ESP_OK; }
    (void)i2c_master_bus_rm_device(p->device); p->device = NULL;
  } return ESP_ERR_NOT_FOUND;
}
static void sample_task(void *arg) { waveshare_v1_sensors_t *p = arg; while (!p->stopping) { uint8_t raw[12] = {0}; if (p->device != NULL && i2c_master_transmit_receive(p->device, &(uint8_t){QMI_DATA}, 1, raw, sizeof(raw), QMI_TIMEOUT_MS) == ESP_OK && xSemaphoreTake(p->lock, pdMS_TO_TICKS(2)) == pdTRUE) { waveshare_v1_motion_frame_t next = { .available = true, .acceleration_mps2 = {(double)sample(raw, 0) * (9.80665 / 8192.0), (double)sample(raw, 2) * (9.80665 / 8192.0), (double)sample(raw, 4) * (9.80665 / 8192.0)}, .angular_velocity_dps = {(double)sample(raw, 6) / 128.0, (double)sample(raw, 8) / 128.0, (double)sample(raw, 10) / 128.0}, .observed_at_ms = esp_timer_get_time() / 1000, .sequence = p->frame.sequence + 1U }; p->frame = next; xSemaphoreGive(p->lock); } vTaskDelay(pdMS_TO_TICKS(PERIOD_MS)); } vTaskDelete(NULL); }
esp_err_t waveshare_v1_sensors_create(i2c_master_bus_handle_t bus, waveshare_v1_sensors_t **out) { if (bus == NULL || out == NULL) return ESP_ERR_INVALID_ARG; *out = NULL; waveshare_v1_sensors_t *p = calloc(1, sizeof(*p)); if (p == NULL) return ESP_ERR_NO_MEM; p->lock = xSemaphoreCreateMutex(); if (p->lock == NULL) { free(p); return ESP_ERR_NO_MEM; } (void)configure(p, bus); if (xTaskCreate(sample_task, "tsx_motion", 3072, p, 3, &p->task) != pdPASS) { if (p->device != NULL) (void)i2c_master_bus_rm_device(p->device); vSemaphoreDelete(p->lock); free(p); return ESP_ERR_NO_MEM; } *out = p; return ESP_OK; }
void waveshare_v1_sensors_destroy(waveshare_v1_sensors_t *p) { if (p == NULL) return; p->stopping = true; vTaskDelay(pdMS_TO_TICKS(PERIOD_MS + 5)); if (p->device != NULL) (void)i2c_master_bus_rm_device(p->device); vSemaphoreDelete(p->lock); free(p); }
bool waveshare_v1_sensors_read_motion(waveshare_v1_sensors_t *p, waveshare_v1_motion_frame_t *out) { if (p == NULL || out == NULL || xSemaphoreTake(p->lock, 0) != pdTRUE) return false; *out = p->frame; xSemaphoreGive(p->lock); return out->available; }
