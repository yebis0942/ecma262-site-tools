'use strict';

/* global versionBarManifest, versionBarSections, versionBarDataDir */

// Version Bar — rich version-history UI for spec sections.
//
// The bar is collapsed by default: every listed clause gets a `versions`
// button in its <h1>, and the bar is built on demand from the per-section
// [added, deleted] stats the build embeds in `versionBarSections`. Opening it
// gives range selection (drag handles / range drag / cell snap), a
// single-version view with Blame, a pair view with unified / side-by-side
// diff, and a link into ecma262-compare for the selected pair.
//
// "Show every bar" is a remembered preference (localStorage): when set, all
// bars are built at load, which needs no fetch because the stats are inline.
//
// Requires `versionBarManifest` ({ versions: [{key, label}] }),
// `versionBarSections` ({ sectionId: ([add, del] | null)[] }) and
// `versionBarDataDir` to be defined before this script runs (injected by the
// build), plus assets/versionBarCore.js loaded via an earlier `<script defer>`.

(function () {
  if (typeof versionBarManifest === 'undefined') return;

  // versionBarCore provides diffSequences(aKeys, bKeys) ->
  // [{type:'same'|'add'|'del', ai, bi}] (ai/bi index the inputs, -1 for the
  // untouched side). Fail loud rather than degrade silently if it is missing.
  const core = typeof self !== 'undefined' ? self.versionBarCore : undefined;
  if (!core || typeof core.diffSequences !== 'function') {
    console.error(
      'version-bar: versionBarCore.js is not loaded (it must appear in a <script defer> before versionBar.js); version bar UI disabled.',
    );
    return;
  }

  const manifest = versionBarManifest;
  const dataDir = typeof versionBarDataDir === 'string' ? versionBarDataDir : '';
  const sections =
    typeof versionBarSections === 'object' && versionBarSections !== null
      ? versionBarSections
      : {};

  // Maximum bar-graph height in px (the bar track is 32px tall in CSS).
  const BAR_MAX_HEIGHT = 28;

  const SHOW_ALL_KEY = 'ecma262-plus:version-bar:show-all';

  // Cache for fetched per-section data: sectionId -> Promise<v2 data>.
  // Caching the promise (not the value) collapses concurrent renders of the
  // same section into one request; drag re-renders resolve from cache.
  const sectionCache = {};

  // Per-bar UI state: bar element -> { active, idxL, idxR, blameOn, sbsOn,
  // token, lastRendered, ...element refs }. lo/hi/single are derived on render.
  const stateByBar = new WeakMap();

  function fetchSectionData(sectionId) {
    if (!sectionCache[sectionId]) {
      const url =
        (dataDir ? dataDir + '/' : '') +
        'version-bar-data/' +
        encodeURIComponent(sectionId) +
        '.json';
      sectionCache[sectionId] = fetch(url).then(response => {
        if (!response.ok) throw new Error('Failed to fetch ' + url);
        return response.json();
      });
      // Drop failed fetches from the cache so a later click can retry.
      sectionCache[sectionId].catch(() => {
        delete sectionCache[sectionId];
      });
    }
    return sectionCache[sectionId];
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function segmentsOf(bar) {
    return bar.querySelectorAll('.version-segment');
  }

  // Map a pointer x-coordinate to the nearest segment index (demo formula).
  function indexFromClientX(bar, clientX) {
    const row = bar.querySelector('.vb-row');
    const n = segmentsOf(bar).length;
    if (!row || !n) return 0;
    const rect = row.getBoundingClientRect();
    const cellPx = rect.width / n;
    return clamp(Math.round((clientX - rect.left - cellPx / 2) / cellPx), 0, n - 1);
  }

  // Expand one block's HTML into `parent` via <template> so context-sensitive
  // fragments (<li>, <tr>) parse intact instead of being foster-parented away.
  // Trust boundary: block HTML is sanitized at build time by the generation
  // script, so it is safe to assign to template.innerHTML here.
  function appendBlockHtml(parent, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = typeof html === 'string' ? html : '';
    parent.appendChild(tpl.content);
  }

  // ── preference ───────────────────────────────────────────────────────────

  // localStorage can throw outright (private mode, site data blocked), so both
  // reads and writes are guarded and a failure just means "not remembered".
  function readShowAll() {
    try {
      return localStorage.getItem(SHOW_ALL_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeShowAll(on) {
    try {
      localStorage.setItem(SHOW_ALL_KEY, on ? '1' : '0');
    } catch (e) {
      // Preference simply is not remembered.
    }
  }

  // ── bar construction ─────────────────────────────────────────────────────

  // "es6" -> "6"; fall back to the whole key for unexpected shapes.
  function editionNumber(key) {
    const match = /^es(.+)$/.exec(key);
    return match ? match[1] : key;
  }

  function labelForKey(key) {
    for (let i = 0; i < manifest.versions.length; i++) {
      if (manifest.versions[i].key === key) return manifest.versions[i].label;
    }
    return key;
  }

  // Build the bar for one section from its per-version stats (null = the
  // section is absent from that edition). Bar heights are scaled to the
  // section's own busiest edition, so each bar is a within-section comparison.
  function buildBar(sectionId, stats) {
    const bar = document.createElement('div');
    bar.className = 'version-bar';
    bar.setAttribute('data-section-id', sectionId);
    // The row and the slider are sized in CSS as --vb-count * --vb-cell, which
    // is what makes the slider's percentage positions land exactly on cell
    // boundaries (see .vb-row / .vb-slider in widgets.css).
    bar.style.setProperty('--vb-count', String(manifest.versions.length));
    const row = document.createElement('div');
    row.className = 'vb-row';

    let maxTotal = 0;
    for (let i = 0; i < stats.length; i++) {
      if (stats[i]) maxTotal = Math.max(maxTotal, stats[i][0] + stats[i][1]);
    }

    for (let i = 0; i < manifest.versions.length; i++) {
      const version = manifest.versions[i];
      const entry = stats[i] || null;
      const segment = document.createElement('button');
      segment.type = 'button';
      segment.className = entry
        ? 'version-segment'
        : 'version-segment version-segment--absent';
      segment.setAttribute('data-version', version.key);
      segment.setAttribute('data-index', String(i));

      const track = document.createElement('span');
      track.className = 'vb-bar';
      if (entry) {
        const add = entry[0];
        const del = entry[1];
        segment.setAttribute('data-add', String(add));
        segment.setAttribute('data-del', String(del));
        const total = add + del;
        if (total === 0) {
          const flat = document.createElement('span');
          flat.className = 'vb-bar-flat';
          track.appendChild(flat);
        } else {
          const barH = maxTotal > 0 ? Math.round((total / maxTotal) * BAR_MAX_HEIGHT) : 0;
          const addH = Math.round((add / total) * barH);
          const addEl = document.createElement('span');
          addEl.className = 'vb-bar-add';
          addEl.style.height = addH + 'px';
          const delEl = document.createElement('span');
          delEl.className = 'vb-bar-del';
          delEl.style.height = barH - addH + 'px';
          track.appendChild(addEl);
          track.appendChild(delEl);
        }
        segment.title = version.label + ' — +' + add + ' / −' + del;
      } else {
        segment.title = version.label + ' — not present in this version';
      }

      const num = document.createElement('span');
      num.className = 'vb-num';
      num.textContent = editionNumber(version.key);

      segment.appendChild(track);
      segment.appendChild(num);
      row.appendChild(segment);
    }

    bar.appendChild(row);
    return bar;
  }

  // ── collapse / expand ────────────────────────────────────────────────────

  // The clause's own <h1>: the first one that is not inside a nested section.
  function ownHeader(clause) {
    const headers = clause.getElementsByTagName('h1');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].closest('emu-clause, emu-annex') === clause) return headers[i];
    }
    return null;
  }

  function barFor(clause) {
    const h1 = ownHeader(clause);
    const next = h1 ? h1.nextElementSibling : null;
    return next && next.classList.contains('version-bar') ? next : null;
  }

  function setToggleState(clause, open) {
    const h1 = ownHeader(clause);
    const button = h1 ? h1.querySelector('.vb-toggle-btn') : null;
    if (!button) return;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.classList.toggle('on', open);
  }

  function expand(clause) {
    if (barFor(clause)) return;
    const sectionId = clause.getAttribute('id');
    const stats = sections[sectionId];
    const h1 = ownHeader(clause);
    if (!stats || !h1) return;
    h1.after(buildBar(sectionId, stats));
    setToggleState(clause, true);
  }

  function collapse(clause) {
    const bar = barFor(clause);
    if (!bar) return;
    deactivate(bar); // drops the slider, controls and the viewer sibling
    bar.remove();
    setToggleState(clause, false);
  }

  function eachListedClause(visit) {
    const clauses = document.querySelectorAll('emu-clause[id], emu-annex[id]');
    for (let i = 0; i < clauses.length; i++) {
      if (sections[clauses[i].getAttribute('id')]) visit(clauses[i]);
    }
  }

  function attachToggles() {
    eachListedClause(clause => {
      const h1 = ownHeader(clause);
      if (!h1 || h1.querySelector('.vb-toggle-btn')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vb-toggle-btn';
      button.textContent = 'versions';
      button.title = "Show this section's edition history";
      button.setAttribute('aria-expanded', 'false');
      h1.appendChild(button);
    });
  }

  let showAllObserver = null;

  // Apply the "show every bar" preference. No network is involved either way:
  // the stats are already inline. `keep` is the clause the user is currently
  // reading (the switch lives in its panel), which stays open when the
  // preference is turned off — collapsing it under the pointer would throw
  // away the panel they are looking at.
  function applyShowAll(on, keep) {
    if (showAllObserver) {
      showAllObserver.disconnect();
      showAllObserver = null;
    }
    if (!on) {
      eachListedClause(clause => {
        if (clause !== keep) collapse(clause);
      });
      return;
    }
    // The single-page build lists every section, so expanding all of them up
    // front would build tens of thousands of nodes in one go. Materialize each
    // bar as its clause approaches the viewport instead, and stop watching it
    // once built (so a manual collapse stays collapsed).
    if (typeof IntersectionObserver !== 'function') {
      eachListedClause(expand);
      return;
    }
    showAllObserver = new IntersectionObserver(
      entries => {
        for (let i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          expand(entries[i].target);
          if (showAllObserver) showAllObserver.unobserve(entries[i].target);
        }
      },
      { rootMargin: '400px 0px' },
    );
    eachListedClause(clause => showAllObserver.observe(clause));
  }

  // ── activation / teardown ────────────────────────────────────────────────

  // Build the interactive layer (slider, controls, viewer) and select `idx`.
  function activate(bar, idx) {
    const state = {
      active: true,
      idxL: idx,
      idxR: idx,
      blameOn: false,
      sbsOn: false,
      token: 0,
      lastRendered: '',
    };
    stateByBar.set(bar, state);
    buildSlider(bar, state);
    buildControls(bar, state);
    buildViewer(bar, state);
    render(bar);
  }

  // Remove the interactive layer and restore the bar to its static state.
  function deactivate(bar) {
    const state = stateByBar.get(bar);
    if (!state) return;
    if (state.slider) state.slider.remove();
    if (state.controls) state.controls.remove();
    if (state.viewer) state.viewer.remove();
    const segments = segmentsOf(bar);
    for (let i = 0; i < segments.length; i++) {
      segments[i].classList.remove('in-range', 'endpoint');
    }
    stateByBar.delete(bar);
  }

  // Slider under the bar: range band (drags both edges) + two edge handles.
  function buildSlider(bar, state) {
    const slider = document.createElement('div');
    slider.className = 'vb-slider';
    const range = document.createElement('div');
    range.className = 'vb-range';
    const handleL = buildHandle();
    const handleR = buildHandle();
    slider.appendChild(range);
    slider.appendChild(handleL);
    slider.appendChild(handleR);
    bar.appendChild(slider);
    state.slider = slider;
    state.range = range;
    state.handleL = handleL;
    state.handleR = handleR;
    attachHandleDrag(bar, handleL, 'idxL');
    attachHandleDrag(bar, handleR, 'idxR');
    attachRangeDrag(bar, range);
  }

  function buildHandle() {
    const handle = document.createElement('div');
    handle.className = 'vb-handle';
    const grip = document.createElement('span');
    grip.className = 'vb-grip';
    grip.textContent = '⁞';
    handle.appendChild(grip);
    return handle;
  }

  // Edge-handle drag: pointer capture keeps move events flowing to the handle
  // even when the pointer leaves it; capture is auto-released on pointerup.
  function attachHandleDrag(bar, handle, prop) {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const state = stateByBar.get(bar);
      if (!state) return;
      const idx = indexFromClientX(bar, event.clientX);
      if (state[prop] !== idx) {
        state[prop] = idx;
        render(bar);
      }
    });
  }

  // Range-band drag: move both endpoints together by whole-cell deltas from
  // the pointerdown origin, clamped so the span stays inside the bar.
  function attachRangeDrag(bar, range) {
    let drag = null; // { startX, origLo, span }
    range.addEventListener('pointerdown', event => {
      const state = stateByBar.get(bar);
      if (!state) return;
      event.preventDefault();
      range.setPointerCapture(event.pointerId);
      drag = {
        startX: event.clientX,
        origLo: Math.min(state.idxL, state.idxR),
        span: Math.abs(state.idxR - state.idxL),
      };
    });
    range.addEventListener('pointermove', event => {
      if (!drag || !range.hasPointerCapture(event.pointerId)) return;
      const state = stateByBar.get(bar);
      if (!state) return;
      const row = bar.querySelector('.vb-row');
      const n = segmentsOf(bar).length;
      if (!row || !n) return;
      const cellPx = row.getBoundingClientRect().width / n;
      const delta = Math.round((event.clientX - drag.startX) / cellPx);
      const newLo = clamp(drag.origLo + delta, 0, n - 1 - drag.span);
      if (Math.min(state.idxL, state.idxR) !== newLo) {
        state.idxL = newLo;
        state.idxR = newLo + drag.span;
        render(bar);
      }
    });
    const endDrag = () => {
      drag = null;
    };
    range.addEventListener('pointerup', endDrag);
    range.addEventListener('pointercancel', endDrag);
  }

  // Controls row: info text, one mode toggle (Blame or Side-by-Side), the
  // ecma262-compare link, the "show every bar" preference, close. The mode
  // toggle is inserted by updateControls just before the compare button.
  function buildControls(bar, state) {
    const controls = document.createElement('div');
    controls.className = 'vb-controls';

    const info = document.createElement('span');
    info.className = 'vb-info';

    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'vb-compare-btn';
    compare.textContent = 'ecma262-compare';

    const pref = buildSwitch('showall', '全節で表示', 'vb-switch-pref');
    pref.classList.toggle('on', readShowAll());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'vb-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');

    controls.appendChild(info);
    controls.appendChild(compare);
    controls.appendChild(pref);
    controls.appendChild(close);
    bar.appendChild(controls);
    state.controls = controls;
    state.info = info;
    state.compareBtn = compare;
  }

  // ecma262-compare needs a commit hash per edition, which assets/
  // versionCompare.js resolves (releases.json, with a baked-in fallback). Its
  // list starts at ES2016, so a range with an ES2015 endpoint has no URL.
  function compareUrlFor(baseKey, headKey, sectionId) {
    const releases = typeof self !== 'undefined' ? self.versionCompareReleases : null;
    if (!releases || typeof releases.compareUrl !== 'function' || !sectionId) return null;
    return releases.compareUrl(labelForKey(baseKey), labelForKey(headKey), sectionId);
  }

  // Content panel below the bar; reuses the existing viewer class names.
  function buildViewer(bar, state) {
    const viewer = document.createElement('div');
    viewer.className = 'version-viewer';
    const contentEl = document.createElement('div');
    contentEl.className = 'version-viewer-content';
    viewer.appendChild(contentEl);
    bar.after(viewer);
    // Blame legend hover: dim every blame line not introduced by the hovered
    // version (delegated so it survives content re-renders).
    viewer.addEventListener('mouseover', event => {
      const item = event.target.closest('.vv-legend-item');
      if (item) setBlameDim(viewer, item.getAttribute('data-vidx'));
    });
    viewer.addEventListener('mouseout', event => {
      const item = event.target.closest('.vv-legend-item');
      if (item) setBlameDim(viewer, null);
    });
    state.viewer = viewer;
    state.contentEl = contentEl;
  }

  function setBlameDim(viewer, vidx) {
    const lines = viewer.querySelectorAll('.vv-blame-line');
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.toggle(
        'vv-dim',
        vidx != null && lines[i].getAttribute('data-vidx') !== vidx,
      );
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────

  // Sync every piece of UI (cells, slider, controls, content) to the state.
  function render(bar) {
    const state = stateByBar.get(bar);
    if (!state) return;
    const segments = segmentsOf(bar);
    const n = segments.length;
    if (!n) return;
    const lo = Math.min(state.idxL, state.idxR);
    const hi = Math.max(state.idxL, state.idxR);
    const single = lo === hi;
    // Mode toggles only apply to one selection shape; auto-clear on transition.
    if (single) state.sbsOn = false;
    else state.blameOn = false;

    for (let i = 0; i < n; i++) {
      segments[i].classList.toggle('in-range', i >= lo && i <= hi);
      segments[i].classList.toggle('endpoint', i === lo || i === hi);
    }

    const cellW = 100 / n;
    state.range.style.left = lo * cellW + '%';
    state.range.style.width = (hi - lo + 1) * cellW + '%';
    state.handleL.style.left = lo * cellW + '%';
    state.handleR.style.left = (hi + 1) * cellW + '%';

    const baseKey = segments[lo].getAttribute('data-version') || '';
    const headKey = segments[hi].getAttribute('data-version') || '';
    updateControls(bar, state, single, baseKey, headKey);
    renderContent(bar, state, { lo, hi, single, segments, baseKey, headKey });
  }

  // Info text and mode toggle. The toggle element is kept across renders of
  // the same mode so its thumb transition animates; it is swapped only on a
  // single<->pair transition. Text goes through textContent, never innerHTML.
  function updateControls(bar, state, single, baseKey, headKey) {
    const info = state.info;
    info.textContent = '';
    const strongBase = document.createElement('strong');
    strongBase.textContent = baseKey;
    info.appendChild(strongBase);
    if (single) {
      info.appendChild(document.createTextNode(' を表示中'));
    } else {
      const strongHead = document.createElement('strong');
      strongHead.textContent = headKey;
      info.appendChild(document.createTextNode(' → '));
      info.appendChild(strongHead);
      info.appendChild(document.createTextNode(' の差分'));
    }

    const want = single ? 'blame' : 'sbs';
    let sw = state.controls.querySelector('.vb-switch-mode');
    if (sw && sw.getAttribute('data-toggle') !== want) {
      sw.remove();
      sw = null;
    }
    if (!sw) {
      sw = buildSwitch(want, single ? 'Blame' : 'Side-by-Side', 'vb-switch-mode');
      state.controls.insertBefore(sw, state.compareBtn);
    }
    sw.classList.toggle('on', single ? state.blameOn : state.sbsOn);

    // A single edition is a content view, not a diff, so there is nothing to
    // hand to ecma262-compare; the button stays visible but inert.
    const url = single ? null : compareUrlFor(baseKey, headKey, bar.getAttribute('data-section-id'));
    state.compareUrl = url;
    state.compareBtn.disabled = !url;
    state.compareBtn.title = url
      ? labelForKey(baseKey) + ' → ' + labelForKey(headKey) + ' を ecma262-compare で開く'
      : single
        ? '2つの版を選ぶと ecma262-compare で開けます'
        : 'この範囲は ecma262-compare の対象外です（ES2015 には対応する境界がありません）';
  }

  function buildSwitch(kind, label, extraClass) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = extraClass ? 'vb-switch ' + extraClass : 'vb-switch';
    sw.setAttribute('data-toggle', kind);
    const track = document.createElement('span');
    track.className = 'vb-switch-track';
    const thumb = document.createElement('span');
    thumb.className = 'vb-switch-thumb';
    track.appendChild(thumb);
    sw.appendChild(track);
    sw.appendChild(document.createTextNode(label));
    return sw;
  }

  // Fetch the section data and render the panel for the current selection.
  // The per-state generation token discards stale async resolutions (a newer
  // render wins the race); the lastRendered memo skips rebuilding the panel
  // when a drag re-render lands on an identical (lo, hi, blame, sbs) tuple.
  function renderContent(bar, state, view) {
    const memoKey =
      view.lo + '|' + view.hi + '|' + state.blameOn + '|' + state.sbsOn;
    if (state.lastRendered === memoKey) return;
    state.lastRendered = memoKey;
    const token = ++state.token;
    const contentEl = state.contentEl;
    const sectionId = bar.getAttribute('data-section-id');
    if (!sectionId) return;
    // Only flash "Loading..." on a cold fetch; cached renders swap in place.
    if (!sectionCache[sectionId]) contentEl.textContent = 'Loading...';
    fetchSectionData(sectionId)
      .then(data => {
        if (stateByBar.get(bar) !== state || state.token !== token) return;
        if (!data || data.schemaVersion !== 2) {
          renderError(
            contentEl,
            'This section’s version data uses an unsupported schema (expected schemaVersion 2). Please rerun npm run generate-version-bar-data and rebuild.',
          );
          return;
        }
        contentEl.textContent = '';
        // Presence comes from the baked --absent class; data is keyed by
        // version key and only carries present versions.
        const basePresent = !view.segments[view.lo].classList.contains('version-segment--absent');
        const headPresent = !view.segments[view.hi].classList.contains('version-segment--absent');
        const baseData = basePresent ? data.versions[view.baseKey] : null;
        const headData = headPresent ? data.versions[view.headKey] : null;
        if (view.single) {
          if (!basePresent) {
            renderNotPresent(contentEl, 'このバージョンにはこのセクションは存在しません');
          } else if (!baseData) {
            renderError(
              contentEl,
              'Version data for ' + view.baseKey + ' is missing from this section’s data file. Please rerun npm run generate-version-bar-data.',
            );
          } else if (state.blameOn) {
            renderBlame(contentEl, baseData);
          } else {
            renderSingle(contentEl, baseData);
          }
        } else {
          renderPair(contentEl, state, view, baseData, headData);
        }
      })
      .catch(() => {
        if (stateByBar.get(bar) !== state || state.token !== token) return;
        state.lastRendered = ''; // allow a retry render for the same selection
        renderError(contentEl, 'Failed to load version data for this section.');
      });
  }

  // Single version: reinflate the skeleton by splicing blocks back into their
  // <!--vb:N--> markers. Every marker and every block must be used exactly
  // once — anything else means corrupted data, so fail loud.
  function renderSingle(contentEl, vdata) {
    let replaced = 0;
    let bad = false;
    const html = vdata.skeleton.replace(/<!--vb:(\d+)-->/g, (_, i) => {
      replaced++;
      const block = vdata.blocks[Number(i)];
      if (typeof block !== 'string') {
        bad = true;
        return '';
      }
      return block;
    });
    if (bad || replaced !== vdata.blocks.length) {
      renderError(
        contentEl,
        'Corrupted version data (marker/block mismatch). Please rerun npm run generate-version-bar-data.',
      );
      return;
    }
    // Trust boundary: version content is sanitized at build time by the
    // generation script, so it is safe to inject as innerHTML here.
    contentEl.innerHTML = html;
  }

  // Blame view: one row per block with a colored gutter naming the version
  // (global manifest index) that introduced it, plus a hoverable legend.
  function renderBlame(contentEl, vdata) {
    const blocks = vdata.blocks;
    const blame = vdata.blame || [];
    const frag = document.createDocumentFragment();
    const seen = [];
    for (let i = 0; i < blocks.length; i++) {
      const gi = blame[i];
      const version = manifest.versions[gi];
      const line = document.createElement('div');
      line.className = 'vv-blame-line';
      line.setAttribute('data-vidx', String(gi));
      const gutter = document.createElement('div');
      gutter.className = 'vv-blame-gutter vb-c' + (((gi % 10) + 10) % 10);
      const tag = document.createElement('span');
      tag.className = 'vv-blame-tag';
      tag.textContent = version ? version.key.replace(/^es/, '') : '?';
      gutter.appendChild(tag);
      const text = document.createElement('div');
      text.className = 'vv-blame-text';
      appendBlockHtml(text, blocks[i]);
      line.appendChild(gutter);
      line.appendChild(text);
      frag.appendChild(line);
      if (seen.indexOf(gi) === -1) seen.push(gi);
    }
    seen.sort((a, b) => a - b);
    const legend = document.createElement('div');
    legend.className = 'vv-legend';
    for (let i = 0; i < seen.length; i++) {
      const gi = seen[i];
      const version = manifest.versions[gi];
      const item = document.createElement('span');
      item.className = 'vv-legend-item vb-c' + (((gi % 10) + 10) % 10);
      item.setAttribute('data-vidx', String(gi));
      item.appendChild(document.createTextNode(version ? version.key : '?'));
      legend.appendChild(item);
    }
    frag.appendChild(legend);
    contentEl.appendChild(frag);
  }

  // All-add/all-del op list for diffs where one side is absent.
  function synthOps(count, type) {
    const ops = [];
    for (let i = 0; i < count; i++) {
      ops.push({
        type,
        ai: type === 'del' ? i : -1,
        bi: type === 'add' ? i : -1,
      });
    }
    return ops;
  }

  // Pair view: diff stats header + unified or side-by-side body.
  function renderPair(contentEl, state, view, baseData, headData) {
    if (!baseData && !headData) {
      renderNotPresent(contentEl, '両バージョンにこのセクションは存在しません');
      return;
    }
    let ops;
    let note = null;
    if (baseData && headData) {
      ops = core.diffSequences(baseData.keys, headData.keys);
    } else if (headData) {
      ops = synthOps(headData.blocks.length, 'add');
      note = 'セクション新規追加（' + view.headKey + '）';
    } else {
      ops = synthOps(baseData.blocks.length, 'del');
    }
    let addCount = 0;
    let delCount = 0;
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type === 'add') addCount++;
      else if (ops[i].type === 'del') delCount++;
    }

    const stats = document.createElement('div');
    stats.className = 'vv-stats';
    const statAdd = document.createElement('span');
    statAdd.className = 'vv-stat-add';
    statAdd.textContent = '+' + addCount + ' 追加';
    const statDel = document.createElement('span');
    statDel.className = 'vv-stat-del';
    statDel.textContent = '−' + delCount + ' 削除';
    stats.appendChild(statAdd);
    stats.appendChild(statDel);
    contentEl.appendChild(stats);

    if (state.sbsOn) {
      renderSbs(contentEl, ops, baseData, headData, view);
    } else {
      renderUnified(contentEl, ops, baseData, headData, note);
    }
  }

  // Unified diff: one row per op with a +/− marker and the block content.
  function renderUnified(contentEl, ops, baseData, headData, note) {
    const frag = document.createDocumentFragment();
    if (note) {
      const noteLine = document.createElement('div');
      noteLine.className = 'vv-diff-line add vv-diff-note';
      const mk = document.createElement('span');
      mk.className = 'vv-mk';
      mk.textContent = '+';
      const body = document.createElement('div');
      body.className = 'vv-diff-body';
      body.textContent = note;
      noteLine.appendChild(mk);
      noteLine.appendChild(body);
      frag.appendChild(noteLine);
    }
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const line = document.createElement('div');
      line.className = 'vv-diff-line ' + op.type;
      const mk = document.createElement('span');
      mk.className = 'vv-mk';
      mk.textContent = op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ';
      const body = document.createElement('div');
      body.className = 'vv-diff-body';
      // same/add read from the head side, del from the base side.
      const html = op.bi >= 0 && headData ? headData.blocks[op.bi] : baseData.blocks[op.ai];
      appendBlockHtml(body, html);
      line.appendChild(mk);
      line.appendChild(body);
      frag.appendChild(line);
    }
    contentEl.appendChild(frag);
  }

  // Side-by-side: a 2-column grid built from the same op list; add/del rows
  // pair the changed block with an empty cell on the other side.
  function renderSbs(contentEl, ops, baseData, headData, view) {
    const grid = document.createElement('div');
    grid.className = 'vv-sbs-grid';
    const headL = document.createElement('div');
    headL.className = 'vv-sbs-head';
    headL.textContent = view.baseKey;
    const headR = document.createElement('div');
    headR.className = 'vv-sbs-head';
    headR.textContent = view.headKey;
    grid.appendChild(headL);
    grid.appendChild(headR);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const left = document.createElement('div');
      left.className = 'vv-sbs-cell';
      const right = document.createElement('div');
      right.className = 'vv-sbs-cell';
      if (op.type === 'same') {
        appendBlockHtml(left, baseData.blocks[op.ai]);
        appendBlockHtml(right, headData.blocks[op.bi]);
      } else if (op.type === 'del') {
        left.classList.add('sbs-del');
        appendBlockHtml(left, baseData.blocks[op.ai]);
        right.classList.add('sbs-empty');
      } else {
        left.classList.add('sbs-empty');
        right.classList.add('sbs-add');
        appendBlockHtml(right, headData.blocks[op.bi]);
      }
      grid.appendChild(left);
      grid.appendChild(right);
    }
    contentEl.appendChild(grid);
  }

  // Plain-text panel messages (textContent — never HTML).
  function renderNotPresent(contentEl, message) {
    contentEl.textContent = '';
    const div = document.createElement('div');
    div.className = 'vv-not-present';
    div.textContent = message;
    contentEl.appendChild(div);
  }

  function renderError(contentEl, message) {
    contentEl.textContent = '';
    const div = document.createElement('div');
    div.className = 'vv-error';
    div.textContent = message;
    contentEl.appendChild(div);
  }

  // ── event wiring ─────────────────────────────────────────────────────────

  // Re-sync the controls of every open bar (the compare link can only be
  // resolved once versionCompare.js has its release hashes). render() rebuilds
  // the controls unconditionally and the content render is memoized, so this
  // costs nothing beyond the controls.
  function refreshOpenControls() {
    const bars = document.querySelectorAll('.version-bar');
    for (let i = 0; i < bars.length; i++) {
      if (stateByBar.get(bars[i])) render(bars[i]);
    }
  }

  // Single delegated click listener for every bar on the page. Absent
  // segments are clickable too — the panel shows a not-present message.
  function handleDocumentClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    const toggle = target.closest('.vb-toggle-btn');
    if (toggle) {
      const clause = toggle.closest('emu-clause, emu-annex');
      if (!clause) return;
      if (barFor(clause)) collapse(clause);
      else expand(clause);
      return;
    }

    const compare = target.closest('.vb-compare-btn');
    if (compare) {
      const bar = compare.closest('.version-bar');
      const state = bar ? stateByBar.get(bar) : undefined;
      if (state && state.compareUrl) window.open(state.compareUrl, '_blank');
      return;
    }

    const close = target.closest('.vb-close');
    if (close) {
      const bar = close.closest('.version-bar');
      if (bar) deactivate(bar);
      return;
    }

    const sw = target.closest('.vb-switch');
    if (sw) {
      // The preference switch is not per-bar: it flips every bar on the page
      // and is remembered for later visits.
      if (sw.getAttribute('data-toggle') === 'showall') {
        const on = !readShowAll();
        writeShowAll(on);
        const current = sw.closest('emu-clause, emu-annex');
        applyShowAll(on, current);
        const prefSwitches = document.querySelectorAll('.vb-switch-pref');
        for (let i = 0; i < prefSwitches.length; i++) prefSwitches[i].classList.toggle('on', on);
        return;
      }
      const bar = sw.closest('.version-bar');
      const state = bar ? stateByBar.get(bar) : undefined;
      if (!state) return;
      if (sw.getAttribute('data-toggle') === 'blame') state.blameOn = !state.blameOn;
      else state.sbsOn = !state.sbsOn;
      render(bar);
      return;
    }

    const segment = target.closest('.version-segment');
    if (segment) {
      const bar = segment.closest('.version-bar');
      if (!bar) return;
      const idx = parseInt(segment.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;
      const state = stateByBar.get(bar);
      if (!state || !state.active) {
        activate(bar, idx);
      } else {
        // Already active: snap the selection to the clicked cell.
        state.idxL = idx;
        state.idxR = idx;
        render(bar);
      }
    }
  }

  function subscribeToReleases() {
    const releases = typeof self !== 'undefined' ? self.versionCompareReleases : null;
    if (!releases || typeof releases.subscribe !== 'function') return false;
    releases.subscribe(refreshOpenControls);
    return true;
  }

  function init() {
    document.addEventListener('click', handleDocumentClick);
    attachToggles();
    if (readShowAll()) applyShowAll(true);
    // versionCompare.js is a later <script defer>, so it may not have run yet
    // when a defer-time init() happens; retry once the document is parsed.
    if (!subscribeToReleases()) {
      document.addEventListener('DOMContentLoaded', subscribeToReleases);
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
