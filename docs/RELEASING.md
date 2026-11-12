# Mac preview releases

Stashpad Preview currently installs through an Apple Silicon DMG published as a GitHub prerelease. Releases are manual; there is no automatic updater. The alpha uses local notes only, with no accounts or synchronization. [README.md](../README.md#download-and-install) is the user-facing installation guide.

The existing preview is ad-hoc signed, **not Developer ID signed or notarized**. Production signing, credentials, notarization, Intel builds, and other platforms require separate decisions. Keep the Preview identifier `tech.barbajoe.stashpad.preview` stable: its local library is separate from the application bundle. A future name or icon change must explicitly consider identity and data-location compatibility.

## Scope and prerequisites

- Follow [CONTRIBUTING.md](../CONTRIBUTING.md), including independent reviews, verification, and source identity. Packaging is not a replacement for implementation acceptance.
- Confirm the current task authorizes publishing a release. Code approval, a merged PR, or a past release does not grant standing publication or credential access. If publication is already authorized, complete the verified release without asking again.
- Use the README's pinned Node, pnpm, and Rust versions, macOS command-line build prerequisites, the `aarch64-apple-darwin` Rust target, Python 3 for the checks below, and authenticated GitHub CLI access to `Barbacoa08/stashpad`. Select the toolchains in the shell before running Tauri's child commands. Do not depend on another worktree's ignored toolchain/cache paths.
- Start from a clean, freshly fetched, verified release commit, normally merged `origin/main`, in an isolated worktree. Record commit/tree IDs, tool versions, architecture, commands, outcomes, and omissions in a dated ignored `.projects/` task folder.
- Never use an original Stashpad profile or bundle personal notes, SQLite files, backups, exports, private captures, credentials, or scratch directories. New installations start empty. Do not launch against an existing user profile merely to package the installer.

For a prose-only PR, documentation checks are sufficient and no new installer is needed. For a runtime release, verify the selected source under the contributor guide, and record the applicable packaged native checks and their limits. If a squash merge leaves the complete tracked tree identical to the tested PR head, retain both identities and the verified tree equality; do not imply a fresh test run occurred. Build the release afresh from the selected clean commit.

## Build and stage an immutable application

The shell examples assume the repository root and one continuing shell. Keep error checking enabled so a failed build cannot fall through to packaging a cached artifact. Choose an unused release tag before running them; the `N` below is a placeholder, not the next release number. Never overwrite an existing tag or release asset. Check the actual release list first.

```sh
set -eu
gh release list --repo Barbacoa08/stashpad
release_tag='v0.1.0-alpha.N' # Replace N with the approved unused number.
case "$release_tag" in *N*) echo 'Choose a real release tag first.' >&2; exit 1 ;; esac

git fetch origin --prune
test -z "$(git status --porcelain)"
release_commit=$(git rev-parse HEAD)
test "$release_commit" = "$(git rev-parse origin/main)"
release_dir=$(mktemp -d "$PWD/.projects/$(date +%F)-mac-release-XXXXXX")
git rev-parse HEAD 'HEAD^{tree}' > "$release_dir/source-identity.txt"
node --version > "$release_dir/tool-versions.txt"
pnpm --version >> "$release_dir/tool-versions.txt"
rustc --version >> "$release_dir/tool-versions.txt"
cargo --version >> "$release_dir/tool-versions.txt"

pnpm install --frozen-lockfile
release_target_dir=$(python3 -c 'import os; from pathlib import Path; print(Path(os.environ.get("CARGO_TARGET_DIR", "src-tauri/target")).resolve())')
env -u TAURI_CONFIG -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE \
  -u APPLE_CERTIFICATE_PASSWORD -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
  CARGO_TARGET_DIR="$release_target_dir" \
  pnpm exec tauri build --ci --no-sign --bundles app --target aarch64-apple-darwin \
  > "$release_dir/build-app.log" 2>&1

test -z "$(git status --porcelain)"
mkdir "$release_dir/staging" "$release_dir/assets"
release_app="$release_dir/staging/Stashpad Preview.app"
ditto "$release_target_dir/aarch64-apple-darwin/release/bundle/macos/Stashpad Preview.app" "$release_app"
codesign --force --sign - --timestamp=none \
  --identifier tech.barbajoe.stashpad.preview "$release_app"
codesign --verify --deep --strict --verbose=2 "$release_app"
codesign -dv --verbose=4 "$release_app" 2> "$release_dir/signature.txt"
ln -s /Applications "$release_dir/staging/Applications"
```

`--no-sign` builds without a signing identity; the subsequent `codesign --sign -` seals only the staged copy ad hoc. Do not change keychain, account, certificate, or notarization settings for this procedure. The checked-in `tauri:build` command makes an app bundle, not a DMG or a published release.

Read `Contents/Info.plist` and confirm product name, bundle identifier, executable, and internal version against the selected source configuration. Run `lipo -archs` on that executable and require `arm64`. Record `vtool -show-build` output; do not claim an older macOS version is supported merely because the plist lists it. Record every staged bundle file's relative path and SHA-256, and inspect its complete contents, including symlinks, against the expected application resources. Never copy a running app's data directory into staging. The staging root must contain only the application and the `/Applications` symlink.

Release tag and internal application version are different identities: alpha.1 and alpha.2 used internal version `0.1.0`. Read and disclose the actual values rather than silently changing source while packaging. A version/configuration change belongs in a reviewed source change before the release build.

## Package and inspect the DMG

```sh
release_label=${release_tag#v}
release_name="Stashpad-Preview_${release_label}_aarch64.dmg"
release_dmg="$release_dir/assets/$release_name"
test ! -e "$release_dmg"
hdiutil create -volname 'Stashpad Preview' -fs HFS+ \
  -srcfolder "$release_dir/staging" -format UDZO -imagekey zlib-level=9 \
  "$release_dmg" > "$release_dir/create-dmg.log" 2>&1
hdiutil verify "$release_dmg" > "$release_dir/verify-dmg.log" 2>&1

release_mount="$release_dir/verify-mount"
mkdir "$release_mount"
release_mounted=false
release_cleanup() {
  if [ "$release_mounted" = true ]; then
    hdiutil detach "$release_mount" || return 1
    release_mounted=false
  fi
  if [ -d "$release_mount" ]; then rmdir "$release_mount"; fi
}
trap 'release_cleanup' EXIT
trap 'exit 1' HUP INT TERM
hdiutil attach -readonly -noautoopen -nobrowse \
  -mountpoint "$release_mount" -plist "$release_dmg" \
  > "$release_dir/attach-result.plist"
release_mounted=true
```

The trap detaches the successfully attached image if a later check exits or is interrupted. Keep it active through inspection; equivalent verification scripts must use a cleanup/finally guard. If detachment fails, stop, retain the mount context, and resolve it without forcing unmounts. Check the returned mount point before reading it. Verify all of the following before upload:

1. The volume contains only the expected app, Applications shortcut, and ordinary filesystem metadata. The shortcut is a symlink to `/Applications`.
2. The mounted app's complete file/symlink inventory matches staging, and all file hashes equal the recorded signed manifest. Check identifier, internal version, executable, and arm64 architecture again on the mounted app.
3. `codesign --verify --deep --strict` succeeds on the mounted application. Signature integrity establishes an intact ad-hoc seal; it does not establish Developer ID trust or notarization.
4. There are no bundled notes, profiles, databases, exports, backups, credentials, or unrelated artifacts.
5. The image is detached successfully. Never leave a failed verification mount behind or upload after a failed check.

```sh
codesign --verify --deep --strict "$release_mount/Stashpad Preview.app"
release_cleanup
trap - EXIT HUP INT TERM
(cd "$release_dir/assets" && shasum -a 256 "$release_name" > SHA256SUMS.txt)
```

`hdiutil` may print deprecation notices on newer macOS versions. This is the verified packaging procedure used for the current alpha; record actual tool behavior and validate an alternative before changing the process.

## Release notes, upload, and publication

Write release notes inside the task folder. Include changes, source commit, actual verification and omissions, Apple Silicon/local-only limits, internal version, ad-hoc signing/notarization status, and installation/update instructions. Explain that replacing the app retains its separately stored library, while restoring a backup **replaces** the destination library. Recommend export before updating. Link [Apple's per-app opening instructions](https://support.apple.com/en-us/102445); managed Macs may restrict opening. Do not prescribe disabling system-wide protections or removing quarantine attributes.

Create a draft first so uploaded files can be checked before public publication:

```sh
gh release create "$release_tag" "$release_dmg" "$release_dir/assets/SHA256SUMS.txt" \
  --repo Barbacoa08/stashpad --draft --prerelease --target "$release_commit" \
  --title "Stashpad Preview $release_label — Apple Silicon" \
  --notes-file "$release_dir/release-notes.md"
gh api 'repos/Barbacoa08/stashpad/releases?per_page=100' \
  > "$release_dir/draft-releases.json"
gh release download "$release_tag" --repo Barbacoa08/stashpad \
  --dir "$release_dir/download-check" --pattern '*.dmg' --pattern SHA256SUMS.txt
cmp "$release_dmg" "$release_dir/download-check/$release_name"
cmp "$release_dir/assets/SHA256SUMS.txt" "$release_dir/download-check/SHA256SUMS.txt"
```

Before publishing, select the exact tag from the returned metadata and verify draft/prerelease flags, full target commit, exact asset names, uploaded state, byte counts, and asset digests against the local files. Both downloaded assets must be byte-identical. Do not mark those checks complete in release notes until they have actually passed. On failure, keep the release as a draft, preserve evidence, and resolve the issue before proceeding. Use the connected GitHub tools when they support the operation; the CLI supplies release mutations and binary transfers when the connector cannot.

When these checks pass and publication is authorized:

```sh
gh release edit "$release_tag" --repo Barbacoa08/stashpad \
  --draft=false --prerelease --latest=false
gh api "repos/Barbacoa08/stashpad/releases/tags/$release_tag" \
  > "$release_dir/published-release.json"
git ls-remote --tags origin "refs/tags/$release_tag" \
  > "$release_dir/published-tag.txt"
curl --fail --location --silent --show-error \
  --output "$release_dir/public-download.dmg" \
  "https://github.com/Barbacoa08/stashpad/releases/download/$release_tag/$release_name"
cmp "$release_dmg" "$release_dir/public-download.dmg"
```

Confirm public metadata says `draft: false`, `prerelease: true`, and the expected target/assets; the published tag must resolve to the exact release commit. The unauthenticated public download must match the local SHA-256 and byte count. Preserve the release URL, artifact identities, verification output, and any omissions locally. If post-publication checks fail, report the failure and assess the next action under the current authorization; do not silently replace immutable assets or repoint tags.

Update the root README's installation link through the normal reviewed change process. Prereleases are not reliably addressed by `releases/latest`; use the exact tag/asset URLs. A docs-only follow-up does not require rebuilding the same application. Never advertise synchronization, automatic updates, notarization, or wider platform support that the released build does not provide.
