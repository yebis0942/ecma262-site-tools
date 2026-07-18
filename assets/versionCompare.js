'use strict';

// Version compare widget: adds a per-clause button that links to ecma262-compare
// for viewing diffs between ECMAScript spec versions.

// Release boundaries are fetched at runtime from ecma262-section-history's
// releases.json, which derives them from `git merge-base <tag> main` — the
// point on main where each release branch forked. The list below is a baked-in
// fallback for when that fetch fails, using the same merge-base hashes.
// ES2016 is the exception: its release predates snapshot coverage, so it uses
// the actual release commit (on a side branch) and is never overridden.
const versionCompareReleasesUrl =
  'https://yebis0942.github.io/ecma262-section-history/releases.json';

let definedVersions = [
  { label: 'ES2016', hash: 'b154ce84698377ab53fe88c889633263607f4423' },
  { label: 'ES2017', hash: 'c8a6acfb99a364a114ac0152e3a071539dc1ca1a' },
  { label: 'ES2018', hash: '59d73dc08ea371866c1d9d45843e6752f26a48e4' },
  { label: 'ES2019', hash: '362cb1074cb5cc51867d98b4c3304e75117724d3' },
  { label: 'ES2020', hash: '1b7ca8d5c87f2655acf976ae72efcbf75f48ca15' },
  { label: 'ES2021', hash: 'a53b61fbe9c42f2f0bda2267fb3f51d6ecd904d9' },
  { label: 'ES2022', hash: '9d440aefa584bcc0d76dd4de611eabcc4f687043' },
  { label: 'ES2023', hash: '1c5ca183844ab453f939f1ee6165747c8b1c64ee' },
  { label: 'ES2024', hash: '6ec325c22e9b3c47397c95c6b301491e76edb768' },
  { label: 'ES2025', hash: 'ab261035815e2dff8705a0fe9a5eb7660ecea78c' },
];

let versionCompareState = {
  openPanel: null, // the currently open panel element, or null
  fromIndex: definedVersions.length - 2, // default: one before latest
  toIndex: definedVersions.length - 1, // default: latest
  selectingEndpoint: 'from', // 'from' or 'to'
};

// Merge releases.json entries ([{ release: 'es2025', hash, seq }, ...], oldest
// first) into definedVersions: known labels get their hash updated, unknown
// releases (e.g. a future ES2026) are appended.
function applyVersionCompareReleases(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return;
  for (let i = 0; i < releases.length; i++) {
    let entry = releases[i];
    if (typeof entry.release !== 'string' || typeof entry.hash !== 'string') return;
  }
  let updated = definedVersions.map(v => {
    let match = releases.find(r => r.release === v.label.toLowerCase());
    return match ? { label: v.label, hash: match.hash } : v;
  });
  for (let i = 0; i < releases.length; i++) {
    let r = releases[i];
    if (!updated.some(v => v.label.toLowerCase() === r.release)) {
      updated.push({ label: r.release.toUpperCase(), hash: r.hash });
    }
  }
  definedVersions = updated;
  // Reset selection defaults; close any open panel so it is rebuilt from the
  // new list on next open.
  closePanel();
  versionCompareState.fromIndex = definedVersions.length - 2;
  versionCompareState.toIndex = definedVersions.length - 1;
  versionCompareState.selectingEndpoint = 'from';
}

function loadVersionCompareReleases() {
  if (typeof fetch !== 'function') return;
  fetch(versionCompareReleasesUrl)
    .then(res => (res.ok ? res.json() : null))
    .then(releases => {
      if (releases) applyVersionCompareReleases(releases);
    })
    .catch(() => {
      // Network/CORS failures are fine; the baked-in list is used as-is.
    });
}

function initVersionCompare() {
  loadVersionCompareReleases();
  let clauses = document.querySelectorAll('emu-clause[id], emu-annex[id]');
  for (let i = 0; i < clauses.length; i++) {
    let clause = clauses[i];
    let h1 = clause.querySelector('h1');
    if (!h1) continue;
    // Only attach to direct h1 children of this clause
    if (h1.parentNode !== clause) continue;

    let btn = document.createElement('button');
    btn.className = 'version-compare-btn';
    btn.textContent = 'compare';
    btn.title = 'Compare versions of this section';
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(btn, clause.id);
    });
    h1.appendChild(btn);
  }

  // Close panel on outside click
  document.addEventListener('click', e => {
    if (
      versionCompareState.openPanel &&
      !versionCompareState.openPanel.contains(e.target) &&
      !e.target.classList.contains('version-compare-btn')
    ) {
      closePanel();
    }
  });
}

function togglePanel(btn, sectionId) {
  if (versionCompareState.openPanel && versionCompareState.openPanel._sectionId === sectionId) {
    closePanel();
    return;
  }
  closePanel();
  openPanel(btn, sectionId);
}

function closePanel() {
  if (versionCompareState.openPanel) {
    versionCompareState.openPanel.remove();
    versionCompareState.openPanel = null;
  }
}

function openPanel(btn, sectionId) {
  let panel = document.createElement('div');
  panel.className = 'version-compare-panel';
  panel._sectionId = sectionId;

  // Endpoint selectors
  let endpoints = document.createElement('div');
  endpoints.className = 'version-compare-endpoints';

  let fromBtn = document.createElement('button');
  fromBtn.className = 'version-compare-endpoint';
  if (versionCompareState.selectingEndpoint === 'from') {
    fromBtn.classList.add('active');
  }
  fromBtn.addEventListener('click', e => {
    e.stopPropagation();
    versionCompareState.selectingEndpoint = 'from';
    updatePanel(panel);
  });

  let toBtn = document.createElement('button');
  toBtn.className = 'version-compare-endpoint';
  if (versionCompareState.selectingEndpoint === 'to') {
    toBtn.classList.add('active');
  }
  toBtn.addEventListener('click', e => {
    e.stopPropagation();
    versionCompareState.selectingEndpoint = 'to';
    updatePanel(panel);
  });

  endpoints.appendChild(fromBtn);
  endpoints.appendChild(toBtn);
  panel.appendChild(endpoints);

  // Version bar
  let bar = document.createElement('div');
  bar.className = 'version-compare-bar';

  for (let v = 0; v < definedVersions.length; v++) {
    let cell = document.createElement('button');
    cell.className = 'version-compare-cell';
    cell.textContent = definedVersions[v].label;
    cell.dataset.index = v;
    cell.addEventListener('click', function (e) {
      e.stopPropagation();
      let idx = parseInt(this.dataset.index);
      if (versionCompareState.selectingEndpoint === 'from') {
        versionCompareState.fromIndex = idx;
        // Auto-switch to 'to' after selecting 'from'
        versionCompareState.selectingEndpoint = 'to';
      } else {
        versionCompareState.toIndex = idx;
        // Auto-switch to 'from' after selecting 'to'
        versionCompareState.selectingEndpoint = 'from';
      }
      updatePanel(panel);
    });
    bar.appendChild(cell);
  }

  panel.appendChild(bar);

  // Open button
  let openBtn = document.createElement('button');
  openBtn.className = 'version-compare-open-btn';
  openBtn.addEventListener('click', e => {
    e.stopPropagation();
    let fromHash = definedVersions[versionCompareState.fromIndex].hash;
    let toHash = definedVersions[versionCompareState.toIndex].hash;
    let url =
      'https://arai-a.github.io/ecma262-compare/?from=' +
      encodeURIComponent(fromHash) +
      '&to=' +
      encodeURIComponent(toHash) +
      '&id=' +
      encodeURIComponent(sectionId);
    window.open(url, '_blank');
  });
  panel.appendChild(openBtn);

  // Close button
  let closeBtn = document.createElement('button');
  closeBtn.className = 'version-compare-close-btn';
  closeBtn.textContent = '\u2716';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    closePanel();
  });
  panel.appendChild(closeBtn);

  updatePanel(panel);

  // Position relative to button
  btn.style.position = 'relative';
  btn.parentNode.style.position = 'relative';
  btn.parentNode.appendChild(panel);

  versionCompareState.openPanel = panel;
}

function updatePanel(panel) {
  // Update endpoint buttons
  let endpointBtns = panel.querySelectorAll('.version-compare-endpoint');
  let fromBtn = endpointBtns[0];
  let toBtn = endpointBtns[1];

  fromBtn.textContent = 'From: ' + definedVersions[versionCompareState.fromIndex].label;
  fromBtn.classList.toggle('active', versionCompareState.selectingEndpoint === 'from');
  toBtn.textContent = 'To: ' + definedVersions[versionCompareState.toIndex].label;
  toBtn.classList.toggle('active', versionCompareState.selectingEndpoint === 'to');

  // Update version cells
  let cells = panel.querySelectorAll('.version-compare-cell');
  for (let i = 0; i < cells.length; i++) {
    let idx = parseInt(cells[i].dataset.index);
    cells[i].classList.remove('selected-from', 'selected-to', 'in-range');
    if (idx === versionCompareState.fromIndex) {
      cells[i].classList.add('selected-from');
    }
    if (idx === versionCompareState.toIndex) {
      cells[i].classList.add('selected-to');
    }
    let lo = Math.min(versionCompareState.fromIndex, versionCompareState.toIndex);
    let hi = Math.max(versionCompareState.fromIndex, versionCompareState.toIndex);
    if (idx > lo && idx < hi) {
      cells[i].classList.add('in-range');
    }
  }

  // Update open button
  let openBtn = panel.querySelector('.version-compare-open-btn');
  openBtn.textContent =
    'Compare ' +
    definedVersions[versionCompareState.fromIndex].label +
    ' \u2192 ' +
    definedVersions[versionCompareState.toIndex].label;
}

document.addEventListener('DOMContentLoaded', initVersionCompare);
