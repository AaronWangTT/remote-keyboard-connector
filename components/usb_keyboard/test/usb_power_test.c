#include "idf_stubs.h"
#include "usb_keyboard.h"
#include "keyboard_state.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

#include "class/hid/hid.h"

#define pdTRUE 1
#define portMAX_DELAY UINT32_MAX
#define TINYUSB_EVENT_ATTACHED 1
typedef struct { int id; } tinyusb_event_t;
static int semaphore;
static int *state_mutex = &semaphore;
static keyboard_state_t keyboard;
static keyboard_report_t submitted_report;
static keyboard_report_t completed_report;
static bool leds_known;
static bool caps_lock;
static bool sleep_detached;
static bool awaiting_mount;
static int64_t worker_seen_at;
static bool remote_wakeup_enabled;
static usb_keyboard_wake_status_t wakeup;
static uint32_t wakeup_generation;
static uint32_t wakeup_keyboard_generation;
static bool wakeup_key_pressed;
static int64_t wakeup_deadline;
static int64_t now = 1000;
static bool mounted = true;
static bool suspended;
static bool connect_success = true;
static bool remote_wakeup_success = true;
static bool fail_lock;
static unsigned connects;
static unsigned disconnects;
static unsigned reports;
static unsigned remote_wakeups;
static jmp_buf worker_exit;

static int xSemaphoreTake(int *mutex, TickType_t timeout)
{
    (void)timeout;
    assert(mutex == state_mutex && semaphore == 0);
    if (fail_lock) return 0;
    semaphore = 1;
    return pdTRUE;
}
static void xSemaphoreGive(int *mutex) { assert(mutex == state_mutex && semaphore == 1); semaphore = 0; }
int64_t esp_timer_get_time(void) { return now; }
void vTaskDelay(TickType_t ticks) { assert(ticks == 10 && semaphore == 0); now += 10000; longjmp(worker_exit, 1); }
static bool tud_mounted(void) { return mounted; }
static bool tud_suspended(void) { return suspended; }
static bool tud_hid_ready(void) { return true; }
static bool tud_disconnect(void) { disconnects++; return connect_success; }
static bool tud_connect(void) { connects++; return connect_success; }
static bool tud_remote_wakeup(void) { remote_wakeups++; return remote_wakeup_success; }
static bool tud_hid_report(uint8_t instance, const void *report, uint16_t length)
{
    assert(instance == 0 && length == sizeof(keyboard_report_t) && report == &submitted_report);
    reports++;
    return true;
}

#include "usb_power.inc"

static void run_worker(void)
{
    if (setjmp(worker_exit) == 0) keyboard_worker(NULL);
    assert(semaphore == 0 && worker_seen_at != 0);
}

static void complete_report(void)
{
    tud_hid_report_complete_cb(0, (const uint8_t *)&submitted_report, sizeof(submitted_report));
}

int main(void)
{
    keyboard_state_init(&keyboard);
    tinyusb_event_t attached = {.id = TINYUSB_EVENT_ATTACHED};
    usb_event(&attached, NULL);
    run_worker();
    assert(reports == 1 && keyboard_report_empty(&submitted_report));
    complete_report();
    assert(usb_keyboard_quiescent() && usb_keyboard_status().ready);
    uint32_t wakeup_id = 0;
    unsigned previous_reports = reports;
    assert(usb_keyboard_wakeup_begin(&wakeup_id) == ESP_OK);
    usb_keyboard_wake_status_t wake_status = usb_keyboard_wakeup_status(wakeup_id);
    assert(wake_status.state == USB_KEYBOARD_WAKE_PENDING && wake_status.usb_active);
    assert(!wake_status.remote_wakeup_sent && reports == previous_reports);
    run_worker();
    assert(submitted_report.keys[0] == HID_KEY_F24 && submitted_report.keys[1] == 0);
    complete_report();
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    complete_report();
    wake_status = usb_keyboard_wakeup_status(wakeup_id);
    assert(wake_status.state == USB_KEYBOARD_WAKE_DELIVERED && reports == previous_reports + 2);
    usb_keyboard_wakeup_finish(wakeup_id);

    assert(usb_keyboard_wakeup_begin(&wakeup_id) == ESP_OK);
    run_worker();
    assert(submitted_report.keys[0] == HID_KEY_F24);
    complete_report();
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    tud_hid_report_failed_cb(0, HID_REPORT_TYPE_INPUT,
                             (const uint8_t *)&submitted_report, 0);
    wake_status = usb_keyboard_wakeup_status(wakeup_id);
    assert(wake_status.state == USB_KEYBOARD_WAKE_FAILED);
    usb_keyboard_wakeup_finish(wakeup_id);
    run_worker();
    complete_report();
    assert(usb_keyboard_status().ready);

    suspended = true;
    tud_suspend_cb(true);
    assert(usb_keyboard_wakeup_begin(&wakeup_id) == ESP_OK && remote_wakeups == 1);
    wake_status = usb_keyboard_wakeup_status(wakeup_id);
    assert(wake_status.state == USB_KEYBOARD_WAKE_PENDING && wake_status.remote_wakeup_sent &&
           !wake_status.usb_active && !usb_keyboard_quiescent());
    suspended = false;
    tud_resume_cb();
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    complete_report();
    run_worker();
    assert(submitted_report.keys[0] == HID_KEY_F24 && submitted_report.keys[1] == 0);
    complete_report();
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    complete_report();
    wake_status = usb_keyboard_wakeup_status(wakeup_id);
    assert(wake_status.state == USB_KEYBOARD_WAKE_DELIVERED && wake_status.usb_active);
    usb_keyboard_wakeup_finish(wakeup_id);
    assert(usb_keyboard_status().ready);

    suspended = true;
    tud_suspend_cb(false);
    assert(usb_keyboard_wakeup_begin(&wakeup_id) == ESP_ERR_NOT_SUPPORTED && remote_wakeups == 1);
    suspended = false;
    tud_resume_cb();
    run_worker();
    complete_report();
    assert(usb_keyboard_status().ready);

    keyboard_report_t pressed = {.keys = {4}};
    assert(usb_keyboard_submit(keyboard.generation, &pressed));
    assert(!usb_keyboard_quiescent());
    assert(usb_keyboard_sleep(true) == ESP_ERR_INVALID_STATE && disconnects == 0);
    assert(usb_keyboard_begin_maintenance());
    assert(!usb_keyboard_quiescent());
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    assert(usb_keyboard_sleep(true) == ESP_ERR_INVALID_STATE);
    complete_report();
    assert(usb_keyboard_quiescent());
    assert(usb_keyboard_sleep(true) == ESP_OK && disconnects == 1);
    uint32_t old_generation = keyboard.generation;
    usb_event(&attached, NULL);
    tud_resume_cb();
    run_worker();
    assert(!usb_keyboard_status().ready && !keyboard.online && mounted);
    assert(!usb_keyboard_submit(old_generation, &pressed));
    connect_success = false;
    assert(usb_keyboard_sleep(false) == ESP_FAIL && sleep_detached);
    connect_success = true;
    assert(usb_keyboard_sleep(false) == ESP_OK && connects == 2);
    run_worker();
    assert(!usb_keyboard_status().ready && awaiting_mount);
    tud_resume_cb();
    assert(!usb_keyboard_status().ready);
    usb_event(&attached, NULL);
    assert(!usb_keyboard_status().ready && !awaiting_mount);
    run_worker();
    assert(keyboard_report_empty(&submitted_report));
    complete_report();
    assert(usb_keyboard_status().ready && !usb_keyboard_status().leds_known);
    assert(usb_keyboard_heartbeat(keyboard.generation));
    usb_keyboard_release(keyboard.generation);
    tud_suspend_cb(false);
    assert(usb_keyboard_quiescent());
    assert(usb_keyboard_sleep(true) == ESP_OK);
    fail_lock = true;
    assert(usb_keyboard_sleep(false) == ESP_ERR_TIMEOUT);
    puts("PASS: USB F24 wake delivery, failure handling, detach admission, and suspend safety");
    return 0;
}
