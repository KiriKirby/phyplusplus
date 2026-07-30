// ==UserScript==
// @name         Phy++ for Phytozome
// @namespace    https://phytozome-next.jgi.doe.gov/
// @version      3.7.0
// @description  Adds dates, identifiers, sequence tools, and exports to Phytozome.
// @license      MIT
// @homepageURL  https://github.com/KiriKirby/phyplusplus
// @supportURL   https://github.com/KiriKirby/phyplusplus/issues
// @updateURL    https://raw.githubusercontent.com/KiriKirby/phyplusplus/main/phyplusplus.user.js
// @downloadURL  https://raw.githubusercontent.com/KiriKirby/phyplusplus/main/phyplusplus.user.js
// @match        https://phytozome-next.jgi.doe.gov/*
// @grant        none
// @run-at       document-start
// @sandbox      raw
// ==/UserScript==

function phyplusplusMain() {
  'use strict';

  const CACHE = new Map();
  const PROTEIN_RECORD_CACHE = new Map();
  const PROTEIN_GROUP_CACHE = new Map();
  const PROTEOME_IDS = new Map();
  const GENOME_METADATA = new Map();
  const GENOME_METADATA_REQUESTS = new Map();
  const GENOME_METADATA_QUEUE = [];
  const GENOME_METADATA_QUEUED = new Set();
  let metadataRequests = 0;
  const MAX_CONCURRENT_REQUESTS = 8;
  const MAX_CONCURRENT_METADATA_REQUESTS = 4;
  const SPECIES_DEBOUNCE_MS = 400;
  let peptideRefreshPending = false;
  let xlsxPromise;
  const SELECTOR = 'table';
  const greenButtonStyle = 'background:#6ca51b;color:white;border:0;border-radius:2px;margin-left:2px;padding:1px 4px;font:inherit;line-height:1.15;cursor:pointer';

  function nativeButton(label, title, handler) {
    const button = Object.assign(document.createElement('button'), { textContent: label, title, type: 'button', style: greenButtonStyle });
    button.addEventListener('click', handler);
    return button;
  }

  function nativeReportUrl(row) {
    return `${location.origin}/report/protein/${row['Hsp_hit-jbrowseName']}/${row['Hsp_hit-sequenceId']}`;
  }

  function fetchProteinRecord(row) {
    const key = String(row.Hit_accession);
    if (PROTEIN_RECORD_CACHE.has(key)) return PROTEIN_RECORD_CACHE.get(key);
    const task = fetch(`/api/db/sequence/protein/${encodeURIComponent(row.Hit_accession)}`, { credentials: 'include' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(data => Array.isArray(data) ? data[0] : data);
    PROTEIN_RECORD_CACHE.set(key, task);
    return task;
  }

  async function fetchNativeSequence(row) {
    const url = nativeReportUrl(row);
    if (CACHE.has(url)) return CACHE.get(url);
    const task = fetchProteinRecord(row)
      .then(record => {
        const residues = record?.residues?.replace(/\*$/, '');
        if (!residues) throw new Error('No peptide sequence found.');
        return `>${record.organism || row['Hsp_hit-species']}|${row['Hsp_hit-sequenceId']}\n${residues}`;
      })
      .catch(error => { console.warn('[Phy++] sequence fetch failed:', url, error); return null; });
    CACHE.set(url, task);
    return task;
  }

  function nativeViewRenderer(params) {
    const row = params.data;
    const wrap = document.createElement('span');
    const report = nativeReportUrl(row);
    const gene = Object.assign(document.createElement('a'), { href: report, title: 'View gene report', textContent: 'G', style: greenButtonStyle });
    const jbrowse = Object.assign(document.createElement('a'), { href: `${location.origin}/jbrowse/index.html?data=genomes%2F${encodeURIComponent(row['Hsp_hit-jbrowseName'])}&loc=${encodeURIComponent(row['Hsp_hit-sequenceId'])}`, title: 'View in JBrowse', textContent: 'B', style: greenButtonStyle });
    const copy = nativeButton('F', 'Copy full peptide sequence', async () => { const fasta = await fetchNativeSequence(row); if (fasta) await navigator.clipboard.writeText(fasta); });
    wrap.append(gene, jbrowse, copy);
    return wrap;
  }

  function nativeLinkRenderer(params) {
    const link = Object.assign(document.createElement('a'), { href: nativeReportUrl(params.data), target: '_blank', rel: 'noopener', textContent: nativeReportUrl(params.data) });
    return link;
  }

  function nativePeptideRenderer(params) {
    const value = params.value || 'Loading...';
    const element = document.createElement('div');
    element.textContent = value;
    element.style.cssText = 'white-space:pre-wrap;min-width:500px;line-height:1.2';
    return element;
  }

  async function fetchProteinGroup(row) {
    const cacheKey = `${row['Hsp_hit-jbrowseName']}/${row['Hsp_hit-sequenceId']}`;
    if (PROTEIN_GROUP_CACHE.has(cacheKey)) return PROTEIN_GROUP_CACHE.get(cacheKey);
    const task = fetchProteinRecord(row)
      .then(record => fetch(`/api/db/gene_${encodeURIComponent(record.phytozome_genome_id)}?protein=${encodeURIComponent(row['Hsp_hit-sequenceId'])}`, { credentials: 'include' }))
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(gene => gene?.primaryidentifier || null)
      .catch(() => null);
    PROTEIN_GROUP_CACHE.set(cacheKey, task);
    return task;
  }

  async function loadProteinGroups(rows) {
    await concurrentMap(rows, async row => { row._phyppProteinGroup = await fetchProteinGroup(row); });
    const counts = new Map();
    rows.forEach(row => {
      if (row._phyppProteinGroup) counts.set(row._phyppProteinGroup, (counts.get(row._phyppProteinGroup) || 0) + 1);
    });
    rows.forEach(row => { row._phyppProteinInGroup = (counts.get(row._phyppProteinGroup) || 0) > 1; });
  }

  function isProteinSortActive(api, eventColumnApi) {
    const sortModel = api?.getSortModel?.();
    if (Array.isArray(sortModel)) return sortModel.some(sort => sort.colId === 'Hsp_hit-sequenceId');
    const columnApis = [...new Set([api?.columnApi, eventColumnApi].filter(Boolean))];
    return columnApis.some(columnApi => {
      const proteinColumn = columnApi.getColumn?.('Hsp_hit-sequenceId');
      if (proteinColumn?.isSortActive?.() || ['asc', 'desc'].includes(proteinColumn?.getSort?.())) return true;
      const allColumns = columnApi.getAllColumns?.() || columnApi.getAllGridColumns?.() || columnApi.getAllDisplayedColumns?.() || [];
      return allColumns.some(column => column.getColId?.() === 'Hsp_hit-sequenceId' &&
        (column.isSortActive?.() || ['asc', 'desc'].includes(column.getSort?.())));
    });
  }

  function refreshProteinHighlight(api, options, eventColumnApi) {
    const refresh = () => {
      options.__phyppProteinSortActive = isProteinSortActive(api, eventColumnApi);
      api?.refreshCells?.({ force: true, columns: ['Hsp_hit-sequenceId'] });
    };
    refresh();
    // Some older AG Grid builds dispatch sortChanged before their column state
    // has settled. Re-check on the next frame so stale red styles are removed.
    (window.requestAnimationFrame || setTimeout)(refresh);
  }

  function enhanceNativeGridOptions(options) {
    if (options.__phyppEnhanced || !options.columnDefs?.some(column => column.field === 'Hsp_align-len')) return;
    options.__phyppEnhanced = true;
    const columns = options.columnDefs;
    const protein = columns.find(column => column.field === 'Hsp_hit-sequenceId');
    if (protein) {
      const originalCellStyle = protein.cellStyle;
      protein.cellStyle = params => {
        const baseStyle = typeof originalCellStyle === 'function' ? originalCellStyle(params) : originalCellStyle;
        return options.__phyppProteinSortActive && params.data?._phyppProteinInGroup
          ? { ...(baseStyle || {}), color: '#d00000' }
          : baseStyle;
      };
    }
    const view = columns.find(column => column.field === 'uHsp');
    if (view) {
      view.headerName = 'Views';
      view.width = Math.max(view.width || 0, 88);
      view.minWidth = 88;
      view.cellRenderer = nativeViewRenderer;
      delete view.cellRendererFramework;
    }
    const identityIndex = columns.findIndex(column => column.field === 'Hsp_percent-identity');
    columns.splice(identityIndex + 1, 0, {
      field: '_phyppCoverage', headerName: '% Query Coverage', width: 175, minWidth: 175,
      wrapHeaderText: false, filter: 'agNumberColumnFilter', comparator: (a, b) => a - b,
    });
    columns.push(
      { field: '_phyppLink', headerName: 'Link', width: 420, cellRenderer: nativeLinkRenderer, filter: 'agTextColumnFilter' },
      { field: '_phyppPeptide', headerName: 'Peptide sequence', width: 700, cellRenderer: nativePeptideRenderer, filter: 'agTextColumnFilter' },
    );
    options.rowData.forEach(row => {
      const queryLength = Number(row['Iteration_query-length']);
      // Keep this numeric, like the native identity column, so AG Grid's
      // number filters and numeric sorting work without string parsing.
      row._phyppCoverage = queryLength ? Number((Number(row['Hsp_align-len']) / queryLength * 100).toFixed(2)) : null;
      row._phyppLink = nativeReportUrl(row);
      row._phyppPeptide = 'Loading...';
    });
    // Begin API-backed version grouping before the native grid is mounted.
    // The result is calculated once and merely shown/hidden as Protein sorting
    // changes, avoiding repeat work and delayed highlight state.
    const proteinGroupsReady = loadProteinGroups(options.rowData);
    const previousReady = options.onGridReady;
    const previousSortChanged = options.onSortChanged;
    options.onSortChanged = event => {
      previousSortChanged?.(event);
      refreshProteinHighlight(event.api, options, event.columnApi);
    };
    options.onGridReady = event => {
      previousReady?.(event);
      const rows = event.api.getDisplayedRowCount ? Array.from({ length: event.api.getDisplayedRowCount() }, (_, index) => event.api.getDisplayedRowAtIndex(index)?.data).filter(Boolean) : options.rowData;
      const refreshPeptides = () => {
        if (peptideRefreshPending) return;
        peptideRefreshPending = true;
        (window.requestAnimationFrame || setTimeout)(() => {
          peptideRefreshPending = false;
          event.api.refreshCells({ force: true, columns: ['_phyppPeptide'] });
        });
      };
      concurrentMap(rows, async row => {
        const fasta = await fetchNativeSequence(row);
        row._phyppPeptide = fasta || 'Unavailable';
        refreshPeptides();
      });
      proteinGroupsReady.then(() => refreshProteinHighlight(event.api, options));
      refreshProteinHighlight(event.api, options);
      setTimeout(() => addNativeOutput(event.api, options), 0);
    };
  }

  function addNativeOutput(api, gridOptions) {
    if (document.querySelector('.phypp-output')) return;
    const exportButton = [...document.querySelectorAll('button')].find(button => text(button) === 'Export');
    if (!exportButton) return;
    const wrap = document.createElement('span');
    wrap.className = 'phypp-output';
    wrap.style.cssText = 'position:relative;display:inline-block;margin-left:8px';
    const button = Object.assign(document.createElement('button'), { textContent: 'Phy++ output', type: 'button' });
    const menu = document.createElement('div');
    menu.className = 'phypp-output-menu';
    menu.hidden = true;
    // The controls live in a clipped React layout.  Portal the menu to body
    // while open so it cannot be hidden by the surrounding result panel.
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:#fff;border:1px solid #999;box-shadow:0 2px 8px #777;min-width:150px;padding:3px';
    const option = (label, handler) => {
      const entry = Object.assign(document.createElement('button'), { textContent: label, type: 'button' });
      entry.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:#fff;padding:5px;cursor:pointer';
      entry.addEventListener('click', async () => { menu.hidden = true; try { await handler(); } catch (error) { if (error.name !== 'AbortError') alert(error.message); } });
      menu.append(entry);
    };
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (!menu.hidden) { menu.hidden = true; return; }
      document.body.append(menu);
      const rect = button.getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 3}px`;
      menu.hidden = false;
    });
    document.addEventListener('click', event => {
      if (!menu.hidden && !menu.contains(event.target) && event.target !== button) menu.hidden = true;
    });
    option('Export FASTA', async () => {
      const fasta = (await Promise.all(api.getSelectedRows().map(fetchNativeSequence))).filter(Boolean).join('\n\n');
      if (!fasta) throw new Error('Select at least one row with an available peptide sequence.');
      await saveFile(fasta, [{ description: 'FASTA sequence', accept: { 'text/plain': ['.fasta', '.fa'] } }]);
    });
    option('Export table', async () => {
      const rows = api.getSelectedRows();
      if (!rows.length) throw new Error('Select at least one result row.');
      const XLSX = await loadXlsx();
      // Phytozome currently ships an older AG Grid.  Its displayed columns
      // live on columnApi, whereas newer releases expose them on grid api.
      const displayedColumns = api.getAllDisplayedColumns?.()
        || api.columnApi?.getAllDisplayedColumns?.()
        || gridOptions.columnDefs.map(definition => ({ getColDef: () => definition }));
      const columns = displayedColumns.filter(column => column.getColDef().field);
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([columns.map(column => column.getColDef().headerName), ...rows.map(row => columns.map(column => row[column.getColDef().field]))]);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Phy++ results');
      await saveFile(new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
    });
    wrap.append(button);
    exportButton.insertAdjacentElement('afterend', wrap);
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('Unable to load the Excel exporter.'));
      script.onerror = () => reject(new Error('Unable to load the Excel exporter.'));
      document.head.append(script);
    });
    return xlsxPromise;
  }

  // Phytozome's vendor bundle is an array-indexed webpack module table.  This
  // must run before the main bundle consumes that table and constructs AG Grid.
  function hookAgGridModule(modules) {
    const originalFactory = modules?.[253];
    if (typeof originalFactory !== 'function' || originalFactory.__phyppWrapped) return;
    function phyppAgGridModule(module, exports, require) {
      originalFactory.call(this, module, exports, require);
      const exported = exports?.AgGridReact || module.exports?.AgGridReact;
      if (!exported || exported.__phyppWrapped) return;
      class PhyppAgGridReact extends exported {
        constructor(props, context) {
          if (props?.gridOptions) enhanceNativeGridOptions(props.gridOptions);
          super(props, context);
        }

        componentWillReceiveProps(nextProps, nextContext) {
          if (nextProps?.gridOptions) enhanceNativeGridOptions(nextProps.gridOptions);
          return super.componentWillReceiveProps?.(nextProps, nextContext);
        }
      }
      PhyppAgGridReact.__phyppWrapped = true;
      if (exports) exports.AgGridReact = PhyppAgGridReact;
      if (module.exports) module.exports.AgGridReact = PhyppAgGridReact;
    }
    phyppAgGridModule.__phyppWrapped = true;
    modules[253] = phyppAgGridModule;
  }

  function hookWebpackQueue(queue) {
    if (!Array.isArray(queue) || queue.__phyppWrapped) return;
    const originalPush = queue.push.bind(queue);
    queue.push = (...chunks) => {
      chunks.forEach(chunk => hookAgGridModule(chunk?.[1]));
      return originalPush(...chunks);
    };
    queue.forEach(chunk => hookAgGridModule(chunk?.[1]));
    queue.__phyppWrapped = true;
  }

  function hookWebpack() {
    let queue = window.webpackJsonp;
    hookWebpackQueue(queue);
    try {
      Object.defineProperty(window, 'webpackJsonp', {
        configurable: true,
        get: () => {
          if (!queue) {
            queue = [];
            hookWebpackQueue(queue);
          }
          return queue;
        },
        set: value => { queue = value; hookWebpackQueue(queue); },
      });
    } catch (_) {
      // If another script already locked this property, its current queue can
      // still be wrapped without interfering with the page's JavaScript.
      hookWebpackQueue(window.webpackJsonp);
    }
  }

  hookWebpack();

  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  const text = node => normalize(node?.textContent);

  function isBlastPage() {
    return /blast-results/i.test(location.pathname) || /BLAST results/i.test(document.body.textContent);
  }

  function findBlastTable() {
    return [...document.querySelectorAll(SELECTOR)].find(table => {
      const headings = [...table.querySelectorAll('th')].map(text).join(' ').toLowerCase();
      return headings.includes('e-value') && headings.includes('align len') && headings.includes('identity');
    });
  }

  function getColumnIndex(table, matcher) {
    return [...table.querySelectorAll('thead th, tr th')].findIndex(th => matcher(text(th).toLowerCase()));
  }

  function findGeneUrl(row) {
    const buttons = [...row.querySelectorAll('a,button')];
    const gene = buttons.find(item => text(item) === 'G');
    return gene?.href || gene?.closest('a')?.href || null;
  }

  function extractFastaFromDocument(page) {
    const label = [...page.querySelectorAll('h1, h2, h3, h4, h5, dt, strong, b, label')]
      .find(node => /Peptide sequence/i.test(text(node)));
    if (label) {
      let candidate = label.nextElementSibling;
      while (candidate && !/^[>A-Z\s]+$/m.test(candidate.textContent)) candidate = candidate.nextElementSibling;
      if (candidate) {
        const found = candidate.textContent.trim();
        if (/^>[^\r\n]+[\s\S]*[A-Z]{8}/.test(found)) return found;
      }
    }
    const all = [...page.querySelectorAll('pre, textarea, code, div')];
    const holder = all.find(node => /Peptide sequence/i.test(text(node)) && />[^\s]+[\s\S]*[A-Z]{8}/.test(node.textContent));
    if (!holder) return null;
    const content = holder.textContent;
    const start = content.search(/>[^\r\n]+/);
    return start < 0 ? null : content.slice(start).trim();
  }

  async function proteomeIdFor(genome) {
    if (PROTEOME_IDS.has(genome)) return PROTEOME_IDS.get(genome);
    const main = [...document.scripts].map(script => script.src).find(src => /\/main-[^/]+\.js$/.test(src));
    const source = await fetch(main, { credentials: 'include' }).then(response => response.text());
    const position = source.indexOf(`jbrowseName":"${genome}"`);
    const fragment = source.slice(Math.max(0, position - 1200), position + 1200);
    const id = fragment.match(/(?:proteomeId|proteome_id|phytozome_genome_id|"id")":"?(\d+)/)?.[1];
    if (!id) throw new Error(`Unable to resolve proteome ID for ${genome}.`);
    PROTEOME_IDS.set(genome, id);
    return id;
  }

  async function fetchSequence(url) {
    if (!url) return null;
    if (CACHE.has(url)) return CACHE.get(url);
    const task = (async () => {
      const [, genome, protein] = new URL(url, location.origin).pathname.match(/\/report\/protein\/([^/]+)\/([^/]+)/) || [];
      if (!genome || !protein) throw new Error('Invalid protein report URL.');
      const proteomeId = await proteomeIdFor(genome);
      const gene = await fetch(`/api/db/gene_${proteomeId}?protein=${encodeURIComponent(protein)}`, { credentials: 'include' }).then(response => response.json());
      const transcript = gene.transcripts?.find(item => item.protein === protein);
      const pac = transcript?.secondaryidentifier?.replace(/^PAC:/, '');
      if (!pac) throw new Error(`No protein identifier found for ${protein}.`);
      const sequence = await fetch(`/api/db/sequence/protein/${pac}`, { credentials: 'include' }).then(response => response.json());
      const record = Array.isArray(sequence) ? sequence[0] : sequence;
      const residues = record?.residues?.replace(/\*$/, '');
      if (!residues) throw new Error(`No peptide sequence found for ${protein}.`);
      const species = document.querySelector(`[href="/info/${CSS.escape(genome)}"]`)?.textContent?.trim() || record.organism || genome;
      return `>${species}|${protein}\n${residues}`;
    })()
      .catch(error => { console.warn('[Phy++] sequence fetch failed:', url, error); return null; });
    CACHE.set(url, task);
    return task;
  }

  async function concurrentMap(items, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    });
    await Promise.all(runners);
  }

  function getQueryLength(table) {
    const from = getColumnIndex(table, value => value === 'query from');
    const to = getColumnIndex(table, value => value === 'query to');
    if (from < 0 || to < 0) return null;
    const values = [...table.querySelectorAll('tbody tr')].map(row => {
      const cells = row.cells;
      return Math.abs(Number(text(cells[to])) - Number(text(cells[from])) + 1);
    }).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  }

  function makeCell(value, className) {
    const cell = document.createElement('td');
    cell.className = className;
    cell.textContent = value;
    return cell;
  }

  function injectBlastColumns(table) {
    if (table.dataset.phyplusplusReady) return;
    const headRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (!headRow) return;
    const identityIndex = getColumnIndex(table, value => value.includes('identity'));
    const evalueIndex = getColumnIndex(table, value => value.includes('e-value'));
    const alignIndex = getColumnIndex(table, value => value.includes('align len'));
    if (identityIndex < 0 || evalueIndex < 0 || alignIndex < 0) return;

    const queryLength = getQueryLength(table);
    const identityHead = [...headRow.cells].find(cell => /identity/i.test(text(cell)));
    if (identityHead) headRow.insertBefore(identityHead, headRow.cells[evalueIndex + 1]);
    const postEvalue = [...headRow.cells].findIndex(cell => /e-value/i.test(text(cell))) + 1;
    headRow.insertBefore(Object.assign(document.createElement('th'), { textContent: '% Query Coverage', className: 'phypp-coverage' }), headRow.cells[postEvalue + 1] || null);
    headRow.append(Object.assign(document.createElement('th'), { textContent: 'Link', className: 'phypp-link' }));
    headRow.append(Object.assign(document.createElement('th'), { textContent: 'Peptide sequence', className: 'phypp-peptide' }));

    const bodyRows = [...table.querySelectorAll('tbody tr')];
    for (const row of bodyRows) {
      const cells = [...row.cells];
      const identityCell = cells.find(cell => /^(% )?identity$/i.test(text(cell.previousElementSibling))) || cells[identityIndex];
      if (identityCell) row.insertBefore(identityCell, row.cells[evalueIndex + 1]);
      const currentAlignIndex = [...headRow.cells].findIndex(cell => /align len/i.test(text(cell)));
      // The header already has the new coverage column; this row does not until below.
      const alignmentLength = Number(text(row.cells[currentAlignIndex - 1]));
      const coverage = queryLength && Number.isFinite(alignmentLength) ? `${(alignmentLength / queryLength * 100).toFixed(2)}%` : '';
      const identityNow = [...headRow.cells].findIndex(cell => /identity/i.test(text(cell)));
      row.insertBefore(makeCell(coverage, 'phypp-coverage'), row.cells[identityNow + 1] || null);
      const url = findGeneUrl(row);
      const linkCell = makeCell('', 'phypp-link');
      if (url) linkCell.append(Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener', textContent: url }));
      row.append(linkCell);
      row.append(makeCell('Loading...', 'phypp-peptide'));
      const viewCell = [...row.cells].find(cell => cell.querySelector('a, button') && [...cell.querySelectorAll('a, button')].some(item => text(item) === 'G'));
      if (viewCell && url) {
        const copy = Object.assign(document.createElement('button'), { textContent: 'F', title: 'Copy full peptide sequence', type: 'button', style: greenButtonStyle });
        copy.addEventListener('click', async () => {
          const fasta = await fetchSequence(url);
          if (fasta) await navigator.clipboard.writeText(fasta);
        });
        viewCell.append(copy);
      }
      fetchSequence(url).then(fasta => {
        const peptideCell = row.querySelector('.phypp-peptide');
        if (peptideCell) peptideCell.textContent = fasta || 'Unavailable';
      });
    }
    table.dataset.phyplusplusReady = 'true';
  }

  function selectedRows(table) { return [...table.querySelectorAll('tbody tr')].filter(row => row.querySelector('input[type="checkbox"]')?.checked); }

  async function saveFile(content, types) {
    if (!window.showSaveFilePicker) throw new Error('This browser does not support the required Save As dialog.');
    const handle = await window.showSaveFilePicker({ types });
    const stream = await handle.createWritable();
    await stream.write(content);
    await stream.close();
  }

  function addOutputMenu(table) {
    if (document.querySelector('.phypp-output')) return;
    const exportButton = [...document.querySelectorAll('button, input[type="button"], input[type="submit"]')].find(item => /^export$/i.test(item.value || text(item)));
    if (!exportButton) return;
    const wrap = document.createElement('span');
    wrap.className = 'phypp-output';
    wrap.style.cssText = 'position:relative;display:inline-block;margin-left:8px';
    const button = Object.assign(document.createElement('button'), { textContent: 'Phy++ output', type: 'button' });
    const menu = document.createElement('div');
    menu.hidden = true;
    menu.style.cssText = 'position:absolute;z-index:9999;top:100%;left:0;background:#fff;border:1px solid #aaa;min-width:150px;padding:3px';
    const makeOption = (label, handler) => {
      const option = Object.assign(document.createElement('button'), { textContent: label, type: 'button' });
      option.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:#fff;padding:5px;cursor:pointer';
      option.addEventListener('click', async () => { menu.hidden = true; try { await handler(); } catch (error) { if (error.name !== 'AbortError') alert(error.message); } });
      menu.append(option);
    };
    button.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    makeOption('Export FASTA', async () => {
      const rows = selectedRows(table);
      const fasta = (await Promise.all(rows.map(row => fetchSequence(findGeneUrl(row))))).filter(Boolean).join('\n');
      if (!fasta) throw new Error('Select at least one row with an available peptide sequence.');
      await saveFile(fasta, [{ description: 'FASTA sequence', accept: { 'text/plain': ['.fasta', '.fa'] } }]);
    });
    makeOption('Export table', async () => {
      const rows = selectedRows(table);
      if (!rows.length) throw new Error('Select at least one result row.');
      const headers = [...table.querySelectorAll('thead th')].map(text);
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows.map(row => [...row.cells].map(cell => text(cell)))]);
      sheet['!cols'] = headers.map((heading, index) => ({ wch: Math.min(80, Math.max(12, heading.length, ...rows.map(row => text(row.cells[index]).length))) }));
      XLSX.utils.book_append_sheet(workbook, sheet, 'Phy++ results');
      const content = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      await saveFile(new Blob([content], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
    });
    wrap.append(button, menu);
    exportButton.insertAdjacentElement('afterend', wrap);
  }

  function installSpeciesSuffixStyle() {
    if (document.getElementById('phypp-species-suffix-style')) return;
    const style = document.createElement('style');
    style.id = 'phypp-species-suffix-style';
    style.textContent = '.react-autosuggest__suggestion .name[data-phypp-suffix]::after,.rct-title.large-screen[data-phypp-suffix]::after,#adf a[data-phypp-suffix]::after{content:attr(data-phypp-suffix);white-space:pre;color:inherit;font:inherit}';
    (document.head || document.documentElement).append(style);
  }

  function formatSpeciesSuffix(id) {
    const date = GENOME_METADATA.get(id);
    return `${date ? ` ${date}` : ''} (id${id})`;
  }

  function compactDate(value) {
    const text = String(value || '').trim();
    const numeric = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (numeric) return `${numeric[1]}.${numeric[2].padStart(2, '0')}.${numeric[3].padStart(2, '0')}`;
    const named = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    const month = named && ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[1].slice(0, 3).toLowerCase());
    if (named && month >= 0) return `${named[3]}.${String(month + 1).padStart(2, '0')}.${named[2].padStart(2, '0')}`;
    return '';
  }

  function genomeIdsByInfoPath() {
    const ids = new Map();
    document.querySelectorAll('.rct-text a[href^="/info/"]').forEach(link => {
      const id = link.closest('.rct-text')?.querySelector('input[id]')?.id.match(/-(\d+)$/)?.[1];
      if (id) ids.set(link.getAttribute('href'), id);
    });
    return ids;
  }

  function drainMetadataQueue() {
    while (metadataRequests < MAX_CONCURRENT_METADATA_REQUESTS && GENOME_METADATA_QUEUE.length) {
      const id = GENOME_METADATA_QUEUE.shift();
      GENOME_METADATA_QUEUED.delete(id);
      if (GENOME_METADATA.has(id) || GENOME_METADATA_REQUESTS.has(id)) continue;
      metadataRequests++;
      const request = fetch(`/api/db/properties/proteome/${id}`, { credentials: 'include' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then(data => {
          const record = Array.isArray(data) ? data[0] : data;
          const rawDate = record?.xrefs?.find(xref => xref.release_date)?.release_date || '';
          GENOME_METADATA.set(id, rawDate.replace(/-/g, '.'));
        })
        .catch(() => { GENOME_METADATA.set(id, ''); })
        .finally(() => {
          metadataRequests--;
          GENOME_METADATA_REQUESTS.delete(id);
          drainMetadataQueue();
          scheduleSpeciesDecoration();
        });
      GENOME_METADATA_REQUESTS.set(id, request);
    }
  }

  function requestGenomeMetadata(id) {
    if (GENOME_METADATA.has(id) || GENOME_METADATA_REQUESTS.has(id) || GENOME_METADATA_QUEUED.has(id)) return;
    GENOME_METADATA_QUEUED.add(id);
    GENOME_METADATA_QUEUE.push(id);
    drainMetadataQueue();
  }

  function decorateSpeciesOptions() {
    installSpeciesSuffixStyle();
    const idsByInfoPath = genomeIdsByInfoPath();
    document.querySelectorAll('#adf tbody tr').forEach(row => {
      const link = row.querySelector('a[href^="/info/"]');
      const id = link && idsByInfoPath.get(link.getAttribute('href'));
      if (!link || !id) return;
      const date = compactDate(row.cells?.[2]?.textContent?.trim());
      if (date) GENOME_METADATA.set(id, date);
      link.dataset.phyppSuffix = formatSpeciesSuffix(id);
      requestGenomeMetadata(id);
    });
    const suggestions = document.querySelectorAll('.react-autosuggest__suggestion .name[data-pid]');
    suggestions.forEach(title => {
      const id = title.dataset.pid;
      if (!id) return;
      // Do not mutate textContent: React owns it and synchronous rewrites can
      // cause a render loop while users type.  CSS renders this safe suffix.
      title.dataset.phyppSuffix = formatSpeciesSuffix(id);
      requestGenomeMetadata(id);
    });
    document.querySelectorAll('.rct-text').forEach(node => {
      const id = node.querySelector('input[id]')?.id.match(/-(\d+)$/)?.[1];
      const title = node.querySelector('.rct-title.large-screen');
      if (!id || !title) return;
      title.dataset.phyppSuffix = formatSpeciesSuffix(id);
      requestGenomeMetadata(id);
    });
  }

  function findBlastGrid() {
    return [...document.querySelectorAll('[role="grid"]')].find(grid => grid.querySelector('[col-id="Hsp_align-len"]') && grid.querySelector('[col-id="Hsp_round-evalue"]'));
  }

  function gridCell(column, value, left, width) {
    const cell = document.createElement('div');
    cell.className = 'ag-cell ag-cell-not-inline-editing ag-cell-with-height ag-cell-value';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('col-id', column);
    cell.style.cssText = `width:${width}px;left:${left}px;`;
    cell.textContent = value;
    return cell;
  }

  function decorateBlastGrid(grid) {
    if (grid.dataset.phyppGridReady) return;
    const headers = [...grid.querySelectorAll('.ag-header-cell')];
    const identity = headers.find(header => header.getAttribute('col-id') === 'Hsp_percent-identity');
    const align = headers.find(header => header.getAttribute('col-id') === 'Hsp_align-len');
    if (!identity || !align) return;
    const coverageLeft = parseFloat(align.style.left);
    const coverageWidth = parseFloat(align.style.width);
    const headerRow = identity.parentElement;
    const coverageHeader = identity.cloneNode(true);
    coverageHeader.setAttribute('col-id', 'phypp-coverage');
    coverageHeader.style.left = `${coverageLeft}px`;
    coverageHeader.style.width = `${coverageWidth}px`;
    coverageHeader.querySelector('[role="columnheader"]').textContent = '% Query Coverage';
    headerRow.insertBefore(coverageHeader, align);
    [...grid.querySelectorAll('.ag-header-cell')].filter(header => parseFloat(header.style.left) >= coverageLeft && header !== coverageHeader).forEach(header => {
      header.style.left = `${parseFloat(header.style.left) + coverageWidth}px`;
    });

    const lastHeader = [...grid.querySelectorAll('.ag-header-cell')].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)).at(-1);
    const appendHeader = (id, label, width) => {
      const clone = lastHeader.cloneNode(true);
      clone.setAttribute('col-id', id);
      clone.style.left = `${parseFloat(lastHeader.style.left) + parseFloat(lastHeader.style.width)}px`;
      clone.style.width = `${width}px`;
      clone.querySelector('[role="columnheader"]').textContent = label;
      headerRow.append(clone);
      return clone;
    };
    const linkHeader = appendHeader('phypp-link', 'Link', 330);
    lastHeader = linkHeader;
    appendHeader('phypp-peptide', 'Peptide sequence', 620);
    const extraWidth = coverageWidth + 950;
    [...grid.querySelectorAll('.ag-header-container, .ag-center-cols-container')].forEach(node => { node.style.width = `${parseFloat(node.style.width || 0) + extraWidth}px`; });
    grid.dataset.phyppGridReady = 'true';

    const addRows = () => {
      const queryLength = Math.max(...[...grid.querySelectorAll('[col-id="Hsp_query-to"]')].map(cell => Number(text(cell))).filter(Number.isFinite));
      [...grid.querySelectorAll('.ag-center-cols-container [role="row"]')].forEach(row => {
        if (row.querySelector('[col-id="phypp-coverage"]')) return;
        const cells = [...row.children];
        const alignCell = row.querySelector('[col-id="Hsp_align-len"]');
        const coverage = `${(Number(text(alignCell)) / queryLength * 100).toFixed(2)}%`;
        const left = parseFloat(alignCell.style.left);
        cells.filter(cell => parseFloat(cell.style.left) >= left).forEach(cell => { cell.style.left = `${parseFloat(cell.style.left) + coverageWidth}px`; });
        row.insertBefore(gridCell('phypp-coverage', coverage, left, coverageWidth), alignCell);
        const gene = row.querySelector('a[title="View gene report"]');
        const last = [...row.children].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)).at(-1);
        const linkLeft = parseFloat(last.style.left) + parseFloat(last.style.width);
        const link = gridCell('phypp-link', '', linkLeft, 330);
        if (gene) link.append(Object.assign(document.createElement('a'), { href: gene.href, target: '_blank', rel: 'noopener', textContent: gene.href }));
        const peptide = gridCell('phypp-peptide', 'Loading...', linkLeft + 330, 620);
        row.append(link, peptide);
        if (gene) {
          const f = Object.assign(document.createElement('button'), { textContent: 'F', title: 'Copy full peptide sequence', type: 'button', style: greenButtonStyle });
          f.addEventListener('click', async () => { const fasta = await fetchSequence(gene.href); if (fasta) await navigator.clipboard.writeText(fasta); });
          gene.parentElement.append(f);
          fetchSequence(gene.href).then(fasta => { peptide.textContent = fasta || 'Unavailable'; });
        }
      });
    };
    new MutationObserver(addRows).observe(grid.querySelector('.ag-center-cols-container'), { childList: true, subtree: true });
    addRows();
  }

  function addGridOutput(grid) {
    if (document.querySelector('.phypp-output')) return;
    const exportButton = [...document.querySelectorAll('button')].find(button => text(button) === 'Export' && !button.closest('.phypp-output'));
    if (!exportButton) return;
    const wrap = document.createElement('span');
    wrap.className = 'phypp-output';
    wrap.style.cssText = 'position:relative;display:inline-block;margin-left:8px';
    const button = Object.assign(document.createElement('button'), { textContent: 'Phy++ output', type: 'button' });
    const menu = document.createElement('div');
    menu.hidden = true;
    menu.style.cssText = 'position:absolute;z-index:9999;top:100%;left:0;background:#fff;border:1px solid #aaa;min-width:150px;padding:3px';
    const selected = () => [...grid.querySelectorAll('.ag-center-cols-container [role="row"]')].filter(row => row.classList.contains('ag-row-selected') || row.querySelector('.ag-icon-checkbox-checked:not(.ag-hidden)'));
    const option = (label, handler) => {
      const item = Object.assign(document.createElement('button'), { textContent: label, type: 'button' });
      item.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:#fff;padding:5px;cursor:pointer';
      item.addEventListener('click', async () => { menu.hidden = true; try { await handler(); } catch (error) { if (error.name !== 'AbortError') alert(error.message); } });
      menu.append(item);
    };
    button.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    option('Export FASTA', async () => {
      const rows = selected();
      const fasta = (await Promise.all(rows.map(row => fetchSequence(row.querySelector('a[title="View gene report"]')?.href)))).filter(Boolean).join('\n');
      if (!fasta) throw new Error('Select at least one row with an available peptide sequence.');
      await saveFile(fasta, [{ description: 'FASTA sequence', accept: { 'text/plain': ['.fasta', '.fa'] } }]);
    });
    option('Export table', async () => {
      const rows = selected();
      if (!rows.length) throw new Error('Select at least one result row.');
      const columns = [...grid.querySelectorAll('.ag-header-cell')].map(cell => ({ id: cell.getAttribute('col-id'), label: text(cell) })).filter(column => column.label);
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([columns.map(column => column.label), ...rows.map(row => columns.map(column => text(row.querySelector(`[col-id="${CSS.escape(column.id)}"]`))))]);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Phy++ results');
      await saveFile(new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
    });
    wrap.append(button, menu);
    exportButton.insertAdjacentElement('afterend', wrap);
  }

  let speciesTimer;
  let speciesRetryTimer;
  let speciesObserver;
  let speciesQueryGeneration = 0;
  let speciesLastQuery = '';
  const SPECIES_INPUT_SELECTOR = '.react-autosuggest__container input,input[aria-autocomplete="list"],input[placeholder^="Choose genomes by selecting"]';
  function speciesSearchValue() {
    const input = document.querySelector(SPECIES_INPUT_SELECTOR);
    return input?.value || '';
  }

  function decorateSpeciesOptionsWhenStable(query, generation) {
    if (speciesSearchValue() !== query || generation !== speciesQueryGeneration) return;
    decorateSpeciesOptions();
    // React can replace suggestions shortly after the input event. One short
    // confirmation pass catches that replacement without touching its text.
    clearTimeout(speciesRetryTimer);
    speciesRetryTimer = setTimeout(() => {
      if (speciesSearchValue() === query && generation === speciesQueryGeneration) decorateSpeciesOptions();
    }, 120);
  }

  // Wait for typing to settle, then decorate the complete current suggestion
  // list. A child-list observer catches React's delayed suggestion rendering;
  // CSS attributes avoid feedback into React-owned text nodes.
  function scheduleSpeciesDecoration() {
    clearTimeout(speciesTimer);
    const query = speciesSearchValue();
    if (query !== speciesLastQuery) {
      speciesLastQuery = query;
      speciesQueryGeneration++;
      clearTimeout(speciesRetryTimer);
    }
    const generation = speciesQueryGeneration;
    speciesTimer = setTimeout(() => {
      decorateSpeciesOptionsWhenStable(query, generation);
    }, SPECIES_DEBOUNCE_MS);
  }

  document.addEventListener('input', event => {
    if (event.target.matches(SPECIES_INPUT_SELECTOR)) scheduleSpeciesDecoration();
  }, true);
  document.addEventListener('focusin', event => {
    if (event.target.matches(SPECIES_INPUT_SELECTOR)) scheduleSpeciesDecoration();
  }, true);

  function isSpeciesSuggestionMutation(record) {
    const selector = '.react-autosuggest__container,.react-autosuggest__suggestions-container,.react-autosuggest__suggestion,#adf,.rct-text';
    if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest?.(selector)) return true;
    return [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === Node.ELEMENT_NODE && (node.matches?.(selector) || node.querySelector?.(selector)));
  }

  function startSpeciesObserver() {
    if (speciesObserver || !document.documentElement) return;
    speciesObserver = new MutationObserver(records => {
      if (records.some(isSpeciesSuggestionMutation)) scheduleSpeciesDecoration();
    });
    speciesObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  startSpeciesObserver();
  if (!speciesObserver) document.addEventListener('DOMContentLoaded', startSpeciesObserver, { once: true });
  scheduleSpeciesDecoration();
}

// `@sandbox raw` executes in the page world. Running directly avoids a
// CSP-sensitive inline-script injection while retaining access to webpack.
if (!window.__phyppMainInstalled) {
  window.__phyppMainInstalled = true;
  phyplusplusMain();
}
