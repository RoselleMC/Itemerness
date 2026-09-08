import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release


class ReleaseTest(unittest.TestCase):
    def test_only_an_exact_marker_requests_a_version(self):
        for message in (
            "Fix release handling",
            "chore(release): v0.1.0",
            "Mention Release: v0.1.0",
            "    Release: v0.1.0",
        ):
            self.assertIsNone(release.release_version(message))
        self.assertEqual(
            release.release_version("First release\n\nRelease: v0.1.0\n"), "0.1.0"
        )
        self.assertEqual(release.release_version("Release: v1.2.3-rc.1"), "1.2.3-rc.1")

    def test_malformed_or_ambiguous_markers_fail_closed(self):
        for message in (
            "Release:",
            "Release: 0.1.0",
            "Release: v01.1.0",
            "Release: v1.2",
            "Release: v1.2.3; echo injected",
            "Release: v1.2.3+build",
            "Release: v1.2.3-rc.01",
            "Release: v0.1.0\nRelease: v0.1.0",
        ):
            with self.subTest(message=message), self.assertRaises(ValueError):
                release.release_version(message)

    def test_only_main_pushes_publish(self):
        versions = {"plugin": "0.1.0", "editor": "0.1.0"}
        for event, ref in (
            ("pull_request", "refs/pull/1/merge"),
            ("workflow_dispatch", "refs/heads/main"),
            ("push", "refs/heads/feature"),
            ("push", "refs/tags/v0.1.0"),
        ):
            self.assertEqual(
                release.metadata("Release: v0.1.0", event, ref, versions)["release"],
                "false",
            )
        self.assertEqual(
            release.metadata("Release: v0.1.0", "push", "refs/heads/main", versions)[
                "release"
            ],
            "true",
        )
        self.assertEqual(
            release.metadata("Fix editor", "push", "refs/heads/main", versions)[
                "release"
            ],
            "false",
        )

    def test_release_requires_matching_versions(self):
        with self.assertRaises(ValueError):
            release.metadata(
                "Release: v0.1.0",
                "push",
                "refs/heads/main",
                {"plugin": "0.1.0-SNAPSHOT", "editor": "0.1.0"},
            )
        self.assertEqual(
            release.metadata(
                "Next development commit",
                "push",
                "refs/heads/main",
                {"plugin": "0.2.0-SNAPSHOT"},
            )["version"],
            "0.2.0-SNAPSHOT",
        )

    def test_real_project_versions_are_read_from_build_manifests(self):
        versions = release.project_versions(release.ROOT)
        self.assertEqual(len(versions), 6)
        self.assertTrue(
            all(release.VERSION.fullmatch(version) for version in versions.values())
        )
        self.assertEqual(versions["Cargo"], versions["Cargo.lock"])

    def assets(self, directory):
        for name in (
            "Itemerness.jar",
            "Itemerness-Editor_0.1.0_macos_aarch64.app.zip",
            "Itemerness-Editor_0.1.0_macos_x86_64.app.zip",
            "Itemerness-Editor_0.1.0_windows_x86_64.exe",
        ):
            (directory / name).write_bytes(b"artifact")

    def test_complete_assets_get_sorted_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            files = release.release_files(directory, "0.1.0")
            self.assertEqual(len(files), 5)
            lines = files[-1].read_text().splitlines()
            self.assertEqual(lines, sorted(lines))
            self.assertTrue(
                all(
                    line.startswith(hashlib.sha256(b"artifact").hexdigest())
                    for line in lines
                )
            )

    def test_missing_extra_empty_or_wrong_version_assets_block_publication(self):
        for failure in ("missing", "extra", "empty", "version"):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = Path(temporary)
                self.assets(directory)
                if failure == "missing":
                    (directory / "Itemerness.jar").unlink()
                elif failure == "extra":
                    (directory / "unexpected.jar").write_bytes(b"other")
                elif failure == "empty":
                    (directory / "Itemerness.jar").write_bytes(b"")
                with self.assertRaises(ValueError):
                    release.release_files(
                        directory, "0.2.0" if failure == "version" else "0.1.0"
                    )

    def test_publication_requires_a_release_event(self):
        with self.assertRaises(ValueError):
            release.publish({"release": "false"})

    def test_existing_public_release_is_never_overwritten(self):
        sha = "a" * 40
        existing = {
            "tag_name": "v0.1.0",
            "draft": False,
            "html_url": "https://example.test/release",
        }
        for target in (sha, "b" * 40):
            with (
                self.subTest(target=target),
                patch.dict(
                    release.os.environ,
                    {"GITHUB_SHA": sha, "GITHUB_REPOSITORY": "owner/repo"},
                ),
                patch.object(release, "release_files", return_value=[]),
                patch.object(
                    release,
                    "run",
                    side_effect=[
                        sha,
                        json.dumps([[existing]]),
                        json.dumps({"sha": target}),
                    ],
                ) as run,
            ):
                if target == sha:
                    release.publish(
                        {"release": "true", "tag": "v0.1.0", "version": "0.1.0"}
                    )
                else:
                    with self.assertRaises(ValueError):
                        release.publish(
                            {"release": "true", "tag": "v0.1.0", "version": "0.1.0"}
                        )
                self.assertEqual(run.call_count, 3)

    def test_a_draft_for_a_different_commit_cannot_be_reused(self):
        sha = "a" * 40
        existing = {"tag_name": "v0.1.0", "draft": True, "target_commitish": "b" * 40}
        with (
            patch.dict(
                release.os.environ,
                {"GITHUB_SHA": sha, "GITHUB_REPOSITORY": "owner/repo"},
            ),
            patch.object(release, "release_files", return_value=[]),
            patch.object(
                release, "run", side_effect=[sha, json.dumps([[existing]])]
            ) as run,
        ):
            with self.assertRaises(ValueError):
                release.publish(
                    {"release": "true", "tag": "v0.1.0", "version": "0.1.0"}
                )
            self.assertEqual(run.call_count, 2)

    def test_an_existing_tag_without_a_release_cannot_be_reused(self):
        sha = "a" * 40
        with (
            patch.dict(
                release.os.environ,
                {"GITHUB_SHA": sha, "GITHUB_REPOSITORY": "owner/repo"},
            ),
            patch.object(release, "release_files", return_value=[]),
            patch.object(
                release,
                "run",
                side_effect=[sha, "[[]]", '[{"ref":"refs/tags/v0.1.0"}]'],
            ) as run,
        ):
            with self.assertRaises(ValueError):
                release.publish(
                    {"release": "true", "tag": "v0.1.0", "version": "0.1.0"}
                )
            self.assertEqual(run.call_count, 3)

    def test_uploads_are_verified_before_a_draft_becomes_public(self):
        sha = "a" * 40
        for failure in (None, "upload", "verification"):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as temporary,
            ):
                file = Path(temporary) / "artifact.zip"
                file.write_bytes(b"artifact")
                responses = [sha, "[[]]", "[]", ""]
                if failure == "upload":
                    responses.append(
                        release.subprocess.CalledProcessError(1, "gh release upload")
                    )
                else:
                    responses.extend(
                        [
                            "",
                            json.dumps(
                                {
                                    "assets": []
                                    if failure
                                    else [
                                        {"name": file.name, "size": file.stat().st_size}
                                    ]
                                }
                            ),
                        ]
                    )
                if not failure:
                    responses.extend(["", "https://example.test/release"])
                with (
                    patch.dict(
                        release.os.environ,
                        {"GITHUB_SHA": sha, "GITHUB_REPOSITORY": "owner/repo"},
                    ),
                    patch.object(release, "release_files", return_value=[file]),
                    patch.object(release, "run", side_effect=responses) as run,
                ):
                    data = {"release": "true", "tag": "v0.1.0", "version": "0.1.0"}
                    if failure:
                        with self.assertRaises(
                            (ValueError, release.subprocess.CalledProcessError)
                        ):
                            release.publish(data)
                    else:
                        release.publish(data)
                    calls = [call.args for call in run.call_args_list]
                    self.assertIn("--draft", calls[3])
                    self.assertEqual(
                        any("--draft=false" in call for call in calls), failure is None
                    )


if __name__ == "__main__":
    unittest.main()
