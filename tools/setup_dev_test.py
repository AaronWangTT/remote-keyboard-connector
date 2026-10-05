import json
import os
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

    def test_help_has_no_installation_side_effects(self):
        with tempfile.TemporaryDirectory() as home:
            result = self.run_setup("--help", env={**os.environ, "HOME": home})
            self.assertEqual(result.returncode, 0, result.stderr)
            for option in ("--firmware-only", "--check", "--skip-system", "--verify", "--with-vscode"):
                self.assertIn(option, result.stdout)
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


if __name__ == "__main__":
    unittest.main()
