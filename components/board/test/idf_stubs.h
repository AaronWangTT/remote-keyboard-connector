#pragma once

#include <stddef.h>
#include <stdint.h>

#ifndef CONFIG_BOARD_XINLUCITY_ESP32S3_NANO
#define CONFIG_BOARD_XINLUCITY_ESP32S3_NANO 0
#endif
#ifndef CONFIG_IDF_TARGET_ESP32S3
#define CONFIG_IDF_TARGET_ESP32S3 0
#endif

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL (-1)
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_NOT_SUPPORTED 3
#define ESP_ERR_NO_MEM 4
#define ESP_ERR_TIMEOUT 5
#define ESP_ERR_NVS_NOT_FOUND 6
#define ESP_ERR_SLEEP_REJECT 7

typedef void *TaskHandle_t;
typedef void (*TaskFunction_t)(void *);
typedef uint32_t TickType_t;
#define pdPASS 1
#define pdMS_TO_TICKS(milliseconds) (milliseconds)
#define tskIDLE_PRIORITY 0

int xTaskCreate(TaskFunction_t entry, const char *name, uint32_t stack_size, void *argument,
                unsigned priority, TaskHandle_t *handle);
void vTaskDelay(TickType_t ticks);
void vTaskDelete(TaskHandle_t handle);
int64_t esp_timer_get_time(void);
const char *esp_err_to_name(esp_err_t error);
void test_log(const char *tag, const char *format, ...);
#define ESP_LOGW(...) test_log(__VA_ARGS__)

typedef int gpio_num_t;
#define GPIO_NUM_48 48
#define GPIO_NUM_0 0
#define GPIO_MODE_INPUT 2
#define GPIO_PULLUP_ENABLE 1
#define GPIO_MODE_OUTPUT 1
#define GPIO_PULLUP_DISABLE 0
#define GPIO_PULLDOWN_DISABLE 0
#define GPIO_INTR_DISABLE 0
typedef struct {
    uint64_t pin_bit_mask;
    int mode;
    int pull_up_en;
    int pull_down_en;
    int intr_type;
} gpio_config_t;

esp_err_t gpio_set_level(gpio_num_t pin, uint32_t level);
esp_err_t gpio_config(const gpio_config_t *configuration);
int gpio_get_level(gpio_num_t pin);
esp_err_t gpio_hold_en(gpio_num_t pin);
esp_err_t gpio_hold_dis(gpio_num_t pin);
void gpio_deep_sleep_hold_en(void);
void gpio_deep_sleep_hold_dis(void);
esp_err_t rtc_gpio_deinit(gpio_num_t pin);
esp_err_t rtc_gpio_pullup_en(gpio_num_t pin);
esp_err_t rtc_gpio_pulldown_dis(gpio_num_t pin);
#define ESP_SLEEP_WAKEUP_ALL 0
#define ESP_EXT1_WAKEUP_ANY_LOW 0
esp_err_t esp_sleep_disable_wakeup_source(int source);
esp_err_t esp_sleep_enable_ext1_wakeup_io(uint64_t pins, int level);
esp_err_t esp_sleep_disable_ext1_wakeup_io(uint64_t pins);
esp_err_t esp_deep_sleep_try_to_start(void);
typedef unsigned nvs_handle_t;
typedef int nvs_open_mode_t;
#define NVS_READONLY 0
#define NVS_READWRITE 1
esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *handle);
esp_err_t nvs_get_u32(nvs_handle_t handle, const char *key, uint32_t *value);
esp_err_t nvs_set_u32(nvs_handle_t handle, const char *key, uint32_t value);
esp_err_t nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);

typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
void test_enter_critical(portMUX_TYPE *lock);
void test_exit_critical(portMUX_TYPE *lock);
#define portENTER_CRITICAL(lock) test_enter_critical(lock)
#define portEXIT_CRITICAL(lock) test_exit_critical(lock)

typedef void *httpd_handle_t;
typedef void (*httpd_work_fn_t)(void *);
#define HTTPD_WS_CLIENT_WEBSOCKET 2
esp_err_t httpd_queue_work(httpd_handle_t handle, httpd_work_fn_t work, void *argument);
int httpd_ws_get_fd_info(httpd_handle_t handle, int socket);