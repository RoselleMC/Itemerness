"""Validate commit-triggered releases and publish only complete build sets."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)


def release_version(message):
    markers = [
        line.removeprefix("Release:").strip()
        for line in message.splitlines()
        if line.startswith("Release:")
    ]
    if not markers:
        return None
    if len(markers) != 1 or not markers[0].startswith("v"):
        raise ValueError("Use exactly one release marker: Release: vMAJOR.MINOR.PATCH")
    version = markers[0][1:]
    match = VERSION.fullmatch(version)
    if not match or any(
        part.isdigit() and len(part) > 1 and part.startswith("0")
        for part in (match.group(4) or "").split(".")
    ):
        raise ValueError("Release version must be SemVer without build metadata")
    return version


def project_versions(root):
    properties = dict(
        line.split("=", 1)
        for line in (root / "gradle.properties").read_text().splitlines()
        if line and not line.startswith(("#", "!")) and "=" in line
    )
    cargo = tomllib.loads((root / "editor/apps/web/src-tauri/Cargo.toml").read_text())
    lock = tomllib.loads((root / "editor/apps/web/src-tauri/Cargo.lock").read_text())
    return {
        "plugin": properties["itemernessVersion"].strip(),
        "Cargo": cargo["package"]["version"],
        "Cargo.lock": next(
            package["version"]
            for package in lock["package"]
            if package["name"] == cargo["package"]["name"]
        ),
        **{
            path: json.loads((root / path).read_text())["version"]
            for path in (
                "editor/package.json",
                "editor/apps/web/package.json",
                "editor/apps/web/src-tauri/tauri.conf.json",
            )
        },
    }


def metadata(message, event, ref, versions):
    version = release_version(message)
    if version and any(value != version for value in versions.values()):
        raise ValueError(
            f"Release v{version} does not match project versions: {versions}"
        )
    return {
        "release": "true"
        if version and event == "push" and ref == "refs/heads/main"
        else "false",
        "version": version or versions["plugin"],
        "tag": f"v{version}" if version else "",
    }


def release_files(directory, version):
    expected = {
        "Itemerness.jar",
        f"Itemerness-Editor_{version}_macos_aarch64.app.zip",
        f"Itemerness-Editor_{version}_macos_x86_64.app.zip",
        f"Itemerness-Editor_{version}_windows_x86_64.exe",
    }
    actual = {entry.name for entry in directory.iterdir()}
    if actual != expected:
        raise ValueError(
            f"Incomplete release assets: expected {sorted(expected)}, found {sorted(actual)}"
        )
    files = sorted(directory.iterdir())
    if any(
        not file.is_file() or file.is_symlink() or file.stat().st_size == 0
        for file in files
    ):
        raise ValueError("Release assets must be nonempty regular files")
    checksum = directory / "SHA256SUMS"
    lines = []
    for file in files:
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        lines.append(f"{digest}  {file.name}\n")
    checksum.write_text("".join(lines), encoding="utf-8")
    return [*files, checksum]


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def publish(data):
    if data["release"] != "true":
        raise ValueError("Publishing requires a marked main-branch push")
    sha = os.environ["GITHUB_SHA"]
    if run("git", "rev-parse", "HEAD") != sha:
        raise ValueError("The checkout does not match the triggering commit")
    repo = os.environ["GITHUB_REPOSITORY"]
    tag = data["tag"]
    files = release_files(ROOT / "build/release", data["version"])
    releases = json.loads(
        run("gh", "api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100")
    )
    existing = next(
        (
            release
            for page in releases
            for release in page
            if release["tag_name"] == tag
        ),
        None,
    )
    if existing:
        target = (
            json.loads(run("gh", "api", f"repos/{repo}/commits/{tag}"))["sha"]
            if not existing["draft"]
            else existing["target_commitish"]
        )
        if target != sha:
            raise ValueError(f"{tag} already belongs to another commit")
        if not existing["draft"]:
            print(f"Already published: {existing['html_url']}")
            return
    else:
        # Never attach a release to a pre-existing tag, even if it has no release yet.
        refs = json.loads(
            run("gh", "api", f"repos/{repo}/git/matching-refs/tags/{tag}")
        )
        if any(ref["ref"] == f"refs/tags/{tag}" for ref in refs):
            raise ValueError(f"Tag {tag} already exists without a matching release")
        notes = ROOT / ".github/releases" / f"{tag}.md"
        args = ["--notes-file", str(notes)] if notes.is_file() else ["--generate-notes"]
        if "-" in data["version"]:
            args.append("--prerelease")
        run(
            "gh",
            "release",
            "create",
            tag,
            "--repo",
            repo,
            "--target",
            sha,
            "--title",
            f"Itemerness {tag}",
            "--draft",
            *args,
        )
    run(
        "gh",
        "release",
        "upload",
        tag,
        "--repo",
        repo,
        "--clobber",
        *(str(file) for file in files),
    )
    uploaded = json.loads(
        run("gh", "release", "view", tag, "--repo", repo, "--json", "assets")
    )["assets"]
    if {asset["name"]: asset["size"] for asset in uploaded} != {
        file.name: file.stat().st_size for file in files
    }:
        raise ValueError(
            "Draft release asset verification failed; the release remains private"
        )
    run("gh", "release", "edit", tag, "--repo", repo, "--draft=false")
    print(
        run(
            "gh",
            "release",
            "view",
            tag,
            "--repo",
            repo,
            "--json",
            "url",
            "--jq",
            ".url",
        )
    )


def main():
    data = metadata(
        run("git", "log", "-1", "--format=%B"),
        os.environ.get("GITHUB_EVENT_NAME"),
        os.environ.get("GITHUB_REF"),
        project_versions(ROOT),
    )
    if sys.argv[1:] == ["metadata"]:
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a", encoding="utf-8") as stream:
                stream.writelines(f"{key}={value}\n" for key, value in data.items())
        print(json.dumps(data))
    elif sys.argv[1:] == ["publish"]:
        publish(data)
    else:
        raise ValueError("Usage: release.py metadata|publish")


if __name__ == "__main__":
    main()
