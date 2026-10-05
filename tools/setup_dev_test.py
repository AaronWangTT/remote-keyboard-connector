import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "setup-dev.sh"


class SetupDevTest(unittest.TestCase):
    def run_setup(self, *arguments, env=None):
        return subprocess.run(["bash", str(SCRIPT), *arguments],
                              capture_output=True, text=True, env=env, check=False)

    @contextmanager
    def eim_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / "bin"
            binary.mkdir()
            scripts = {
                "dpkg-query": "echo 'install ok installed'",
                "git": '[ "$1" = -C ] || { echo UNEXPECTED_CLONE >&2; exit 99; }\ncat "$2/commit"',
                "idf.py": "echo 'ESP-IDF v6.1'",
                "cmake": "echo 'cmake test'",
                "ninja": "echo 'ninja test'",
                "xtensa-esp-elf-gcc": "echo 'gcc test'",
                "python": "echo 'Python signing dependencies: OK'",
                "sudo": "echo UNEXPECTED_SUDO >&2; exit 99",
            }
            for name, body in scripts.items():
                path = binary / name
                path.write_text(f"#!/bin/sh\n{body}\n")
                path.chmod(0o755)
            tools = home / "project" / "tools"
            tools.mkdir(parents=True)
            script = tools / "setup-dev.sh"
            shutil.copyfile(SCRIPT, script)
            registry = home / ".espressif" / "tools" / "eim_idf.json"
            registry.parent.mkdir(parents=True)
            sdk = home / "custom sdk"
            sdk.mkdir()
            (sdk / "commit").write_text("fff9895c82d744c7237be8847347bdd1b07c6643\n")
            activation = sdk / "activate.sh"
            activation.write_text(f'optional_argument="$1"\nexport IDF_PATH="{sdk}"\n')
            entry = {"id": "custom", "name": "My renamed SDK", "status": "finished",
                     "path": str(sdk), "activationScript": str(activation)}
            registry.write_text(json.dumps({"idfSelectedId": "custom", "idfInstalled": [entry]}))
            env = {**os.environ, "HOME": str(home), "PATH": f"{binary}:/usr/bin:/bin"}
            yield home, script, registry, entry, env

    def test_help_has_no_installation_side_effects(self):
        with tempfile.TemporaryDirectory() as home:
            result = self.run_setup("--help", env={**os.environ, "HOME": home})
            self.assertEqual(result.returncode, 0, result.stderr)
            for option in ("--firmware-only", "--check", "--skip-system", "--verify", "--with-vscode"):
                self.assertIn(option, result.stdout)
            self.assertNotIn("without installing or writing files", result.stdout)
            self.assertIn("temporary browser runtime files", result.stdout)
            self.assertEqual(list(Path(home).iterdir()), [])

    def test_unknown_option_fails_explicitly(self):
        result = self.run_setup("--unknown")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unknown option", result.stderr)

    def test_pins_match_repository(self):
        script = SCRIPT.read_text()
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        lock = (ROOT / "dependencies.lock").read_text()
        self.assertIn("IDF_VERSION=v6.1", script)
        self.assertIn("version: 6.1.0", lock)
        self.assertIn("espressif/idf:v6.1@", workflow)
        self.assertIn("NODE_VERSION=22.23.2", script)
        self.assertIn("node-version: '22.23.2'", workflow)

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_check_reports_missing_packages_without_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            (binary / "dpkg-query").write_text("#!/bin/sh\nexit 1\n")
            (binary / "sudo").write_text("#!/bin/sh\necho UNEXPECTED_SUDO >&2\nexit 99\n")
            for path in binary.iterdir():
                path.chmod(0o755)
            env = {**os.environ, "HOME": str(root), "PATH": f"{binary}:/usr/bin:/bin"}
            result = self.run_setup("--check", env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Missing system packages", result.stderr)
            self.assertIn("build-essential", result.stderr)
            self.assertNotIn("UNEXPECTED_SUDO", result.stderr)
            self.assertFalse((root / "esp").exists())
            firmware = self.run_setup("--check", "--firmware-only", env=env)
            self.assertNotIn("build-essential", firmware.stderr)

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_skip_system_never_requests_sudo(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory)
            (binary / "dpkg-query").write_text("#!/bin/sh\nexit 1\n")
            (binary / "sudo").write_text("#!/bin/sh\necho UNEXPECTED_SUDO >&2\nexit 99\n")
            for path in binary.iterdir():
                path.chmod(0o755)
            result = self.run_setup("--skip-system", env={
                **os.environ, "PATH": f"{binary}:/usr/bin:/bin",
            })
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Missing system packages", result.stderr)
            self.assertNotIn("UNEXPECTED_SUDO", result.stderr)

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_check_reuses_eim_and_rejects_wrong_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / "bin"
            binary.mkdir()
            scripts = {
                "dpkg-query": "echo 'install ok installed'",
                "git": "echo fff9895c82d744c7237be8847347bdd1b07c6643",
                "idf.py": "echo 'ESP-IDF v6.1'",
                "cmake": "echo 'cmake test'",
                "ninja": "echo 'ninja test'",
                "xtensa-esp-elf-gcc": "echo 'gcc test'",
                "python": "echo 'Python signing dependencies: OK'",
                "sudo": "echo UNEXPECTED_SUDO >&2; exit 99",
            }
            for name, body in scripts.items():
                path = binary / name
                path.write_text(f"#!/bin/sh\n{body}\n")
                path.chmod(0o755)
            sdk = home / ".espressif" / "v6.1" / "esp-idf"
            sdk.mkdir(parents=True)
            (sdk / "export.sh").touch()
            tools = home / ".espressif" / "tools"
            tools.mkdir()
            activation = tools / "activate_idf_v6.1.sh"
            activation.write_text(
                '[ "$0" = bash ] || { echo "incorrect sourcing shell" >&2; exit 1; }\n'
                f'export IDF_PATH="{sdk}"\n')
            registry = tools / "eim_idf.json"
            registry.write_text(json.dumps({
                "idfSelectedId": "test",
                "idfInstalled": [{"id": "test", "name": "v6.1", "status": "finished",
                                  "path": str(sdk), "activationScript": str(activation)}],
            }))
            env = {**os.environ, "HOME": str(home), "PATH": f"{binary}:/usr/bin:/bin"}
            result = self.run_setup("--check", "--firmware-only", env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(sdk), result.stdout)
            self.assertIn("Environment check passed", result.stdout)
            self.assertFalse((home / "esp").exists())
            self.assertNotIn("UNEXPECTED_SUDO", result.stderr)
            (binary / "git").write_text("#!/bin/sh\necho wrong-commit\n")
            result = self.run_setup("--check", "--firmware-only", env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not match the pinned", result.stderr)
            registry.write_text("invalid-json")
            result = self.run_setup("--check", "--firmware-only", env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("JSONDecodeError", result.stderr)

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_missing_sdk_check_does_not_clone(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / "bin"
            binary.mkdir()
            (binary / "dpkg-query").write_text("#!/bin/sh\necho 'install ok installed'\n")
            (binary / "git").write_text("#!/bin/sh\necho UNEXPECTED_GIT >&2\nexit 99\n")
            for path in binary.iterdir():
                path.chmod(0o755)
            result = self.run_setup("--check", "--firmware-only", env={
                **os.environ, "HOME": str(home), "PATH": f"{binary}:/usr/bin:/bin",
            })
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ESP-IDF v6.1 is not installed", result.stderr)
            self.assertNotIn("UNEXPECTED_GIT", result.stderr)
            self.assertFalse((home / "esp").exists())

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_fresh_install_checks_commit_before_running_sdk_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / "bin"
            binary.mkdir()
            tools = home / "project" / "tools"
            tools.mkdir(parents=True)
            script = tools / "setup-dev.sh"
            shutil.copyfile(SCRIPT, script)
            (binary / "dpkg-query").write_text("#!/bin/sh\necho 'install ok installed'\n")
            (binary / "git").write_text(
                '#!/bin/bash\n'
                'if [[ $1 == clone ]]; then\n'
                '  for target in "$@"; do :; done\n'
                '  mkdir -p "$target"\n'
                '  printf \'#!/bin/sh\\ntouch "$HOME/UNEXPECTED_INSTALL"\\n\' > "$target/install.sh"\n'
                'else\n'
                '  echo wrong-commit\n'
                'fi\n')
            for path in binary.iterdir():
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", str(script), "--skip-system", "--firmware-only"],
                env={**os.environ, "HOME": str(home), "PATH": f"{binary}:/usr/bin:/bin"},
                capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Downloaded SDK does not match", result.stderr)
            self.assertFalse((home / "UNEXPECTED_INSTALL").exists())

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_check_reuses_custom_named_eim_installation(self):
        with self.eim_fixture() as (home, script, _, entry, env):
            result = subprocess.run(
                ["bash", str(script), "--check", "--firmware-only"], env=env,
                capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f'Using ESP-IDF: {entry["path"]}', result.stdout)
            self.assertFalse((home / "esp").exists())
            self.assertFalse((script.parents[1] / ".cache").exists())

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_eim_selection_prefers_matching_selected_commit(self):
        with self.eim_fixture() as (home, script, registry, entry, env):
            other = home / "other sdk"
            other.mkdir()
            commit = other / "commit"
            commit.write_text((Path(entry["path"]) / "commit").read_text())
            activation = other / "activate.sh"
            activation.write_text(f'export IDF_PATH="{other}"\n')
            selected = {**entry, "id": "selected", "name": "ESP-IDF legacy display name",
                        "path": str(other), "activationScript": str(activation)}
            scenarios = [
                ("selected", "finished", "matching", str(other)),
                ("selected", "finished", "different", entry["path"]),
                ("custom", "finished", "matching", entry["path"]),
                ("selected", "installing", "matching", entry["path"]),
            ]
            for selected_id, status, revision, expected in scenarios:
                with self.subTest(selected=selected_id, status=status, revision=revision):
                    selected["status"] = status
                    commit.write_text("different\n" if revision == "different" else
                                      (Path(entry["path"]) / "commit").read_text())
                    registry.write_text(json.dumps({
                        "idfSelectedId": selected_id, "idfInstalled": [entry, selected],
                    }))
                    result = subprocess.run(
                        ["bash", str(script), "--check", "--firmware-only"], env=env,
                        capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(f"Using ESP-IDF: {expected}", result.stdout)
                    self.assertFalse((home / "esp").exists())

    @unittest.skipIf(os.geteuid() == 0, "Installer intentionally rejects root")
    def test_generated_activation_preserves_nounset_and_errors(self):
        with self.eim_fixture() as (_, script, _, entry, env):
            result = subprocess.run(
                ["bash", str(script), "--skip-system", "--firmware-only"], env=env,
                capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = script.parents[1] / ".cache" / "development-env.sh"
            activation = Path(entry["activationScript"])
            for fail in (False, True):
                if fail:
                    activation.write_text('optional_argument="$1"\nreturn 37\n')
                for nounset in (False, True):
                    with self.subTest(fail=fail, nounset=nounset):
                        command = (
                            f'set {"-u" if nounset else "+u"}; '
                            'source "$1"; status=$?; '
                            'printf "status=%s\\n" "$status"; '
                            'case $- in *u*) echo nounset=on;; *) echo nounset=off;; esac; '
                            'if declare -F _remote_keyboard_activate >/dev/null; then exit 99; fi')
                        sourced = subprocess.run(
                            ["bash", "-c", command, "bash", str(generated)], env=env,
                            capture_output=True, text=True, check=False)
                        self.assertEqual(sourced.returncode, 0, sourced.stderr)
                        self.assertIn(f'status={37 if fail else 0}', sourced.stdout)
                        self.assertIn(f'nounset={"on" if nounset else "off"}', sourced.stdout)
                        self.assertNotIn("unbound variable", sourced.stderr)
                        if fail:
                            self.assertIn("ESP-IDF activation failed (exit 37)", sourced.stderr)
                        else:
                            self.assertEqual(sourced.stderr, "")


if __name__ == "__main__":
    unittest.main()
