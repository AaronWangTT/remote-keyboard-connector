#!/usr/bin/env bash
# EIM activation detects a sourcing shell using $0 rather than BASH_SOURCE.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    exec bash -c 'setup_script=$1; shift; source "$setup_script" "$@"' bash "${BASH_SOURCE[0]}" "$@"
fi
set -euo pipefail

trap 'printf "Setup failed at line %s. Resolve the error above and rerun the same command.\n" "$LINENO" >&2' ERR

IDF_VERSION=v6.1
IDF_COMMIT=fff9895c82d744c7237be8847347bdd1b07c6643
NODE_VERSION=22.23.2
NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
firmware_only=false
check_only=false
skip_system=false
verify=false
with_vscode=false

usage() {
    cat <<'EOF'
Usage: bash tools/setup-dev.sh [options]

Set up Ubuntu 24.04 x86_64 (including WSL) for ESP32-S3 development.
Default: firmware tools, native-test tools, Node.js, and Playwright browsers.

  --firmware-only  Skip Node.js, npm dependencies, and host/browser tests
  --check          Check tools without installing packages or writing setup files
  --skip-system    Do not install apt packages or browser system libraries
  --verify         Build in .cache/setup-build and run applicable test suites
  --with-vscode    Install ESP-IDF and C/C++ extensions using the code CLI
  --help           Show this help

System packages may prompt for your sudo password. Do not run this script as root.
No SDK is deleted, shell startup file edited, board flashed, or USB forwarded.
Checks may update EIM's selection and create temporary browser runtime files.
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

for option in "$@"; do
    case "$option" in
        --firmware-only) firmware_only=true ;;
        --check) check_only=true ;;
        --skip-system) skip_system=true ;;
        --verify) verify=true ;;
        --with-vscode) with_vscode=true ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; fail "Unknown option: $option" ;;
    esac
done

[[ $EUID != 0 ]] || fail "Run as your normal user; sudo is used only for system packages."
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] ||
    fail "Supported platform: Ubuntu 24.04 x86_64, including WSL."
command -v python3 >/dev/null || fail "Install python3 before running setup."

packages=(git wget curl ca-certificates flex bison gperf python3-pip python3-venv
    python3-setuptools cmake ninja-build ccache libffi-dev libssl-dev dfu-util usbutils)
if ! $firmware_only; then
    packages+=(build-essential)
fi
missing=()
for package in "${packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
        missing+=("$package")
    fi
done
if ((${#missing[@]})); then
    if $check_only || $skip_system; then
        fail "Missing system packages: ${missing[*]}. Run setup without --skip-system to install them."
    fi
    printf 'Administrator access required for: %s\n' "${missing[*]}"
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
fi

# Prefer the EIM registration to avoid creating a second SDK after VS Code setup.
sdk=$(python3 - "$HOME/.espressif/tools/eim_idf.json" "$IDF_COMMIT" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

registry = Path(sys.argv[1])
if registry.exists():
    data = json.loads(registry.read_text())
    candidates = [item for item in data["idfInstalled"]
                  if item.get("status") == "finished"]
    candidates.sort(key=lambda item: item["id"] != data.get("idfSelectedId"))
    for item in candidates:
        commit = subprocess.check_output(
            ["git", "-C", item["path"], "rev-parse", "HEAD"], text=True).strip()
        if commit == sys.argv[2]:
            print(item["path"])
            print(item["activationScript"])
            break
PY
)
activation=
if [[ -n $sdk ]]; then
    activation=${sdk#*$'\n'}
    sdk=${sdk%%$'\n'*}
elif [[ -f $HOME/.espressif/v6.1/esp-idf/export.sh ]]; then
    sdk=$HOME/.espressif/v6.1/esp-idf
    activation=$HOME/.espressif/tools/activate_idf_v6.1.sh
elif [[ -f $HOME/esp/esp-idf-v6.1/export.sh ]]; then
    sdk=$HOME/esp/esp-idf-v6.1
    activation=$sdk/export.sh
else
    sdk=$HOME/esp/esp-idf-v6.1
    activation=$sdk/export.sh
    if $check_only; then
        fail "ESP-IDF $IDF_VERSION is not installed. Run setup without --check."
    fi
    [[ ! -e $sdk ]] || fail "$sdk exists but is not a recognized SDK; inspect it before retrying."
    mkdir -p "$HOME/esp"
    git clone --branch "$IDF_VERSION" --depth 1 --recursive --shallow-submodules \
        https://github.com/espressif/esp-idf.git "$sdk"
    [[ $(git -C "$sdk" rev-parse HEAD) == "$IDF_COMMIT" ]] ||
        fail "Downloaded SDK does not match the pinned ESP-IDF commit."
    export IDF_TOOLS_PATH=$HOME/.espressif
    unset IDF_PYTHON_ENV_PATH
    bash "$sdk/install.sh" esp32s3
fi
[[ -f $activation ]] || fail "SDK activation script missing: $activation. Repair the installation in EIM."
[[ $(git -C "$sdk" rev-parse HEAD) == "$IDF_COMMIT" ]] ||
    fail "$sdk does not match the pinned ESP-IDF $IDF_VERSION commit; select the correct installation."
printf 'Using ESP-IDF: %s\n' "$sdk"
if [[ $activation == "$sdk/export.sh" ]]; then
    export IDF_TOOLS_PATH=$HOME/.espressif
    unset IDF_PYTHON_ENV_PATH
fi
# EIM's generated activation script reads optional positional arguments.
set +u
. "$activation"
set -u
[[ $IDF_PATH == "$sdk" ]] || fail "Activation selected an unexpected SDK: $IDF_PATH"
idf.py --version
cmake --version | head -n 1
ninja --version
xtensa-esp-elf-gcc --version | head -n 1
python -c 'import cryptography, espsecure; print("Python signing dependencies: OK")'

node_bin=$HOME/.local/opt/node-v$NODE_VERSION-linux-x64/bin
if ! $firmware_only; then
    if [[ ! -x $node_bin/node ]]; then
        $check_only && fail "Pinned Linux Node.js $NODE_VERSION missing. Run setup without --check."
        node_dir=${node_bin%/bin}
        [[ ! -e $node_dir ]] || fail "Incomplete Node.js installation at $node_dir; inspect it before retrying."
        mkdir -p "$HOME/.local/opt"
        download=$(mktemp -d)
        trap 'rm -f "$download/node.tar.xz"; rmdir "$download"' EXIT
        curl -fLsS --retry 3 -o "$download/node.tar.xz" \
            "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
        printf '%s  %s\n' "$NODE_SHA256" "$download/node.tar.xz" | sha256sum --check -
        tar -xJf "$download/node.tar.xz" -C "$HOME/.local/opt"
    fi
    export PATH="$node_bin:$PATH"
    [[ $(node --version) == "v$NODE_VERSION" ]] || fail "Unexpected Node.js version at $node_bin."
    node --version
    npm --version
    cc --version | head -n 1
    if ! $check_only; then
        npm ci --prefix "$ROOT/tools" --ignore-scripts
        if $skip_system; then
            npm exec --prefix "$ROOT/tools" -- playwright install chromium --only-shell
            npm exec --prefix "$ROOT/tools" -- playwright install webkit
        else
            printf 'Playwright may request administrator access for browser system libraries.\n'
            npm exec --prefix "$ROOT/tools" -- playwright install --with-deps chromium --only-shell
            npm exec --prefix "$ROOT/tools" -- playwright install --with-deps webkit
        fi
    fi
    node --input-type=module - "$ROOT" <<'JS'
import { pathToFileURL } from "node:url";
const entry = pathToFileURL(`${process.argv[2]}/tools/node_modules/@playwright/test/index.mjs`);
const { chromium, webkit } = await import(entry);
for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent("<title>Environment check</title>");
        if (await page.title() !== "Environment check") throw new Error(`${name} page failed`);
        console.log(`${name}: OK`);
    } finally {
        await browser.close();
    }
}
JS
fi

if $with_vscode; then
    command -v code >/dev/null || fail "VS Code CLI not found; open the project using VS Code in WSL."
    if $check_only; then
        extensions=$(code --list-extensions)
        for extension in espressif.esp-idf-extension ms-vscode.cpptools; do
            grep -qx "$extension" <<< "$extensions" || fail "VS Code extension missing: $extension"
        done
    else
        code --install-extension espressif.esp-idf-extension
        code --install-extension ms-vscode.cpptools
    fi
fi

cd "$ROOT"
if $check_only; then
    printf 'Environment check passed. No packages installed or setup files written.\n'
    exit 0
fi
mkdir -p .cache
{
    if ! $firmware_only; then
        printf 'export PATH=%q:"$PATH"\n' "$node_bin"
    fi
    if [[ $activation == "$sdk/export.sh" ]]; then
        printf 'export IDF_TOOLS_PATH=%q\nunset IDF_PYTHON_ENV_PATH\n' "$HOME/.espressif"
    fi
    cat <<'EOF'
_remote_keyboard_activate() {
    local restore_nounset=false activation_status=0
    case $- in
        *u*) restore_nounset=true ;;
    esac
    set +u
EOF
    printf '    if . %q; then\n' "$activation"
    cat <<'EOF'
        activation_status=0
    else
        activation_status=$?
    fi
    if "$restore_nounset"; then
        set -u
    else
        set +u
    fi
    if ((activation_status != 0)); then
        printf 'ESP-IDF activation failed (exit %s).\n' "$activation_status" >&2
    fi
    unset -f _remote_keyboard_activate
    return "$activation_status"
}
_remote_keyboard_activate
EOF
} > .cache/development-env.sh

if $verify; then
    idf.py -B .cache/setup-build -D SDKCONFIG=.cache/setup-build/sdkconfig build
    if ! $firmware_only; then
        bash tools/test-host.sh
        python tools/install_device_test.py
        node tools/install-device.mjs --firmware .cache/setup-build \
            --verification-key .cache/setup-build/firmware-signing-public.pem
        npm --prefix tools test
    fi
fi
printf '\nSetup complete. In a new Bash terminal, run:\n'
printf '  cd %q\n  source .cache/development-env.sh\n  idf.py build\n' "$ROOT"
printf 'VS Code: select ESP-IDF %s at %s; do not install another copy.\n' "$IDF_VERSION" "$sdk"
printf 'An existing build from another SDK path needs a fresh build directory; see docs/development-setup.md.\n'
