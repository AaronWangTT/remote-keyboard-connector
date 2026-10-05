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
    .flash_bytes = UPDATE_FLASH_BYTES,
    .slot_bytes = UPDATE_SLOT_BYTES,
#if CONFIG_KEYBOARD_RELEASE
    .security_profile = 2,
#else
    .security_profile = 1,
#endif
    .product = "remote-keyboard",
    .board = UPDATE_BOARD,
    .layout = UPDATE_LAYOUT,
    .source = FIRMWARE_SOURCE_COMMIT,
    .version = FIRMWARE_VERSION,
};

const update_descriptor_t *firmware_update_descriptor(void)
{
    return &descriptor;
}