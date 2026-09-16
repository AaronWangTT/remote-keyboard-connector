#include "firmware_update.h"

#include "device_identity.h"
#include "sdkconfig.h"

static const update_descriptor_t descriptor __attribute__((section(".rodata_custom_desc"), used)) = {
    .magic = {'K', 'B', 'O', 'T', 'A', '0', '0', '1'},
    .format_version = 1,
    .bootstrap_version = 1,
    .updater_version = 1,
    .settings_version = 1,
    .kdf_iterations = DEVICE_KDF_ITERATIONS,
    .flash_bytes = 0x1000000,
    .slot_bytes = UPDATE_SLOT_BYTES,
#if CONFIG_KEYBOARD_RELEASE
    .security_profile = 2,
#else
    .security_profile = 1,
#endif
    .product = "remote-keyboard",
#if CONFIG_BOARD_XINLUCITY_ESP32S3_NANO
    .board = "xinlucity-s3-nano-16m",
#else
    .board = "esp32s3-generic-16m",
#endif
    .layout = "kb16-ab6-nvs64-v1",
    .source = FIRMWARE_SOURCE_COMMIT,
    .version = FIRMWARE_VERSION,
};

const update_descriptor_t *firmware_update_descriptor(void)
{
    return &descriptor;
}