# Wi-Fi Enhancement Plan

Date: 2026-09-14

Status: HTTP/WS software implementation and automated checks completed;
private device provisioning and physical acceptance remain pending.
The implementation record below separates executed tests from unverified
hardware behavior. This is not a deployment or shipping sign-off.

This increment follows the [keyboard enhancement](keyboard-enhancement-plan.md)
and refines the [networking and security design](remote-keyboard-design.md#4-wi-fi-modes-and-provisioning).
The agreed direction is two user-facing modes, temporary AP+STA for setup and
recovery, and the preferred browser hostname `kb.local` in both modes.

## Starting Baseline

The following describes the input to this increment, not the current behavior.

- `components/network/network.c` starts only a WPA2 access point named
  `WiFiKeyboard-<last-six-MAC-hex-digits>` at `192.168.4.1/24`, with DHCP and
  one associated client. Its password is a public build-time development value.
- Wi-Fi configuration uses RAM storage. There is no saved station profile,
  provisioning interface, network state machine, scan API, or mDNS responder.
- `components/web_server/web_server.c` serves HTTP/WS and permits one input
  socket, but does not authenticate its owner or validate the request Origin.
  A socket limit is not authorization to control the USB host.
- AP disconnection currently releases input globally. STA and concurrent
  interfaces require controller-aware loss handling while retaining the
  independent one-second input deadline and existing USB generation checks.
- A native Windows ESP-IDF v6.1 build for `esp32s3` passed on 2026-09-14.
  The app was `0xd82a0` bytes, with 16% of the existing app partition free.
  This is a baseline build result, not validation of this enhancement.

## Agreed Scope

- **Standalone AP:** direct browser access without a router or Internet.
- **Join Wi-Fi (STA):** connect to one saved 2.4 GHz WPA2-Personal network,
  use DHCP, and serve the same keyboard and settings interface on the LAN.
- Persist the selected mode and one station profile across restarts. Keeping
  AP mode must be an explicit, durable choice, not a failed STA attempt.
- Use AP+STA only for candidate-network testing and protected recovery.
  Do not keep the AP enabled during ordinary successful STA operation.
- Default the requested mDNS hostname to `kb`, producing `kb.local`. Enable
  discovery on both AP and STA interfaces and keep direct-IP access available.
- Configure networks through a mobile-first Network view in the existing app.
  Retain the existing typing layout, protocol semantics, and USB safety rules.
- Include owner authentication and safe controller ownership before permitting
  LAN keyboard access. The first increment uses HTTP/WS on protected personal
  test networks. HTTPS/WSS remains planned at lower priority, not removed from
  scope or required to complete this development increment.

## Agreed Provisioning Workflow

The sender provisions each board before shipping. Recipients need no SDK,
serial driver, flashing utility, or private file retained on the sender's PC
for ordinary setup. The sender supplies a private setup card with the unique
AP SSID/password, Wi-Fi QR code, `kb.local` address, and separate owner setup code.

- The unique AP password remains valid for first setup, standalone operation,
  and recovery. Preserve it across normal updates, reboot, and Forget Network.
  Its QR code encodes the password rather than removing or encrypting it.
- The owner setup code is single-use. On first claim the recipient chooses a
  device-specific owner password; store its salted verifier and retire the
  setup code atomically. Subsequent login uses the owner password.
- Generate secrets locally using a cryptographic random generator. Keep private
  records outside Git, avoid secrets in command arguments/logs/chat, and never
  generate a universal default. Production Wi-Fi credentials are supplied later
  in the browser, preferably while joined to the protected setup AP.
- Provisioning is an explicit sender-side operation, never part of build.
  An NVS image replaces a partition rather than merging keys. Validate the
  partition layout and choose a non-destructive initialization/migration route
  before any write; do not overwrite existing device NVS blindly.
- Missing or inconsistent identity fails closed with input disarmed. Network
  recovery retains the private AP identity. Owner-account recovery requires a
  separately verified physical workflow, not reuse of a consumed setup code.
- This HTTP/WS increment needs no certificate installation. It does not protect
  passwords, session tokens, or keystrokes against interception or modification
  of the network path. No public/shared-network or Internet-exposed use is implied.

No multiple saved networks, static IP UI, enterprise Wi-Fi, open upstream
networks, upstream captive-portal login, 5 GHz, cloud service, WAN exposure,
NAT/bridging, permanent dual-mode option, or OTA update workflow in this increment.
WPA3-Personal, including WPA2/WPA3 transition mode, and a setup captive portal
are deferred. The full browser must
work without a captive-portal popup. The firmware does not require Internet
reachability, public DNS, or NTP to declare a local network usable.

## Mode And Recovery Behavior

Keep the saved desired mode separate from the current runtime state. A temporary
recovery AP must not replace a saved STA preference or erase known-good credentials.

| State or event | Required behavior |
| --- | --- |
| First boot, no station profile | Start the protected setup AP and offer standalone AP or Join Wi-Fi. Without privately provisioned setup/owner secrets, remain disarmed in local service mode; do not expose an open or universally passworded control interface. |
| Explicit AP mode | Start AP and restore that choice on reboot. Retain any saved station profile without attempting to join it. |
| STA startup | Try the saved network with bounded backoff for up to 30 seconds. Remain disarmed until the active network, authenticated controller, and USB are ready. |
| STA ready | Use the DHCP address, announce mDNS, and serve the app on the LAN. Stop the temporary AP after a safe handover. |
| STA disconnect or address loss | Immediately invalidate affected control and request release of all keys. Retry without reboot loops or credential erasure. |
| Connection deadline exceeded | Offer the protected recovery AP while retaining the STA preference and profile. Expose connection failure and retry status. |
| Router returns during recovery | Recover automatically only when the recovery AP is idle. Do not interrupt an active AP control lease or setup session; defer disruptive retries/scans and handover until the owner finishes or explicitly switches. |
| Candidate network submitted | Disarm, keep the last committed profile, and test the candidate asynchronously using temporary AP+STA. |
| Candidate succeeds | Require association and a DHCP lease, commit the validated profile, show the assigned IP/effective hostname, and give the owner a handover confirmation period. Internet access is not a success criterion. |
| Candidate fails, is cancelled, or save is interrupted | Keep a recoverable committed configuration and protected AP access. Report the failure without returning or logging passwords. |
| Return to AP mode | Persist AP mode, stop STA safely, and retain the saved station profile. |
| Forget network | Require explicit owner confirmation, remove the station profile, select AP mode, and release/revoke control. Do not erase unrelated NVS data or the recovery identity. |

Use 30 seconds as the initial connection/recovery deadline. A proposed handover
grace period is 15 seconds after the UI acknowledges the successful job, with an
explicit switch action. Do not start AP shutdown merely because DHCP succeeded
if the owner has not received the result. Session expiry must eventually allow
an abandoned recovery session to become idle. Final timer values are tunable
after hardware testing, not promises about uninterrupted connectivity.

The implementation grants a 60-second candidate-confirmation grace period and
keeps AP handover deferred after authenticated management mutations. Read-only
status polling does not refresh this activity window. Once
the grace period and management activity expire, a successful saved candidate
becomes idle STA without another credential submission. An unconfirmed AP-address
change instead expires without renumbering, retaining the previous profile and
protected AP. Explicit confirmation still uses the 15-second handover interval.

Retain `192.168.4.1/24` as the default AP subnet and the existing one-associated-
client AP limit for this increment. If the STA subnet overlaps, select a
non-overlapping AP subnet and surface the proposed address before requiring
confirmation to change DHCP addressing and reconnect AP clients. Address changes must
release input, refresh discovery, and provide a reconnect path. Use a correct
regulatory country/channel configuration.

ESP32-S3 has one shared Wi-Fi radio: the AP channel follows the connected STA
channel, and scans or channel changes can interrupt AP clients. AP+STA keeps a
recovery interface available but cannot guarantee a continuous browser socket.
Configuration jobs must survive browser reconnects. Do not route, bridge, or
reflect mDNS between the two networks.

## Discovery With kb.local

Use Espressif's maintained [mDNS component](https://docs.espressif.com/projects/esp-protocols/mdns/docs/latest/en/index.html),
which supports the standard AP and STA interfaces. Pin a compatible component
version and retain the generated dependency lock when implementation begins.
Configure the hostname label as `kb`, without the `.local` suffix.

| Active interface | Expected resolution for a client on that link |
| --- | --- |
| AP | `kb.local` resolves to the current AP address, normally `192.168.4.1`. |
| STA | `kb.local` resolves to the DHCP-assigned LAN address. |
| Temporary AP+STA | Advertise on both links with addresses reachable through the receiving interface; do not advertise an unreachable address from the other network. |

- The first-increment URL is `http://kb.local/`. Trusted `https://kb.local/`
  remains lower-priority follow-up work. Bare `kb` is not a guaranteed address.
- Keep the AP SSID `WiFiKeyboard-<device-id>` separate from the hostname. Changing
  the hostname must not silently change the Wi-Fi network name or credentials.
- Persist the requested hostname; expose the effective advertised hostname and
  each active IP in authenticated status and the Network view.
- Default to `kb` but permit a validated user-defined hostname. Detect conflicts
  using the mDNS library and display its effective name, for example
  `kb-2.local`. Never promise that two boards can both own `kb.local` on one LAN.
  A hostname conflict may affect both interfaces when the responder uses a
  shared hostname; reflect the actual library behavior rather than assuming
  separate AP and STA names.
- Announce after link/address changes and withdraw obsolete records when an
  interface stops. Clients may briefly cache the old address during handover.
- Advertise the web service for the active transport. Do not publish credentials,
  session tokens, or key contents in mDNS TXT records.
- mDNS is link-local discovery, not authentication or a router DNS entry. Client
  resolver support, VPNs, multicast filtering, guest isolation, and VLANs can
  affect access. Keep direct-IP access and router DHCP lookup as fallbacks.
- Hostname changes and collision renaming must update allowed Host/Origin values
  safely. HTTPS certificates must cover the actual name/address used; a rename
  does not justify bypassing certificate warnings or downgrading to HTTP.

## Network Settings Experience

Add a Network view reachable from the current keyboard page, with a predictable
return path. Entering configuration must release input and relinquish control;
typing SSIDs, passwords, and hostnames must never send USB keyboard reports.

Provide a mode selector for Standalone AP and Join Wi-Fi; scan/select a network,
manual SSID entry for hidden networks, password entry with a reveal control,
and a Test and Connect command. Show connection progress and bounded failures
such as authentication failure, network not found, and DHCP timeout. Do not label
every disconnect as an incorrect password when the driver cannot distinguish it.

Show desired mode, runtime state, connected SSID, effective hostname, and current
addresses. Include retry/cancel while appropriate, a handover confirmation,
Return to AP Mode, and a separately confirmed Forget Network. Display errors and
long/duplicate SSIDs without breaking phone layouts; treat SSIDs as untrusted
text. Do not prefill a password returned from the device or persist it in browser
storage. Clear candidate secrets after completion or cancellation.

The controller may need to leave the AP and join the router's network after
setup. Do not claim the browser can switch the phone's Wi-Fi automatically.
Retain numeric addresses and job status so a lost socket or delayed mDNS lookup
does not force another credential submission.

## Persistence And APIs

Use a dedicated, versioned NVS configuration record for the desired mode,
requested hostname, and one committed station profile. Keep a candidate separate
from the active record until it passes association and DHCP checks. A checked
commit/active-record switch must recover after power loss to either the previous
or fully committed new record, never a mixed SSID/password or an open AP.

Validate lengths, supported security mode, and hostname syntax before starting
a job. Scan results are bounded and expire; preserve the selected SSID accurately,
including manual hidden-SSID entry. Routine reconnects must not write flash.
Do not repeatedly erase NVS on initialization or connection errors. Migrate any
older record explicitly; the current public AP password is not an owner secret.

Reuse the existing HTTP server and `/api/v1` convention. The planned endpoints
follow the broader design; finalize schemas alongside bounded parser tests.

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/v1/status` | Extend existing USB status with safe network, address, hostname, and control-availability fields. No secrets. |
| `POST /api/v1/network/scan` | Start a bounded asynchronous scan while disarmed. |
| `POST /api/v1/network` | Validate and start mode/profile/hostname operations, including explicit forget semantics. |
| `GET /api/v1/network/job` | Return current job identity, progress, safe results, and errors for scans and configuration changes. |

Network operations are owner-only; mutations require CSRF protection. Admit one
configuration job at a time, return `202` for accepted work and `409` for a
conflict, and keep the HTTP event loop responsive. The UI must not blindly
resubmit a credential change after losing its response; recover the job first.
Extend the existing preview/mock and test helpers without adding a second web
server, frontend framework, or an unrelated protocol layer.

Scan results expire 30 seconds after publication. Each entry carries a UTF-8
display `ssid` and lossless `ssid_hex`; saved profiles expose `saved_ssid_hex`
alongside their display name. Connect requests accept exactly one of `ssid` or
`ssid_hex`, plus the password. Hexadecimal input represents 1-32 non-NUL bytes;
the existing station profile does not support embedded NUL bytes. Manual edits
discard the selected raw token, while an expired scan does not alter it.

Accepted operations return a numeric `management_url` derived from the serving
interface. After a rename request from a `.local` page, the UI uses that address
to retrieve the committed state without relying on the retired mDNS name or
resubmitting the operation. Host-only cookies require signing in on the new
origin. The previous effective Host/Origin remains accepted for 60 seconds for
in-flight requests; this grace period does not retain the old mDNS record.

An overlapping subnet pauses the job at `awaiting_ap_reconnect` and publishes
`ap_reconnect_ip` without renumbering or deauthenticating the AP client. Confirm
authorizes that advertised address change; the UI retains the current status and
retry page plus an explicit recovery link that opens separately. It does not
navigate on the queued `202` response or assume the new IP is already live.
Candidate credentials commit after the confirmed transition passes the existing
association/DHCP checks. Cancel retains the current AP address and clears the
pending change. Idle cancellation is rejected with `409` without changing the
runtime mode or saved desired mode.

## Security And Input Safety

Authentication is a prerequisite to exposing keyboard control on a LAN, not a
future substitute for the public AP password. Retain the security boundaries in
the [design specification](remote-keyboard-design.md#5-security-and-controller-ownership).

- Provision separate random per-device AP and owner secrets privately. Never
  store real credentials in Git, build defaults, URLs, logs, or chat prompts.
- Use owner login, a standard salted password verifier, rate limits, bounded
  requests, and opaque sessions in HttpOnly/SameSite cookies. The future TLS
  profile must also set Secure. The current HTTP/WS development profile omits
  Secure so cookies work over HTTP; this exception provides no transport
  confidentiality or integrity. Protect administrative operations against CSRF
  and validate exact allowed Host/Origin values before WebSocket upgrade and
  mutations.
- Require explicit Take Control and permit only one input lease across AP and
  STA combined. Another connection must receive busy status, not silently take
  ownership. Keep all management-field input local to the browser.
- Release keys and revoke affected control on mode/address changes, candidate
  tests, scanning, configuration writes, owner logout, interface loss, and USB
  reset. An unrelated idle management-client disconnect must not be mistaken
  for loss of a controller on the other interface.
- Retain generation checks, report-age bounds, and independent USB/input
  deadlines. After reconnect or handover, require fresh control acquisition;
  never replay held keys. Network work must not block the USB safety path.
- HTTP/WS testing is limited to an explicitly selected development profile on
  an isolated AP or trusted test LAN with non-sensitive hosts and credentials.
  Login alone does not encrypt traffic or make a shared LAN safe.
- HTTPS/WSS, a usable certificate trust/enrollment process, and encrypted NVS
  remain lower-priority security work. They are not gates for the agreed
  HTTP/WS increment. Do not claim transport confidentiality in their absence,
  enable irreversible eFuse settings, or substitute homemade encryption.

Provide physical recovery independent of saved router credentials. Its exact
button/GPIO and gesture must follow verified board wiring. Recovery opens the
protected AP while disarmed; factory reset is a separate confirmed action and
retains the private recovery identity. Automatic fallback cannot replace a
physical recovery path when the router works but the controller is isolated.

## Implementation Phases

The software in phases 1-4 is integrated and its automated checks pass. Hardware
gates in phases 1, 3, and 5 remain pending. Implementation continued through the
mock UI while those checks were blocked by unverified board/provisioning details;
this does not waive the physical gates. Run focused checks after edits and phase
gates at integration points; a build or browser mock is not a radio/USB test.

| Phase | Scope and existing implementation surfaces | Gate before proceeding |
| --- | --- | --- |
| 1. Ownership prerequisites | Add session/control protections in `components/web_server`, the browser app, and USB release coordination. Implement sender-only provisioning and one-time owner claim. | Authentication, claim lifecycle, Origin/CSRF, busy-controller, management-field isolation, and release tests pass. No anonymous LAN input endpoint. ESP32-S3 build passes. |
| 2. Configuration and lifecycle | Extend `components/network` with desired/runtime states, versioned persistence, bounded retry jobs, and controller-aware events. Keep HTTP handlers thin. | Focused native tests cover boot decisions, rollback, interrupted commits, retry deadlines, and active-recovery deferral using existing host-test conventions. |
| 3. AP/STA and discovery | Wire ESP-IDF Wi-Fi events, DHCP, temporary AP+STA, subnet handling, and the pinned mDNS responder. | ESP32-S3 build passes; isolated hardware checks confirm both modes, interface-specific discovery, router loss/recovery, and collision behavior. |
| 4. Network UI and APIs | Add the settings view and bounded asynchronous endpoints to the existing app and preview/mock. | Parser/API tests and Chromium/WebKit checks cover scan, manual SSID, failed/successful changes, reconnect, settings input isolation, and responsive layouts. |
| 5. Integrated acceptance | Run the matrix below, existing keyboard regressions, resource checks, and physical recovery tests. Update user-facing docs with measured results. | Automated and real-board results are recorded separately. Development acceptance is explicitly distinguished from HTTPS, encrypted-storage, and operational-release gates. |

Do not expand firmware partitions or enable PSRAM merely to fit this feature.
Measure image size, free heap, and task stack use as networking/security grows.
The physical flash capacity and board wiring remain unconfirmed in the
[hardware record](../hardware/README.md). Any memory-layout change requires a
separate verified hardware decision. The broader 20% app-partition headroom goal
remains an operational gate; the current baseline already falls below it.

## Acceptance Matrix

All results start as **pending**. Record firmware revision, network topology,
controller OS/browser, observations, and whether evidence is automated or physical.

| ID | Scenario and pass condition |
| --- | --- |
| WF-01 | First boot offers protected setup with privately provisioned identity. The recipient claims once and selects an owner password without SDK/serial tooling. Reused setup codes fail. Missing secrets fail closed. AP credentials survive claim, reboot, and network recovery. |
| WF-02 | Explicit AP mode survives reboot, works without Internet, and does not auto-join a retained station profile. |
| WF-03 | Valid WPA2 credentials obtain DHCP and allow authenticated LAN use; loss of Internet alone does not trigger AP recovery. |
| WF-04 | Wrong password, unavailable SSID, DHCP failure, cancel, and reboot during save retain a usable committed configuration and protected recovery path. |
| WF-05 | Router shutdown releases input and reaches recovery after the deadline. Router return does not interrupt an active AP controller or setup session. |
| WF-06 | Confirmed handover and Return to AP Mode change interfaces safely, revoke prior control, refresh status, and permit fresh authenticated acquisition. |
| WF-07 | `kb.local` resolves to the reachable address in AP, STA, and temporary AP+STA tests. AP shutdown and DHCP address change withdraw/refresh records. |
| WF-08 | A second responder using `kb.local` causes safe conflict handling and visible effective naming. User rename persists; unreachable cross-interface addresses are not advertised. |
| WF-09 | With mDNS unavailable but IP connectivity allowed, direct-IP access works. Client isolation is reported as a topology limitation, not a password failure. |
| WF-10 | Same-subnet AP/STA overlap and differing radio channels produce a recoverable reconnect path without credential loss, unexpected routing, or stuck keys. |
| WF-11 | Anonymous, expired-session, cross-origin, CSRF, oversized, malformed, and concurrent-job requests are rejected without leaking secrets. One input owner spans both interfaces. |
| WF-12 | SSID/password/hostname editing never reaches USB. Network scan, handover, and active-controller loss release held keys and require fresh acquisition. |
| WF-13 | Cancel/reload/lost-response handling recovers job status without duplicate credential commits. Hidden, duplicate, long, and escaped SSIDs render safely on mobile and desktop. |
| WF-14 | Confirmed Forget Network removes only the profile and restores AP mode. Verified physical recovery works even when STA is connected but inaccessible from the controller. |
| WF-15 | Native and browser keyboard regressions pass, ESP-IDF builds fit the configured partition, and measured resource/deadline behavior remains acceptable under network activity. |
| WF-16 | Lower-priority security acceptance separately verifies trusted HTTPS/WSS, certificate name changes, and encrypted credential storage. Pending WF-16 does not block the agreed HTTP/WS increment and must remain visible in release notes. |

Use real iPhone/iPad Safari, Windows, and macOS clients for discovery and handover
checks. A Playwright WebKit pass is not evidence of iOS Wi-Fi switching, mDNS
resolution, native USB reports, or radio behavior. No flashing, reset, erase, or
board-configuration changes are authorized merely by this documentation step.

## Decisions Before Implementation

The accepted defaults are AP/STA as separate modes, temporary AP+STA, one saved
WPA2 network, DHCP, no Internet dependency, preferred hostname `kb`, sender-only
private provisioning, and HTTP/WS first with HTTPS/WSS retained at lower priority.
The following details still require resolution at the relevant phase:

- Exact protected storage/image layout for sender provisioning; preserve existing
  device NVS and do not write anything before verifying the board/partition map.
- Supported regulatory country configuration and verified physical recovery
  button/GPIO. Hardware identification is still pending.
- Operational certificate enrollment and how hostname collision/rename is
  reconciled with trusted certificate names. TLS must not silently weaken.
- Final handover/idle timer tuning and measured memory budget on the actual board.

The next device step is verified board identification and sender provisioning,
followed by the physical matrix. Do not flash or replace NVS without that check.

## Implementation Record

Date: 2026-09-14. Initial validation used native Windows tools; the PR review
follow-up used Linux host tools, ESP-IDF v6.1, and the loopback preview.

| Area | Executed result |
| --- | --- |
| Native C | Five suites passed: owner-record persistence/claim consumption, access/credential validation, network state/persistence selection, eight USB-state cases, and the full-state JSON parser. Initial Windows validation used Zig 0.15.2 without sanitizers; Linux review follow-up passed ASan/UBSan, including interrupted claims, malformed UTF-8, and maximum-length raw SSID cases. |
| Keyboard model | All 12 existing JavaScript model/layout tests passed. |
| Provisioning and browser/API | All 25 tests passed, covering unique private setup artifacts, one-time claim, session/Origin/CSRF checks, explicit control, Network settings, expired scans, raw SSIDs, failed candidates, storage-fault admission, mode-preserving scan cancellation, confirmed/abandoned AP-address transitions, abandoned handover expiry, numeric-address recovery after hostname retirement, lost-response recovery without resubmission, and keyboard regressions. |
| Browser layout | Chromium and WebKit checked account/network views at 320x568, 390x844, 568x320, 768x1024, and 1366x768 as applicable. Keyboard regression checks retain the larger viewport matrix. Screenshots were inspected; a WebKit long-selector overflow was fixed. |
| Firmware | ESP-IDF v6.1 ESP32-S3 build passed. App `0xf4570` bytes; `0xba90` bytes (47,760 bytes, about 5%) free in the existing app partition, with the SDK low-headroom warning. Bootloader size check passed. No flash/partition/PSRAM expansion. |
| Device operations | No serial connection, provisioning write, flash write, erase, or eFuse change was performed. The new firmware has not run on the board. |

An isolated Linux harness also executed the actual cleanup and status callbacks
with hardware dependencies stubbed. It verified delayed cleanup cannot release
a newer controller sharing the USB generation, scan expiry at its deadline, and
preservation/expiry of the full collision-resolved previous hostname. Further
fault injection verified cleanup on timer creation/start failure, reservation
checks before stale-controller termination, and no AP renumbering/deauthentication
before explicit confirmation. These checks do not establish real radio, DHCP,
or USB timing behavior.

Follow-up regressions verify that overlapping preview claim requests cannot
replace the first owner's password, logout/session expiry clears unsent Wi-Fi
credentials, and connect requests require exactly one typed SSID representation.
Fault injection of the NVS loader verified corrupt-selector defaults remain
writable; AP/Forget restart tests verified protected-AP retry and accurate error
reporting if the retry also fails. Existing test files contain the browser/API
regressions; hardware-dependent cases used isolated host harnesses.

Further checks cover duplicate handover-confirmation rejection, preservation of
failed cancellation status, interface-hostname error propagation, canonical
zero-padded persisted strings, and preview NUL rejection. The Linux host entry
point also passed immediately after ESP-IDF activation without a caller-side
PATH override, using the runner's explicit native binutils selection.

Network disarm already calls `usb_keyboard_release()`, which advances the USB
generation and clears queued reports while holding the same mutex as report
submission. The actual adapters and keyboard state were checked under sanitizers:
queued input is cleared, old-generation submissions/heartbeats are rejected even
after neutral completion, and an old release cannot affect a fresh generation.
WebSocket clients and reservations retain their admitted generation; an open
socket alone cannot reacquire input after network disarm. No additional lease
mechanism was introduced.

The latest browser checks cover a delayed AP transition with no premature
navigation, preserved status/recovery links, committed mode/profile form updates,
UTF-8 byte-length owner passwords, and Host/Origin rejection before session
activity refresh. Fault-injected AP rollback skips deauthentication when any
address-transition step fails. Pinned mDNS 1.13.0 initializes already-addressed
interfaces in `mdns_priv_netif_init()` as well as registering later Wi-Fi/IP
events; predefined AP/STA and IPv4 are enabled in the generated configuration.

Native confirmation tests cover the grace boundary, active-management deferral,
and unattended expiry; preview tests recover both successful handovers and pending
AP-address changes without a duplicate credential submission. An online recovery
STA with its AP still up exposes confirmation, and an owned network guard is not
advertised as available for control. C parsers distinguish literal escaped
backslashes from decoded NUL escapes. The preview uses pinned `jsonc-parser`
3.3.1 in strict mode to reject duplicate decoded keys and NUL values, and decodes
UTF-8 after collecting a bounded complete body. These are tooling dependencies,
not firmware npm dependencies.

Login remains available while another session owns or reserves keyboard control,
so an authenticated recovery browser can use priority Stop; Take Control remains
exclusive. Regressions cover both pending reservations and active sockets,
ownership-aware `can_control` status, and a 401 logout returning the keyboard
view to signed out. Preview scans require an empty body, rejecting nonempty,
oversized, and chunked bodies with 413 before changing the job. Ownership is
rechecked after asynchronous request-body parsing.

Invalid JSON content types and oversized bodies are drained before the next
keep-alive request; the regression sends a rejected partial body and verifies
the same socket can then retrieve unchanged job status. The shared scan and
association predicate rejects WPA2/WPA3 transition mode as outside this increment.

Frequent status polling is covered by the abandonment regression and cannot
prevent confirmation expiry. Form-reset regressions also verify that resetting
the selected value preserves all unexpired scan options. ESP-IDF v6.1 performs
the firmware's unread-body cleanup in `httpd_req_delete()` before accepting a
subsequent request; failed purging returns failure through session processing,
which closes the socket. A sanitizer-enabled harness exercised the actual SDK
purge function with empty, partial, oversized, and receive-failure cases.

AP rollback retains the original address until its DHCP server is verified as
started. Recovery retries incomplete restoration; persistent address/DHCP errors
keep network availability and control acquisition disabled rather than reporting
an unusable AP as recovered. Fault injection covers transient/persistent startup
failure, address restoration failure, and DHCP initialization without service.
Repeated-poll browser assertions verify the existing address rendering replaces
its contents and keeps exactly one recovery link.

Startup accepts the documented already-stopped DHCP result while propagating
real stop failures. A sanitizer-enabled check ran the actual pinned SDK stop
implementation together with the startup guard: INIT, STOPPED, and successful
STARTED cases proceed; invalid-interface and failed-stop cases remain errors.

Claim consumption is durably committed before the owner record. If the claim
is interrupted after consumption or the owner record is later lost, loading
fails closed rather than accepting the setup code again. Existing valid owner
records receive the consumption marker on loading if it is absent. This can
require explicit sender service after an interrupted claim; it is not hardware
anti-rollback and cannot prevent restoring an entire older identity snapshot.
Isolated loader/claim tests verify write ordering, interrupted owner writes,
missing owner records, and migration. Incomplete AP address/DHCP restoration is
retried by the worker at 30-second intervals before normal STA processing;
deadline tests cover repeated failures and eventual unattended recovery.

Owner-record loading and marker-before-owner commit sequencing now use the
portable `owner_store` implementation called by the firmware NVS adapter. Its
committed native suite runs in the default host command and CI. It injects
failures before and after every write/commit, with immediate and commit-delayed
durability, and verifies reboot behavior, lost-owner rejection, legacy marker
migration, invalid records, and storage errors. Startup also propagates either
AP or STA hostname initialization failure before Wi-Fi is started.

Saved-profile recovery honors the same confirmation grace whenever its AP is
still active. Failed AP+STA driver startup falls back to protected AP-only mode
without changing the saved STA preference; repeated driver failures retry every
30 seconds. Guard release restores control availability synchronously from
network readiness, independently of ownership. Rename applies all runtime names
before persistence and restores the previous requested name on failure; failed
rollback retries with new control disabled. Existing ambiguous NVS-write failures
still require restart to establish the durable selected record. Fault injection
checks the fallback, reacquisition, runtime/persistence ordering, and rollback
retry. The existing pending-overlap early continuation was also exercised beyond
the connection deadline and retains the candidate without premature recovery.

Initial saved-STA driver startup also enters protected AP fallback on failure
without skipping worker creation; a failed fallback is serviced by the same
timed retries. Provisioning validates the device ID before creating any parent
or output directory, allowing a corrected MAC to reuse the intended path.

Recovery retries a station that remains associated without DHCP at its bounded
idle retry deadline; active management still defers that restart. Provisioning
removes only its newly created output directory after a caught ACL, QR, or file
write failure, and reports cleanup failure explicitly. Existing directories are
never removed or overwritten. Tests cover generation failure, partial output,
same-path retry, and invalid owner records returning before marker lookup.

Failed identity initialization clears the AP password, claim salt/digest, and
owner record. Actual initialization and owner-store adapter fault injection covers
partial salt/hash reads, cost/owner errors, and crypto initialization failure,
with successful unclaimed retry and owned startup checked afterward.
Fail-closed claim persistence errors wipe the same buffers, including failures at
open, marker write/commit, and owner write/commit. Invalid setup codes and
pre-storage derivation failures retain retry eligibility.

Provisioning resolves the nearest existing parent before creating missing
directories, rejecting an outside symlink into the repository without creating
the nested repository path. The existing provisioning suite covers this case.

A latched storage fault rejects persistent changes before job admission with a
restart-required error; status, scans, and non-writing control remain available.
NVS-open failures also latch the fault; fault injection verifies no invalid-handle
close, no saved-profile change, blocked subsequent writes, and continued scans.
Cancelling a scan only stops the scan and undoes temporary AP scan mode, leaving
the saved profile and current STA/AP state intact. Firmware fault injection and
API regressions verify no job-ID mutation on rejected writes and mode preservation
on cancellation. Configuration-application failures have a specific UI message.
Queued cancellation rechecks whether work remains busy before recovery, preserving
the result and STA mode if a scan completed after cancellation was admitted.
Browser scan cancellation also preserves unsaved mode, SSID, and hostname edits;
it does not mark scan cancellation as a committed field-resetting job.
Firmware and preview predicate checks confirm an offline pending-overlap cancel
is already non-writing under a storage fault; an online Keep AP save is blocked.

Scan completion, timeout, cancellation, and failed startup check restoration of AP radio
mode and enter recovery if it fails. Fault injection verifies a failed restoration
cannot publish scan success or fall through to station processing after timeout.
Network job admission and control acquisition check ownership under the same lock;
tests cover both orderings without releasing an already-owned USB generation.
Owner and Wi-Fi password reveal controls return to
masked inputs with matching icons and accessible labels when cleared or signed
out, including failed login, session expiry, and leaving Network settings.
Page blur, pagehide, and hidden-tab events clear and mask the unsent Wi-Fi
candidate as well as releasing keyboard input; browser lifecycle tests cover all
three event handlers and the existing keyboard release behavior.

Both firmware JSON parsers validate complete request text as UTF-8 before cJSON
parsing. Malformed raw UTF-8 and unpaired JSON surrogate escapes are rejected in
firmware and preview; `ssid_hex` remains the explicit path for non-UTF-8 SSID
bytes. SSID displays escape Unicode controls, format characters, line/paragraph
separators, and default-ignorable code points as raw-byte escapes while retaining
ordinary Unicode and the exact hex token. The compact firmware ranges match the
Unicode 17.0 properties used by the tested Node runtime. A sanitizer-enabled
comparison verified 4,424 control/boundary cases against both formatters, and
the browser scan regression verifies a bidi-control name cannot reorder its
signal-strength/security suffix.

The native interrupted-save tests inject failure around the same stage/activate
selection helper used by the NVS adapter. They verify old-or-new complete-record
selection, not physical flash behavior during power removal. An ambiguous NVS
write failure prevents further configuration writes until restart. Candidate
profiles commit only after association and a fresh DHCP event; retries alone do
not write flash. Forget Network removes the active logical profile, not forensic
copies from flash wear leveling.

The sender utility prepares `identity.csv`, `wifi-qr.png`, and `setup-card.html`
in a new protected directory outside Git. It generates a 24-character AP password
and independent 24-hex-character setup code, and stores a salted PBKDF2-HMAC-SHA256
claim verifier (100,000 iterations) in the CSV. Owner passwords use the same KDF
with a fresh salt. The `kb_identity` NVS namespace is bound to the factory base
MAC. A committed owner record retires the setup code; the AP password is retained.
No actual user's provisioning artifacts were generated, only temporary fixtures
that the tests removed. KDF timing and NVS claim/reboot behavior still need hardware
measurement, even though the SDK crypto API compiled and the algorithm is enabled.

The runtime AP/STA adapter has one worker and one admitted configuration command,
bounded scan results, a 30-second initial retry deadline, and interface-specific
input guards. Automatic recovery retries defer for an AP controller or recently
active authenticated setup client. An explicitly confirmed handover has a
15-second grace period. Cancelling handover after a successful save selects AP
mode while retaining the new profile. Explicit AP mode never auto-joins a saved
network. Failed candidate tests preserve the prior profile and leave protected
AP access for another attempt.

mDNS 1.13.0 is pinned. The responder advertises `kb.local` on AP/STA, reports the
effective collision-resolved name, and advertises `_http._tcp` on port 80.
Current APIs retain `/api/v1/status` with USB plus network status and use
`/api/v1/network/job` for detailed settings/job state. Host/Origin allowlisting
tracks the effective name and active IPv4 addresses. No NAT or mDNS reflection
is enabled. Actual client discovery, collision handling, channel changes, and
subnet-overlap recovery have not yet been observed on hardware.

### Remaining Device Gates

- Identify the exact board, flash capacity, recovery-button wiring, and the
  intended regulatory country. The implementation leaves ESP-IDF's conservative
  default country/channel configuration unchanged rather than inventing one.
- Verify a private provisioning layout and the sender's initial NVS write or
  migration path. The utility intentionally does not generate/write an NVS image.
  Existing NVS must not be blindly replaced. Missing identity fails closed.
- Implement and validate physical stop/network recovery and owner-account
  recovery once the button wiring and reset policy are agreed. There is no GPIO
  polling or factory-reset endpoint in this increment, and no claim of complete
  recipient recovery without this work.
- Run WF-01 through WF-15 on the provisioned board as applicable: power-loss
  persistence, DHCP/mDNS, AP/STA radio transitions, cross-interface ownership,
  real USB release timing, router outages, iPhone/iPad behavior, and resource use.
- Address the measured 5% app-partition headroom only after the board's physical
  flash is confirmed. Trusted HTTPS/WSS, certificate enrollment, encrypted NVS,
  and WF-16 remain explicitly lower priority, not abandoned requirements.