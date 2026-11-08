# 美化管理器

SillyTavern extension for managing and recoloring a CSS-injected beauty theme's own decorative images, without editing the theme's original files.

## Features

- Injects an entry into the Extensions (wand) menu.
- **Scan**: finds the current theme's decorative images across the whole page (CSS background images, IMG, SVG image, Canvas), skipping the roleplay chat content itself.
- **Manager grid**: lists scanned images as thumbnails; click one to edit it.
- **Manual pick**: duangduang-style point-and-click fallback for anything the scan misses (same-origin iframes, open Shadow DOM, images inside `<a>` links).
- Replace a selected image with a local file (stored in IndexedDB) or restore the original.
- Independent background / decoration / overall color layers, each with hue, saturation, brightness and contrast. Adjustments apply as a CSS `filter` on the matched element itself — not a translucent overlay — so there's no page-wide color wash.
- Elements are keyed by their **original resource URL**, not a random id, so saved edits automatically re-apply next time the same theme renders the same asset (page reload, chat switch, etc.).
- **Theme binding**: save the current set of edits as a named profile stored in the extension's own settings, and switch between profiles from a dropdown.
- **Export / import**: export the current edits (images inlined as base64) to a standalone `.json` file that isn't kept in the extension's storage, and import it back later.

## Install

Add this repository URL in SillyTavern's extension installer:

`https://github.com/1614130601zjs-del/st-beauty-controller`

## Notes

Image hit-testing is adapted from the working implementation in [duangduang](https://github.com/1614130601zjs-del/duangduang). Original theme files are never edited; all changes live in the extension's own settings/IndexedDB until exported.

Canvas-based decorations have no stable source URL, so their saved edits are session-scoped only (keyed by a random id) and won't auto-reapply after a reload.
