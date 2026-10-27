# HTML Parquet Viewer

A self-contained, offline Parquet file viewer delivered as **one HTML file**.

Open the file in a modern browser, select or drop Parquet files, and inspect them locally. No installation, build step, server, CDN, or network connection is required.

![HTML Parquet Viewer demo](assets/demo.gif)


## Try it online

Open the hosted viewer:  
[parquet-viewer.html](https://ttomohisa.github.io/html-parquet-viewer/parquet-viewer.html)

Your files stay in your browser. Nothing is uploaded.

## Why

Parquet files often need a quick inspection on locked-down workstations, air-gapped networks, or during data-pipeline debugging. This viewer is designed for that job:

- **Single-file distribution** — copy one HTML file anywhere
- **Offline and private** — files stay in your browser, with network connections blocked by Content Security Policy
- **Metadata-first preview** — reads the footer and only the requested preview range; it does not eagerly expand the whole file into memory
- **No dependencies at runtime** — scripts, styles, and required codecs are embedded

## Features

- Open one or many local Parquet files from the picker or with drag and drop
- Work with several files at once in closable tabs
- Read Parquet v1 and v2 files
- Support uncompressed, Snappy, Gzip, Brotli, LZ4, LZ4_RAW, and Zstandard data
- Inspect file metadata (`created_by` and custom key/value metadata), schema, row count, row groups, and codecs
- Browse preview rows without loading the entire file
- Choose 50, 100, 250, 500, or 1,000 rows per page
- Jump directly to a page and see `Page N of M`
- Collapse the Schema and Data preview panels
- Display concise type badges such as `text`, `int64`, `time`, and `decimal`
- Distinguish `null` from an empty string without adding noise to empty cells
- Sort the current preview page: ascending → descending → reset, with exact signed BigInt ordering
- Find literal values on the current page with matching-row highlights, counts, and previous/next navigation
- Save or copy every row on the current page as CSV, with an editable export filename
- Switch the complete application and help between Japanese and English without resetting open files, pages, sorting or Find
- Explain common read errors in actionable language

## Quick start

1. Download [`parquet-viewer.html`](./parquet-viewer.html) from this repository.
2. Open it in a current Chromium-based browser, Firefox, or Safari.
3. Choose one or more `.parquet` files, or drag them into the drop area.

There is no upload. Your selected files remain local to your browser session.

## Preview behavior

The viewer is intentionally a **preview and inspection** tool, not a full query engine.

- Paging reads the current range of rows from the local file.
- Sorting and finding are explicitly limited to the current preview page. Finding never filters rows or reads another page.
- Find is case-insensitive and searches displayed cell text, including the `null` marker. Empty cells remain empty. Binary values are searched only through their displayed summary (the first 24 bytes), not their hidden bytes.
- Each tab keeps its find query in memory. Page and sort changes reset the current match; loading or failed reads clear old results.
- Files whose metadata cannot be read retain their own error tab, which can be closed.
- Each tab retains its own completed preview and sort order. Switching back does not re-read a completed page.
- CSV actions are disabled while a page is loading or after a read failure. Retry by entering the page number again or choosing a smaller page size.
- The `Save CSV` and `Copy CSV` actions use every row of the completed current page, including its current sort order. Find highlights never narrow the export. Edit the CSV filename beside the actions; a `.csv` extension is always used and filename characters unsafe on common desktop systems are replaced. The filename and CSV contents are captured when the action starts.
- Opening a new tab does not upload or persist a file; closing/reloading the browser removes the in-memory session.

## UI notes

| Interaction | Behavior |
|---|---|
| Click a column header, or focus its button and press Enter / Space | Ascending sort for the current page |
| Click it again | Descending sort |
| Click it a third time | Reset to the original read order |
| Tab to **Choose Parquet files** or a file's named close button, then press Enter / Space | Open the file picker or close that file |
| Click **Schema**, **File metadata**, or **Data preview** | Collapse or expand that section |
| Click **Save CSV** | Start downloading every row on the current preview page as a UTF-8 CSV file with the edited name |
| Click **Copy CSV** | Copy the current preview page to the clipboard (with a local-file fallback) |
| Enter a page number | Jump to that page |
| Type in **Find values on this page** | Highlight matching rows without changing CSV contents or order |
| Press Enter / Shift+Enter in Find | Move to the next / previous matching row, wrapping within this page |
| Press Escape in Find or click **Clear** | Remove the query and highlights |

## Supported formats

| Item | Support |
|---|---|
| Parquet format | v1 and v2 |
| Compression | Uncompressed, Snappy, Gzip, Brotli, LZ4, LZ4_RAW, Zstandard |
| Files | Local files selected via browser picker or drag and drop |
| Network | Not required; the viewer is designed to run offline |

Support ultimately depends on the encodings used by the file and the embedded parser/codecs. If a file cannot be read, the app distinguishes common cases such as a missing `PAR1` header, a truncated/invalid footer, unsupported encoding or compression, and preview rendering failures.

## Development

The distributable is deliberately a single generated HTML file. If you modify it directly, keep these principles intact:

- Do not add external CDN or network dependencies.
- Keep the Content Security Policy restrictive (`connect-src 'none'`) and do not comment it out.
- Test with both small and large files, multiple row groups, and compressed input.
- Test the file picker and multi-file drag-and-drop flows.

### Catalog metadata

`app.config.json` declares `versionPolicy: "unversioned"` deliberately: the app has no semantic release version, version badge, or build step. The `build.output` field identifies the already-shipped `parquet-viewer.html`; it does not introduce a builder. `build.blockRuntimeNetwork: true` records the existing restrictive CSP. The UI and in-app help support Japanese and English. Startup uses a valid `?lang=ja` / `?lang=en`, then the shared `browser-kitty:ui-language:v1` preference, then the first supported browser language, then English. Only an explicit language choice attempts to write the shared preference. Storage failure still switches the current screen and shows a session-only language notice. Existing `lang` query parameters are updated without adding history. The canonical catalog screenshots (`assets/screenshot.png` and `assets/screenshot-en.png`) reuse the genuine English demo capture in `assets/demo.png`, showing the bundled synthetic Parquet sample.

### State regression checks

Run `node scripts/embed-ui-conventions.cjs --check` and `node --test` with Node.js 22 or newer. No packages or parser build step are needed.

The tests evaluate the application functions extracted from the shipped HTML, using a small DOM adapter, deferred parser-boundary doubles and fictitious row values. They cover tab/request ownership, metadata and page failures, page/CSV identity, retry, sorting, navigation, empty results and clipboard callbacks. Find checks cover literal/display-format matching, row navigation, tab/page ownership, and unchanged CSV/read behavior. BigInt checks cover signed INT64 extremes and adjacent values beyond Number precision. Keyboard-control checks cover native-button markup, sort state announcements, actual click handlers and focus continuity across tab/header replacement, including pending reads and newer focus. Contract checks preserve the embedded parser/codecs, CSP and notices. Every shipped inline module is also passed to Node with `--input-type=module --check`, so duplicate module bindings cannot slip through classic-script VM checks.

The UI adapter tests also parse the bundled Snappy sample with the unchanged embedded parser, compare first/second/sorted-page CSV hashes captured from baseline `0e8c03c9dcb85f54f9db79d014c4693a4e55b69a`, reject invalid/truncated inputs, and verify bilingual controls, rejected storage, edited filenames, snapshots, BOM, duplicate-copy prevention and stale callbacks. A fixed Zstandard frame verifies that the embedded ZSTD decoder remains callable after app initialization and language changes. Clipboard tests cover returning to an older pending tab after a newer tab copy, both completion orders and both success/rejection outcomes; native busy cleanup is independent of notification ownership. The smaller existing tests continue to use parser-boundary doubles. These checks do not use a file picker or validate browser layout and native Tab / Enter / Space interaction. The manual file and browser checks above are still needed before release.

### Shared UI embedding

`parquet-viewer.html` remains the authoritative source and the only distributable. The exact upstream Browser Kitty UI v1.0.0 sources live in `components/`; `ui-conventions.lock.json` pins their SHA-256 hashes. Do not edit vendored components independently. The marked JS and CSS blocks are embedded in the HTML, with no runtime imports or requests.

After copying an approved canonical component update, run `node scripts/embed-ui-conventions.cjs`, then `node scripts/embed-ui-conventions.cjs --check` and `node --test`. The helper fails on missing/duplicate markers or lock mismatches, and preserves the original parser/codecs byte region. The parser integrity check normalizes only Git checkout line endings. Tests also pin the bundled license notices. This helper does not regenerate the parser or split the application into another source format.

A visible notice states that work disappears when the tab closes. Files, preview rows, page/sort/Find state and edited export names stay in memory only. Closing a file removes that session tab and leaves the original file unchanged. There is no automatic file persistence, project saving, backup, undo or stop-processing action. Ordinary download feedback says **Download started** because the browser cannot confirm completion on disk.

Human release checks remain required: open the standalone file and offline HTTP viewer; try the picker and multi-file drop; validate native CSV delivery and clipboard fallback; switch both languages during reads and with Help open; verify keyboard focus, errors and controls at 360/390/768/1280 px. Automated DOM adapters do not establish those device/browser results.

## License and third-party notices

Copyright (c) 2026 Tomohisa Takagi

This project is licensed under the [MIT License](LICENSE).

This distribution bundles or derives from third-party software, including
[hyparquet](https://github.com/hyparam/hyparquet) and
[hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the applicable
copyright notices and license texts.

“Apache”, “Apache Parquet”, and associated logos are trademarks of the Apache Software Foundation. This project is an independent viewer and is not affiliated with or endorsed by the Apache Software Foundation. Avoid presenting the bundled icon as an official project logo.

## Third-party acknowledgements

- [hyparquet](https://github.com/hyparam/hyparquet) — JavaScript Parquet parser, MIT License
- [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors) — browser decompression support, MIT License

## Contributing

Bug reports with a reproducible file are welcome. Please remove sensitive data before sharing a Parquet file or provide a minimal synthetic reproduction.
