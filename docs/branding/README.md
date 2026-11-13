# Scratchtree branding direction

Current discussion decisions, recorded November 13, 2026. These selections remain open to refinement. The Root navigation and Dock integration below use the selected family; the installed name, identifiers, and note location remain unchanged.

## Name and terminology

The working name is **Scratchtree**, with the description **“Fast Markdown notes, organized into note trees.”** The intended feel is simple, fast, and geared toward developers. “Note” and “note tree” are the leading vocabulary; exact terms for containers, descendants, and navigation remain under discussion. The intended future identity moves away from “stash” and “pad.”

## Current icon selections

The mark combines a rounded bare tree with a blue, wind-like S. The tree should be recognizable first and the S second. Smaller versions simplify the tree and stroke to preserve recognition. The smallest current selections use only the tree.

| Intended size      | Current selection                                                             | Preserved reference artwork                                           |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Greater than 128px | Fuller rounded contour, dry-brush S, tighter framing                          | [Large reference](reference-artwork/large-fuller-rounded-contour.png) |
| 128px              | Compact study, tighter framing                                                | [Compact reference](reference-artwork/compact-128.png)                |
| 64px               | D2 staggered two-branch tree and solid S, tighter framing                     | [D2 reference](reference-artwork/d2-64.png)                           |
| 32px               | Broad brush ribbon on the edge-to-edge D2 tree, with the **+3 S** enlargement | [Ribbon +3 reference](reference-artwork/ribbon-plus-3-32.png)         |
| 24px               | Edge-to-edge D2 tree only                                                     | [Tree-only reference](reference-artwork/tree-only-small.png)          |
| 16px               | Edge-to-edge D2 tree only                                                     | [Tree-only reference](reference-artwork/tree-only-small.png)          |

The 32px choice is the adjusted **+3** study, not the original ribbon or an earlier +3 pass. “+3” is a visual size-study label: the S grew approximately 3.1px in total height when displayed in a 32px square. It is not a font size. The tree and icon frame stay fixed in direction.

The large design derives from **Fix B — Fuller rounded contour**, not the later “Rounded wood bridge” variation. Tighter framing is now selected for all three larger designs: the tree's top, base, and outer branch tips touch, or come close to, the square's edges. These selected references have no review captions. The earlier framing remains in Git history. All linked PNGs are high-resolution generated concept references, not finished exports at the table's pixel sizes. [selection.json](selection.json) records their exact SHA-256 identities, including the shared reference for 24px and 16px.

The blue direction is the button/link blue from `@barbajoe/css-lib`, targeting `#0000EE`. Generated raster colors are approximate; exact palette matching remains part of production preparation. This color choice does not select a CSS library for the application.

## Still open

- Revisit the 24px and 16px tree-only versions; they remain the current choices meanwhile.
- Finalize the vocabulary and any naming alternatives before applying a rename.
- Explore light and dark treatments, platform icon containers, transparency, and final production assets.

The original concept references are preserved to keep the decisions recoverable from a fresh clone. They remain distinct from the generated native assets. No final vector master, favicon package, mobile icon package, or broader platform acceptance is established by these references.

## Current application integration

The sidebar uses a small, locally authored monochrome SVG interpretation of the selected tree-only silhouette, inheriting the text color. It labels the live-library destination Root, followed by a noninteractive separator. Root is always visible and never collapses. Other command and container icons remain unchanged.

The Mac Dock icon uses the selected reference artwork in a light rounded tile. See [the native asset guide](../../src-tauri/icons/README.md) for the reproducible generator, source-hash checks, representation mapping, and platform limits. Standard logical 16px slots use the tree-only artwork, 32px slots use the adjusted ribbon +3, 128px uses compact, and larger slots use the large design. Each Retina representation uses its logical-size artwork. The 24px and 64px selections remain preserved as references; the standard generated iconset has no corresponding logical slots. macOS chooses the representation for the actual Dock context.

This increment keeps Stashpad Preview and `tech.barbajoe.stashpad.preview`; it does not rename the app, change stored notes, add a menu-bar tray, or select a CSS library. Further small-size, palette, light/dark, and terminology refinements remain open.
