# Mac application icon

`icon.icns` is the native Dock/Finder app icon configured by `tauri.conf.json`. It is generated from the five selected concept references and their exact SHA-256 identities in [the branding record](../../docs/branding/README.md) and [selection ledger](../../docs/branding/selection.json), originating in source commit `149b2c6ba2314685933aebe2c711c7b833d3282b`. References are independently generated project artwork, not original Stashpad assets.

Run from the repository root on macOS with the Xcode command-line tools:

```sh
swift scripts/generate-macos-icon.swift
```

The generator checks all source hashes, draws the unchanged reference into a light rounded-square tile with transparent outer padding, and writes a standard ICNS container containing ten PNG representations. It uses native macOS frameworks and adds no package dependency. Identical output was verified on the development environment; byte-for-byte equality across macOS/toolchain versions is not guaranteed. Commit the generated ICNS whenever deliberately changing an approved source or the generator.

| Logical size | Source                   | Pixel sizes at 1x / 2x |
| ------------ | ------------------------ | ---------------------- |
| 16           | Tree only                | 16 / 32                |
| 32           | Adjusted ribbon +3       | 32 / 64                |
| 128          | Compact, tighter framing | 128 / 256              |
| 256          | Large, tighter framing   | 256 / 512              |
| 512          | Large, tighter framing   | 512 / 1024             |

The standard iconset has no logical 24px or 64px slots. Those approved references remain available for other contexts. The operating system chooses a representation; arbitrary Dock sizes do not establish exact variant selection. The small in-app Root icon is a separate authored SVG interpretation of the tree-only silhouette, using `currentColor`.

To inspect the generated representations, extract a copy into a temporary directory with `iconutil -c iconset -o <temporary-directory>/Preview.iconset src-tauri/icons/icon.icns`. The generator writes standard PNG ICNS chunks directly because the iconutil encoder rejected the generated iconset in the development environment; native extraction successfully verified all ten slots. Preserve transparent padding, light-tile contrast, and the selected logical-size mapping when making future changes.
