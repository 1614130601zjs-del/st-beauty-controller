# 美化管理器

SillyTavern extension for managing and recoloring a CSS-injected beauty theme's own decorative images, without editing the theme's original files.

## Features

- Injects an entry into the Extensions (wand) menu.
- **Scan**, two sources combined:
  - **CSS source scan**: reads SillyTavern's own Custom CSS stylesheet (`#custom-style`, i.e. `power_user.custom_css`, following `@import` one level) directly via the CSSOM, and pulls every `url(...)` out of `background`/`background-image`/`border-image`/`mask`/`list-style-image`/`content` declarations, together with the selector that owns it. This finds things a live-DOM scan never can — `:hover` states, unopened modals, `::before`/`::after` pseudo-element art — because it reads the rule itself, not a rendered element.
  - **DOM scan**: walks the rendered page for `IMG`/`CANVAS`/`SVG image` and elements with a computed background image, skipping the roleplay chat content itself. Catches anything injected via JS/HTML rather than the Custom CSS box.
- **Manager grid**: lists results from both scans as thumbnails; click one to edit it.
- **Manual pick**: duangduang-style point-and-click fallback for anything neither scan reaches (same-origin iframes, open Shadow DOM, images inside `<a>` links).
- Replace a selected image with a local file (stored in IndexedDB) or restore the original.
- Independent background / decoration / overall color layers, each with hue, saturation, brightness and contrast.
  - DOM-sourced hits: the filter applies directly to the matched element — not a translucent overlay — so there's no page-wide color wash.
  - CSS-sourced hits: the replacement/filter is written as a new rule (same selector, `!important`) into the extension's own `<style id="sbc-override-style">`, appended after the theme's stylesheet. This is why it keeps applying automatically to every future match of that selector, with no DOM watching needed.
- DOM-sourced elements are keyed by their **original resource URL**; CSS-sourced rules are keyed by **selector + property** — neither is a random id, so saved edits automatically re-apply next time the same theme renders the same asset (page reload, chat switch, etc.).
- **Theme binding**: save the current set of edits as a named profile stored in the extension's own settings, and switch between profiles from a dropdown.
- **Export / import**: export the current edits (images inlined as base64) to a standalone `.json` file that isn't kept in the extension's storage, and import it back later.

## Install

Add this repository URL in SillyTavern's extension installer:

`https://github.com/1614130601zjs-del/st-beauty-controller`

## Notes

Image hit-testing is adapted from the working implementation in [duangduang](https://github.com/1614130601zjs-del/duangduang). Original theme files are never edited; all changes live in the extension's own settings/IndexedDB until exported.

Canvas-based decorations have no stable source URL, so their saved edits are session-scoped only (keyed by a random id) and won't auto-reapply after a reload.
