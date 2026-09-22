# Board Power Management Proposal

Date: 2026-09-18
Status: implemented behind an explicit board profile; physical acceptance pending.

This document records the power-management investigation, product discussion,
and subsequently authorized software implementation. The implementation record
below distinguishes software checks from pending physical acceptance. Flashing,
hardware modification, and physical power measurements require separate approval.

## Goal And Recommended Direction

Allow the board to remain plugged in without keeping Wi-Fi and the USB keyboard
active indefinitely when unused. Reduce idle energy consumption while preserving
predictable recovery, saved configuration, and input safety.

The user confirmed that pressing BOOT after a long idle period is acceptable.
Continuous browser reachability is therefore not a requirement while asleep.

The recommended baseline is:

- Automatic deep sleep after **30 minutes** without meaningful activity.
- Proposed timeout choices: **30 minutes / 60 minutes / Never**, with 30 minutes
  as the default. The setting should survive ordinary restart and sleep/wake.
- Press BOOT to wake; retain RST as the hardware restart/recovery control.
- Stop Wi-Fi, deliberately disconnect USB HID, and turn the controllable G48
  LED off before deep sleep.
- Preserve saved settings, but require login and explicit Take Control again
  after wake. Never resume held keys or replay queued input.
- No separate power-off key, web shutdown action, or long-press sleep gesture
  in the initial scope.

Call this **sleep**, not power-off. Deep sleep does not remove the board's supply,
and the fixed PWR LED cannot be turned off by firmware.

## Alternatives And Conventions

| Approach | Assessment |
| --- | --- |
| BOOT toggles sleep/wake | Technically plausible with firmware support. A deliberate sleep gesture would be preferable to a single-click toggle, but manual sleep is deferred. |
| Shutdown action, RST to restart | Valid soft-off pattern. ZMK documents this behavior for keyboards without a dedicated wake control. It is not true electrical power-off. |
| Automatic sleep, BOOT wake, RST recovery | Recommended for this accessible board, given acceptance of physical wake after inactivity. |
| Remain connected with idle optimizations | Better for unattended remote access, but saves less than disconnecting services and sleeping. Wi-Fi modem sleep is distinct from deep sleep; AP and station operation need separate evaluation. |
| True power cutoff | Requires unplugging, an appropriate physical supply switch, or additional hardware. Outside this firmware proposal. |

[ZMK's low-power states](https://zmk.dev/docs/features/low-power-states)
distinguish connected idle, deep sleep, and explicit soft-off. This is a useful
product model, not a suggestion to replace this project's firmware framework.
Conventional USB peripherals also cooperate with host-directed suspend/resume;
[USB selective suspend](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/usb-selective-suspend)
is separate from our application's inactivity timer.

Unlike a physical wireless keyboard, this board's browser keys cannot wake it
once Wi-Fi is off. Neither a browser reconnect attempt nor network traffic is a
wake source in the proposed deep-sleep state.

## Hardware Findings And Limits

The investigation reviewed the
[vendor schematic](https://testxinlu.oss-cn-beijing.aliyuncs.com/static/upload/images/warehouse/2026/06/24/1782294569274239.png)
for the XinluCity ESP32S3 NANO / ESP32-S3-N16R8. Exact physical PCB revision and
sleep behavior remain unverified; see the [hardware record](../hardware/README.md).

| Item | Finding and consequence |
| --- | --- |
| BOOT | Pulls GPIO0 low. ESP32-S3 GPIO0 is RTC-wake capable; firmware must configure a suitable low-level wake source before sleeping. This establishes feasibility, not a passed wake test. |
| RST | Connected to the chip's enable/reset input, `CHIP_PU/EN`. It restarts the chip independently of the application and is not an ordinary software-readable button. |
| Supply | No firmware-controlled board supply cutoff is shown. Regulators and other board loads can continue drawing current during chip sleep. |
| PWR | Hard-wired to 3V3 through its resistor. Remains lit while the rail is powered. |
| G48 | Active-low GPIO48 LED. Can be made dark, but its sleep-state electrical behavior must be configured and validated, not inferred from setting it HIGH while awake. |
| USB power | BOOT and RST work only while sufficient supply remains available. A phone or hub may remove power after USB disconnect; reconnecting the cable may then be necessary. |

[ESP-IDF sleep modes](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/sleep_modes.html)
support RTC GPIO wake on the ESP32-S3, including GPIO0. Deep-sleep wake loads the
application again; it is not a continuation of the suspended application task.
Light sleep preserves execution state, but manually stopping Wi-Fi still loses
its connections. Deep sleep fits the accepted reconnect-on-wake behavior.

BOOT wake and RST have different reset causes, but both start fresh application
state under this proposal. Neither is a factory reset. Saved owner credentials,
network configuration, and the proposed timeout setting must remain intact;
browser sessions and controller leases must not be restored across the restart.

Preserve the existing download/recovery procedure. BOOT held during power-on or
an external reset can select the ROM downloader, as described in
[Espressif's boot-mode guidance](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html).
Validate ordinary deep-sleep wake separately from BOOT+RST and power-on with
BOOT held. Do not change strapping circuitry or eFuses for this feature.

## Proposed User Experience

| Situation | Proposed behavior |
| --- | --- |
| Supply first connected | Start normally with saved settings and a fresh inactivity interval. |
| Awake and being used | Preserve existing typing, control-lease, and status LED behavior. |
| Idle below the timeout | Remain available through the current AP or station connection. |
| Timeout reached and safe to sleep | Quiesce input and management work, disconnect services, turn G48 off, and enter deep sleep. |
| Asleep | No Wi-Fi service or USB keyboard connection; no controller can send input. PWR remains independent. |
| BOOT pressed while asleep | Restart application services and enumerate USB again. Rejoin Wi-Fi as needed, log in, and Take Control before typing. |
| BOOT pressed while awake | No new sleep or power-off gesture in the initial scope. |
| RST pressed | Hardware restart, retaining saved settings. Useful if normal wake or firmware operation fails. |

Reconnection is not promised to be instantaneous. In AP mode the controlling
phone may need to rejoin the board's Wi-Fi network. In station mode the board
must reconnect to the router and restore network services. Host USB enumeration
and browser reconnection add their own delays; measure end-to-end usability.

An approaching-sleep notice with a deliberate cancellation action remains a
deferred usability refinement, not a prerequisite for physical wake. The timeout
setting is implemented under Network settings > Power > Auto sleep, with an
explicit Save power setting action and board-persisted values.

## Inactivity Policy

Use board-observed, monotonic elapsed time rather than wall-clock time or a
browser timer. A browser closing, becoming hidden, or losing its connection must
not prevent the firmware from evaluating inactivity.

- Count authorized, deliberate keyboard/control and management actions, such as
  accepted input changes, successful login, Take Control, or a settings action.
- Do not count background polling, WebSocket heartbeats, USB polling, Wi-Fi
  association alone, unauthenticated traffic, or a merely open browser tab.
- A live controller lease by itself is not proof of user activity and must not
  keep an abandoned page awake indefinitely.
- Valid held keys inhibit automatic sleep. Stale or disconnected input still
  follows the existing safety expiry and release rules; sleep must not extend
  those deadlines or preserve a stale held state.
- Inhibit automatic sleep during owner setup, active provisioning or recovery
  transactions, firmware upload/verification/activation, trial-boot validation,
  and settings writes. An idle recovery AP is not by itself ongoing work.
- Begin a fresh quiet interval after startup/wake and after a blocking management
  operation finishes, avoiding an immediate surprise sleep on completion.
- `Never` disables application idle sleep only. It does not override USB suspend
  obligations, input safety, hardware reset, or loss of supply.

Keep inactivity accounting separate from the existing short input-release and
control-lease timers. Do not persist every activity timestamp to flash; only a
deliberate timeout-setting change needs persistence.

## Safe Sleep And Wake

Sleep is a coordinated state transition, not a timer callback that immediately
cuts services:

1. Recheck elapsed inactivity and blockers at transition admission. New accepted
   activity before sleep is committed cancels the transition. Coordinate with
   management and OTA admission so a conflicting operation cannot start midway.
2. Stop accepting new keyboard input and revoke control. Clear pending input and
   send a neutral, all-keys-up report while USB is usable. Wait for bounded report
   completion, not merely queue acceptance.
3. Close controller connections and stop network services and Wi-Fi in a way
   that prevents automatic reconnect tasks from undoing the shutdown. Detach
   USB deliberately instead of leaving an enumerated, unresponsive device.
4. Stop status rendering, leave G48 electrically inactive through sleep, and
   configure BOOT wake with appropriate pin bias and retention. Do not enter
   sleep while BOOT is already held low, which could cause immediate wake.
5. Enter deep sleep. On wake, initialize normal services with empty input state,
   fresh sessions, and a fresh inactivity interval. Consume/debounce the wake
   press and wait for release before considering further button events.

If USB is already disconnected or suspended, the board cannot guarantee delivery
of a release report. Clear its own input state, never defer keys for later
delivery, and preserve neutral-first behavior when USB becomes usable again.

If a required sleep preparation step fails, abort automatic sleep and stay
disarmed, restoring management access where possible. Use bounded waits; do not
sleep blindly after failing to configure wake or while a usable USB connection
still has an incomplete release. RST remains the hardware recovery path.
The implementation disables automatic sleep for the remainder of a boot after
a preparation failure. It also disables sleep on settings read/write failure;
neither case silently changes the saved timeout to Never or erases settings.

Any future manual sleep command must be board-local and owner-authorized when
sent over the network. It must not emit a USB HID Power/Sleep usage that shuts
down or suspends the connected host computer.

## USB Suspend Is Separate

The inspected [USB implementation](../components/usb_keyboard/usb_keyboard.c)
marks ordinary input offline in `tud_suspend_cb()` but does not stop Wi-Fi
there. The [USB descriptor](../components/usb_keyboard/usb_descriptors.h) now
advertises Remote Wakeup for the source-restricted `POST /wakeup` path. That
path requests USB resume and confirms delivery of an F24 press and release while
the board remains powered and network-reachable. These facts are not evidence
of measured suspend-current compliance.

The [existing power contract](remote-keyboard-design.md#power-debugging-and-recovery)
already requires bus-powered suspend-current compliance and safe input release.
A 30-minute application timeout does not satisfy that separate requirement:
host-directed USB suspend must be handled on its own required timing and power
budget, including Wi-Fi shutdown if needed.

Host USB Remote Wakeup cannot wake this GPIO-woken deep-sleep design because
deep sleep stops the network endpoint and detaches USB. Enabling generic CPU
light sleep is also not assumed compatible with a live TinyUSB connection. The
separate host-suspend/resume path is implemented in software but still requires
physical Windows and USB-port validation. Waking the board with BOOT does not
itself promise to wake a sleeping host computer.

## Why Thirty Minutes

The earlier 60-minute suggestion prioritized convenience, not measured energy
efficiency. With physical BOOT wake accepted, 30 minutes is the recommended
starting balance between idle savings and interruptions during ordinary breaks.
There is no universal keyboard convention requiring either timeout.

For an otherwise unblocked idle interval lasting at least one hour, the
30-minute choice replaces an additional half-hour of awake operation with sleep
compared with 60 minutes. Breaks between 30 and 60 minutes become the usability
trade-off: they now require a physical wake and reconnection. Reconnection itself
also consumes energy.

Halving the timeout does not halve total energy use. Actual savings depend on
usage patterns, AP versus station behavior, awake and sleeping board current,
and reconnection frequency. Do not publish a percentage reduction, battery-life
claim, or chip-datasheet sleep current as a board measurement.

## Verification And Acceptance

Software implementation was separately approved. The checklist below defines
acceptance criteria; the implementation record identifies completed software
checks. Physical acceptance remains pending and requires separate approval.

### Software Checks

- Test the 30-minute default, 60-minute option, `Never`, exact timeout boundaries,
  monotonic accounting, and fresh intervals after wake and maintenance.
- Test meaningful activity versus heartbeats/polls, abandoned controller leases,
  held input and safety expiry, and all management/OTA sleep blockers.
- Exercise activity, takeover, settings writes, and OTA admission racing sleep;
  confirm no stuck keys, queued replay, or unauthorized session restoration.
- Test neutral-report completion and failure, USB already unavailable, failed
  sleep preparation, button bounce/held-low behavior, and management recovery.
- Preserve the existing USB and authentication regression checks. Build the
  explicit supported board profile and keep unsupported/generic profiles from
  assuming GPIO0/GPIO48 wiring or silently enabling board-specific sleep.

### Physical Checks

- Confirm the actual PCB's BOOT, RST, LED, and supply wiring against the vendor
  schematic before relying on the proposed pin ownership.
- Measure total current at the board's USB input in active typing, connected
  idle in AP and station modes, deep sleep, and host-directed USB suspend.
  Include regulator, memory, LEDs, and any attached peripherals.
- Repeat BOOT sleep/wake and RST recovery cycles, including held BOOT, bounce,
  BOOT+RST download recovery, and power loss/restoration. Confirm G48 stays dark
  during sleep and PWR retains its independent behavior.
- Verify USB detach/re-enumeration, neutral input, fresh control, retained settings,
  and measured time to usable typing on intended Windows, Mac, iPhone, and iPad
  hosts. Exercise AP and station reconnection separately.
- Verify whether each intended phone/hub keeps supplying power while the board
  is asleep. If it cuts power, document the cable-reconnect requirement and
  reconsider compatibility before promising BOOT-only wake for that host.
- Validate USB suspend/resume and its current budget independently of the idle
  timer, followed by repeated-cycle and overnight idle checks.

Until these checks pass, energy savings, reliable BOOT-only recovery, and USB
power compliance remain unverified. A successful firmware build or simulated
timeout test would not complete the physical acceptance gate.

## Implementation Record

The [board controls](../components/board/Kconfig) gate this feature on
`CONFIG_BOARD_XINLUCITY_ESP32S3_NANO` and ESP32-S3. The new
`CONFIG_BOARD_POWER_MANAGEMENT` defaults to enabled only for that selected
profile and can be disabled at build time. Generic profiles leave BOOT/GPIO0
untouched, report power management unsupported, and hide the settings control.
Existing configurations should be checked explicitly; CI uses a fresh selected
profile and asserts that power management is enabled before accepting its build.

### Policy And Storage

The [idle policy](../components/board/board_power_policy.c) uses monotonic time,
with 30 minutes as the default, 60 minutes as the alternative, and zero for
Never. Completed blocking work starts a fresh interval. Automatic Wi-Fi retries
do not count as user activity; unavailable networking delays admission without
continually restarting the activity clock.

The [power coordinator](../components/web_server/power_control.c) is polled by
the HTTP-owner status publisher, so it never samples controller/session pointers
from a foreign task. Successful login, claim, control actions, network/update
commands, saved timeout changes, and changed accepted input reports count as
activity. Repeated identical reports, GET polling, and heartbeats do not.
Unclaimed setup, pending control, valid held or incomplete USB input, network
management jobs and the existing AP management grace window, OTA work, and
unvalidated startup block sleep. The grace deadline is checked during both
blocker observation and atomic network sleep admission; polling does not extend
it. A fresh idle interval follows its expiry. BOOT must be
released stably for at least 50 ms before admission.

The [board driver](../components/board/board_power.c) stores a single NVS `u32`
at namespace `board_power`, key `idle_minutes`. Missing data selects the default
without writing it. Invalid records and storage failures disable automatic
sleep for that boot. Only a changed, explicitly saved setting writes NVS; input
timestamps are RAM-only. No existing identity/network data or partition layout
is changed.

### Shutdown And Recovery

Sleep admission atomically reserves the network using the current USB/controller
generation before revoking control. A rejected reservation preserves the live
controller and original inactivity deadline, allowing the next valid attempt
without another full timeout. Once admitted, the HTTP owner revokes control and
rejects new mutation requests. A dedicated worker configures GPIO0 low-level EXT1 wake and waits up to
two seconds for USB neutral completion. The network reservation excludes OTA,
management, and control admission; only the network worker stops/restores Wi-Fi.
The sleep worker waits up to three seconds for the stopped acknowledgment before
detaching USB and entering deep sleep. HTTP/mDNS tasks are not destroyed during
preparation; Wi-Fi stop removes reachability, and deep sleep ends execution.
This preserves a recovery path when entry is rejected.

G48 rendering is paused under its output lock and driven HIGH while still awake.
The pin is then changed to `GPIO_MODE_DISABLE`, with input, output, and both
pulls disabled, before enabling pad and deep-sleep hold. This replaces retaining
a driven HIGH output, which left the LED lit in the user's PC and iPad sleep
tests. The new state is a candidate correction; its optical/electrical result
still needs physical verification. No pad-supply or flash/PSRAM setting changes.

If sleep is rejected, the driver restores the HIGH output latch and output
configuration before releasing pad hold, then resumes status rendering. Every
cleanup step is attempted even if an earlier step fails; the first cleanup
error is retained. Startup also sets HIGH/output before releasing retention.
GPIO0, not the USB host or a timer, is the configured wake source. The wake path
is the ordinary application startup, with a fresh policy interval and no saved
controller/session state. RST and BOOT+RST recovery retain their hardware roles.

ESP-IDF v6.1's `ext1_wakeup_prepare()` selects the RTC mux, enables input, and
holds the wake-pin configuration inside sleep entry. BOOT remains a digital
input for the pre-entry held-button checks; an early `rtc_gpio_init()` is not
required. On rejected entry or startup, the board driver explicitly releases
GPIO0's RTC hold before returning the pin to digital input. A native fixture
executes the SDK's actual EXT1 preparation with its ESP32-S3 capability header;
register operations are mocked, so this is not a physical wake test.

If preparation fails, the worker removes the wake configuration and attempts
network/USB restoration without restoring control. After a software USB detach,
the service requires a fresh mount event and neutral report before reporting
ready; TinyUSB's cached configured state alone is insufficient. Hardware failures
can still require RST or cable reconnection. Automatic sleep remains disabled
until restart and the settings view reports its unavailability.

### Settings API

`GET /api/v1/power` requires an owner session and returns `supported`,
`available`, `preparing`, `idle_minutes`, and `error`. The same object is included
as `power` in the authenticated device status response.

`POST /api/v1/power` requires the existing Host/Origin, owner-session, and CSRF
checks, no active/pending keyboard control, and no conflicting network/OTA work.
It accepts an `application/json` object (also with `charset=utf-8`) with one numeric `idle_minutes`
field equal to 0, 30, or 60. Bodies are bounded to 128 bytes; duplicate fields,
unknown fields, invalid types/values, trailing data, and embedded or escaped NUL
are rejected. Successful saves return the current settings object. Unsupported
hardware or unavailable storage returns an error rather than pretending to save.
Settings admission checks active jobs separately from the sleep grace deadline,
so a save is not rejected merely because its authenticated request opens that
grace window.

The browser preserves unsaved choices during polling, prevents stale GET
responses from overwriting a newer save, and reconciles lost responses by
reading settings without replaying the mutation. No shutdown key, automatic
re-arming, or host HID power command is added.

### Software Validation

Local validation on 2026-09-18:

- All 18 native suites passed with ASan/UBSan, including enabled/disabled board
  drivers, real USB service blocks, network reservation/stop/restore races,
  strict request parsing, coordinator failure paths, SDK-backed OTA checks, and
  SDK EXT1 mux/input/hold preparation with rejected-entry cleanup.
- All 26 existing keyboard model tests passed.
- All 88 full browser/API/provisioning tests passed, including the power cases
  below and existing keyboard, layout, authentication, network, and OTA flows.
- All 10 power-focused API/model/Chromium/WebKit tests passed, covering timeout
  choices, physical-wake simulation, held-input/OTA blockers, revoked sessions,
  lost replies, stale reads, storage errors, and unsupported boards.
- Chromium and WebKit settings screenshots and bounds checks passed at
  320x568 and 1280x800, using the existing settings layout.
- The local generic ESP-IDF build succeeded with signed application size 987,136 bytes
  and 84% free per application slot. Required CI also builds the explicit
  XinluCity profile; its final result is recorded on the implementation PR.

The loopback preview models sleep/wake; its `/__test__/power` clock/wake controls
exist only in the development preview, never in firmware. These results do not
measure current, validate real GPIO wake or USB reconnection, or establish USB
suspend-current compliance. The user subsequently confirmed an idle sleep/BOOT
recovery cycle but reported G48 remaining lit on both PC and iPad, as recorded
in the [hardware results](../hardware/README.md#hardware-test-status). This does
not complete the remaining electrical, USB, timing, and endurance checks.

### G48 Sleep Follow-up

On 2026-09-18 the GPIO48-only candidate changed the retained state from driven
HIGH to high impedance with no pulls. A native regression requiring that state
before hold failed on the original implementation and passes with the change.
The board tests also cover disable/hold failures, HIGH/output restoration on
rejected entry, independent cleanup attempts, and error precedence. These checks
verify API sequencing with mocked GPIO operations, not LED current or brightness.

Follow-up software validation passed all 18 native ASan/UBSan suites and 26
keyboard model tests, including normal G48 startup, unsupported/disabled
profiles, and the SDK GPIO0 wake path. The isolated XinluCity 0.1.2 test build
produced a 1,052,672-byte signed application with 83% free per slot. Offline
artifact validation passed against the prior local 0.1.1 public verification
key. This is a local test image, not a release or evidence of physical LED-off
acceptance; no board was flashed.

The 30/60/Never policy, Wi-Fi/USB shutdown, GPIO0 wake, normal awake LED patterns,
PWR circuit, and all flash/PSRAM/eFuse settings are unchanged. High impedance
does not disconnect pad protection paths, so the earlier supply-domain leakage
hypothesis remains unverified rather than proven fixed. A new physical check
must confirm G48 is dark throughout sleep and BOOT restores normal operation.

## Deferred Scope

Manual Sleep now, a long-press BOOT gesture, true power-switch hardware, timed
board wake, further connected-idle optimization, and brightness control are not
part of this implementation. Host Remote Wakeup is implemented separately by
`POST /wakeup`, with physical Windows acceptance still pending. A pre-sleep
warning remains deferred; the timeout setting is implemented without adding a
keyboard key or shutdown control.
