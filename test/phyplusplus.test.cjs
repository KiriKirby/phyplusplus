const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const source = readFileSync('phyplusplus.user.js', 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('updates species suffixes after typing settles without rewriting React-owned text', async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="react-autosuggest__container"><input aria-autocomplete="list"></div>
    <div class="react-autosuggest__suggestion"><div class="name" data-pid="533">P. trichocarpa v4.1</div></div>
  </body>`, { runScripts: 'dangerously', url: 'https://phytozome-next.jgi.doe.gov/blast' });
  const { window } = dom;
  window.fetch = async url => {
    assert.match(String(url), /\/api\/db\/properties\/proteome\/533$/);
    return { ok: true, json: async () => [{ xrefs: [{ release_date: '2021-04-29' }] }] };
  };
  window.eval(source);
  const input = window.document.querySelector('input');
  input.value = 'ptr';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(450);
  const title = window.document.querySelector('.name[data-pid="533"]');
  assert.equal(title.textContent, 'P. trichocarpa v4.1');
  assert.equal(title.dataset.phyppSuffix, ' (id533)');
  await wait(450);
  assert.equal(title.dataset.phyppSuffix, ' 2021.04.29 (id533)');
});

test('injects into the page world and intercepts the native AgGridReact module before construction', async () => {
  const dom = new JSDOM('<!doctype html><body><button>Export</button></body>', {
    runScripts: 'dangerously', url: 'https://phytozome-next.jgi.doe.gov/blast-results/777',
  });
  const { window } = dom;
  const saves = [];
  let clipboard = '';
  window.fetch = async url => {
    const value = String(url);
    if (/\/api\/db\/sequence\/protein\/99$/.test(value)) {
      return { ok: true, json: async () => [{ organism: 'P.test', phytozome_genome_id: '533', residues: 'MPEPTIDE*' }] };
    }
    const protein = new URL(value, window.location.origin).searchParams.get('protein');
    if (protein) {
      return { ok: true, json: async () => ({ primaryidentifier: protein === 'other-1-2' ? 'other-1-2' : 'shared-protein' }) };
    }
    throw new Error(`Unexpected request: ${value}`);
  };
  window.navigator.clipboard = { writeText: async value => { clipboard = value; } };
  window.showSaveFilePicker = async options => ({ createWritable: async () => ({ write: async value => saves.push({ options, value }), close: async () => {} }) });
  let workbook;
  window.XLSX = { utils: { book_new: () => (workbook = {}), aoa_to_sheet: rows => ({ rows }), book_append_sheet: (book, sheet) => { book.sheet = sheet; } }, write: () => Uint8Array.from([1]) };
  window.eval(source);
  assert.equal(window.__phyppPageWorld, true);

  class OriginalAgGridReact { constructor(props) { this.props = props; } }
  // The live vendor bundle uses an array-indexed webpack module table.
  const modules = [];
  modules[253] = (module, exports) => { exports.AgGridReact = OriginalAgGridReact; };
  window.webpackJsonp.push([[99], modules, []]);
  const module = { exports: {} };
  modules[253](module, module.exports, () => {});

  const row = {
    uHsp: 'one', Hit_accession: '99', 'Hsp_hit-jbrowseName': 'P_test_v1', 'Hsp_hit-sequenceId': 'protein-1',
    'Hsp_hit-species': 'P.test', 'Iteration_query-length': 100, 'Hsp_align-len': 50,
  };
  const versionTwo = { ...row, 'Hsp_hit-sequenceId': 'protein-2' };
  const unrelated = { ...row, 'Hsp_hit-sequenceId': 'other-1-2' };
  const options = {
    columnDefs: [
      { field: 'uHsp', headerName: 'Views', cellRendererFramework: () => null },
      { field: 'Hsp_hit-sequenceId', headerName: 'Protein' },
      { field: 'Hsp_round-evalue', headerName: 'E-value' },
      { field: 'Hsp_percent-identity', headerName: '% identity' },
      { field: 'Hsp_align-len', headerName: 'Align len' },
    ], rowData: [row, versionTwo, unrelated],
  };
  new module.exports.AgGridReact({ gridOptions: options });

  assert.deepEqual(options.columnDefs.map(column => column.headerName), ['Views', 'Protein', 'E-value', '% identity', '% Query Coverage', 'Align len', 'Link', 'Peptide sequence']);
  assert.equal(options.columnDefs[0].cellRendererFramework, undefined);
  assert.equal(typeof options.columnDefs[0].cellRenderer, 'function');
  assert.equal(options.columnDefs[0].minWidth, 88);
  assert.equal(options.columnDefs[4].minWidth, 175);
  assert.equal(options.columnDefs[4].wrapHeaderText, false);
  assert.equal(row._phyppCoverage, 50);
  assert.equal(row._phyppLink, 'https://phytozome-next.jgi.doe.gov/report/protein/P_test_v1/protein-1');
  const proteinColumn = options.columnDefs.find(column => column.field === 'Hsp_hit-sequenceId');
  assert.equal(proteinColumn.cellStyle({ value: 'protein-1', data: row }), undefined);

  const selected = [row];
  let refreshCount = 0;
  const api = {
    getDisplayedRowCount: () => 3,
    getDisplayedRowAtIndex: index => ({ data: [row, versionTwo, unrelated][index] }),
    refreshCells: () => { refreshCount++; },
    getSelectedRows: () => selected,
    // Match Phytozome's AG Grid version: the grid API lacks this method.
    columnApi: { getAllDisplayedColumns: () => options.columnDefs.map(definition => ({ getColDef: () => definition })) },
    getSortModel: () => [{ colId: 'Hsp_hit-sequenceId', sort: 'asc' }],
  };
  options.onGridReady({ api });
  for (let attempt = 0; attempt < 20 && !row._phyppProteinGroup; attempt++) await wait(10);
  assert.equal(row._phyppProteinGroup, 'shared-protein');
  assert.equal(row._phyppPeptide, '>P.test|protein-1\nMPEPTIDE');
  options.onSortChanged({ api });
  assert.equal(proteinColumn.cellStyle({ value: 'protein-1', data: row }).color, '#d00000');
  assert.equal(proteinColumn.cellStyle({ value: 'protein-2', data: versionTwo }).color, '#d00000');
  assert.equal(proteinColumn.cellStyle({ value: 'other-1-2', data: unrelated }), undefined);
  // Old AG Grid exposes sorting only through columnApi, as Phytozome does.
  api.getSortModel = undefined;
  const legacyColumnApi = { getColumn: id => id === 'Hsp_hit-sequenceId' ? { getSort: () => 'desc' } : null };
  options.onSortChanged({ api, columnApi: legacyColumnApi });
  assert.equal(proteinColumn.cellStyle({ value: 'protein-1', data: row }).color, '#d00000');
  options.onSortChanged({ api, columnApi: { getColumn: () => ({ getSort: () => null }) } });
  assert.equal(proteinColumn.cellStyle({ value: 'protein-1', data: row }), undefined);

  const view = options.columnDefs[0].cellRenderer({ data: row });
  const f = [...view.querySelectorAll('button')].find(button => button.textContent === 'F');
  f.click(); await flush();
  assert.equal(clipboard, '>P.test|protein-1\nMPEPTIDE');

  window.document.querySelector('.phypp-output > button').click();
  selected.push({ ...row, 'Hsp_hit-sequenceId': 'protein-2' });
  const fastaButton = [...window.document.querySelectorAll('.phypp-output-menu button')].find(button => button.textContent === 'Export FASTA');
  assert.equal(fastaButton.parentElement.parentElement, window.document.body);
  fastaButton.click();
  await flush();
  assert.equal(saves[0].value, '>P.test|protein-1\nMPEPTIDE\n\n>P.test|protein-2\nMPEPTIDE');
  assert.equal('suggestedName' in saves[0].options, false);

  window.document.querySelector('.phypp-output > button').click();
  [...window.document.querySelectorAll('.phypp-output-menu button')].find(button => button.textContent === 'Export table').click();
  await flush();
  assert.deepEqual(workbook.sheet.rows[0], ['Views', 'Protein', 'E-value', '% identity', '% Query Coverage', 'Align len', 'Link', 'Peptide sequence']);
  assert.equal(workbook.sheet.rows[1][4], 50);
  assert.equal('suggestedName' in saves[1].options, false);
});
