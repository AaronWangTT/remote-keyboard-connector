#include "update_stubs.h"
#include "../firmware_update.c"

#include <assert.h>
#include <setjmp.h>

static int64_t now;
static unsigned enters, begins, writes, aborts, ends, selections, releases, marks, rollbacks;
static size_t erase_bytes, write_offset;
static bool reserved, allow_network, quiescent, signature_ok, activation_ok, health_ok, watchdog_disabled;
static bool cancel_in_begin;
static bool extra_bytes;
static bool check_worker_exit, check_network_release;
static unsigned cleanup_checks;
static void expect_cleanup_busy(void);
static esp_ota_img_states_t boot_state;
static esp_err_t boot_state_result;
static esp_ota_select_entry_t boot_metadata[2];
static unsigned boot_metadata_writes;
static unsigned health_calls;
static void (*boot_entry)(void *);
static jmp_buf task_exit;
static uint8_t flash[8192];
static esp_partition_t partitions[] = {{0x9000, 0x10000, false}, {0x19000, 0x2000, false},
                                      {0x20000, UPDATE_SLOT_BYTES, false}, {0x620000, UPDATE_SLOT_BYTES, false}};
static update_descriptor_t running_descriptor;
static esp_app_desc_t running_app = {.version = "0.1.0", .project_name = "esp32s3_starter"};

void test_update_enter(portMUX_TYPE *mutex) { assert(enters++ == 0 && *mutex == 0); *mutex = 1; }
void test_update_exit(portMUX_TYPE *mutex)
{
    assert(enters-- == 1 && *mutex == 1); *mutex = 0;
    if (check_worker_exit && !worker_active && network_held && !update_policy_busy(&status.policy)) {
        check_worker_exit = false;
        expect_cleanup_busy();
    }
}
int64_t esp_timer_get_time(void) { return now; }
esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *timer)
{ assert(args->callback != NULL); *timer = &now; return ESP_OK; }
esp_err_t esp_timer_start_once(esp_timer_handle_t timer, uint64_t delay)
{ assert(timer == &now && delay == 200000); return ESP_OK; }
int xTaskCreate(void (*entry)(void *), const char *name, uint32_t stack, void *argument, unsigned priority, TaskHandle_t *task)
{ (void)name; (void)argument; assert(stack >= 4096 && priority == 2); boot_entry = entry; *task = &now; return pdPASS; }
void vTaskDelay(unsigned ticks) { assert(enters == 0); now += ticks * 1000; }
void vTaskDelete(void *task) { assert(task == NULL); longjmp(task_exit, 1); }
void esp_restart(void) { longjmp(task_exit, 2); }
void wdt_hal_write_protect_disable(wdt_hal_context_t *context) { (void)context; }
void wdt_hal_disable(wdt_hal_context_t *context)
{ (void)context; watchdog_disabled = true; assert(marks > 0 || boot_state == ESP_OTA_IMG_VALID); }
void wdt_hal_write_protect_enable(wdt_hal_context_t *context) { (void)context; }
esp_err_t esp_flash_get_size(void *chip, uint32_t *size) { (void)chip; *size = 0x1000000; return ESP_OK; }
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *name)
{
    (void)type; (void)subtype;
    const char *names[] = {"nvs", "otadata", "ota_0", "ota_1"};
    for (size_t index = 0; index < 4; index++) if (strcmp(names[index], name) == 0) return &partitions[index];
    return NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *partition, size_t offset, void *data, size_t bytes)
{ assert(partition == &partitions[3] && offset + bytes <= sizeof(flash)); memcpy(data, flash + offset, bytes); return ESP_OK; }
const esp_partition_t *esp_ota_get_running_partition(void) { return &partitions[2]; }
const esp_partition_t *esp_ota_get_next_update_partition(void *start) { assert(start == NULL); return &partitions[3]; }
esp_err_t esp_ota_get_state_partition(const esp_partition_t *partition, esp_ota_img_states_t *state)
{ assert(partition == &partitions[2]); if (boot_state_result == ESP_OK) *state = boot_state; return boot_state_result; }
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void) { assert(health_calls >= 8); marks++; return ESP_OK; }
esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot(void) { rollbacks++; return ESP_FAIL; }
esp_err_t esp_ota_begin(const esp_partition_t *partition, size_t bytes, esp_ota_handle_t *value)
{
    assert(partition == &partitions[3] && reserved && quiescent && enters == 0);
    begins++; erase_bytes = bytes; *value = 42; memset(flash, 0xff, sizeof(flash));
    if (cancel_in_begin) assert(firmware_update_cancel(status.policy.job_id));
    return ESP_OK;
}
esp_err_t esp_ota_write(esp_ota_handle_t value, const void *data, size_t bytes)
{ assert(value == 42 && write_offset + bytes <= sizeof(flash) && reserved && enters == 0); writes++; memcpy(flash + write_offset, data, bytes); write_offset += bytes; return ESP_OK; }
esp_err_t esp_ota_end(esp_ota_handle_t value) { assert(value == 42 && reserved); ends++; return signature_ok ? ESP_OK : ESP_FAIL; }
esp_err_t esp_image_verify(int mode, const esp_partition_pos_t *position, esp_image_metadata_t *metadata)
{ assert(mode == ESP_IMAGE_VERIFY_SILENT && position->offset == 0x620000); metadata->image_len = extra_bytes ? 4096 : position->size; return ESP_OK; }
esp_err_t esp_ota_abort(esp_ota_handle_t value) { assert(value == 42); aborts++; return ESP_OK; }
esp_err_t esp_ota_get_partition_description(const esp_partition_t *partition, esp_app_desc_t *description)
{ assert(partition == &partitions[3]); *description = running_app; strcpy(description->version, "0.1.1"); return ESP_OK; }
const esp_app_desc_t *esp_app_get_description(void) { return &running_app; }
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *partition)
{ assert(partition == &partitions[3] && reserved && ends == 1); selections++; return activation_ok ? ESP_OK : ESP_FAIL; }
int psa_hash_setup(psa_hash_operation_t *operation, int algorithm) { assert(algorithm == PSA_ALG_SHA_256); operation->active = 1; return PSA_SUCCESS; }
int psa_hash_update(psa_hash_operation_t *operation, const uint8_t *data, size_t bytes)
{ assert(operation->active && data != NULL && bytes > 0); return PSA_SUCCESS; }
int psa_hash_finish(psa_hash_operation_t *operation, uint8_t *digest, size_t capacity, size_t *length)
{ assert(operation->active && capacity == 32); memset(digest, 0xab, 32); *length = 32; operation->active = 0; return PSA_SUCCESS; }
int psa_hash_abort(psa_hash_operation_t *operation) { operation->active = 0; return PSA_SUCCESS; }
bool network_update_begin(uint32_t address)
{ assert(!reserved); if (!allow_network || (address != 1 && address != 2)) return false; reserved = true; return true; }
void network_update_end(void)
{
    assert(reserved && enters == 0);
    if (check_network_release) expect_cleanup_busy();
    reserved = false;
    if (check_network_release) expect_cleanup_busy();
    releases++;
}
usb_keyboard_status_t usb_keyboard_status(void) { return (usb_keyboard_status_t){.generation = 1}; }
void usb_keyboard_release(uint32_t generation) { assert(generation == 1); }
bool usb_keyboard_quiescent(void) { return quiescent; }
bool usb_keyboard_begin_maintenance(void) { return true; }
const update_descriptor_t *firmware_update_descriptor(void) { return &running_descriptor; }
static bool healthy(void) { health_calls++; return health_ok; }

static void expect_cleanup_busy(void)
{
    firmware_update_status_t previous = firmware_update_status();
    uint32_t next_job = 0;
    assert(previous.busy);
    assert(firmware_update_reserve(8192, 1, &next_job) == ESP_ERR_INVALID_STATE && next_job == 0);
    assert(status.policy.job_id == previous.policy.job_id && status.policy.phase == previous.policy.phase);
    assert(!worker_active);
    cleanup_checks++;
}

esp_err_t bootloader_common_read_otadata(const esp_partition_pos_t *partition, esp_ota_select_entry_t *records)
{ assert(partition->offset == 0x19000); memcpy(records, boot_metadata, sizeof(boot_metadata)); return ESP_OK; }
uint32_t bootloader_common_ota_select_crc(const esp_ota_select_entry_t *record)
{ return record->ota_seq ^ UINT32_C(0x5a5a5a5a); }
bool bootloader_common_ota_select_invalid(const esp_ota_select_entry_t *record)
{ return record->ota_seq == UINT32_MAX || record->crc != bootloader_common_ota_select_crc(record) ||
    record->ota_state == ESP_OTA_IMG_INVALID || record->ota_state == ESP_OTA_IMG_ABORTED; }
int bootloader_common_get_active_otadata(const esp_ota_select_entry_t *records)
{ return !bootloader_common_ota_select_invalid(&records[0]) ? 0 : !bootloader_common_ota_select_invalid(&records[1]) ? 1 : -1; }
bool esp_efuse_is_flash_encryption_enabled(void) { return false; }
bool write_otadata(const esp_ota_select_entry_t *record, uint32_t offset, bool encrypted)
{
    assert(!encrypted && (offset == 0x19000 || offset == 0x1a000));
    boot_metadata[(offset - 0x19000) / 4096] = *record;
    boot_state = record->ota_state;
    boot_state_result = ESP_OK;
    boot_metadata_writes++;
    return true;
}

#include "sdk_bootloader.inc"

static void reset(void)
{
    status = (firmware_update_status_t){0}; worker_active = network_held = network_releasing = initialized = handle_open = false;
    boot_task = NULL; boot_entry = NULL; target = NULL; hash = (psa_hash_operation_t)PSA_HASH_OPERATION_INIT;
    now = enters = begins = writes = aborts = ends = selections = releases = marks = rollbacks = 0;
    write_offset = erase_bytes = health_calls = 0; reserved = watchdog_disabled = cancel_in_begin = extra_bytes = false;
    allow_network = quiescent = signature_ok = activation_ok = health_ok = true;
    boot_state = ESP_OTA_IMG_VALID;
    boot_state_result = ESP_OK;
    boot_metadata_writes = 0;
    check_worker_exit = check_network_release = false;
    cleanup_checks = 0;
    running_descriptor = (update_descriptor_t){.magic = {'K','B','O','T','A','0','0','1'}, .format_version = 1,
        .bootstrap_version = 1, .updater_version = 1, .settings_version = 1, .kdf_iterations = 10,
        .flash_bytes = 0x1000000, .slot_bytes = UPDATE_SLOT_BYTES, .security_profile = 1,
        .product = "remote-keyboard", .board = "esp32s3-generic-16m", .layout = "kb16-ab6-nvs64-v1",
        .source = "0123456789abcdef0123456789abcdef01234567", .version = "0.1.0"};
}

static uint32_t begin(void)
{
    uint32_t job = 0;
    status.available = true;
    assert(firmware_update_reserve(8192, 2, &job) == ESP_OK && reserved);
    assert(firmware_update_open(job) == ESP_OK && begins == 1 && erase_bytes == 8192);
    return job;
}

static void upload(uint32_t job)
{
    uint8_t image[8192];
    memset(image, 0xff, sizeof(image));
    update_descriptor_t candidate = running_descriptor;
    strcpy(candidate.version, "0.1.1");
    image[0] = 0xe9;
    memcpy(image + UPDATE_DESCRIPTOR_OFFSET, &candidate, sizeof(candidate));
    image[4096] = 0xe7; image[4097] = 2;
    assert(firmware_update_write(job, image, 4096) == ESP_OK);
    assert(firmware_update_write(job, image + 4096, 4096) == ESP_OK);
}

int main(void)
{
#ifdef UPDATE_TEST_SDK_BOOTLOADER
    reset();
    memset(boot_metadata, 0xff, sizeof(boot_metadata));
    boot_state_result = ESP_ERR_NOT_FOUND;
    bootloader_state_t bootstrap = {.ota_info = {.offset = 0x19000, .size = 8192}, .app_count = 2};
    assert(bootloader_utility_get_selected_boot_partition(&bootstrap) == 0 && ota_has_initial_contents);
    assert(firmware_update_init() == ESP_ERR_NOT_FOUND);
    set_actual_ota_seq(&bootstrap, 0);
    assert(boot_metadata_writes == 1 && boot_metadata[0].ota_seq == 1 && boot_metadata[0].ota_state == ESP_OTA_IMG_VALID);
    assert(boot_metadata[0].crc == bootloader_common_ota_select_crc(&boot_metadata[0]));
    assert(firmware_update_init() == ESP_OK && !firmware_update_status().trial_boot);
    assert(firmware_update_validate_boot(healthy) == ESP_OK && firmware_update_status().available);
    assert(bootloader_utility_get_selected_boot_partition(&bootstrap) == 0 && !ota_has_initial_contents);
    set_actual_ota_seq(&bootstrap, 0);
    assert(boot_metadata_writes == 1);
    puts("PASS: SDK initializes erased otadata to a valid ota_0 record before application entry");
#endif
    reset(); boot_state = -1;
    assert(firmware_update_init() == ESP_ERR_INVALID_STATE && !firmware_update_status().available);
    assert(!watchdog_disabled);

    reset(); health_ok = false;
    assert(firmware_update_init() == ESP_OK && !firmware_update_status().trial_boot);
    assert(watchdog_disabled && !firmware_update_status().available && marks == 0 && boot_entry == NULL);
    now += INT64_C(60000000);
    assert(watchdog_disabled && rollbacks == 0 && !firmware_update_status().available);
    assert(firmware_update_validate_boot(healthy) == ESP_OK);
    assert(boot_entry == NULL && health_calls == 0 && marks == 0 && rollbacks == 0);
    assert(watchdog_disabled && firmware_update_status().available);
    assert(firmware_update_validate_boot(healthy) == ESP_ERR_INVALID_STATE);

    reset();
    boot_state = ESP_OTA_IMG_PENDING_VERIFY;
    assert(firmware_update_init() == ESP_OK && !firmware_update_status().available);
    assert(!watchdog_disabled && marks == 0 && boot_entry == NULL);
    assert(firmware_update_validate_boot(healthy) == ESP_OK);
    if (setjmp(task_exit) == 0) boot_entry(NULL);
    assert(watchdog_disabled && marks == 1 && firmware_update_status().available);

    reset(); boot_state = ESP_OTA_IMG_PENDING_VERIFY; health_ok = false;
    assert(firmware_update_init() == ESP_OK && firmware_update_status().trial_boot);
    assert(firmware_update_validate_boot(healthy) == ESP_OK);
    if (setjmp(task_exit) == 0) boot_entry(NULL);
    assert(!watchdog_disabled && marks == 0 && rollbacks == 1 && !firmware_update_status().available);

    reset(); uint32_t job = begin(); upload(job);
    assert(firmware_update_finish(job) == ESP_OK && reserved && selections == 0);
    assert(firmware_update_activate(job, status.digest) != ESP_OK);
    firmware_update_worker_done(job);
    assert(firmware_update_status().policy.phase == UPDATE_STAGED && reserved);
    assert(firmware_update_activate(job + 1, status.digest) != ESP_OK);
    assert(firmware_update_activate(job, "wrong") != ESP_OK);
    assert(firmware_update_activate(job, status.digest) == ESP_OK && selections == 1);
    assert(!firmware_update_cancel(job) && reserved);

    reset(); job = begin(); signature_ok = false; upload(job);
    assert(firmware_update_finish(job) != ESP_OK);
    firmware_update_fail(job, "signature_failed"); firmware_update_worker_done(job);
    assert(!reserved && !firmware_update_status().busy && ends == 1 && selections == 0 && aborts == 0);

    reset(); job = begin(); upload(job); extra_bytes = true;
    assert(firmware_update_finish(job) == ESP_ERR_INVALID_SIZE);
    firmware_update_fail(job, "trailing_data"); firmware_update_worker_done(job);
    assert(!reserved && selections == 0);

    reset(); job = begin();
    assert(firmware_update_cancel(job) && reserved && firmware_update_status().busy);
    assert(firmware_update_reserve(8192, 1, &job) != ESP_OK);
    assert(firmware_update_write(job, flash, 1) != ESP_OK);
    firmware_update_worker_done(job);
    assert(!reserved && aborts == 1 && selections == 0);
    assert(firmware_update_reserve(8192, 1, &job) == ESP_OK);
    firmware_update_worker_done(job - 1);
    assert(firmware_update_status().busy && reserved);
    firmware_update_cancel(job); firmware_update_worker_done(job);

    reset(); job = begin();
    assert(firmware_update_cancel(job));
    check_worker_exit = check_network_release = true;
    firmware_update_worker_done(job);
    assert(cleanup_checks == 3 && !check_worker_exit && releases == 1 && !firmware_update_status().busy);
    check_network_release = false;
    assert(firmware_update_reserve(8192, 1, &job) == ESP_OK);
    firmware_update_cancel(job); firmware_update_worker_done(job);

    reset(); cancel_in_begin = true; job = begin();
    firmware_update_worker_done(job);
    assert(!reserved && aborts == 1 && writes == 0);

    reset(); job = begin(); upload(job); assert(firmware_update_finish(job) == ESP_OK);
    firmware_update_worker_done(job); now += UPDATE_STAGED_TIMEOUT_US;
    firmware_update_tick(); assert(!reserved && firmware_update_activate(job, status.digest) != ESP_OK);

    reset(); job = begin(); upload(job); assert(firmware_update_finish(job) == ESP_OK);
    firmware_update_worker_done(job); activation_ok = false;
    assert(firmware_update_activate(job, status.digest) != ESP_OK && !reserved);

    reset(); status.available = true; allow_network = false;
    assert(firmware_update_reserve(8192, 2, &job) != ESP_OK && begins == 0 && !firmware_update_status().busy);
    puts("update_service: confirmed/trial boots, inactive writes, signatures, cancellation, expiry and activation failures passed");
}