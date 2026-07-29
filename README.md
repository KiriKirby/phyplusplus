# Phy++ for Phytozome

Phy++ is a [Tampermonkey](https://www.tampermonkey.net/) userscript that improves the
[Phytozome](https://phytozome-next.jgi.doe.gov/) genome search and BLAST-result
experience. It extends Phytozome's existing BLAST **AG Grid**; it does not replace the
site's table with a look-alike.

## Install

1. Install Tampermonkey in a current Chromium browser (Chrome, Edge, or Chromium).
2. Open [the userscript](https://raw.githubusercontent.com/KiriKirby/phyplusplus/main/phyplusplus.user.js).
3. Let Tampermonkey install or update it.
4. Open Phytozome and run a BLAST search. If a page was already open, reload it once.

## What it adds

### Genome search

After typing pauses briefly, each genome-search suggestion gains its compact release date
(`YYYY.MM.DD`) and internal `id...` value. This decoration is rendered safely alongside
the React-managed suggestion text, so it does not change the search term or interfere with
typing.

### Native BLAST-result grid

Phy++ injects the following fields into the site's native grid before it is created:

- Moves **Identity** immediately after **E-value**.
- Adds **Query Coverage**, calculated as `align_len / query_length * 100`. Values are
  numeric percentage values without a `%` suffix so the native grid's filters continue to
  work.
- Widens **View** enough for all three controls.
- Adds **Link**, the Phytozome protein-report address opened by the green `G` button.
- Adds **Peptide sequence**, populated from the linked protein report without its title.
- Adds a green `F` button in **View**. It copies the complete FASTA-style peptide text
  (including its original header) to the clipboard.

Protein entries are marked red only while sorting by **Protein** when Phytozome's own gene
API reports that they share the same `primaryidentifier`. This identifies real alternative
protein versions without guessing from naming conventions.

### Phy++ output

The **Phy++ output** menu beside Phytozome's export/reset controls works on the currently
selected rows, in their visible top-to-bottom order:

- **Export FASTA** writes the complete peptide entries and leaves one blank line between
  entries.
- **Export table** writes the selected native-grid rows to an Excel workbook.

Both commands use the browser's Save As dialog and deliberately leave the filename empty.
No automatic download is started. The Save As feature requires the File System Access API,
which is available in current Chromium-based browsers.

## Data and performance

Peptide reports and version-group API responses are cached for the lifetime of the page and
reused by the grid, clipboard, FASTA export, and spreadsheet export. Protein-report
requests are limited to eight concurrent requests to avoid making BLAST pages unresponsive.

## Development

```powershell
npm install
node --check phyplusplus.user.js
npm test
git diff --check
```

The automated tests cover the script's data and grid helpers. Final browser validation is
performed against a real Phytozome BLAST results page because the live grid and authenticated
protein reports are supplied by Phytozome.

## License

[MIT](LICENSE)
