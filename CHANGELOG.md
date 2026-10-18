# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been released yet, so the entries below carry no release dates.

## [Unreleased]

## [0.2.1] — not released

### Fixed

- **Running row stayed on the placeholder config for a whole boot**: the shared settings mirror notifies subscribers with no argument, but the client read the listener's first parameter as the snapshot. Every notification after `apply()` was therefore mistaken for "not ready" and skipped, so the real profile config never reached the running row — it kept the default look with DSH's own copy until the page reloaded with the document already ready. The client now reads `form.getSnapshot()` on every notification instead of trusting the callback argument.
- **First frame showed the raw `{duration}` template**: DSH renders the running row with `chat.deepDiving` (no duration) until the turn's start time is known. The custom copy was interpolated with no parameters, so a line such as `…用时{duration}…` appeared verbatim for one frame. When the caller passes no `duration`, the line now renders with a zero duration (`0` + the chat dictionary's second unit, so `0秒` / `0s`) instead of the raw template; the real elapsed time replaces it on the next tick.
- **First turn after a page load kept DSH's own running copy**: `apply()` paints a placeholder config before the settings mirror delivers the real one. If a run started in that window, the run rolled against the placeholder and the live config was then ignored for the rest of that run — the row showed the default look with DSH's `深度求索中` copy while the settings page showed the configured presets. The first real config now re-rolls the active run once; later config changes still wait for the next run.

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
