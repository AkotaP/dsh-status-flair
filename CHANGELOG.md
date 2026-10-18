# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been released yet, so the entries below carry no release dates.

## [Unreleased]

## [0.2.0] — not released

### Added

- **Two preset layers**: looks (colour, size, icon, shimmer) and text groups (named sets of candidate lines) are separate; each layer has its own fixed/random strategy, and the line inside a picked group uses first / random / rotate.
- **Default entries** for both layers. The default look sets no CSS variable and removes the plugin marker, so DSH renders the row itself; the default copy passes `translate` through to DSH's own `chat.deepDivingFor`. Nothing official is copied into the plugin.
- **Multi-select dropdown** for random candidates, replacing the ever-growing checkbox row: an "All" summary, select-all, and a guard against zero candidates.
- **Official whale icon**: `icon: whale` reuses the running row's APNG whale tail — resolved from DSH's injected stylesheet as a mask, so colour and size follow the preset while nothing is copied. The whale's own loop speed is baked into the APNG; the preset shimmer still controls the text sweep.
- **Custom icons**: paste `<svg>` markup or upload an SVG / transparent PNG; the icon is used as a mask (alpha shape only), so it follows the preset colour. Scripts, event attributes, `foreignObject` and external `href` values are stripped.
- **Draft + explicit save**: every adjustment lands in an in-page draft and applies live to the running row and preview; only *Save changes* persists through `ctx.configForms`. *Discard changes* (or leaving the page) reverts an unsaved draft.
- **Native whale preview**: the default look preview reads the official APNG whale mask out of DSH's own stylesheets instead of shipping a copy.
- **Bilingual UI**: complete `zh` / `en` dictionaries; shipped preset names, icon labels and the default line for a new text group follow the DSH locale.
- Read-only `GET /status-flair/health` route, including a browser-client heartbeat for installation diagnostics.

### Changed

- Package renamed from `@local/dsh-status-flair` to `dsh-status-flair`; the client half keeps a short transition shim for hosts that still hold the old client graph row until restart.
- Config split into `presets` and `textPresets`; legacy `presets[].texts` is migrated on first read.
- The shipped configuration now contains the three look presets only, with no text groups.
- The golden preset is renamed from 暖金色思考 to 暖金色 (migrated by name).
- Built-in preset rows keep editable-looking buttons but show them disabled, so the ★ and badges stay aligned.

### Fixed

- The save button was white-on-white: the primary button now uses DSH's own `--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-foreground` pair.
- The ★ marker drifted from the preview: it now marks the row the preview actually sampled and re-samples when the selection changes.
- The "saved" notice moved the page: the status line now has a fixed slot.
- Custom icons using `fill="currentColor"` were invisible as data-URI masks in Chromium; the mask builder now substitutes a solid colour.

## [0.1.0] — not released

- Initial feature set: named looks with copy candidate lines, CSS overrides on `[data-chat-running]`, a `LocaleRuntime#translate` wrapper for `chat.deepDiving` / `chat.deepDivingFor`, fixed/random preset candidate selection, and first/random/rotate copy selection.
