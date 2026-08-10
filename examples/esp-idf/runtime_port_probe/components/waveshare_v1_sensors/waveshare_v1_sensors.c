#include "waveshare_v1_sensors.h"

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdlib.h>
#include <stdatomic.h>

#define QMI_HIGH 0x6BU
#define QMI_LOW 0x6AU
#define QMI_ID 0x00U
#define QMI_ID_VALUE 0x05U
#define QMI_DATA 0x35U
#define QMI_TIMEOUT_MS 100
#define DEFAULT_PERIOD_MS 80U

struct waveshare_v1_sensors {
    i2c_master_dev_handle_t device;
    SemaphoreHandle_t lock;
    SemaphoreHandle_t stopped;
    TaskHandle_t task;
    volatile bool stopping;
    atomic_uint_fast32_t period_ms;
    waveshare_v1_motion_frame_t frame;
};

static int16_t sample(const uint8_t *raw, size_t offset)
{
    return (int16_t)((uint16_t)raw[offset] | ((uint16_t)raw[offset + 1U] << 8U));
}

static esp_err_t write_reg(waveshare_v1_sensors_t *provider, uint8_t reg, uint8_t value)
{
    const uint8_t bytes[] = {reg, value};
    return i2c_master_transmit(provider->device, bytes, sizeof(bytes), QMI_TIMEOUT_MS);
}

static esp_err_t configure(waveshare_v1_sensors_t *provider, i2c_master_bus_handle_t bus)
{
    const uint8_t addresses[] = {QMI_HIGH, QMI_LOW};
    for (size_t index = 0; index < sizeof(addresses); index++) {
        if (i2c_master_probe(bus, addresses[index], QMI_TIMEOUT_MS) != ESP_OK) {
            continue;
        }
        const i2c_device_config_t config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = addresses[index],
            .scl_speed_hz = 400000U,
        };
        if (i2c_master_bus_add_device(bus, &config, &provider->device) != ESP_OK) {
            continue;
        }
        uint8_t id = 0;
        const uint8_t id_register = QMI_ID;
        const esp_err_t identity = i2c_master_transmit_receive(provider->device, &id_register, 1, &id, 1, QMI_TIMEOUT_MS);
        if (identity != ESP_OK || id != QMI_ID_VALUE) {
            (void)i2c_master_bus_rm_device(provider->device);
            provider->device = NULL;
            continue;
        }
        esp_err_t result = write_reg(provider, 0x60U, 0xB0U);
        if (result == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(20));
            result = write_reg(provider, 0x02U, 0x60U);
        }
        if (result == ESP_OK) result = write_reg(provider, 0x03U, 0x15U);
        if (result == ESP_OK) result = write_reg(provider, 0x04U, 0x45U);
        if (result == ESP_OK) result = write_reg(provider, 0x08U, 0x03U);
        if (result == ESP_OK) return ESP_OK;

        (void)i2c_master_bus_rm_device(provider->device);
        provider->device = NULL;
    }
    return ESP_ERR_NOT_FOUND;
}

static void sample_task(void *arg)
{
    waveshare_v1_sensors_t *provider = arg;
    while (!provider->stopping) {
        uint8_t raw[12] = {0};
        const uint8_t data_register = QMI_DATA;
        const esp_err_t result = i2c_master_transmit_receive(provider->device, &data_register, 1, raw, sizeof(raw), QMI_TIMEOUT_MS);
        if (result == ESP_OK && xSemaphoreTake(provider->lock, pdMS_TO_TICKS(2)) == pdTRUE) {
            const waveshare_v1_motion_frame_t next = {
                .available = true,
                .acceleration_mps2 = {
                    (double)sample(raw, 0) * (9.80665 / 8192.0),
                    (double)sample(raw, 2) * (9.80665 / 8192.0),
                    (double)sample(raw, 4) * (9.80665 / 8192.0),
                },
                .angular_velocity_dps = {
                    (double)sample(raw, 6) / 128.0,
                    (double)sample(raw, 8) / 128.0,
                    (double)sample(raw, 10) / 128.0,
                },
                .observed_at_ms = esp_timer_get_time() / 1000,
                .sequence = provider->frame.sequence + 1U,
            };
            provider->frame = next;
            xSemaphoreGive(provider->lock);
        }
        vTaskDelay(pdMS_TO_TICKS(atomic_load(&provider->period_ms)));
    }
    xSemaphoreGive(provider->stopped);
    vTaskDelete(NULL);
}

esp_err_t waveshare_v1_sensors_create(i2c_master_bus_handle_t bus, waveshare_v1_sensors_t **out)
{
    if (bus == NULL || out == NULL) return ESP_ERR_INVALID_ARG;
    *out = NULL;
    waveshare_v1_sensors_t *provider = calloc(1, sizeof(*provider));
    if (provider == NULL) return ESP_ERR_NO_MEM;
    atomic_init(&provider->period_ms, DEFAULT_PERIOD_MS);
    provider->lock = xSemaphoreCreateMutex();
    provider->stopped = xSemaphoreCreateBinary();
    if (provider->lock == NULL || provider->stopped == NULL) {
        if (provider->lock != NULL) vSemaphoreDelete(provider->lock);
        if (provider->stopped != NULL) vSemaphoreDelete(provider->stopped);
        free(provider);
        return ESP_ERR_NO_MEM;
    }
    const esp_err_t configured = configure(provider, bus);
    if (configured != ESP_OK) {
        vSemaphoreDelete(provider->stopped);
        vSemaphoreDelete(provider->lock);
        free(provider);
        return configured;
    }
    if (xTaskCreate(sample_task, "tsx_motion", 3072, provider, 3, &provider->task) != pdPASS) {
        (void)i2c_master_bus_rm_device(provider->device);
        vSemaphoreDelete(provider->stopped);
        vSemaphoreDelete(provider->lock);
        free(provider);
        return ESP_ERR_NO_MEM;
    }
    *out = provider;
    return ESP_OK;
}

void waveshare_v1_sensors_destroy(waveshare_v1_sensors_t *provider)
{
    if (provider == NULL) return;
    provider->stopping = true;
    /* A transfer can block for QMI_TIMEOUT_MS. Waiting for the task's explicit
     * terminal signal keeps the mutex/device allocation alive until it exits. */
    if (provider->task != NULL) {
        (void)xSemaphoreTake(provider->stopped, portMAX_DELAY);
        provider->task = NULL;
    }
    if (provider->device != NULL) (void)i2c_master_bus_rm_device(provider->device);
    vSemaphoreDelete(provider->stopped);
    vSemaphoreDelete(provider->lock);
    free(provider);
}

bool waveshare_v1_sensors_read_motion(waveshare_v1_sensors_t *provider, waveshare_v1_motion_frame_t *out)
{
    if (provider == NULL || out == NULL || xSemaphoreTake(provider->lock, 0) != pdTRUE) return false;
    *out = provider->frame;
    xSemaphoreGive(provider->lock);
    return out->available;
}

esp_err_t waveshare_v1_sensors_set_period_ms(waveshare_v1_sensors_t *provider, uint32_t period_ms)
{
    if (provider == NULL || period_ms < WAVESHARE_V1_MOTION_MIN_PERIOD_MS || period_ms > WAVESHARE_V1_MOTION_MAX_PERIOD_MS) {
        return ESP_ERR_INVALID_ARG;
    }
    atomic_store(&provider->period_ms, period_ms);
    return ESP_OK;
}
