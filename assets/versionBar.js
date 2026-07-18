'use strict';

/* global versionBarManifest, versionBarDataDir */

// Version Bar — lazy-loads historical section content and displays it inline.
// Requires `versionBarManifest` and `versionBarDataDir` to be defined
// before this script runs (injected by the build).

(function () {
  if (typeof versionBarManifest === 'undefined') return;

  const manifest = versionBarManifest;
  const dataDir = typeof versionBarDataDir === 'string' ? versionBarDataDir : '';

  // Cache for fetched section data: sectionId -> { versionKey -> html }
  const sectionCache = {};

  function fetchSectionData(sectionId) {
    if (sectionCache[sectionId]) {
      return Promise.resolve(sectionCache[sectionId]);
    }
    const url =
      (dataDir ? dataDir + '/' : '') +
      'version-bar-data/' +
      encodeURIComponent(sectionId) +
      '.json';
    return fetch(url)
      .then(response => {
        if (!response.ok) throw new Error('Failed to fetch ' + url);
        return response.json();
      })
      .then(data => {
        sectionCache[sectionId] = data;
        return data;
      });
  }

  function findVersionLabel(versionKey) {
    for (let i = 0; i < manifest.versions.length; i++) {
      if (manifest.versions[i].key === versionKey) {
        return manifest.versions[i].label;
      }
    }
    return versionKey;
  }

  function getOrCreateViewer(versionBar) {
    let viewer = versionBar.nextElementSibling;
    if (viewer && viewer.classList.contains('version-viewer')) {
      return viewer;
    }
    viewer = document.createElement('div');
    viewer.className = 'version-viewer';
    versionBar.after(viewer);
    return viewer;
  }

  function removeViewer(versionBar) {
    const viewer = versionBar.nextElementSibling;
    if (viewer && viewer.classList.contains('version-viewer')) {
      viewer.remove();
    }
  }

  function clearSelection(versionBar) {
    const segments = versionBar.querySelectorAll('.version-segment.selected');
    for (let i = 0; i < segments.length; i++) {
      segments[i].classList.remove('selected');
    }
  }

  function handleSegmentClick(event) {
    const segment = event.target.closest('.version-segment');
    if (!segment) return;
    if (segment.classList.contains('version-segment--absent')) return;

    const versionBar = segment.closest('.version-bar');
    if (!versionBar) return;

    const sectionId = versionBar.getAttribute('data-section-id');
    const versionKey = segment.getAttribute('data-version');
    if (!sectionId || !versionKey) return;

    // Toggle: if already selected, deselect and close
    if (segment.classList.contains('selected')) {
      clearSelection(versionBar);
      removeViewer(versionBar);
      return;
    }

    clearSelection(versionBar);
    segment.classList.add('selected');

    // Bump the per-bar generation token. Each click gets a unique token so that
    // async fetch resolutions from an earlier (superseded) click can be discarded,
    // guaranteeing the last-clicked version wins the race for the shared viewer.
    versionBar._viewerToken = (versionBar._viewerToken || 0) + 1;
    const token = versionBar._viewerToken;

    const viewer = getOrCreateViewer(versionBar);
    const label = findVersionLabel(versionKey);

    // Build the header via DOM APIs so the (potentially untrusted) label is set
    // through textContent and never interpreted as HTML.
    const header = document.createElement('div');
    header.className = 'version-viewer-header';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'version-viewer-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      clearSelection(versionBar);
      removeViewer(versionBar);
    });
    header.appendChild(labelEl);
    header.appendChild(closeBtn);

    const contentEl = document.createElement('div');
    contentEl.className = 'version-viewer-content';
    contentEl.textContent = 'Loading...';

    viewer.textContent = '';
    viewer.appendChild(header);
    viewer.appendChild(contentEl);

    // Only write the fetched result if this click is still the latest for the bar
    // and its segment remains selected; otherwise a newer click has superseded it.
    const isCurrent = () =>
      versionBar._viewerToken === token && segment.classList.contains('selected');

    fetchSectionData(sectionId)
      .then(data => {
        if (!isCurrent()) return;
        const content = data[versionKey];
        // Trust boundary: version content is sanitized at build time by the
        // generation script, so it is safe to inject as innerHTML here.
        contentEl.innerHTML = content || '<em>Content not available for this version.</em>';
      })
      .catch(() => {
        if (!isCurrent()) return;
        contentEl.innerHTML = '<em>Failed to load content.</em>';
      });
  }

  function init() {
    const bars = document.querySelectorAll('.version-bar');
    for (let i = 0; i < bars.length; i++) {
      bars[i].addEventListener('click', handleSegmentClick);
    }
  }

  // Run immediately if the DOM is already parsed (e.g. deferred or dynamically
  // injected after DOMContentLoaded); otherwise wait for the event.
  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
