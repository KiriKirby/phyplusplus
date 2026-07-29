# Phy++ Agent Instructions

## Scope

This repository contains a Tampermonkey userscript for `https://phytozome-next.jgi.doe.gov/`. Keep all user-visible interface text in English.

## Implementation rules

- Read this file before changing repository files.
- Prefer the site's actual DOM, metadata, and documented browser APIs over simulated controls or hard-coded example data.
- Do not turn required data into placeholders. Sequence rows must be populated from the linked Phytozome protein report, and exports must use the currently selected rows.
- Maintain one request cache per protein URL. Fetch at most eight protein reports concurrently unless measured browser testing establishes a different safe limit.
- Reuse fetched sequence data for the table, clipboard, FASTA export, and spreadsheet export.
- Keep the BLAST result table as the site's native AG Grid.  Extend its `gridOptions`
  before `AgGridReact` is constructed; do not clone, replace, or manually mutate AG Grid DOM.
- The production bundles register webpack modules as array-indexed module tables.  The
  userscript hook must support that format and must not patch global function prototypes.
- For React-managed genome search suggestions, render dates and IDs through separate
  attributes/CSS after typing settles; never synchronously rewrite their text nodes.
- Identify alternate protein versions only through Phytozome's gene API
  `primaryidentifier`; never infer version groups from protein-name text.
- Save exports with `showSaveFilePicker` in a click handler. Do not silently download files or provide a default filename.

## Required verification

- Run syntax and whitespace checks after every implementation change.
- Test the script in a Chromium browser on a real BLAST-results page when a valid result URL is available.
- Verify: column order and query-coverage calculation; actual protein URL and peptide text; F clipboard action; selected-row FASTA output; selected-row XLSX output; and the Save As dialog behavior.
- If live data or browser authorization prevents a check, report that exact gap rather than claiming it passed.
