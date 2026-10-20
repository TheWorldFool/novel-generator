"""Build a signed APK. Signing material lives outside the Git repository."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from android_toolchain import java_home

ROOT = Path(__file__).resolve().parents[1]
LOCAL = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "NovelGenerator"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true", help="Download Android SDK and Gradle on Windows")
    args = parser.parse_args()
    if args.setup:
        subprocess.run([sys.executable, str(ROOT / "tools/android_toolchain.py")], check=True)
    env = os.environ.copy()
    sdk = env.get("ANDROID_HOME") or str(LOCAL / "toolchain/sdk")
    env["ANDROID_HOME"] = sdk
    env["ANDROID_SDK_ROOT"] = sdk
    env["JAVA_HOME"] = java_home()
    env.pop("DEBUG", None)
    signing_dir = LOCAL / "signing"
    signing_dir.mkdir(parents=True, exist_ok=True)
    config_path = signing_dir / "novel-generator.json"
    store = signing_dir / "novel-generator.jks"
    if config_path.exists():
        config = json.loads(config_path.read_text())
    else:
        config = {"password": secrets.token_urlsafe(36)}
        with config_path.open("x", encoding="utf-8") as f:
            json.dump(config, f)
        if os.name != "nt": config_path.chmod(0o600)
    env["NOVEL_SIGNING_STORE"] = str(store)
    env["NOVEL_SIGNING_PASSWORD"] = config["password"]
    keytool = str(Path(env["JAVA_HOME"]) / "bin" / ("keytool.exe" if os.name == "nt" else "keytool"))
    if not store.exists():
        subprocess.run([keytool, "-genkeypair", "-keystore", str(store), "-storetype", "JKS",
                        "-storepass:env", "NOVEL_SIGNING_PASSWORD", "-keypass:env", "NOVEL_SIGNING_PASSWORD",
                        "-alias", "novel-generator", "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
                        "-dname", "CN=TheWorldFool Novel Generator", "-noprompt"], env=env, check=True)
    gradle = LOCAL / "toolchain/gradle-8.13/bin/gradle.bat"
    if os.name != "nt" or not gradle.exists():
        gradle = ROOT / "android" / ("gradlew.bat" if os.name == "nt" else "gradlew")
    subprocess.run([str(gradle), "--no-daemon", "assembleRelease", "lintRelease"], cwd=ROOT / "android", env=env, check=True)
    apk_directory = ROOT / "android/app/build/outputs/apk/release"
    metadata = json.loads((apk_directory / "output-metadata.json").read_text(encoding="utf-8"))
    version = metadata["elements"][0]["versionName"]
    output = ROOT / f"dist/novel-generator-{version}-android.apk"
    output.parent.mkdir(exist_ok=True)
    shutil.copy2(apk_directory / "app-release.apk", output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".apk.sha256").write_text(digest + "  " + output.name + "\n", encoding="ascii")
    print("APK: " + str(output))
    print("SHA256: " + digest)
    print("Keep the signing directory backed up privately: " + str(signing_dir))


if __name__ == "__main__":
    main()
