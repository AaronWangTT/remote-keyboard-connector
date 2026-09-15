# Board Status LED Proposal

Date: 2026-09-15
Status: draft for discussion; not implemented or approved for device installation.

This proposal is on a separate documentation branch based on `origin/main`.
It does not change firmware, GPIO configuration, the web UI, settings, or
packaging, and does not authorize flashing or hardware modification.

## Goal And Scope

Use the board's two LEDs as power indication plus application status. Make it
easy to distinguish a powered board, a keyboard ready for remote control, and
an active browser controller without opening a serial monitor.

The proposed first increment is deliberately small:

- Leave the fixed PWR LED unchanged.
- Use G48 for three application states: ready and idle, actively controlled,
  and not ready.
- Keep detailed fault information in the browser and logs.
- Preserve all existing authentication, control-lease, and USB release behavior.

Brightness control is an optional follow-up, not a requirement for the first
increment. Caps Lock mirroring, per-report activity, device identification,
startup self-test patterns, and hardware modifications are deferred.

## Verified Board Wiring

The user supplied the [XinluCity vendor resource page][vendor] for the
ESP32S3 NANO / ESP32-S3-N16R8 board. The vendor specifies 16 MB flash and
8 MB on-chip PSRAM. Its [component diagram][layout] and [schematic][schematic]
show two ordinary LEDs beside USB-C:

| Marking | Circuit | Software capability |
| --- | --- | --- |
| PWR | `3V3 -> R13 (4.7 kOhm) -> LED -> GND` | None. It indicates that the supply is present, not that firmware or communications are healthy. |
| G48 | `3V3 -> LED1 -> R25 (4.7 kOhm) -> GPIO48` | Active-low: output LOW turns the LED on; output HIGH turns it off. |

G48 is a discrete single-color LED, not an addressable RGB/WS2812 device.

These wiring facts were checked against vendor documentation on 2026-09-15.
They are not a physical GPIO test. Confirm polarity and visible behavior on
the actual board before accepting an implementation. Older
[hardware notes](../hardware/README.md) still contain unconfirmed fields;
reconcile those records when the implementation and hardware check land.

## Proposed Status Patterns

Patterns use a two-second cycle and fixed full-on brightness initially.
The timing below describes visible light, not the inverted GPIO level.

| State | G48 pattern | Meaning |
| --- | --- | --- |
| `READY_IDLE` | ON for 100 ms, OFF for 1900 ms | Control services and USB are ready; no live controlling browser connection exists. |
| `CONTROL_ACTIVE` | Steady ON | An authenticated browser has a valid active control connection and USB is ready. |
| `NOT_READY` | ON 100 ms, OFF 100 ms, ON 100 ms, OFF 1700 ms | A required capability is unavailable, unknown, or blocked. Consult the browser or logs for the reason. |

Start a new cycle when the state changes; do not restart it on every status
refresh. Use monotonic time and skip missed edges after scheduling delays
instead of replaying a burst of flashes.

Before LED initialization, no application pattern is promised. Once the LED
service starts, default to `NOT_READY` until readiness has been established.
An unlit G48 alone is not a fault diagnosis: the pattern may be in its OFF
phase, the application may not have initialized it, or LED support may be
disabled for the selected board profile. PWR retains its independent meaning.

## State Selection

Resolve the state from authoritative runtime facts, with blocking conditions
taking precedence over a remembered controller:

1. Select `NOT_READY` if a required capability is unavailable or unknown.
2. Otherwise select `CONTROL_ACTIVE` only for a valid live controller.
3. Otherwise select `READY_IDLE`.

Readiness requires successful application/web-service startup, usable network
service, valid identity and completed owner setup, USB readiness, and no
management transition that currently blocks keyboard control. A claimable
setup page alone does not mean the keyboard is ready for typing.

Standalone AP operation is valid: connecting to a router, Internet access,
and mDNS availability must not be prerequisites when the device is otherwise
usable through its direct address. A historical failed scan or configuration
request must not force `NOT_READY` if the current service remains usable.

An active indication requires the controlling WebSocket, valid owner session,
unexpired lease, current USB generation, usable controller network path, and
USB readiness. A login or open browser page is not an active controller.
A pending takeover handshake remains idle, never active.

Separate service capability from permission to grant another lease. In
particular, `network_status_t.can_control` may be false because control is
already reserved; that flag alone must not select `NOT_READY` or prove that
a browser is actively controlling the keyboard.

Logout, control release, session expiry, connection loss, USB disconnect or
suspend, and USB generation changes must clear an obsolete active indication
through the existing authoritative state transitions. LED handling must not
extend a lease or change any existing safety deadline.

## Implementation Direction

The current firmware already exposes
[USB readiness and host Caps Lock feedback](../components/usb_keyboard/include/usb_keyboard.h)
and [network status](../components/network/include/network.h).
The [web server](../components/web_server/web_server.c) owns active and pending
controllers and expires their leases. The
[application entry point](../main/app_main.c) observes startup failures.
No onboard status-LED driver is currently initialized.

Add a board component as the home for GPIO ownership and a small pattern
renderer. Keep application-state selection separate from electrical polarity
and time-based rendering so both can be tested without hardware.
Do not make the board driver depend directly on web-server session internals.

- Select the documented board/pin/polarity explicitly. An unsupported or
  unselected board profile must leave the GPIO untouched; do not assume all
  ESP32-S3 boards have this circuit.
- Initialize GPIO48 to its inactive HIGH level before enabling output. Do not
  touch PWR, USB GPIO19/GPIO20, or pins assigned to flash/PSRAM.
- Use the ESP-IDF GPIO driver; no RGB library or addressable-LED driver is needed.
- Publish a compact, synchronized status snapshot or notification from the
  owning components. Do not dereference HTTP client/session pointers from
  an LED task or sample unrelated flags without a coherent ownership check.
- Refresh the indicator on a bounded cadence, targeting visible state changes
  within 100 ms after the authoritative state changes. Distinguish this from
  the existing time needed to detect a network loss or expire a lease.
- Define snapshot freshness during implementation; stale or invalid status
  must not keep asserting active control while the LED service can still run.
- Keep LED work bounded and low priority. No blocking blink loops, sleeps in
  USB/HTTP callbacks, network operations, or lease mutations in the LED path.
- Log LED initialization/update failures without aborting keyboard startup or
  bypassing input-release behavior. Where possible, leave G48 inactive.

The LED is observational, not a security interlock or a watchdog. A crash can
leave the output latched or a hardware-generated pattern running. Authorization,
input expiry, and all-keys-up behavior must remain independent of what is lit.

## Optional And Deferred Uses

Use one primary status scheme rather than multiplexing unrelated meanings
onto the same light.

| Option | Value | Constraint or reason to defer |
| --- | --- | --- |
| Brightness control | Reduce G48 brightness for desk/night use through ESP-IDF LEDC PWM. | Must preserve active-low semantics and the status patterns. PWM cannot increase maximum brightness or dim PWR. UI and persistence need a separate decision. |
| Caps Lock mirror | Show the host-reported Caps Lock state. | Replaces connection/control status. Unknown host feedback must not be represented as a confirmed Caps Lock state. |
| Identify device | Owner-triggered, distinctive, time-limited locator pattern. | Mainly useful with multiple devices; requires an authenticated command and explicit override/restoration rules. |
| HID report activity | Briefly indicate completed USB HID reports. | Must coalesce/rate-limit pulses; report completion is not proof that an application accepted text. It also reveals typing activity to observers. |
| Startup self-test | Brief illumination after LED initialization. | Confirms only that stage, not successful application startup. Avoid another pattern until it has a clear diagnostic purpose. |
| Breathing effect | A softer visual alternative to a blink. | Requires PWM and a defined meaning; do not add decorative motion to the initial status vocabulary. |

Do not add PWR control by changing supply rails, removing components, or
repurposing other pins as part of this proposal. Such changes are hardware
work, not a firmware feature.

## Verification And Acceptance

Prefer the existing native-test harness and board tests when implementing:

- Test state precedence, unknown/startup state, owner setup, and AP-only
  readiness without a router or mDNS.
- Test valid active control versus pending takeover, logout, expired sessions,
  released leases, USB generation changes, and blocking network transitions.
- Cover the case where `can_control` is false solely because a valid controller
  holds the reservation; it must not appear as a readiness fault.
- Test exact pulse boundaries, repeated unchanged snapshots, phase reset on
  state changes, delayed scheduling, stale status, and active-low output.
- Build the supported ESP32-S3 board profile and an LED-disabled configuration.
  Re-run the relevant USB safety and browser-control tests for touched contracts.

Record physical checks separately, after an explicitly approved firmware write:

- Confirm PWR remains unchanged and G48 polarity matches the schematic.
- Verify the three patterns through startup, owner setup, AP-only and station
  operation, Take Control, release/logout, reconnect, USB unplug, and suspend.
- Verify actual state-change visibility and legibility at the default brightness.
- Confirm focus/network loss still releases input correctly and LED activity
  does not degrade USB report handling or keep a controller alive.

Completion requires both software checks and recorded real-board results.
A successful build or simulated timing test is not physical LED validation.
This proposal records no implementation, firmware build, flash, or GPIO test.

[vendor]: https://www.xinlucity.com/?s=resourcedetail/index/id/114.html
[layout]: https://testxinlu.oss-cn-beijing.aliyuncs.com/static/upload/images/warehouse/2026/06/24/1782294571210690.jpg
[schematic]: https://testxinlu.oss-cn-beijing.aliyuncs.com/static/upload/images/warehouse/2026/06/24/1782294569274239.png