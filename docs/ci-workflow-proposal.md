# CI Workflow Setup Proposal

Date: 2026-09-14
Status: hosted PR validation passed; required-check rollout pending.

## Objective

Require a pull request and successful automated checks before merging to `main`,
without requiring a reviewer. Reuse the existing firmware and browser tests;
do not add firmware features, automatic flashing, deployment, or releases.

CI uses the repository-scoped GitHub Actions token with read-only repository
permissions. No personal access token or signed-in developer account is required.

## Workflow

One workflow, two independent jobs with stable check names:

| Check | Environment and sequence |
| --- | --- |
| Firmware and Native Tests | Pinned ESP-IDF v6.1 environment and Node.js 22. Build `esp32s3` from the committed defaults, run `bash tools/test-host.sh`, check dependency-lock drift, report image/partition size, and package the validated build. |
| Browser Integration | Ubuntu 24.04 and Node.js 22. Install the locked development dependencies, install Chromium/WebKit with their Linux runtime dependencies, and run `npm --prefix tools test`. |

Run on pull requests targeting `main`, pushes to `main`, and manual dispatch.
Run both jobs even for documentation-only PRs; skipping an entire required
workflow through path filters can leave PRs waiting for missing checks. Cancel
superseded runs on the same PR or branch and apply finite job timeouts.

Use immutable action references and a pinned ESP-IDF toolchain. A clean checkout
must not depend on ignored local `sdkconfig`, downloaded components, existing
build output, EIM paths, or the WSL browser-library workarounds. The native tests
need the managed TinyUSB and cJSON sources, so run them after ESP-IDF resolves
the committed component lock. Do not silently update dependency locks in CI.

The implementation is [the CI workflow](../.github/workflows/ci.yml). Both jobs
use Node.js `22.23.2`. The firmware job runs inside the official Ubuntu-based
ESP-IDF image and sources `$IDF_PATH/export.sh` for SDK commands; the browser
job runs directly on the hosted runner. Each `bash` step fails on failed pipeline
commands even when their output is also being captured with `tee`.

After activating ESP-IDF, the firmware job adds only `$GITHUB_WORKSPACE` to Git's
`safe.directory` entries in the disposable container and verifies `HEAD` before
building. The mounted checkout can have a different owner from the container
user. This scoped exception preserves Git access for project version detection,
dependency-lock checks, and the summary; it does not trust every directory or
change developers' Git identities or local configuration.

| Dependency | Immutable reference used |
| --- | --- |
| `actions/checkout` v5 | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| `actions/setup-node` v5 | `a0853c24544627f65ddf259abe73b1d18a591444` |
| `actions/upload-artifact` v5 | `330a01c490aca151604b8cf639adc76d48f6c5d4` |
| `espressif/idf:v6.1` | `sha256:81893c71bb5e570088901f21def8684c25cd2a9020281bd01b843a7655edb18c` |

These references were resolved from their official repositories/registry on
2026-09-14. Update them deliberately through a PR. Browser versions follow the
committed npm lock. Only npm's download cache is enabled, keyed by that lock;
build output and installed component/browser directories are not cached.

Firmware and browser jobs have 30-minute and 20-minute timeouts respectively.
The browser installs its system libraries through Playwright's `--with-deps`
option on the disposable hosted runner, not through local WSL path overrides.

## Artifacts

- Upload a separate-image flash ZIP and SHA-256 sidecar, merged BIN and checksum,
  and a size/build summary after successful firmware validation. Record the
  checked-out commit and use unique artifact names containing the commit SHA.
- Label PR output as a test build, not a release or evidence of hardware testing.
  The PR workflow normally validates GitHub's proposed merge commit.
- Keep available build/test logs and browser screenshots for diagnosis, including
  failed runs. Retain artifacts for 14 days; do not commit binaries or upload the
  whole workspace, dependency directories, credentials, or environment dumps.
- Merged BINs write padded gaps, potentially replacing NVS/settings. Preserve
  this warning and the unchanged board flash/recovery prerequisites.

Packaging validates bytes and offsets, not USB behavior. No CI job connects to
a physical board, burns eFuses, signs a production image, or publishes releases.

The firmware artifact is named `firmware-<pr-test|branch-build>-<SHA>-<attempt>`
and contains `firmware-package.zip`, its checksum, `firmware-merged.bin`, its
checksum, and the Markdown build summary with checked-out commit and size data.
The workflow also publishes separate firmware-log and browser-diagnostic
artifacts, including available screenshots. Firmware summaries and diagnostic
uploads use `if: ${{ !cancelled() }}`: they run after earlier failures but skip
canceled runs, so they do not keep superseded jobs alive. Validated firmware is
uploaded only after successful checks.

The existing packager is reused without changing its format. esptool merges the
build-generated image list in `flash_args`, and SHA-256 checksums identify the
downloaded outputs. Nothing is flashed and previously tested local packages are
not modified by the isolated validation run.

## Merge Rules

After both checks have completed successfully on GitHub, add their exact names
to the existing active ruleset for `main` as required status checks. Keep the
PR requirement, zero reviewer approvals, no bypass actors, and the blocks on
force pushes and branch deletion. Do not disable protection to bootstrap CI.

Introduce this change through a feature branch and PR. Workflow implementation
does not itself change the ruleset, merge the PR, or require new approvals.
Manual dispatch becomes available in the UI after the workflow reaches the
default branch; its first hosted validation can run on the introduction PR.

## Security And Scope

Use ordinary `pull_request`, never `pull_request_target` to execute PR code.
Keep `contents: read`, disable persisted checkout credentials, and use no
repository secrets, personal tokens, or self-hosted hardware runners. Fork PRs
must be safe to test with the default restricted token; first-time contributors
may need GitHub's normal workflow-run approval, distinct from merge reviewers.

Fail on build errors, test failures, invalid packages, dependency-lock drift,
or application partition overflow. Report headroom rather than imposing the
broader 20% product target: the current tested image has about 16% free, so
making 20% mandatory would immediately reject the working baseline.

Defer new lint/style policies, mandatory coverage thresholds, scheduled scans,
dependency-update automation, tag-based releases, and hardware-in-the-loop CI
until separately agreed. Chromium/WebKit automation does not establish real
iPhone/iPad compatibility, USB timings, radio reliability, suspend current,
recovery, or endurance.

## Rollout And Validation

1. Add and locally lint the workflow on `ci/github-actions`.
2. Validate the existing native/browser commands and packaging/summary paths;
   distinguish locally executed checks from any unavailable container/runner checks.
3. Commit and push the feature branch when authorized, then open a PR to `main`.
   Confirm both jobs pass from a clean hosted checkout and inspect the artifacts.
4. Enable the two required checks in the existing ruleset after that first pass.
   Merge through the PR without a reviewer requirement.

Record implementation details and actual validation results below before handoff.

## Validation Record

Local validation passed on 2026-09-14:

- `actionlint` v1.7.12 checked the actual workflow with no findings; its downloaded
  binary was verified against the official release checksum. Editor diagnostics
  also reported no workflow errors.
- ESP-IDF v6.1 built in a new `.cache/ci-validation/build` directory with a new
  `sdkconfig` generated from the committed defaults, not the normal local file.
  This used the installed SDK/managed components; it was not a Docker run.
  `dependencies.lock` was unchanged.
- `bash tools/test-host.sh` passed: eight USB state/report tests, bounded JSON
  parser checks, and twelve keyboard model/layout tests with native sanitizers.
- `npm ci --prefix tools --ignore-scripts` left the npm lock unchanged, and all
  ten Chromium/WebKit integration tests passed. Local browser execution used the
  documented WSL library cache; CI will use standard installed dependencies.
- `idf.py size`, ZIP creation and round-trip checks, merged-BIN generation, and
  checksum verification succeeded for the isolated build. The application is
  `0xd7ff0` bytes (884,720 bytes), with `0x28010` bytes (16%) free in the default
  application partition. The merged BIN is `0xe7ff0` bytes (950,256 bytes).

Docker/Podman was unavailable for local validation. The hosted runs below
subsequently exercised the pinned container, GitHub runner setup, standard
browser installation, and artifact uploads. Local results alone did not
establish that the hosted jobs would pass.

The [first PR run](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34860547440)
on 2026-09-14 passed Browser Integration, including standard browser dependency
installation and diagnostic upload. The firmware compiled successfully to
`0xd7ff0` bytes, but the build step then failed at `git diff --exit-code` with
exit 129. Earlier Git diagnostics reported dubious ownership of the mounted
checkout. Native tests and packaging were skipped; firmware compilation alone
did not pass the entire job.

The fix explicitly trusts the exact workspace path in the container before any
build Git operations. An isolated local regression test reproduced the ownership
error, then verified `git rev-parse --verify HEAD` and the lockfile diff pass
with that exact-path exception. The real user Git configuration was untouched;
actionlint and whitespace checks also passed.

The [hosted rerun](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34861221888)
on 2026-09-14 for fix commit `1347451` passed both **Firmware and Native Tests**
and **Browser Integration**. Firmware compilation, dependency-lock validation,
native/model tests, ZIP/BIN packaging, summaries, and artifact uploads completed
successfully. The browser job passed its tests and uploaded its diagnostics.
The run published the firmware test bundle, firmware logs, and browser
logs/screenshots for proposed merge commit `f90af8d7e5a1ed619d14d0a1b0957835193d5039`.

Artifact inspection on 2026-09-14 verified the downloaded ZIP and merged BIN
against their SHA-256 sidecars, ZIP integrity, and every checksum inside the
extracted package. The build summary records the same proposed merge commit
and the `0xd7ff0`-byte application with 16% partition space free. Uploaded WebKit
phone and Chromium desktop screenshots were inspected for rendered keys/icons
and visible layout issues; neither is a physical-device acceptance result.

Required-check rollout remains pending: these documentation changes do not add
required status checks or merge the PR. Retain the existing PR rule with zero
reviewer approvals when enabling the required checks. A hosted CI pass
is not hardware acceptance; post-merge `main` and manual-dispatch runs also remain
to be observed after the workflow reaches the default branch.