#include "device_identity.h"

#include <stdio.h>
#include <string.h>
#include "esp_mac.h"
#include "esp_random.h"
#include "mbedtls/constant_time.h"
#include "mbedtls/platform_util.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "psa/crypto.h"

typedef struct {
    uint32_t version;
    uint32_t iterations;
    uint8_t salt[16];
    uint8_t digest[32];
} owner_record_t;

static bool initialized;
static char device_id[13];
static char ap_password[64];
static uint8_t claim_salt[16];
static uint8_t claim_digest[32];
static owner_record_t owner;

static esp_err_t read_blob(nvs_handle_t handle, const char *key, void *output, size_t expected)
{
    size_t length = expected;
    esp_err_t result = nvs_get_blob(handle, key, output, &length);
    return result == ESP_OK && length != expected ? ESP_ERR_INVALID_SIZE : result;
}

static bool derive(const char *password, const uint8_t salt[16], uint8_t digest[32])
{
    psa_key_derivation_operation_t operation = PSA_KEY_DERIVATION_OPERATION_INIT;
    psa_status_t result = psa_key_derivation_setup(&operation, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
    if (result == PSA_SUCCESS) result = psa_key_derivation_input_integer(&operation, PSA_KEY_DERIVATION_INPUT_COST, DEVICE_KDF_ITERATIONS);
    if (result == PSA_SUCCESS) result = psa_key_derivation_input_bytes(&operation, PSA_KEY_DERIVATION_INPUT_SALT, salt, 16);
    if (result == PSA_SUCCESS) result = psa_key_derivation_input_bytes(&operation, PSA_KEY_DERIVATION_INPUT_PASSWORD, (const uint8_t *)password, strlen(password));
    if (result == PSA_SUCCESS) result = psa_key_derivation_output_bytes(&operation, digest, 32);
    psa_key_derivation_abort(&operation);
    return result == PSA_SUCCESS;
}

static bool verify(const char *password, const uint8_t salt[16], const uint8_t expected[32])
{
    uint8_t digest[32] = {0};
    bool matches = derive(password, salt, digest) && mbedtls_ct_memcmp(digest, expected, sizeof(digest)) == 0;
    mbedtls_platform_zeroize(digest, sizeof(digest));
    return matches;
}

esp_err_t device_identity_init(void)
{
    if (initialized) return ESP_OK;
    esp_err_t result = nvs_flash_init();
    if (result != ESP_OK) return result;
    uint8_t mac[6];
    result = esp_efuse_mac_get_default(mac);
    if (result != ESP_OK) return result;
    snprintf(device_id, sizeof(device_id), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    nvs_handle_t handle;
    result = nvs_open("kb_identity", NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;
    uint32_t version = 0;
    uint32_t iterations = 0;
    char provisioned_id[sizeof(device_id)] = {0};
    size_t length = sizeof(provisioned_id);
    result = nvs_get_u32(handle, "version", &version);
    if (result == ESP_OK && version != 1) result = ESP_ERR_INVALID_VERSION;
    if (result == ESP_OK) result = nvs_get_str(handle, "device_id", provisioned_id, &length);
    if (result == ESP_OK && (length != sizeof(provisioned_id) || strcmp(provisioned_id, device_id) != 0)) result = ESP_ERR_INVALID_ARG;
    length = sizeof(ap_password);
    if (result == ESP_OK) result = nvs_get_str(handle, "ap_password", ap_password, &length);
    if (result == ESP_OK && (length < 9 || length > sizeof(ap_password))) result = ESP_ERR_INVALID_SIZE;
    if (result == ESP_OK) {
        for (size_t index = 0; index + 1 < length; index++) {
            if (ap_password[index] < 32 || ap_password[index] > 126) result = ESP_ERR_INVALID_ARG;
        }
    }
    if (result == ESP_OK) result = read_blob(handle, "claim_salt", claim_salt, sizeof(claim_salt));
    if (result == ESP_OK) result = read_blob(handle, "claim_hash", claim_digest, sizeof(claim_digest));
    if (result == ESP_OK) result = nvs_get_u32(handle, "claim_cost", &iterations);
    if (result == ESP_OK && iterations != DEVICE_KDF_ITERATIONS) result = ESP_ERR_INVALID_VERSION;
    if (result == ESP_OK) {
        result = read_blob(handle, "owner", &owner, sizeof(owner));
        if (result == ESP_ERR_NVS_NOT_FOUND) {
            owner = (owner_record_t){0};
            result = ESP_OK;
        } else if (result == ESP_OK && (owner.version != 1 || owner.iterations != DEVICE_KDF_ITERATIONS)) {
            result = ESP_ERR_INVALID_VERSION;
        }
    }
    if (result == ESP_OK) {
        uint8_t consumed = 0;
        esp_err_t marker = nvs_get_u8(handle, "claim_used", &consumed);
        if (marker == ESP_ERR_NVS_NOT_FOUND) {
            if (owner.version == 1) {
                result = nvs_set_u8(handle, "claim_used", 1);
                if (result == ESP_OK) result = nvs_commit(handle);
            }
        } else if (marker != ESP_OK) {
            result = marker;
        } else if (consumed != 1 || owner.version != 1) {
            result = ESP_ERR_INVALID_STATE;
        }
    }
    nvs_close(handle);
    if (result == ESP_OK && psa_crypto_init() != PSA_SUCCESS) result = ESP_FAIL;
    initialized = result == ESP_OK;
    if (!initialized) {
        mbedtls_platform_zeroize(ap_password, sizeof(ap_password));
        mbedtls_platform_zeroize(claim_digest, sizeof(claim_digest));
        mbedtls_platform_zeroize(&owner, sizeof(owner));
    } else if (owner.version == 1) {
        mbedtls_platform_zeroize(claim_salt, sizeof(claim_salt));
        mbedtls_platform_zeroize(claim_digest, sizeof(claim_digest));
    }
    return result;
}

bool device_identity_ready(void)
{
    return initialized;
}

bool device_identity_claimed(void)
{
    return initialized && owner.version == 1;
}

const char *device_identity_id(void)
{
    return device_id;
}

const char *device_identity_ap_password(void)
{
    return initialized ? ap_password : "";
}

bool device_identity_verify(const char *password)
{
    return device_identity_claimed() && password != NULL && strlen(password) >= DEVICE_PASSWORD_MIN &&
           strlen(password) <= DEVICE_PASSWORD_MAX && verify(password, owner.salt, owner.digest);
}

esp_err_t device_identity_claim(const char *setup_code, const char *password)
{
    if (!initialized || device_identity_claimed()) return ESP_ERR_INVALID_STATE;
    if (setup_code == NULL || strlen(setup_code) != 24 || password == NULL ||
        strlen(password) < DEVICE_PASSWORD_MIN || strlen(password) > DEVICE_PASSWORD_MAX) return ESP_ERR_INVALID_ARG;
    if (!verify(setup_code, claim_salt, claim_digest)) return ESP_ERR_INVALID_CRC;
    owner_record_t candidate = { .version = 1, .iterations = DEVICE_KDF_ITERATIONS };
    esp_fill_random(candidate.salt, sizeof(candidate.salt));
    if (!derive(password, candidate.salt, candidate.digest)) {
        mbedtls_platform_zeroize(&candidate, sizeof(candidate));
        return ESP_FAIL;
    }
    nvs_handle_t handle;
    esp_err_t result = nvs_open("kb_identity", NVS_READWRITE, &handle);
    if (result == ESP_OK) {
        result = nvs_set_u8(handle, "claim_used", 1);
        if (result == ESP_OK) result = nvs_commit(handle);
        if (result == ESP_OK) result = nvs_set_blob(handle, "owner", &candidate, sizeof(candidate));
        if (result == ESP_OK) result = nvs_commit(handle);
        nvs_close(handle);
    }
    if (result == ESP_OK) {
        owner = candidate;
        mbedtls_platform_zeroize(claim_salt, sizeof(claim_salt));
        mbedtls_platform_zeroize(claim_digest, sizeof(claim_digest));
    } else {
        initialized = false;
    }
    mbedtls_platform_zeroize(&candidate, sizeof(candidate));
    return result;
}