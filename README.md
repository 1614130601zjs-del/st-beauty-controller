# 美化调节

SillyTavern extension for selecting page images and tuning visual appearance without editing the original theme files.

## Features

- Injects an entry into the Extensions menu.
- Selects IMG, CSS background images, Canvas and SVG images; supports same-origin iframes and open Shadow DOM.
- Replaces a selected image with a local file and stores the original file data in IndexedDB.
- Provides independent background, decoration and overall adjustment layers.
- Hue, saturation, brightness and contrast controls with automatic settings persistence.

## Install

Add this repository URL in SillyTavern's extension installer:

`https://github.com/1614130601zjs-del/st-beauty-controller`

## Notes

Image hit-testing is adapted from the working implementation in [duangduang](https://github.com/1614130601zjs-del/duangduang). Original theme files are not edited.
