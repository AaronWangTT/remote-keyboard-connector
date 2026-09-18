# Board Power Management Proposal

Date: 2026-09-18
Status: discussion proposal; not implemented or physically validated.

This document records the power-management investigation and subsequent product
discussion. It does not authorize firmware implementation, flashing, hardware
modification, or changes to existing settings. Current behavior is unchanged.

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

An approaching-sleep notice with a deliberate cancellation action is a possible
usability refinement, not a prerequisite for physical wake. Its exact timing
and UI, along with placement of the timeout setting, remain design decisions.

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

Any future manual sleep command must be board-local and owner-authorized when
sent over the network. It must not emit a USB HID Power/Sleep usage that shuts
down or suspends the connected host computer.

## USB Suspend Is Separate

The inspected [USB implementation](../components/usb_keyboard/usb_keyboard.c)
marks input offline in `tud_suspend_cb()` but does not stop Wi-Fi there. The
[USB descriptor](../components/usb_keyboard/usb_descriptors.h) does not advertise
remote wakeup. These facts are not evidence of measured suspend-current
compliance.

The [existing power contract](remote-keyboard-design.md#power-debugging-and-recovery)
already requires bus-powered suspend-current compliance and safe input release.
A 30-minute application timeout does not satisfy that separate requirement:
host-directed USB suspend must be handled on its own required timing and power
budget, including Wi-Fi shutdown if needed.

Do not assume host USB resume can wake this GPIO-woken deep-sleep design, or that
enabling generic CPU light sleep is compatible with a live TinyUSB connection.
Define and validate the host-suspend/resume path separately. Waking the board
with BOOT also does not promise to wake a sleeping host computer.

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

Implementation requires separate approval. The following checks are proposed
acceptance work, not tests performed by this document.

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

## Deferred Scope

Manual Sleep now, a long-press BOOT gesture, true power-switch hardware, host
remote wakeup, timed/network wake, further connected-idle optimization, and
brightness control are not part of the initial proposal. The timeout setting's
UI and any pre-sleep warning require a later design decision; no new keyboard
key or shutdown control is implied by this document.
