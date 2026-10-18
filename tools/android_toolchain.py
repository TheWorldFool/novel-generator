"""Install a project-local Android build toolchain (outside the source tree)."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import re

BASE = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "NovelGenerator" / "toolchain"
GRADLE_VERSION = "8.13"


def java_home():
    configured = os.environ.get("JAVA_HOME")
    if configured:
        return configured
    result = subprocess.run(["java", "-XshowSettings:properties", "-version"], capture_output=True, text=True, check=True)
    match = re.search(r"^\s*java.home\s*=\s*(.+)$", result.stderr, re.MULTILINE)
    if not match:
        raise RuntimeError("Install JDK 17 or newer and set JAVA_HOME")
    return match.group(1).strip()


def download(url, target, digest=None, algorithm="sha256"):
    if target.exists() and (not digest or hashlib.new(algorithm, target.read_bytes()).hexdigest() == digest):
        return
    print("Downloading " + target.name, flush=True)
    part = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as source, part.open("wb") as dest:
        shutil.copyfileobj(source, dest)
    if digest and hashlib.new(algorithm, part.read_bytes()).hexdigest() != digest:
        raise RuntimeError("Download checksum mismatch: " + target.name)
    part.replace(target)


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    sdk = BASE / "sdk"
    sdkmanager = sdk / "cmdline-tools/19.0/bin/sdkmanager.bat"
    if not sdkmanager.exists():
        with urllib.request.urlopen("https://dl.google.com/android/repository/repository2-1.xml", timeout=60) as r:
            root = ET.fromstring(r.read())
        candidates = []
        for package in root.findall("remotePackage"):
            if package.get("path") != "cmdline-tools;19.0":
                continue
            if package.findtext("channelRef") or package.find("obsolete") is not None:
                continue
            channel = package.find("channelRef")
            if channel is not None and channel.get("ref") != "channel-0":
                continue
            for archive in package.findall("archives/archive"):
                if archive.findtext("host-os") == "windows":
                    revision = package.find("revision")
                    version = tuple(int(revision.findtext(k, "0")) for k in ("major", "minor", "micro"))
                    candidates.append((version, archive.find("complete")))
        _, archive = max(candidates, key=lambda x: x[0])
        checksum = archive.find("checksum")
        target = BASE / "commandlinetools-19.zip"
        download("https://dl.google.com/android/repository/" + archive.findtext("url"), target, checksum.text, checksum.get("type", "sha1"))
        unpack = BASE / "commandlinetools-unpack"
        with zipfile.ZipFile(target) as z:
            z.extractall(unpack)
        sdkmanager.parent.parent.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(unpack / "cmdline-tools"), str(sdkmanager.parent.parent))
    gradle = BASE / ("gradle-" + GRADLE_VERSION)
    if not gradle.exists():
        url = f"https://services.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip"
        with urllib.request.urlopen(url + ".sha256", timeout=60) as r:
            digest = r.read().decode().strip()
        target = BASE / f"gradle-{GRADLE_VERSION}-bin.zip"
        download(url, target, digest)
        with zipfile.ZipFile(target) as z:
            z.extractall(BASE)
    env = os.environ.copy()
    # Use the same JDK as javac, without changing the machine's environment.
    env["JAVA_HOME"] = java_home()
    env.pop("DEBUG", None)
    subprocess.run([str(sdkmanager), "--sdk_root=" + str(sdk), "--licenses"], input="y\n" * 100, text=True, env=env, check=True)
    subprocess.run([str(sdkmanager), "--sdk_root=" + str(sdk), "platforms;android-35", "build-tools;35.0.0", "platform-tools"], env=env, check=True)
    if not (sdk / "platforms/android-35/android.jar").exists():
        raise RuntimeError("Android SDK installation did not produce android.jar")
    print("SDK: " + str(sdk), flush=True)
    print("Gradle: " + str(gradle), flush=True)


if __name__ == "__main__":
    main()
