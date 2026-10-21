"""Parse the actual generated deployment fixture through Compose; no daemon or containers required."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deployment_smoke", ROOT / "tests/docker/deployment-smoke.py")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI required; this check does not use a daemon")
class DeploymentSmokeConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="collective-deploy-config-")
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        smoke.prepare_fixture(directory)
        self.operator = smoke.LocalOperator(directory, "collective-deploy-config-fixture", "synthetic-fixture")

    def config(self, *profiles):
        arguments = [argument for profile in profiles for argument in ("--profile", profile)]
        return json.loads(self.operator.compose(smoke.manifest(None), *arguments, "config", "--format", "json"))

    def test_generated_core_config_parses_with_internal_default_and_no_ingress(self):
        config = self.config("maintenance")
        self.assertEqual(set(config["services"]), {"db", "web", "worker", "migrate", "backup"})
        self.assertTrue(config["networks"]["default"]["internal"])
        for service in config["services"].values():
            self.assertFalse(service.get("ports"))
            self.assertEqual(set(service["networks"]), {"default"})
        for name in ("pgdata", "uploads"):
            self.assertEqual(config["volumes"][name]["name"], f"collective-deploy-config-fixture_{name}")

    def test_optional_widget_network_survives_the_fixture_override_and_stays_separate(self):
        config = self.config("maintenance", "mcp-apps")
        self.assertEqual(set(config["networks"]), {"default", "mcp-apps"})
        self.assertTrue(config["networks"]["default"]["internal"])
        sandbox = config["services"]["mcp-app-sandbox"]
        self.assertEqual(set(sandbox["networks"]), {"mcp-apps"})
        self.assertEqual(sandbox["ports"][0]["host_ip"], "127.0.0.1")
        for name in ("db", "web", "worker", "migrate", "backup"):
            self.assertEqual(set(config["services"][name]["networks"]), {"default"})


if __name__ == "__main__":
    unittest.main()
