#pragma once

#include <stdbool.h>
#include "esp_err.h"

#define DEVICE_PASSWORD_MIN 12
#define DEVICE_PASSWORD_MAX 128
#define DEVICE_KDF_ITERATIONS 10

esp_err_t device_identity_init(void);
bool device_identity_ready(void);
bool device_identity_claimed(void);
const char *device_identity_id(void);
const char *device_identity_ap_password(void);
bool device_identity_verify(const char *password);
esp_err_t device_identity_claim(const char *setup_code, const char *password);