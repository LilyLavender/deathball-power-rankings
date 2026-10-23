// Static-site output generation (CSS + client-side JS) for the generated
// index.html page, split out of aggregate_players.js so that file can focus
// on data aggregation. Both functions write directly to repo-root files and
// have no return value.
//
// Comments inside the generated CSS/JS below must never contain a backtick --
// this whole file's output is a JS template literal, and a stray backtick
// closes it early and throws a syntax error at generation time (see CLAUDE.md).
//
// The comments themselves exist for whoever is reading/editing this source
// file, not for whoever opens index.css/index.js in a browser devtools tab --
// stripJsComments/stripCssComments below strip them out of the actual
// written files (bloat + no reason to ship internal rationale to visitors),
// so write comments here freely without worrying about output size.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Strips /* */ comments (CSS has no line-comment syntax) while leaving
// quoted strings -- e.g. the data:image/svg+xml URLs -- untouched, then
// collapses the blank lines comment removal leaves behind.
function stripCssComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === '\\') j++;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close === -1 ? code.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

// Strips // and /* */ comments from the generated client-side JS while
// leaving string/template-literal/regex-literal content untouched -- a
// naive strip would truncate string literals that happen to contain "//"
// (e.g. 'http://www.w3.org/2000/svg') or eat a division operator it
// mistook for the start of a regex. Regex-vs-division is disambiguated by
// checking whether the last meaningful token before the "/" is one that a
// value can't follow (an operator/punctuator/keyword), same heuristic
// simple JS tokenizers use.
const JS_REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'do', 'else',
]);

function isJsRegexContext(outSoFar) {
  const trimmed = outSoFar.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const lastChar = trimmed[trimmed.length - 1];
  if ('([{,;:=!&|?+-*%^~<>'.includes(lastChar)) return true;
  const wordMatch = trimmed.match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
  return !!(wordMatch && JS_REGEX_PRECEDING_KEYWORDS.has(wordMatch[0]));
}

function stripJsComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && code[j] !== quote) {
        j += code[j] === '\\' ? 2 : 1;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && code[j] !== '`') {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '$' && code[j + 1] === '{') {
          j += 2;
          let depth = 1;
          while (j < n && depth > 0) {
            if (code[j] === '{') depth++;
            else if (code[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && isJsRegexContext(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        else if (code[j] === '/' && !inClass) { j++; break; }
        j++;
      }
      while (j < n && /[a-z]/i.test(code[j])) j++;
      out += code.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

function writeCss() {
  const css = `@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;700;900&display=swap');

/* Shared motion tokens for the transition work below (tab/panel fades,
   the AKA/Options accordions, the chart tooltip, the download button's
   icon-swap + success check). Values are picked to sit close to the
   150-220ms plain-"ease" durations already used across the file (tab
   underline, view-toggle pill, etc.) so new motion blends in rather than
   feeling like a different design language. */
:root {
  --duration-quick: 150ms;
  --duration-fast: 250ms;
  --duration-very-slow: 500ms;
  --ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: ease-in-out;
  --ease-out: ease-out;
  --blur-small: 2px;
  --acc-expand: 250ms;
  --acc-collapse: 250ms;
  --acc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --dropdown-open-dur: 250ms;
  --dropdown-close-dur: 150ms;
  --dropdown-pre-scale: 0.97;
  --dropdown-closing-scale: 0.99;
  --dropdown-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --icon-swap-dur: 250ms;
  --icon-swap-blur: 2px;
  --icon-swap-start-scale: 0.25;
  --icon-swap-ease: ease-in-out;
  --tt-in-dur: 150ms;
  --tt-out-dur: 50ms;
  --tt-scale: 0.98;
  --tt-delay: 80ms;
  --tt-in-ease: ease-out;
  --tt-out-ease: ease-out;
  --tt-move-dur: 160ms;
  --tt-move-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --check-opacity-dur: 400ms;
  --check-rotate-dur: 400ms;
  --check-rotate-from: 80deg;
  --check-bob-dur: 400ms;
  --check-y-amount: 10px;
  --check-blur-dur: 400ms;
  --check-blur-from: 6px;
  --check-path-dur: 300ms;
  --check-path-delay: 80ms;
  --check-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --check-ease-opacity: cubic-bezier(0.22, 1, 0.36, 1);
  --check-ease-rotate: cubic-bezier(0.22, 1, 0.36, 1);
  --check-ease-bob: cubic-bezier(0.34, 1.35, 0.64, 1);
  --check-ease-path: cubic-bezier(0.22, 1, 0.36, 1);
  --stagger-dur: 500ms;
  --stagger-distance: 12px;
  --stagger-stagger: 40ms;
  --stagger-blur: 3px;
  --stagger-ease: cubic-bezier(0.22, 1, 0.36, 1);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
/* display:flex + min-height:100vh so .site-footer's margin-top:auto (below)
   can push it to the bottom of the viewport on short pages instead of
   riding up under sparse content -- on tall pages it just sits after the
   last child like normal block flow, since there's no leftover space to
   push into. */
body { font-family: 'Rajdhani', system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem; background: #050505; color: #f0f0f0; font-size: 1rem; display: flex; flex-direction: column; min-height: 100vh; }
h1 { font-family: 'Press Start 2P', monospace; font-size: 1.6rem; letter-spacing: 0.05em; margin: 0 0 1.5rem; color: #fff; }
#tab-heading { display: inline-block; }
a { color: #3eff8b; text-decoration: none; }
a:hover { text-decoration: underline; }
.tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 1px solid #222; position: relative; }
.tab-button { background: none; border: none; border-bottom: 2px solid transparent; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.6rem 1.2rem; cursor: pointer; margin-bottom: -1px; transition: color 150ms ease; }
.tab-button:hover { color: #bbb; }
.tab-button.active { color: #3eff8b; }
/* A plain navigation link to the player-graph.html page, not a real tab (no
   panel, no data-tab) -- kept out of the .tab-button class so
   enableTabs()'s querySelectorAll('.tab-button') never picks it up and
   tries to activate a nonexistent panel. Sits inline with the rest of the
   tab buttons (no margin-left: auto) and is styled the same, just
   underlined on hover since it has no sliding .tab-underline indicator of
   its own to show which one is "active". */
.tab-external-link { display: inline-flex; align-items: center; gap: 0.35em; background: none; border: none; border-bottom: 2px solid transparent; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; text-decoration: none; padding: 0.6rem 1.2rem; margin-bottom: -1px; transition: color 150ms ease; }
.tab-external-link:hover { color: #bbb; text-decoration: underline; }
/* Positioned/sized by JS (enableTabs) to sit under whichever tab is active,
   sliding there via the left/width transition instead of the underline
   just appearing under the newly-clicked tab and disappearing from the old
   one. */
.tab-underline { position: absolute; bottom: -1px; height: 2px; background: #3eff8b; transition: left 220ms ease, width 220ms ease; }
.tab-panel { display: none; }
/* Going from display:none to block re-triggers a CSS animation every time
   (unlike a transition, which needs both states rendered) -- so switching
   tabs plays this fade-in fresh on each activation with no JS involved. */
.tab-panel.active { display: block; animation: t-panel-fade-in var(--duration-fast) var(--ease-in-out); }
@keyframes t-panel-fade-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .tab-panel.active { animation: none !important; }
}
.tab-controls { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
/* display:contents on desktop so #rankings-options-panel's children (the
   view-toggle, filter selects, download button) stay direct flex items of
   the .tab-controls row above -- this wrapper only becomes a real box (the
   accordion's collapsible content) inside the mobile media query below. */
.rankings-options-inner { display: contents; }
.tab-controls label { color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; display: flex; align-items: center; gap: 0.5rem; }
/* Dropdowns. Every select in a .tab-controls row is progressively enhanced
   by enhanceDropdowns() in writeJs: the native select is hidden (still the
   source of truth for .value/.options and still the thing that fires change,
   so applyFilters and friends never know the difference) and replaced with a
   .dd-trigger button plus a .dd-menu listbox. The native select keeps the
   same closed-control skin as the trigger so a no-JS page still matches
   (appearance:none drops the native arrow, so a chevron is drawn as a
   background image; color-scheme:dark keeps the native option popup dark). */
.tab-controls select, .dd-trigger { background-color: #111; color: #f0f0f0; border: 1px solid #333; border-radius: 3px; padding: 0.32rem 0.7rem; font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 600; letter-spacing: 0; text-transform: none; line-height: normal; transition: border-color 150ms, background-color 150ms, color 150ms; appearance: none; -webkit-appearance: none; cursor: pointer; }
.tab-controls select { padding-right: 1.8rem; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.65rem center; background-size: 0.6rem; color-scheme: dark; }
.tab-controls select:hover, .dd-trigger:hover { border-color: #555; background-color: #161616; }
.tab-controls select:focus { outline: none; border-color: #3eff8b; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%233eff8b' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
.dd { position: relative; display: inline-flex; min-width: 0; }
.dd-trigger { display: inline-flex; align-items: center; gap: 0.6rem; min-width: 0; max-width: 100%; text-align: left; }
.dd-trigger:focus { outline: none; }
.dd-trigger:focus-visible, .dd.is-open .dd-trigger { border-color: #3eff8b; }
.dd.is-open .dd-trigger { background-color: #161616; }
.dd-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The chevron is an inline SVG (not a background image like the no-JS
   select's) so it can flip while the menu is open, same cue as the mobile
   options accordion's caret. */
.dd-chevron { flex-shrink: 0; width: 0.6rem; height: auto; color: #888; transition: transform var(--duration-fast) var(--ease-smooth-out), color 150ms; }
.dd-trigger:hover .dd-chevron { color: #aaa; }
.dd.is-open .dd-chevron, .dd-trigger:focus-visible .dd-chevron { color: #3eff8b; }
.dd.is-open .dd-chevron { transform: rotate(180deg); }
/* The long "Rankings at" checkpoint labels are clipped on the closed control
   so the toolbar row stays on one line; the open menu still shows full text. */
.dd[data-for="pr-history-select"] .dd-trigger { max-width: 12rem; }
/* The menu lives directly under body (enhanceDropdowns appends it there) and
   is position:fixed, so it can never be clipped by an overflow:hidden
   ancestor -- which the mobile Power Rankings options accordion
   (.rankings-options-inner) is. z-index sits above the mobile tabs drawer. */
.dd-menu { position: fixed; z-index: 60; margin: 0; padding: 4px; list-style: none; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #333 transparent; background: #0f0f0f; border: 1px solid #333; border-radius: 3px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(62, 255, 139, 0.05); font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 600; }
.dd-menu::-webkit-scrollbar { width: 6px; }
.dd-menu::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
.dd-option { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.75rem; border-radius: 2px; color: #bbb; cursor: pointer; transition: background-color 100ms, color 100ms; }
/* Long labels (the Rankings-at checkpoints) wrap rather than clip, since the open menu is where the full text is meant to be readable. */
.dd-option-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dd-option.is-active { background: #1a1a1a; color: #fff; }
.dd-option[aria-selected="true"] { color: #3eff8b; font-weight: 700; }
.dd-option-check { flex-shrink: 0; width: 0.7rem; height: auto; color: #3eff8b; opacity: 0; }
/* Flag next to an option / the chosen value (the Location filter): a fixed
   box with object-fit so state flags of different aspect ratios line up. */
.dd-flag { flex-shrink: 0; width: 1.4em; height: 1em; object-fit: contain; border-radius: 1px; }
/* Section headers inside a menu (one per optgroup), styled like the site's
   table column headers; every group gets a rule above it. */
.dd-group { padding: 0.55rem 0.75rem 0.25rem; margin-top: 4px; border-top: 1px solid #222; color: #666; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; cursor: default; }
.dd-option[aria-selected="true"] .dd-option-check { opacity: 1; }
/* transitions.dev menu-dropdown: grows out of the trigger's edge (top-left
   when opening downward, bottom-left when flipped above), softer and
   quicker on the way out. */
.t-dropdown {
  transform-origin: top left;
  transform: scale(var(--dropdown-pre-scale));
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition:
    transform var(--dropdown-open-dur) var(--dropdown-ease),
    opacity   var(--dropdown-open-dur) var(--dropdown-ease),
    visibility 0s linear var(--dropdown-open-dur);
  will-change: transform, opacity;
}
.t-dropdown[data-origin="top-right"]     { transform-origin: top right; }
.t-dropdown[data-origin="top-center"]    { transform-origin: top center; }
.t-dropdown[data-origin="bottom-left"]   { transform-origin: bottom left; }
.t-dropdown[data-origin="bottom-center"] { transform-origin: bottom center; }
.t-dropdown[data-origin="bottom-right"]  { transform-origin: bottom right; }
.t-dropdown.is-open {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
  transition:
    transform var(--dropdown-open-dur) var(--dropdown-ease),
    opacity   var(--dropdown-open-dur) var(--dropdown-ease),
    visibility 0s;
}
.t-dropdown.is-closing {
  transform: scale(var(--dropdown-closing-scale));
  opacity: 0;
  pointer-events: none;
  visibility: visible;
  transition:
    transform var(--dropdown-close-dur) var(--dropdown-ease),
    opacity   var(--dropdown-close-dur) var(--dropdown-ease);
}
@media (prefers-reduced-motion: reduce) {
  .t-dropdown, .dd-chevron { transition: none !important; }
}
.filter-count, .ranking-count { color: #555; font-size: 0.9rem; font-weight: 500; }
#count { color: #555; font-size: 0.9rem; margin-bottom: 1rem; }
.view-toggle { display: flex; gap: 0; background: #111; border: 1px solid #333; border-radius: 3px; padding: 2px; flex-shrink: 0; position: relative; }
/* Same sliding-indicator treatment as .tab-underline above, but as a filled
   pill behind the buttons rather than a line under them (positioned/sized
   by JS in enableViewToggle). */
.view-toggle-indicator { position: absolute; top: 2px; bottom: 2px; background: #3eff8b; border-radius: 2px; transition: left 200ms ease, width 200ms ease; }
.view-btn, .delta-btn { position: relative; z-index: 1; background: none; border: none; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.3rem 0.85rem; border-radius: 2px; cursor: pointer; transition: color 150ms; }
.view-btn.active, .delta-btn.active { color: #000; }
.view-btn:not(.active):hover, .delta-btn:not(.active):hover { color: #bbb; }
/* Grid-only toggle -- the up/down/new badge never renders in the table
   view at all (see rankingTableRows), so this pill is hidden whenever the
   Grid/Table switch is on Table (see the [hidden] boolean attribute set in
   enableViewToggle). Desktop collapses it entirely; the mobile override
   below (inside the max-width query) turns this back into
   visibility:hidden instead, so on a phone it still reserves its own box
   rather than shifting the Min Games/Max RD controls sitting next to it. */
.rank-delta-toggle[hidden] { display: none; }
/* Two separate elements share the .download-btn hook/behavior classes
   (see writeJs, which wires both up identically) but only one is ever
   visible at a given viewport width: .download-btn-boxed is the original
   labeled button living inside the Power Rankings tab-controls row
   (desktop); .download-btn-icon is a plain icon-only control in
   .page-title-row, top-right, next to .tabs-toggle (mobile) -- it needs to
   stay reachable regardless of whether the mobile Options panel is
   collapsed, which the boxed version inside that panel can't guarantee. */
.download-btn[hidden] { display: none; }
.download-btn:disabled { cursor: default; opacity: 0.85; }
/* Spinner swaps in for .download-icon while generating -- see the
   downloadBtn click handler in enableViewToggle, which toggles .loading
   (and briefly .success once the export finishes) and disables the button
   for the duration so a second click can't kick off a concurrent export
   mid-generation. Path is a ~300 degree open ring (not a full circle) so
   the rotation itself reads as motion. .download-icon/.download-spinner/
   .download-check are wrapped in a shared .download-icon-slot grid cell
   (see downloadIconSlotHtml in aggregate_players.js) so switching between
   them cross-fades instead of popping -- the slot's data-state
   ('idle'/'loading'/'success') picks which one shows. The bare, unwrapped
   .csv-download-btn instances (synchronous exports that never enter a
   loading state) keep the plain display:none spinner below untouched. */
.download-spinner { display: none; flex-shrink: 0; animation: download-spin 0.7s linear infinite; }
@keyframes download-spin { to { transform: rotate(360deg); } }
.download-icon-slot { position: relative; display: inline-grid; }
.download-icon-slot > * { grid-area: 1 / 1; }
.download-icon-slot .download-icon,
.download-icon-slot .download-spinner {
  display: block;
  opacity: 0;
  filter: blur(var(--icon-swap-blur));
  transform: scale(var(--icon-swap-start-scale));
  transition: opacity var(--icon-swap-dur) var(--icon-swap-ease), filter var(--icon-swap-dur) var(--icon-swap-ease), transform var(--icon-swap-dur) var(--icon-swap-ease);
}
.download-icon-slot[data-state="idle"] .download-icon,
.download-icon-slot[data-state="loading"] .download-spinner {
  opacity: 1;
  filter: blur(0);
  transform: scale(1);
}
.download-check { color: #3eff8b; }
@media (prefers-reduced-motion: reduce) {
  .download-icon-slot .download-icon,
  .download-icon-slot .download-spinner { transition: none !important; }
}
.download-btn-boxed { display: inline-flex; align-items: center; gap: 0.4rem; margin-left: auto; background: #111; border: 1px solid #333; border-radius: 3px; color: #aaa; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.35rem 0.9rem; cursor: pointer; transition: border-color 150ms, color 150ms; }
.download-btn-boxed:hover { border-color: #3eff8b; color: #3eff8b; }
.download-btn-boxed.failed { border-color: #ff5c5c; color: #ff5c5c; }
.download-btn-boxed .download-icon, .download-btn-boxed .download-spinner, .download-btn-boxed .download-check { width: 14px; height: 14px; flex-shrink: 0; }
.download-btn-icon { display: none; align-items: center; justify-content: center; flex-shrink: 0; background: none; border: none; padding: 0; margin: 0; color: #aaa; cursor: pointer; transition: color 150ms; }
.download-btn-icon:hover { color: #3eff8b; }
.download-btn-icon.failed { color: #ff5c5c; }
.download-btn-icon .download-icon, .download-btn-icon .download-spinner, .download-btn-icon .download-check { width: 20px; height: 20px; flex-shrink: 0; }
/* Success check: plays once when a PNG export finishes (see the downloadBtn
   click handler), stacked in the same .download-icon-slot cell as the
   other two icons above. Durations/distances are scaled down from the
   transitions-dev catalog defaults (500ms/40px) to suit a 14-20px button
   icon instead of a full-size confirmation graphic. */
.t-success-check { display: inline-block; transform-origin: center; opacity: 0; will-change: transform, opacity, filter; }
.t-success-check svg { display: block; overflow: visible; width: 100%; height: 100%; }
.t-success-check svg path { stroke-dasharray: 15; stroke-dashoffset: 15; }
.t-success-check[data-state="in"] {
  animation:
    t-check-fade   var(--check-opacity-dur) var(--check-ease-opacity) forwards,
    t-check-rotate var(--check-rotate-dur)  var(--check-ease-rotate)  forwards,
    t-check-blur   var(--check-blur-dur)    var(--check-ease-out)     forwards,
    t-check-bob    var(--check-bob-dur)     var(--check-ease-bob)     forwards;
}
.t-success-check[data-state="in"] svg path {
  animation: t-check-draw var(--check-path-dur) var(--check-ease-path) var(--check-path-delay, 0ms) forwards;
}
@keyframes t-check-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes t-check-rotate { from { transform: rotate(var(--check-rotate-from)); } to { transform: rotate(0deg); } }
@keyframes t-check-blur { from { filter: blur(var(--check-blur-from)); } to { filter: blur(0); } }
@keyframes t-check-bob { from { translate: 0 var(--check-y-amount); } to { translate: 0 0; } }
@keyframes t-check-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .t-success-check { animation: none !important; opacity: 1; }
  .t-success-check svg path { animation: none !important; stroke-dashoffset: 0 !important; }
}
.map-legend { display: flex; align-items: center; gap: 0.5rem; color: #888; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.map-legend-swatch { display: inline-block; width: 90px; height: 10px; border-radius: 2px; background: linear-gradient(to right, hsl(150, 70%, 16%), hsl(150, 70%, 60%)); border: 1px solid #333; }
/* Fixed 2:1 column split (not flex-grow based) so the map's box never
   resizes when the sidebar's content changes — the sidebar is always
   present (full unfiltered list by default, filtered to a region on
   click), never toggling in/out of layout the way it briefly did before.
   No max-width: map + list together fill the same full content width as
   every other tab's table. */
.map-panel { display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; }
.map-canvas { min-width: 0; }
/* Fixed pixel height (not width-relative "auto") so the map never changes
   size — only its width, via the 4fr column, flexes with viewport width. */
.map-svg { width: 100%; height: 600px; display: block; cursor: grab; }
.map-svg.dragging { cursor: grabbing; }
.map-region { fill: rgba(255, 255, 255, 0.05); stroke: #050505; stroke-width: 0.75; transition: fill 200ms ease, stroke 150ms ease; cursor: pointer; }
.map-region:hover { stroke: #3eff8b; stroke-width: 1.5; }
.map-region.selected { stroke: #3eff8b; stroke-width: 2; }
.map-label { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; fill: #eee; text-anchor: middle; dominant-baseline: middle; pointer-events: none; paint-order: stroke; stroke: #000; stroke-width: 2px; stroke-linejoin: round; }
/* Deliberately no card box (background/border) — matches the plain,
   unboxed section + list look used on player pages (see .tourney-section),
   not a bordered "widget" look. */
.map-sidebar { min-width: 0; height: 600px; display: flex; flex-direction: column; }
.map-sidebar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; border-bottom: 1px solid #222; padding-bottom: 0.4rem; margin-bottom: 0.75rem; flex-shrink: 0; }
.map-sidebar-back { background: none; border: none; color: #3eff8b; font-family: 'Rajdhani', sans-serif; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 0; cursor: pointer; flex-shrink: 0; }
.map-sidebar-back:hover { text-decoration: underline; }
.map-sidebar-title { margin: 0; font-family: 'Rajdhani', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #3eff8b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-sidebar-empty { color: #555; font-size: 0.88rem; padding: 0.4rem 0; }
.map-sidebar-list { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
/* Name truncation is normally keyed off nth-child(2) (see .standings-list li
   > span:nth-child(2) above), which assumes every row starts with a
   standings-rank span — the map sidebar's tournament rows don't have one,
   so truncation is pinned to the class directly instead of row position. */
.hist-tourney-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Bigger than the player-page default (this list is the sidebar's main
   content, not a secondary history section) — scoped to the map sidebar
   only so player pages' own lists are untouched. */
.map-sidebar-list .hist-tourney-name { font-size: 1.05rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 1rem; }
#rankings-tab table { user-select: none; }
th, td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #1a1a1a; text-align: left; vertical-align: middle; }
/* z-index needed now that .rank-delta badges (absolutely positioned,
   protruding above their row) exist in tbody -- without it, a sticky th
   (DOM-order stacking, no z-index of its own) paints *behind* a scrolled-up
   row's overflowing content instead of covering it. */
th { cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; background: #111; color: #666; font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid #222; }
th:hover { background: #181818; color: #f0f0f0; }
th.no-sort { cursor: default; }
th.no-sort:hover { background: #111; color: #666; }
th.sorted-asc::after { content: " \\25B2"; }
th.sorted-desc::after { content: " \\25BC"; }
tbody tr { transition: background 150ms; }
tbody tr:hover td { background: rgba(62,255,139,0.04); }
tbody tr:hover td:first-child { box-shadow: inset 2px 0 0 #3eff8b; }
.rank-num { position: relative; font-family: 'Orbitron', monospace; color: #666; text-align: right; min-width: 2rem; font-size: 0.85rem; font-weight: 900; }
/* Rating-change corner badge: grid-cards only (see rankDeltaHtml's call
   sites — the table row never even emits this markup). Shown by default
   (see the "show" button's initial "active" class + #rankings-tab's
   initial show-rank-delta class in writeHtml()); the rank-delta-toggle pill
   can still switch it off. left: max(1em, 50%) + translateX(-50%) centers
   the badge directly above the rank number's own box for wide (multi-digit)
   ranks, same as plain left:50% would -- but for a narrow single-digit rank
   whose own box is well under 2em wide, 50% alone would let the badge
   drift left almost to the card's edge, so the max() floors the anchor at
   1em from .prc-rank's own left edge (~= the card's left edge, since
   .prc-rank sits right at the card's padded content start) instead of
   letting it keep shrinking with the digit. Both sides are resolved against
   the positioned ancestor's own box, so this stays correct no matter how
   wide the rank digits render in whatever font is active at paint time
   (fallback vs. Orbitron), with no JS remeasurement needed. Deliberately
   overflowing (absolute, off the top) rather than reserving space, so it
   never changes a card's size. background is kept at 0 opacity rather than
   removed outright -- easy to dial back up if bare colored text over a
   card's own background turns out to be hard to read. All three variants
   (up/down/new) sit at the same top offset -- a down badge floating below
   the number instead just read as detached from it, so direction is
   conveyed by the arrow glyph/color alone, not position. rank-plain holds
   just the numeral so JS renumbering (filtering/sorting) can overwrite it
   without clobbering the badge above it — see the .prc-rank query
   selectors in writeJs(). Zero rating change (or no prior snapshot to
   compare against) renders nothing at all. */
.rank-delta { display: none; position: absolute; left: max(1em, 50%); top: calc(-0.8em - 4px); transform: translateX(-50%); background: rgba(0,0,0,0); border-radius: 2px; padding: 0 3px; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.66em; line-height: 1.5; white-space: nowrap; }
/* .show-rank-delta is not scoped to #rankings-tab specifically -- the same
   class is stamped directly onto downloadRankingsImage's offscreen export
   clone (a plain child of <body>, not a descendant of #rankings-tab) when
   the live toggle is on, so an exported PR image matches whatever the
   on-page toggle was showing at click time. */
.show-rank-delta .rank-delta { display: block; }
.rank-delta-up { color: #3eff8b; }
.rank-delta-down { color: #ff5c5c; }
.rank-delta-new { color: #b04fff; }
/* The rank number itself picks up the same up/down/new color as its badge
   (rank-plain-<state>, set alongside rankDeltaHtml's call in writeHtml() --
   both read rankDeltaState so they can never disagree), but only while the
   toggle actually has badges showing; otherwise the number would silently
   keep broadcasting direction even after the delta's been hidden. */
.show-rank-delta .rank-plain-up { color: #3eff8b; }
.show-rank-delta .rank-plain-down { color: #ff5c5c; }
.show-rank-delta .rank-plain-new { color: #b04fff; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.col-location { white-space: nowrap; }
.loc-flag { height: 1em; vertical-align: middle; margin-right: 0.35em; border-radius: 1px; }
.loc-venue { color: #f0f0f0; font-weight: 700; }
.loc-citystate { color: #888; }
.loc-sep { color: #444; margin: 0 0.4em; }
.tourney-loc { display: flex; align-items: center; }
.uncertain { opacity: 0.45; }
.filter-dim { opacity: 0.45; }
/* The Grid/Table switch already animates its own sliding pill indicator
   (.view-toggle-indicator); without this, the content underneath it used to
   pop instantly on the same click, undercutting that motion. Reuses the
   same display:none-to-block re-trigger trick as .tab-panel.active above --
   scoped to #rankings-tab specifically so it never touches other tables. */
.pr-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; animation: t-panel-fade-in var(--duration-fast) var(--ease-in-out); }
#rankings-tab table { animation: t-panel-fade-in var(--duration-fast) var(--ease-in-out); }
@media (prefers-reduced-motion: reduce) {
  .pr-grid, #rankings-tab table { animation: none !important; }
}
.pr-card { background: #0f0f0f; border: 1px solid #222; border-radius: 0; padding: 3px 6px; display: flex; flex-direction: column; gap: 2px; min-width: 0; transition: border-color 150ms, background 150ms; user-select: none; }
.pr-card.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%); }
.pr-card.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%); }
.pr-card.card-green:hover { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.38) 0%, #181818 65%); border-color: rgba(62,255,139,0.65); }
.pr-card.card-purple:hover { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.38) 0%, #181818 65%); border-color: rgba(176,79,255,0.6); }
.pr-card.uncertain { opacity: 1; }
.pr-card.filter-dim { opacity: 1; }
.pr-card.filter-dim.card-green, .pr-card.filter-dim.card-purple,
.pr-card.uncertain.card-green, .pr-card.uncertain.card-purple { background: #000; }
.pr-card.filter-dim.card-green:hover, .pr-card.filter-dim.card-purple:hover,
.pr-card.uncertain.card-green:hover, .pr-card.uncertain.card-purple:hover { background: #0a0a0a; border-color: #333; }
/* .prc-rank sits directly in this flex row (not wrapped with the name in a
   sub-container) specifically so .rank-delta, which pokes up/down past
   .prc-rank's own box, isn't clipped by an ancestor's overflow:hidden --
   .prc-name carries its own overflow/min-width for ellipsis truncation, so
   the old wrapper wasn't needed for that either. */
.prc-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.prc-rank { position: relative; font-family: 'Orbitron', monospace; font-size: 1.2rem; color: #888; font-weight: 900; flex-shrink: 0; line-height: 1; }
/* flex: 1 1 0 (not the default 0 1 auto) so this box's width comes purely
   from available flex-row space, not from its own text's content width —
   otherwise shrinking the font also shrinks the box being measured against,
   and fitText() in index.js can converge on a false "it fits" reading before
   the text actually does. */
.prc-name { flex: 1 1 0; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; line-height: 18px; font-weight: 700; color: #f0f0f0; overflow: hidden; text-overflow: clip; white-space: nowrap; min-width: 0; position: relative; top: 1px; }
/* width is fixed (not auto) so this box's footprint is known before the
   (external, async-loaded) flag image itself has actually loaded — otherwise
   the row lays out too wide the first time fitCardNames() runs (on load,
   pre-image-load), then reflows narrower once the image arrives with no
   further re-fit, leaving names under-shrunk until something else (e.g. the
   grid/table view toggle) happens to re-trigger fitCardNames(). */
.prc-flag { height: 1.15em; width: 1.5em; object-fit: contain; border-radius: 2px; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.6); }
.prc-stats { display: flex; align-items: baseline; gap: 2px; }
.prc-loc-abbr { font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; font-weight: 700; color: #777; letter-spacing: 0.04em; margin-left: auto; padding-left: 4px; flex-shrink: 0; }
.prc-val { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; color: #aaa; }
.prc-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 600; color: #444; }
.prc-sep { font-size: 0.75rem; color: #333; font-family: 'Rajdhani', sans-serif; font-weight: 600; margin: 0 1px; }
/* Positioned so its four corners land one row up from where cards 43-46
   (top edge) and 91-94 (bottom edge) would fall in the 8-column grid (row =
   floor(index/8)+1, col = index%8+1) — this only lines up at the 8-column
   breakpoint, so it's hidden below that rather than recomputed per
   breakpoint. The download export clone forces 8 columns and re-shows it
   inline regardless of viewport (see downloadRankingsImage). */
/* Height is pinned to exactly 7 native card rows (7 * 45.6px card height +
   6 * 5px grid row-gap = 349.2px, measured live) rather than left to grow
   with content -- letting it grow taller stretches the grid's row tracks,
   which also stretches every other card sharing those rows. box-sizing:
   border-box so padding/border count inside that height; overflow:hidden
   is a clip guard, not the primary fit mechanism -- inner content is sized
   to actually fit, verified against the real 7-row height via screenshots
   rather than computed on paper (font metrics don't add up cleanly by hand). */
/* position:relative so .pr-square-mascot (an absolutely positioned direct
   child) sits relative to the square itself -- without this, since no
   other ancestor is positioned on the live page (and the export clone's
   ancestor is position:fixed), the mascot falls back to the initial
   containing block and renders miles away from the square. */
/* Hidden on the live site -- it only ever shows up in the downloaded image
   (downloadRankingsImage clones it and explicitly overrides this back to
   flex for the export). */
.pr-square { display: none; position: relative; grid-column: 3 / 7; grid-row: 5 / 12; height: 349.2px; box-sizing: border-box; background: #0a0a0a; border: 1px solid #3eff8b; padding: 10px 14px; flex-direction: column; gap: 1em; user-select: none; box-shadow: 0 0 24px rgba(62,255,139,0.15); overflow: hidden; }
.pr-square-title { display: flex; align-items: center; justify-content: center; gap: 8px; font-family: 'Orbitron', monospace; font-weight: 900; font-size: 1.6rem; color: #fff; letter-spacing: 0.05em; text-align: center; white-space: nowrap; flex: none; }
.pr-square-logo { height: 1.6em; width: auto; }
.pr-square-row { display: flex; gap: 16px; flex: 1; min-height: 0; }
/* Breathing room above the second row so it doesn't butt against the first. */
.pr-square-row-2 { margin-top: 2em; position: relative; }
/* Percentage-based (not fixed px) so it stays roughly between the stats and
   the tagline whether measured on the live responsive grid or the download
   export's fixed-width clone, which render the square at different pixel
   widths. Sits in the empty gap between the two flex columns via absolute
   positioning so it doesn't participate in / disturb their flex sizing. */
.pr-square-mascot { position: absolute; bottom: 0; left: 50%; width: 15%; object-fit: contain; pointer-events: none; }
.pr-square-col { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
/* "How to read a card" only needs to fit the demo card + callouts, so it
   shrinks to content; "how rankings are determined" gets the extra space. */
.pr-square-col-card { flex: 0 0 auto; }
.pr-square-col-text { flex: 1 1 0; }
/* Right-aligned and non-growing so the tagline sits close to the QR code
   next to it instead of centered in its own wide flex share. */
.pr-square-col-tagline { flex: 0 1 auto; align-items: flex-end; }
.pr-square-label { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.68rem; letter-spacing: 0.07em; text-transform: uppercase; color: #666; }
.pr-square-text { font-family: 'Rajdhani', sans-serif; font-size: 0.74rem; color: #999; line-height: 1.3; }
.pr-square-example { pointer-events: none; width: 210px; flex: none; }
.pr-square-callouts { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.pr-square-callout { font-family: 'Rajdhani', sans-serif; font-size: 0.66rem; color: #666; }
.pr-square-callout b { color: #aaa; }
.pr-square-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.pr-square-qr { width: 78px; height: 78px; display: flex; align-items: center; justify-content: center; }
.pr-square-qr img { width: 100%; height: 100%; object-fit: contain; }
.pr-square-qr-label { font-family: 'Rajdhani', sans-serif; font-size: 0.6rem; color: #666; letter-spacing: 0.04em; text-transform: uppercase; }
/* Grid (not flex) so three stat tiles are guaranteed to fit within the
   column's own width instead of overflowing into the next column when
   their combined natural width exceeds it. */
.pr-square-stats { display: grid; grid-template-columns: 4em 4em 4em; gap: 3em; }
.pr-square-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pr-square-stat-num { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 1.05rem; color: #3eff8b; line-height: 1; }
.pr-square-stat-label { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.55rem; letter-spacing: 0.02em; text-transform: uppercase; color: #666; }
/* Outer gap separates independent label+item(s) groups (e.g. "Next
   Tournament" vs "Latest Tournament"); each group's own inner gap (below)
   stays tight since a label sits directly above its own item(s). */
.pr-square-latest { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pr-square-latest-group { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pr-square-latest-item { font-family: 'Rajdhani', sans-serif; font-size: 0.66rem; color: #999; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-square-tagline { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 0.95rem; color: #fff; line-height: 1.35; text-align: right; overflow-wrap: break-word; }
.pr-square-footer { font-family: 'Rajdhani', sans-serif; font-size: 0.62rem; color: #555; text-align: left; flex: none; }
/* Off-screen clone target used by downloadRankingsImage — not display:none
   (html2canvas needs real layout) so it's shoved out via position instead. */
.pr-export-grid { position: fixed; top: 0; left: -10000px; z-index: -1; }
@media (max-width: 1100px) { .pr-grid { grid-template-columns: repeat(4, 1fr); } .pr-square { display: none; } }
@media (max-width: 600px) { .pr-grid { grid-template-columns: repeat(2, 1fr); } body { padding: 1rem; } }
.events-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
@media (max-width: 1100px) { .events-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 700px) { .events-grid { grid-template-columns: 1fr; } }
/* --eh/--es/--el default to the site's amber (hsl(36,100%,65%) ~= #ffb74d)
   via each var()'s fallback argument; an event's "color" field in
   upcoming-events.json overrides them via an inline style on .event-card
   (see parseHsl/buildEventsTabHtml) instead of needing a separate CSS class
   per hue. */
.event-card { display: flex; flex-direction: column; gap: 6px; background: radial-gradient(ellipse at 20% 0%, hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.16) 0%, #0f0f0f 70%); border: 1px solid hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.4); border-radius: 0; padding: 1.1rem 1.3rem; text-decoration: none; box-shadow: 0 0 18px hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.08); transition: border-color 150ms, background 150ms, box-shadow 150ms, transform 150ms; }
.event-card:hover { border-color: hsl(var(--eh, 36), var(--es, 100%), var(--el, 65%)); background: radial-gradient(ellipse at 20% 0%, hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.3) 0%, #181818 70%); box-shadow: 0 0 28px hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.2); text-decoration: none; transform: translateY(-2px); }
/* A linkless event renders as a <div> (see buildEventsTabHtml) -- drop the
   hover lift/pointer affordance so it doesn't read as clickable. */
.event-card.no-link:hover { transform: none; cursor: default; }
/* Only cards with a logo (has-image) split into columns -- imageless cards
   stay a plain single-column block so there's no empty 2/5 gap. */
.event-card.has-image { flex-direction: row; align-items: center; gap: 14px; }
.event-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 3 1 0; }
.event-image-wrap { flex: 2 1 0; display: flex; align-items: center; justify-content: center; min-width: 0; height: 100%; }
.event-image { max-width: 100%; max-height: 100px; object-fit: contain; }
.event-date { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 0.95rem; letter-spacing: 0.04em; color: hsl(var(--eh, 36), var(--es, 100%), var(--el, 65%)); text-transform: uppercase; }
.event-name { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.3rem; color: #fff; line-height: 1.2; }
.event-description { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #bbb; line-height: 1.3; }
.event-venue { display: flex; align-items: center; gap: 6px; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #999; }
.events-footer { font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; color: #666; text-align: center; margin-top: 1.5rem; letter-spacing: 0.03em; }
.events-empty { font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; color: #888; text-align: center; padding: 3rem 0; }
.doubles-pill { display: inline-block; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: #b04fff; border: 1px solid rgba(176,79,255,0.5); border-radius: 3px; padding: 1px 7px; margin-left: 6px; vertical-align: middle; }
/* Player-page "w/ <partner>" pill -- the partner's name is a real link, so
   it keeps its own casing (uppercase would obscure/mangle it) and stays
   unstyled-as-a-link until hover, matching the pill's own color scheme
   instead of the browser-default blue/underline. */
.doubles-pill.doubles-pill-plain { text-transform: none; letter-spacing: 0.01em; }
.doubles-pill.doubles-pill-plain a { color: inherit; text-decoration: none; }
.doubles-pill.doubles-pill-plain a:hover { text-decoration: underline; }
/* align-items: start keeps each card sized to its own content -- without
   it, CSS Grid's default row-stretch makes every card in a row match the
   tallest one, which matters here since a player-page doubles card's height
   varies with how many tournaments it lists (see .doubles-card .standings-list
   below), unlike the Doubles tab's uniform two-line cards. */
/* auto-fit (not a fixed repeat(3, 1fr)) so the column count always derives
   from the actual container's width, not the viewport's -- this covers both
   the full-width Doubles tab and h2h's own narrow 1-of-3 column on mixed
   player pages, where a lone card (or a trailing odd one) stretches to
   fill its row instead of sitting in a narrow track beside empty ones,
   since auto-fit collapses tracks with no content rather than reserving
   space for them the way a fixed column count would. The min() wrapped
   around the minmax minimum keeps a single column from overflowing a
   container narrower than 380px (e.g. a phone screen) -- minmax's own
   minimum can't shrink below itself, only its maximum can, so without
   min() a narrow-enough container would force a horizontal scrollbar
   instead of the card just shrinking to fit. */
.doubles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 20px; align-items: start; }
/* Doubles-only players' 2-of-3-column-wide area (.doubles-only-grid) wants
   the opposite of auto-fit's collapsing behavior: a lone card should stay
   at 1-column width with visible empty space beside it (matching a normal
   card's size elsewhere on the site), not stretch to fill both columns --
   so this overrides the base rule with a genuinely fixed 2-track grid
   instead. */
.doubles-only-grid .doubles-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 700px) { .doubles-only-grid .doubles-grid { grid-template-columns: 1fr; } }
.doubles-card { display: flex; flex-direction: column; gap: 8px; background: #0f0f0f; border: 1px solid #222; border-radius: 0; padding: 1.1rem 1.3rem; transition: border-color 150ms, background 150ms; }
.doubles-card.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%); }
.doubles-card.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%); }
.doubles-card.card-green:hover { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.38) 0%, #181818 65%); border-color: rgba(62,255,139,0.65); }
.doubles-card.card-purple:hover { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.38) 0%, #181818 65%); border-color: rgba(176,79,255,0.6); }
/* Doubles tab only: a team's registered nickname shown inline before its
   two player names on the same line (e.g. "Team Ramrod: zachaction &
   Evan") rather than its own stacked line above them -- keeps every card's
   name area exactly one line regardless of whether a nickname is on file,
   so cards in the tab's dense grid line up evenly. */
.doubles-card-team { color: #aaa; margin-right: 0.15em; }
/* Player pages' Doubles Teams section (.doubles-col) shows one card per
   partner rather than a dense grid of every team on the site, so the
   nickname keeps its own bigger stacked line above the players there. */
.doubles-card-nickname { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.05rem; letter-spacing: 0.02em; color: #ccc; }
.doubles-card-names { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.2rem; color: #fff; line-height: 1.3; }
.doubles-card-names a { color: #fff; }
.doubles-card-names a:hover { color: #3eff8b; }
.doubles-amp { color: #666; font-weight: 400; }
.doubles-card-stats { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #999; display: flex; align-items: center; gap: 8px; }
.doubles-sep { color: #444; }
.doubles-empty { font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; color: #888; text-align: center; padding: 3rem 0; }
/* Player page Doubles section reuses .doubles-grid itself (not just
   .doubles-card), so multiple partner cards can lay out side by side
   within h2h's own column (see .player-grid.has-doubles) exactly like the
   Doubles tab, rather than always stacking one per row. Each card also
   carries its own per-tournament list, so it needs a bit more internal
   spacing than the tab's plain stat line. */
.doubles-card .standings-list { margin-top: 0.5rem; }
.back-link { display: inline-block; color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 1rem; }
.back-link:hover { color: #3eff8b; }
.tourney-meta { display: flex; align-items: center; gap: 1.25rem; color: #888; font-size: 1.05rem; margin: -1rem 0 0.5rem; }
.tourney-meta a { margin: 0; }
.ext-link { font-size: 0.8rem; margin-left: 0.4rem; opacity: 0.7; }
.source-pills { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; }
.source-pill { display: inline-flex; align-items: center; gap: 5px; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.01em; padding: 3px 10px; border-radius: 3px; text-decoration: none; border: 1px solid transparent; transition: background-color 0.15s ease; }
.source-pill img, .source-pill svg { width: 14px; height: 14px; flex-shrink: 0; }
.source-pill img { border-radius: 2px; }
.source-pill-challonge { color: #f96332; border-color: rgba(249, 99, 50, 0.5); }
.source-pill-challonge:hover { background: rgba(249, 99, 50, 0.15); }
.source-pill-startgg { color: #3f80ff; border-color: rgba(63, 128, 255, 0.5); }
.source-pill-startgg:hover { background: rgba(63, 128, 255, 0.15); }
.source-pill-youtube { color: #ff4d4d; border-color: rgba(255, 0, 0, 0.5); }
.source-pill-youtube:hover { background: rgba(255, 0, 0, 0.15); }
.source-pills .doubles-pill { margin-left: 0; font-size: 0.85rem; padding: 3px 10px; }
.tourney-section { margin-bottom: 2rem; }
.tourney-section h2 { font-family: 'Rajdhani', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #3eff8b; border-bottom: 1px solid #222; padding-bottom: 0.4rem; margin-bottom: 0.75rem; }
/* Rating-over-time chart (player pages). Fixed pixel height with a
   viewBox-scaled SVG, same "never resize the plot itself" approach as the
   map's .map-svg — only the wrap's width flexes with the page. */
/* Chart gets the same "mostly opaque" translucent card look as the
   stat-tile/h2h-tile cards elsewhere on the page — see those for the same
   background/border/blur values. */
.rating-chart-wrap { width: 100%; background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 1.5rem 1.5rem 0.75rem; box-sizing: border-box; }
/* The svg and its label/tooltip overlays are positioned as siblings inside
   this unpadded inner box, not directly inside .rating-chart-wrap — every
   label's top/left is a percentage of the SVG's own H/W, and percentage
   offsets on an absolutely-positioned element resolve against its
   containing block's padding box, so that only lines up if this box has no
   padding of its own. .rating-chart-wrap's padding is what actually keeps
   the chart from butting up against the card edges. */
.rating-chart-inner { position: relative; width: 100%; height: 220px; }
.rating-chart { width: 100%; height: 100%; display: block; overflow: visible; }
.chart-grid { stroke: #1a1a1a; stroke-width: 1; }
.chart-line { fill: none; stroke: #3eff8b; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart-dot { fill: #3eff8b; stroke: #050505; stroke-width: 1.5; pointer-events: none; transition: r 120ms ease; }
.chart-hit { fill: transparent; cursor: pointer; }
/* Axis/date/current-value labels are HTML overlays (not SVG <text>), pinned
   to the inner box's edges via CSS percentages — the SVG itself uses
   preserveAspectRatio="none" so the plot fills the column's full width
   without side letterboxing, and non-uniform x/y scaling of embedded SVG
   text would visibly stretch it. Sizing these as HTML instead keeps the
   labels crisp and lets them be sized larger independent of that scaling. */
.chart-label { position: absolute; font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 600; color: #888; pointer-events: none; white-space: nowrap; }
.chart-label-y { left: 0; transform: translateY(-50%); }
.chart-label-date-start { left: 0; bottom: -0.6rem; }
.chart-label-date-end { right: 0; bottom: -0.6rem; }
/* Anchored via "right" (not "left") so the label grows leftward off the
   last point instead of rightward past the edge of the chart. Nudged up an
   extra few px past the plain -100% flip so it doesn't sit flush against
   the point/line it's labeling. */
.chart-label-current { font-family: 'Orbitron', monospace; font-size: 1rem; font-weight: 700; color: #3eff8b; transform: translateY(calc(-100% - 5px)); }
.chart-point:focus { outline: none; }
.chart-point:focus .chart-dot, .chart-point:hover .chart-dot { r: 5.5; }
/* Positioned in JS against the inner box's own rect (not the viewport), so
   it tracks correctly regardless of how the SVG's preserveAspectRatio scales
   the underlying viewBox coordinates to the box's actual rendered size. */
/* Tooltip open/close, adapted from the transitions-dev catalog: default
   rule (data-show="false"/absent) controls the LEAVE state -- no delay, so
   hiding plays immediately -- while the [data-show="true"] rule adds the
   appear delay. left/top always transition on --tt-move-dur regardless of
   data-show, so the bubble travels smoothly between points instead of
   popping to the next one (see the mousemove nearest-point handler in
   aggregate_players.js, which now snaps position only on the first show
   after being hidden). scale is a standalone property (not part of the
   positioning transform above it) so the pop-in doesn't fight the
   translate used to anchor the tooltip above its point. */
.chart-tooltip {
  position: absolute;
  transform: translate(-50%, -100%) translateY(-10px);
  scale: var(--tt-scale);
  transform-origin: 50% 100%;
  background: #111; border: 1px solid #333; border-radius: 3px; padding: 0.4rem 0.6rem; font-size: 0.8rem; line-height: 1.4; color: #ddd; white-space: nowrap; pointer-events: none; z-index: 2;
  opacity: 0;
  transition:
    opacity var(--tt-out-dur) var(--tt-out-ease),
    scale   var(--tt-out-dur) var(--tt-out-ease),
    left    var(--tt-move-dur) var(--tt-move-ease),
    top     var(--tt-move-dur) var(--tt-move-ease);
}
.chart-tooltip[data-show="true"] {
  opacity: 1;
  scale: 1;
  transition:
    opacity var(--tt-in-dur) var(--tt-in-ease) var(--tt-delay),
    scale   var(--tt-in-dur) var(--tt-in-ease) var(--tt-delay),
    left    var(--tt-move-dur) var(--tt-move-ease),
    top     var(--tt-move-dur) var(--tt-move-ease);
}
.chart-tooltip strong { color: #3eff8b; }
@media (prefers-reduced-motion: reduce) {
  .chart-tooltip { transition: none !important; }
}
/* Standings and the bracket/round list side by side — a narrow standings
   list otherwise leaves most of the page empty next to it. The bracket
   column has no fixed width (min-width:0 lets it shrink below its content's
   natural size); brackets-viewer already scrolls itself horizontally (see
   its own overflow:auto), so a wide bracket scrolls in place instead of
   forcing the columns apart. flex-wrap alone (no media query needed) drops
   the bracket to its own full-width row below standings once the viewport
   is too narrow for both to fit at a reasonable size. */
.tourney-columns { display: flex; align-items: flex-start; gap: 2.5rem; flex-wrap: wrap; }
.tourney-standings { flex: 0 0 240px; }
.tourney-matches { flex: 1 1 520px; min-width: 0; }
.round-group { margin-bottom: 2rem; }
.round-group h3 { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #666; margin: 0 0 0.4rem; }
.match-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid #161616; font-size: 0.95rem; }
.match-winner { font-weight: 700; color: #f0f0f0; }
.match-loser { color: #888; }
.match-score { font-variant-numeric: tabular-nums; color: #3eff8b; font-weight: 700; margin-left: auto; }
.match-dq { color: #ff5e5e; font-size: 0.8rem; }
/* Swiss cards: a grid of one card per match (3 per row), left player |
   score | right player -- left/right is decided the same way
   build_bracket.js decides top/bottom for a bracket match (a stable hash
   of the pairing, not win/loss), so a player isn't always shown on the
   same side just for having won. Neither name is bolded; only the score
   numbers are colored (green for whoever actually won, red for whoever
   lost), independent of which side they landed on. A 3-column grid (not
   flex) gives each side its own full-height cell -- padding included --
   so the hover highlight (.player-active, via setActivePlayer) can fill
   exactly that half of the card without touching the score or the other
   player. Names crowd toward the score (right player's name left-aligned,
   left player's right-aligned) with each side's flag at the outer edge --
   flagAfter (see nameHtml/teamNameHtml) flips the flag to trail the name
   for the right side so both flags land outermost instead of both
   clustering next to the score. */
.swiss-round-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem; }
.swiss-match-card { display: grid; grid-template-columns: 1fr auto 1fr; align-items: stretch; border: 1px solid #1a1a1a; border-radius: 4px; background: #0d0d0d; font-size: 0.95rem; overflow: hidden; }
.swiss-match-card .match-side { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f0f0f0; font-weight: 400; padding: 0.7rem 0.9rem; }
.swiss-match-card .match-side:first-child { text-align: right; }
.swiss-match-card .match-side:last-child { text-align: left; }
/* The base .loc-flag rule only ever adds margin-right (it assumes a flag
   always leads the name) -- on the right side the flag trails the name
   instead (flagAfter, see nameHtml), so its gap needs to flip to
   margin-left or the name and flag would sit flush against each other. */
.swiss-match-card .match-side:last-child img.loc-flag { margin-right: 0; margin-left: 0.35em; }
.swiss-match-card .match-score { display: flex; align-items: center; justify-content: center; gap: 0.25em; padding: 0.7rem 0.4rem; font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.swiss-match-card .score-win { color: #3eff8b; }
.swiss-match-card .score-loss { color: #ff5e5e; }
.swiss-match-card .score-sep { color: #555; }
.swiss-match-card .score-dq { color: #ff5e5e; }
.standings-list { list-style: none; margin: 0; padding: 0; counter-reset: none; }
.standings-list li { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.4rem 0.75rem; border-bottom: 1px solid #161616; cursor: pointer; transition: background-color 150ms ease; }
/* Texts reveal, adapted for a batch of list rows rather than a couple of
   headline lines: the "Show more" button (see its click handler below)
   marks each newly-revealed <li> with .t-stagger-line and an inline
   transition-delay per its index in the batch, then adds .is-shown a frame
   later so they rise in with a staggered blur instead of popping in as a
   block the instant [hidden] is cleared. */
.standings-list li.t-stagger-line {
  opacity: 0;
  transform: translateY(var(--stagger-distance));
  filter: blur(var(--stagger-blur));
  transition: opacity var(--stagger-dur) var(--stagger-ease), transform var(--stagger-dur) var(--stagger-ease), filter var(--stagger-dur) var(--stagger-ease), background-color 150ms ease;
}
.standings-list li.t-stagger-line.is-shown {
  opacity: 1;
  transform: translateY(0);
  filter: blur(0);
}
@media (prefers-reduced-motion: reduce) {
  .standings-list li.t-stagger-line { transition: background-color 150ms ease !important; }
}
.standings-rank { font-family: 'Orbitron', monospace; color: #666; font-weight: 900; min-width: 2rem; flex-shrink: 0; }
.standings-list li > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.standings-record { color: #777; font-variant-numeric: tabular-nums; margin-left: auto; flex-shrink: 0; white-space: nowrap; }
/* A doubles team with a registered nickname (e.g. "Team Ramrod") shown
   above its two player names -- overrides the plain single-line ellipsis
   truncation above with a 2-line stack, each line truncated on its own. */
.standings-list li > span.standings-name-stack { display: flex; flex-direction: column; gap: 0.1rem; white-space: normal; line-height: 1.3; }
.standings-team-name { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.92rem; letter-spacing: 0.03em; text-transform: uppercase; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.standings-team-players { color: #999; font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Synced with the bracket/crosstable/round-list: hovering or clicking a
   player anywhere highlights them everywhere (see setupPlayerInteractivity
   in the always-loaded player-interactivity head script). */
.standings-list li.player-active { background-color: rgba(62,255,139,0.12); }
.stage-label { font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #3eff8b; margin: 1.5rem 0 0.75rem; }
.stage-label:first-child { margin-top: 0; }
.bracket-incomplete-note { color: #ffb74d; font-size: 0.9rem; background: rgba(255,183,77,0.08); border: 1px solid rgba(255,183,77,0.3); border-radius: 3px; padding: 0.5rem 0.75rem; margin: 0 0 0.75rem; }
.crosstable-wrap { overflow-x: auto; }
.crosstable { border-collapse: collapse; font-size: 0.85rem; }
.crosstable th, .crosstable td { border: 1px solid #1a1a1a; padding: 0.4rem 0.6rem; text-align: center; white-space: nowrap; }
/* Player names are real names, not fixed column labels like the rest of the
   site's tables -- override the global uppercase th rule so they render in
   their actual casing. */
.crosstable th { background: #111; color: #f0f0f0; font-weight: 700; font-size: 0.78rem; letter-spacing: 0.04em; text-transform: none; cursor: pointer; }
.crosstable th.row-name { text-align: left; }
.crosstable td.cell-diag { background: #0a0a0a; }
.crosstable td.cell-empty { color: #333; }
/* Result label -- W/L/D plus the actual game score (the score used to be
   tooltip-only via the title attribute), plain colored text with no pill
   background. */
.crosstable-result { display: inline-flex; align-items: center; gap: 0.35em; font-weight: 700; font-variant-numeric: tabular-nums; }
.crosstable-result.cell-win { color: #3eff8b; }
.crosstable-result.cell-loss { color: #ff5e5e; }
.crosstable-result.cell-draw { color: #ccc; }
/* Hovering/clicking a player (row header, column header, or standings row)
   highlights their row-name th, every column th, and every cell of theirs
   -- i.e. all of their games in the crosstable -- via data-player/
   data-row-player/data-col-player attributes set in writeTournamentPages. */
.crosstable th.player-active, .crosstable td.player-active { background: rgba(62,255,139,0.16); }
/* Round-list entries and swiss cards get the same hover highlight on
   whichever name was hovered. */
.round-group .player-active { background-color: rgba(62,255,139,0.16); border-radius: 2px; }
/* Swiss's own .match-side is already a full-height, padded grid cell (see
   .swiss-match-card above) -- no radius of its own, so the card's outer
   border-radius plus overflow:hidden is what actually rounds the highlight
   at the card's edge instead of a mismatched inner corner mid-card. */
.swiss-match-card .player-active { border-radius: 0; }
h1 img.loc-flag { height: 0.75em; margin-right: 0.4em; }
.alias-list { color: #888; font-size: 0.9rem; }
/* 15-column grid so Record (3) + Goals (4) + the combined ranking card (6)
   + the Compare link tile (2) line up evenly across one row on wide screens. */
.player-stats-grid { display: grid; grid-template-columns: repeat(15, 1fr); gap: 0.75rem; }
.stat-span-2 { grid-column: span 2; }
.stat-span-3 { grid-column: span 3; }
.stat-span-4 { grid-column: span 4; }
.stat-span-6 { grid-column: span 6; }
@media (max-width: 700px) {
  .player-stats-grid { grid-template-columns: repeat(2, 1fr); }
  .stat-span-2, .stat-span-3, .stat-span-4, .stat-span-6 { grid-column: span 2; }
}
/* The Compare tile is a link styled as a stat tile: same card shell, icon
   stacked over an uppercase label, centered. It's an <a>, so the global
   green link color/underline is reset here and the whole card brightens on
   hover instead. */
.compare-tile { align-items: center; text-align: center; color: #888; text-decoration: none; gap: 0.4rem; transition: border-color 150ms ease, color 150ms ease; }
.compare-tile:hover { text-decoration: none; color: #f0f0f0; border-color: rgba(62,255,139,0.5); }
.compare-tile-icon { display: flex; }
.compare-tile-icon .h2h-icon { width: 24px; height: 24px; color: #3eff8b; }
.compare-tile-label { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
/* Per-opponent compare icon on Match Statistics tiles: pinned to the tile's
   top-right corner (the tile is position:relative for this), dim until
   hovered so it reads as a secondary action rather than part of the stat. */
.h2h-tile { position: relative; }
.h2h-compare { position: absolute; top: 0.55rem; right: 0.7rem; display: inline-flex; align-items: center; color: #555; transition: color 150ms ease; }
.h2h-compare:hover { color: #3eff8b; text-decoration: none; }
.h2h-compare .h2h-icon { width: 14px; height: 14px; }
/* --- Compare page (compare.html, see compare_page.js) ---
   Picker: selected players as chips (slot color dot + flag + linked name +
   remove), followed by the search input while there's room for another. */
.compare-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.5rem 0 1rem; }
.compare-chip { display: inline-flex; align-items: center; gap: 0.45rem; background: rgba(10,10,10,0.35); border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; padding: 0.4rem 0.5rem 0.4rem 0.7rem; font-size: 1.05rem; font-weight: 600; }
.compare-chip-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--chip-color, #3eff8b); box-shadow: 0 0 6px var(--chip-color, #3eff8b); flex-shrink: 0; }
.compare-chip .loc-flag { margin-right: 0; }
.compare-chip a { color: #f0f0f0; }
.compare-chip a:hover { color: #3eff8b; }
.compare-chip-remove { background: none; border: none; color: #666; font-size: 1.2rem; line-height: 1; padding: 0 0.2rem; cursor: pointer; font-family: inherit; transition: color 150ms ease; }
.compare-chip-remove:hover { color: #ff5e5e; }
.compare-search-wrap { position: relative; flex: 1 1 220px; max-width: 320px; }
.compare-search { width: 100%; box-sizing: border-box; background: #111; border: 1px solid #333; border-radius: 3px; color: #f0f0f0; font-family: inherit; font-size: 1rem; font-weight: 600; padding: 0.5rem 0.75rem; }
.compare-search:focus { outline: none; border-color: #3eff8b; }
.compare-search::placeholder { color: #555; font-weight: 500; }
/* Autocomplete list: same shell as the custom dropdown menus elsewhere on
   the site (.dd-menu), anchored under the search input. */
.compare-ac-list { position: absolute; top: 100%; left: 0; right: 0; margin-top: 3px; z-index: 60; display: none; background: #0f0f0f; border: 1px solid #333; border-radius: 3px; box-shadow: 0 12px 32px rgba(0,0,0,0.7); max-height: 320px; overflow-y: auto; padding: 4px; }
.compare-ac-list.visible { display: block; }
.compare-ac-item { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.4rem 0.75rem; border-radius: 2px; cursor: pointer; color: #bbb; }
.compare-ac-item.is-active { background: #1a1a1a; color: #fff; }
.compare-ac-name { font-weight: 700; font-size: 1rem; }
.compare-ac-meta { font-size: 0.8rem; color: #666; }
.compare-hint { color: #888; font-size: 0.95rem; margin: 0 0 1.5rem; }
/* Stats table: label column + one column per player. Global th rules make
   headers sticky-top and pointer-cursored for the sortable tables; neither
   applies here. The label column is sticky-left instead so it stays visible
   while the player columns scroll inside .table-wrap on narrow screens. */
.compare-table th { position: static; cursor: default; }
.compare-table th.compare-player-col { position: relative; min-width: 150px; padding-top: 0.9rem; text-transform: none; letter-spacing: 0.02em; font-size: 1.05rem; color: #f0f0f0; }
.compare-table th.compare-stat-col { width: 1%; }
.compare-col-bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--col-color, #3eff8b); box-shadow: 0 0 8px var(--col-color, #3eff8b); }
.compare-col-name { display: block; }
.compare-col-name a { color: #f0f0f0; }
.compare-col-name a:hover { color: var(--col-color, #3eff8b); }
.compare-col-sub { display: block; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; color: #666; margin-top: 0.1rem; }
.compare-table td { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.1rem; }
.compare-table td.compare-stat-label { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #666; white-space: nowrap; }
.compare-table td.compare-empty { color: #3a3a3a; font-weight: 500; }
.compare-table td.compare-best { color: #3eff8b; }
.compare-table .compare-note { display: block; font-size: 0.72rem; letter-spacing: 0.04em; color: #3eff8b; }
.compare-table th:first-child, .compare-table td:first-child { position: sticky; left: 0; z-index: 2; background: #050505; }
.compare-table tbody tr:hover td:first-child { background: #0a0a0a; }
.compare-intro { color: #888; font-size: 1.05rem; margin: -1rem 0 0.5rem; }
/* Chart legend (one entry per plotted player, in column color) above the
   shared .rating-chart-wrap shell; .chart-line/.chart-dot colors are set
   inline per series. */
.compare-legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; margin-bottom: 0.75rem; font-weight: 700; font-size: 1rem; }
.compare-legend-item { display: inline-flex; align-items: center; gap: 0.45rem; }
.compare-legend-item .compare-chip-dot { background: var(--col-color); box-shadow: 0 0 6px var(--col-color); }
/* A player's name tinted with their column color wherever it appears
   inside the Head-to-Head and Shared Tournaments sections. */
.compare-colored { color: var(--col-color, #3eff8b); font-weight: 700; }
.compare-colored:hover { color: #fff; }
.compare-subhead { font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #888; margin: 1.5rem 0 0.5rem; }
.compare-empty-note { color: #666; font-size: 0.95rem; margin: 0.25rem 0; }
/* Two-player record: name, big score, name. */
.compare-h2h-record { display: flex; align-items: center; justify-content: center; gap: 1.5rem; flex-wrap: wrap; padding: 1rem 0.5rem; background: rgba(10,10,10,0.35); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; }
.compare-h2h-side { font-size: 1.3rem; }
.compare-h2h-score { display: inline-flex; align-items: baseline; gap: 0.5rem; font-family: 'Orbitron', monospace; font-size: 2rem; font-weight: 900; color: #666; }
.compare-h2h-lead { color: #f0f0f0; }
.compare-h2h-dash { color: #444; font-size: 1.4rem; }
.compare-matrix th { cursor: default; position: static; }
.compare-matrix th.row-name { text-align: left; }
/* Common-opponents and shared-tournaments tables reuse .compare-table with
   a slimmer player header (no flag/location, just the color bar + name). */
.compare-table th.compare-player-col-compact { min-width: 110px; padding-top: 0.8rem; font-size: 0.95rem; }
.compare-table td.compare-opp-name { text-transform: none; letter-spacing: 0.02em; font-size: 1rem; color: #f0f0f0; white-space: nowrap; }
.compare-table td.compare-opp-name a { color: #f0f0f0; }
.compare-table td.compare-opp-name a:hover { color: #3eff8b; }
.compare-table td.compare-opp-name .compare-col-sub { margin-top: 0.15rem; }
.compare-common td.result-win { color: #3eff8b; }
.compare-common td.result-loss { color: #ff5e5e; }
.compare-shared td .compare-col-sub { font-weight: 600; }
.compare-shared td .compare-col-sub a { color: #888; }
@media (max-width: 700px) {
  /* Let the sticky label column wrap instead of claiming half the phone
     width with a single nowrap line; player columns keep their min-width
     and scroll inside .table-wrap. */
  .compare-table td.compare-stat-label { white-space: normal; max-width: 6.5rem; font-size: 0.72rem; line-height: 1.25; }
  .compare-table th.compare-player-col { min-width: 130px; }
  .compare-table .compare-note { white-space: nowrap; }
  .compare-search-wrap { flex-basis: 100%; max-width: none; }
}
.stat-tile { position: relative; background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 1rem 0.9rem; min-height: 5.5rem; display: flex; flex-direction: column; gap: 0.15rem; justify-content: center; }
.stat-value { font-family: 'Rajdhani', sans-serif; font-size: 1.4rem; font-weight: 700; color: #f0f0f0; }
.stat-label { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #666; }
.stat-sub { font-size: 1rem; font-weight: 700; color: #3eff8b; }
.stat-multi { display: flex; gap: 1.25rem; flex-wrap: wrap; row-gap: 0.4rem; }
/* Each stat grows (auto basis, so wrapping on narrow tiles still works) to
   share the tile's width, spreading the row across the card instead of
   clustering at the left with dead space on the right. */
.stat-multi > span { display: flex; flex-direction: column; gap: 0.15rem; flex: 1 1 auto; }
/* Positioned out of flow so a qualification note doesn't add a line to the
   stat-multi row it sits under — the tile's height (and every other item's
   vertical centering within it) stays identical whether or not the note is
   present, instead of the row growing/shifting when it appears. */
.stat-note { position: absolute; left: 0.9rem; right: 0.9rem; bottom: 0.6rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; color: #3eff8b; }
.rank-total { font-family: 'Rajdhani', sans-serif; font-size: 0.7rem; font-weight: 600; color: #666; }
/* Fixed width so "1st"/"21st" etc. don't shift the record that follows it. */
.rank-ordinal { display: inline-block; width: 2.8em; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.05rem; color: #f0f0f0; }
.player-columns { display: flex; gap: 2.5rem; flex-wrap: wrap; }
.player-col { flex: 1 1 300px; min-width: 0; }
/* Used instead of .player-columns when a rating chart is present: the chart
   takes the width of two columns (same as Matches+Tournaments together)
   with Match Statistics beside it, then Matches/Tournaments fill the row below
   — Match Statistics spans both rows so it "extends into" that lower row
   whenever its own content runs taller than the chart. */
.player-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-areas: "chart chart h2h" "matches tournaments h2h"; gap: 2.5rem; }
.chart-col { grid-area: chart; min-width: 0; }
.h2h-col { grid-area: h2h; min-width: 0; }
.matches-col { grid-area: matches; min-width: 0; }
.tournaments-col { grid-area: tournaments; min-width: 0; }
/* For a mixed player, the Doubles section is nested directly inside
   .h2h-col (right after Match Statistics) rather than being a grid item of
   its own, so it picks up its spacing from a margin here instead of
   .player-grid's inter-item gap the way a sibling grid cell would --
   .doubles-col's own grid-area only actually applies in .doubles-only-grid
   below. The "Doubles Teams" <h2>'s UA-default top margin (0.83em) would
   otherwise collapse through the empty .doubles-col box and add on top of
   this, so it's zeroed and this margin is the only spacing above the
   section. Scoped to the nested (.h2h-col) case specifically -- in
   .doubles-only-grid, .doubles-col is a grid-area sibling of
   .tournaments-col and needs its top to stay flush with the grid row (no
   margin) so the two columns' headers line up. */
.doubles-col { grid-area: doubles; min-width: 0; }
.doubles-col h2 { margin-top: 0; }
.h2h-col .doubles-col { margin-top: 1.25rem; }
/* Doubles-only players (no singles play at all) skip the chart/stats/match
   log entirely -- Tournaments takes the left 1 of 3 columns, Doubles the
   right 2, same 3-column grid as everyone else's page. */
.player-grid.doubles-only-grid { grid-template-areas: "tournaments doubles doubles"; }
@media (max-width: 900px) {
  .player-grid { grid-template-columns: 1fr; grid-template-areas: "chart" "h2h" "matches" "tournaments"; }
  .player-grid.doubles-only-grid { grid-template-areas: "tournaments" "doubles"; }
}
.h2h-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
.h2h-tile { background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 0.6rem 0.9rem; display: flex; flex-direction: column; gap: 0.15rem; }
.h2h-label { display: flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #666; }
.h2h-value { font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; font-weight: 700; }
/* Line-art glyphs distinguishing each Match Statistics tile at a glance — see
   H2H_ICONS in aggregate_players.js. stroke: currentColor picks up the
   label's own muted color for free; icon-flip mirrors one path for its
   opposite-meaning pair (trend up/down, giant-killer/upset-victim) instead
   of hand-drawing an inverse shape. */
.h2h-icon { width: 14px; height: 14px; flex-shrink: 0; }
.icon-flip { transform: scaleY(-1); }
.h2h-count { font-family: 'Orbitron', monospace; font-size: 1.05rem; font-weight: 900; color: #f0f0f0; }
.h2h-record-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 600; color: #666; }
.standings-rank { white-space: nowrap; }
/* Fixed width so a longer score (e.g. "12-11") doesn't wrap onto its own
   line or butt up against the W/L letter before it. Margin is asymmetric —
   more space separating it from the W/L letter, much less before the
   opponent name that follows (the li's flex gap already provides some). */
.match-score-mini { display: inline-block; width: 1.2em; font-family: 'Rajdhani', sans-serif; font-size: 0.8rem; font-weight: 600; color: #888; }
.match-tourney-name { font-size: 0.85em; color: #999; }
.match-tourney-name a { color: #999; }
.match-tourney-name a:hover { color: #3eff8b; }
.standings-rank.result-win { color: #3eff8b; }
.standings-rank.result-loss { color: #ff5e5e; }
/* Fixed width so "W" and "L" — different glyph widths in this font — don't
   shift the score/opponent columns that follow depending on which one shows. */
.result-letter { display: inline-block; width: 1.6em; text-align: center; }
.hist-record { display: inline-block; width: 1.8em; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.95rem; color: #3eff8b; }
.hist-tourney-name { font-size: 0.85em; }
.hist-tourney-name a { color: #777; }
.hist-tourney-name a:hover { color: #3eff8b; }
.show-more-btn { display: inline-block; margin-top: 0.6rem; background: none; border: none; padding: 0; color: #3eff8b; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; cursor: pointer; }
/* Map sidebar: multi-column layout (name + placement/rating/last-active for
   players, name + date for tournaments) with a matching header row above
   the list — overrides standings-list's flex row (declared earlier) with a
   grid so every column lines up with its header regardless of content
   length. Column count/labels are set by JS (renderMapSidebar) via the
   map-cols-players/map-cols-tournaments classes on both this header and
   the list itself, so their grid-template-columns stay in sync. */
.map-sidebar-colhead { display: grid; gap: 0.5rem; padding: 0 0.75rem 0.35rem; font-family: 'Rajdhani', sans-serif; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
.map-sidebar-colhead span:not(:first-child) { text-align: right; }
.map-sidebar-colhead span { cursor: pointer; user-select: none; }
.map-sidebar-colhead span:hover { color: #999; }
.map-sidebar-colhead span.sorted-asc, .map-sidebar-colhead span.sorted-desc { color: #3eff8b; }
.map-sidebar-colhead span.sorted-asc::after { content: " \\25B2"; }
.map-sidebar-colhead span.sorted-desc::after { content: " \\25BC"; }
/* renderMapSidebar (see writeJs) rebuilds this list from scratch (innerHTML
   = '' then re-append) on every region click and every Players/Tournaments
   toggle, so a freshly-inserted <li> always plays this fade-in -- no JS
   needed, same display/insertion-triggers-animation mechanism as
   .tab-panel.active above. Opacity-only (no stagger) since the whole list
   swaps together, unlike the .t-stagger-line batch reveal on player pages. */
.map-sidebar-list li { display: grid; gap: 0.5rem; animation: t-panel-fade-in var(--duration-fast) var(--ease-in-out); }
@media (prefers-reduced-motion: reduce) {
  .map-sidebar-list li { animation: none !important; }
}
.map-sidebar-list li > span:not(:first-child) { text-align: right; margin-left: 0; }
/* The map-cols-* class is toggled onto both the header div (which is
   itself the grid, so this rule applies directly) and the <ol> (which
   isn't a grid — its <li> children are), hence the two selector forms. */
.map-sidebar-colhead.map-cols-players, ol.map-cols-players li { grid-template-columns: 1fr 3.4rem 6.5rem 4rem; }
.map-sidebar-colhead.map-cols-tournaments, ol.map-cols-tournaments li { grid-template-columns: 1fr 8.5rem; }
/* Player pages carry a background glow matching their power-ranking card
   color (see cardAccent) — card-green vs card-purple varies the glow for
   visual variety, but page text always stays the site's green accent
   regardless of which glow is showing. */
body.card-green, body.card-purple { min-height: 100vh; }
body.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(0, 70, 30) 0%, #050505 55%); }
body.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(40, 0, 70) 0%, #050505 55%); }
.show-more-btn:hover { text-decoration: underline; }
.site-footer { margin-top: auto; padding-top: 1rem; border-top: 1px solid #222; display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; align-items: center; color: #555; font-size: 0.8rem; }
.site-footer a { color: #777; }
.site-footer a:hover { color: #3eff8b; }
/* --- Mobile responsiveness (max-width queries + a couple of touch-only
   rules that are inert without a touchscreen, so nothing here can ever
   affect a mouse/desktop-width viewport) --- */
/* h1 loses its own bottom margin here since .page-title-row (which wraps it
   together with the hamburger icon and the download icon) carries that
   margin instead -- see writeHtml, where index.html's h1 is the only one
   wrapped this way (player/tournament page h1s are untouched, plain
   elements, so their own margin: 0 0 1.5rem rule still applies to them). */
.page-title-row { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 1.5rem; }
.page-title-row h1 { margin: 0; flex: 1 1 auto; min-width: 0; }
.tabs-toggle { display: none; }
/* Off by default (no .options-open class) above the mobile breakpoint too,
   but the toggle button itself is display:none there, so .tab-controls'
   normal (always visible) CSS is the only thing that ever applies on desktop. */
.rankings-options-toggle { display: none; }
/* Hidden on desktop -- the "Historical Rating"-style heading above the top
   stat grid only exists to label that grid once it's the first thing on the
   page on mobile (see .player-title-row and h1 shrinking below); on desktop
   the grid sits directly under the page title where a label is redundant. */
.mobile-only-heading { display: none; }
.player-title-row { display: block; }
.aka-toggle { display: none; }
.aka-content { display: none; }
.footer-copyright-short { display: none; }
/* .footer-row is display:contents on desktop so each pairing (credits+Ko-Fi,
   sources+correction) still renders as independent flex items of
   .site-footer, wrapping wherever the row happens to break -- the grouping
   only turns into an actual visual row once .site-footer switches to
   flex-direction:column on mobile (see below). */
.footer-row { display: contents; }
.date-short { display: none; }
.stat-label-short { display: none; }
/* Lets a two-finger touch gesture on the map be handled entirely by
   enableMapPinchZoom (see writeJs) instead of the browser's own page-zoom/
   scroll gesture recognizer grabbing it first. No effect for mouse/desktop
   input, so this isn't gated behind a max-width query. */
.map-svg { touch-action: none; }
@media (max-width: 700px) {
  h1 { font-size: 1.1rem; }
  /* Hamburger replaces the full tab row -- six tabs (Power Rankings/Players/
     Tournaments/Doubles/Map/Events) don't fit a phone width even scrolled --
     as a plain white icon next to the page title (no button box), matching
     .download-btn's own icon-only look on the opposite side of the row.
     Clicking it slides .tabs in from the left edge as a fixed drawer over a
     dimming backdrop, rather than a dropdown that would otherwise need to
     find room directly under a title row that's now also holding the
     download icon. */
  .tabs-toggle { display: flex; align-items: center; justify-content: center; background: none; border: none; padding: 0; color: #ccc; cursor: pointer; flex-shrink: 0; }
  .tabs-toggle:hover { color: #3eff8b; }
  .tabs-toggle-icon { width: 20px; height: 20px; }
  .tabs { flex-direction: column; position: fixed; top: 0; bottom: 0; left: 0; width: 78%; max-width: 300px; background: #0a0a0a; border-right: 1px solid #222; z-index: 50; padding: 4rem 1.25rem 1.5rem; margin-bottom: 0; transform: translateX(-100%); transition: transform 220ms ease; }
  .tabs.mobile-open { transform: translateX(0); }
  .tab-button { text-align: left; padding: 0.7rem 1rem; border-bottom: 1px solid #161616; margin-bottom: 0; }
  .tab-external-link { text-align: left; padding: 0.7rem 1rem; border-bottom: 1px solid #161616; margin-bottom: 0; margin-left: 0; }
  .tab-underline { display: none; }
  /* Fades in/out alongside the .tabs drawer's own transform slide (see
     .tabs above) instead of popping on/off -- visibility (not display) so
     it can transition, with the delayed visibility flip on the way out
     keeping it non-interactive/invisible-to-screen-readers once faded. */
  .tabs-backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 40;
    opacity: 0;
    visibility: hidden;
    transition: opacity var(--duration-fast) var(--ease-smooth-out), visibility 0s linear var(--duration-fast);
  }
  .tabs-backdrop.mobile-open {
    opacity: 1;
    visibility: visible;
    transition: opacity var(--duration-fast) var(--ease-smooth-out), visibility 0s linear 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    .tabs-backdrop { transition: none !important; }
  }

  /* Swap which download button is visible -- the boxed one (inside the
     Power Rankings tab-controls row) only makes sense on desktop; mobile
     shows the plain icon in .page-title-row instead, top-right next to
     .tabs-toggle. Both share the same [hidden]/loading/failed state (see
     updateDownloadVisibility/enableViewToggle in writeJs), so only their
     display toggles here, not their visibility logic. */
  .download-btn-boxed { display: none; }
  .download-btn-icon { display: inline-flex; }
  /* .csv-download-btn reuses .download-btn-boxed's styling but, unlike the
     PR image export, has no separate icon-only counterpart for mobile (it's
     not tied to updateDownloadVisibility's grid/PR-tab-only visibility) --
     override the boxed-only display:none back on for it specifically so it
     doesn't disappear on narrow viewports. */
  .csv-download-btn.download-btn-boxed { display: inline-flex; margin-left: 0; }

  /* Fixed 240px standings column (see .tourney-standings above) can pinch
     the bracket column on a narrow phone -- stack them instead, same as
     flex-wrap already does once both no longer fit side by side at a
     reasonable size. */
  .tourney-standings { flex: 1 1 100%; }
  .tourney-matches { flex: 1 1 100%; }
  /* Tournament page: location / date / "view original" each pinned to their
     own line via column layout, reordered (source order stays date/location/
     link, unchanged for desktop) and clipped with an ellipsis instead of
     wrapping a second time within their own line. */
  .tourney-meta { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  .tourney-meta > * { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tourney-loc { order: 1; }
  .tourney-date { order: 2; }
  .source-pills { display: flex; order: 3; white-space: normal; flex-wrap: wrap; }
  /* 3 cards per row is too cramped once the tournament columns have
     already stacked to full width on a phone -- drop to 1. */
  .swiss-round-grid { grid-template-columns: 1fr; }

  /* Power Rankings tab: filters/view-toggles/download collapse behind an
     Options button instead of sitting open above the grid by default. */
  .rankings-options-toggle { display: flex; align-items: center; gap: 0.4rem; background: #111; border: 1px solid #333; border-radius: 3px; color: #aaa; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.4rem 0.9rem; margin-bottom: 1rem; cursor: pointer; }
  .rankings-options-toggle:hover, .rankings-options-toggle.active { border-color: #3eff8b; color: #3eff8b; }
  .rankings-options-caret { width: 9px; height: 6px; transition: transform 150ms ease; }
  .rankings-options-toggle.active .rankings-options-caret { transform: rotate(180deg); }
  /* Accordion expand: the panel itself is the grid-template-rows 0fr/1fr
     track (no JS height measuring, any content height animates cleanly);
     .rankings-options-inner is the overflow:hidden clipping box that also
     owns the real 2-column layout and its own opacity/blur fade so the
     controls don't pop in the instant the track finishes growing. */
  #rankings-options-panel {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--acc-collapse) var(--acc-ease);
  }
  #rankings-options-panel.options-open {
    grid-template-rows: 1fr;
    transition: grid-template-rows var(--acc-expand) var(--acc-ease);
  }
  /* 2-column grid instead of one long wrapping row of controls -- the
     Grid/Table and Hide/Show-delta pills naturally land in row 1 (one per
     column), then the four filter selects form a clean 2x2 grid below them
     in the same document order they already had. Grid's default
     justify-items:stretch fills each pill's own column width instead of
     leaving it at its cramped intrinsic size -- its two buttons then split
     that width evenly (flex: 1 1 0) rather than sizing to their own text. */
  .rankings-options-inner {
    display: grid;
    overflow: hidden;
    /* minmax(0, 1fr), not bare 1fr: a bare 1fr track has an auto minimum
       equal to its content's min-content width, and the Rankings-at
       dropdown trigger's nowrap label would otherwise push its column past
       the grid (clipped by overflow:hidden, but the control ran off-screen). */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.65rem 0.75rem;
    align-items: end;
    opacity: 0;
    filter: blur(var(--blur-small));
    transition: opacity var(--acc-collapse) var(--acc-ease), filter var(--acc-collapse) var(--acc-ease);
  }
  #rankings-options-panel.options-open .rankings-options-inner {
    opacity: 1;
    filter: blur(0);
    transition: opacity var(--acc-expand) var(--acc-ease), filter var(--acc-expand) var(--acc-ease);
  }
  .rankings-options-inner .view-toggle,
  .rankings-options-inner .rank-delta-toggle { width: 100%; }
  .rankings-options-inner .view-btn,
  .rankings-options-inner .delta-btn { flex: 1 1 0; text-align: center; white-space: nowrap; padding-left: 0.4rem; padding-right: 0.4rem; }
  /* Override the desktop [hidden]{display:none} rule above -- on mobile,
     switching to Table view should leave this pill's grid cell empty
     (invisible but still occupying its row) instead of collapsing it and
     shifting Min Games/Max RD up into row 1. Needs !important to beat the
     global [hidden]{display:none !important} rule (see the .pr-card/
     [hidden] note elsewhere in this file), which otherwise wins over any
     non-important rule regardless of selector specificity or source order. */
  .rank-delta-toggle[hidden] { display: flex !important; visibility: hidden; }
  .rankings-options-inner label { display: flex; flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  .rankings-options-inner label select, .rankings-options-inner label .dd, .rankings-options-inner label .dd-trigger { width: 100%; }
  .rankings-options-inner label .dd[data-for="pr-history-select"] .dd-trigger { max-width: none; }
  /* Finger-sized rows for the custom dropdown menu. */
  .dd-option { padding: 0.55rem 0.8rem; }
  @media (prefers-reduced-motion: reduce) {
    #rankings-options-panel, .rankings-options-inner { transition: none !important; }
  }

  /* Player page: name + AKA toggle share a row; the header matching
     "Historical Rating" only shows here since the grid is the first section
     on the page on mobile. */
  .player-title-row { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .mobile-only-heading { display: block; }
  .aka-full { display: none; }
  /* Caret sits after the "AKA" text (flex row, not the default marker
     position) and never itself moves -- toggling .open only affects
     .aka-content, a separate full-width block between the name and the
     location/active meta line, so this button's own size/position is
     identical whether the list is open or not. */
  .aka-toggle { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: none; padding: 0; cursor: pointer; color: #888; font-family: 'Rajdhani', sans-serif; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; user-select: none; }
  .aka-toggle:hover, .aka-toggle.active { color: #3eff8b; }
  .aka-caret { width: 9px; height: 6px; flex-shrink: 0; transition: transform 150ms ease; }
  .aka-toggle.active .aka-caret { transform: rotate(180deg); }
  /* Accordion expand, same technique as #rankings-options-panel above:
     .aka-content is the grid-template-rows 0fr/1fr track (kept as the
     element .open toggles on, so the .aka-content.open + .tourney-meta
     sibling-spacing rule below still applies unchanged); .aka-content-inner
     clips overflow and carries its own opacity/blur fade. Same -1rem trick
     .tourney-meta uses below to pull up close under h1's own large default
     margin -- keeps the title-to-AKA gap the same size as the
     title-to-location gap on a page with no AKA line at all. */
  .aka-content {
    display: grid;
    grid-template-rows: 0fr;
    margin: -1rem 0 0;
    transition: grid-template-rows var(--acc-collapse) var(--acc-ease);
  }
  .aka-content.open {
    grid-template-rows: 1fr;
    transition: grid-template-rows var(--acc-expand) var(--acc-ease);
  }
  .aka-content-inner {
    overflow: hidden;
    color: #888;
    font-size: 0.85rem;
    opacity: 0;
    filter: blur(var(--blur-small));
    transition: opacity var(--acc-collapse) var(--acc-ease), filter var(--acc-collapse) var(--acc-ease);
  }
  .aka-content.open .aka-content-inner {
    opacity: 1;
    filter: blur(0);
    transition: opacity var(--acc-expand) var(--acc-ease), filter var(--acc-expand) var(--acc-ease);
  }
  @media (prefers-reduced-motion: reduce) {
    .aka-content, .aka-content-inner { transition: none !important; }
  }
  /* Once AKA is open and visible, .tourney-meta directly follows it instead
     of h1 -- its own -1rem margin-top (tuned for pulling up against h1's
     larger gap) would sit too tight against a line of plain text, so this
     drops it to the same 0.3rem rhythm .tourney-meta already uses between
     its own location/active lines, keeping every line in the block evenly
     spaced. Only matches while .open is present, so a page with the AKA
     toggle closed (or no aliases at all) still gets the normal tourney-meta
     spacing straight off h1. */
  .aka-content.open + .tourney-meta { margin-top: 0.3rem; }

  /* Match Statistics tiles stay 2-per-row instead of collapsing to 1 once
     each tile's 200px minimum no longer fits twice across a phone width. */
  .h2h-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  /* Condensed "Jul. 10 '26" dates in the Matches/Tournaments lists (see
     dateDualHtml) instead of the full "July 10, 2026" form. */
  .date-full { display: none; }
  .date-short { display: inline; }

  /* Shorter Match Statistics labels (see dualLabelHtml) -- e.g. "Best Win
     Rate" instead of "Best Win Rate (Min. 3)" -- only on mobile; desktop
     keeps the original, more explicit wording. */
  .stat-label-full { display: none; }
  .stat-label-short { display: inline; }

  /* Footer: condensed copyright, one row per group (credits+Ko-Fi, then
     sources+correction) instead of wrapping wherever the flex row breaks. */
  .site-footer { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  .footer-copyright-full { display: none; }
  .footer-copyright-short { display: inline; }
  .footer-row { display: flex; gap: 1rem; flex-wrap: wrap; }
}
@media (max-width: 800px) {
  /* 2:1 map/sidebar split (see .map-panel above) is too cramped once the
     map column itself drops under ~300px -- stack map above sidebar and
     shrink the map's own fixed height (still fixed, just a smaller fixed
     value, matching the "never resize dynamically" approach used on desktop). */
  .map-panel { grid-template-columns: 1fr; }
  .map-svg { height: 320px; }
  .map-sidebar { height: 420px; }
  /* Drop the Rating column from the player sidebar list -- Placement and
     Last Active are what people actually scan for on a narrow screen, and
     three number columns plus a name don't have room to breathe. Column
     order is Player/Placement/Rating/Last Active (see MAP_SIDEBAR_COLUMNS
     and renderMapSidebar in writeJs), so Rating is always the 3rd child. */
  .map-sidebar-colhead.map-cols-players, ol.map-cols-players li { grid-template-columns: 1fr 3.4rem 4rem; }
  .map-sidebar-colhead.map-cols-players span:nth-child(3),
  ol.map-cols-players li > span:nth-child(3) { display: none; }
}
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.css'), stripCssComments(css));
}

function writeJs(glickoUncertainRdThreshold) {
  const stateNamesJson = JSON.stringify({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
    OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'Washington D.C.',
    AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
    NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
    NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
    SK: 'Saskatchewan', YT: 'Yukon',
  });

  const js = `(function () {
  const STATE_NAMES = ${stateNamesJson};
  const MAP_REGION_DATA = JSON.parse(document.getElementById('map-region-data')?.textContent || '{}');
  const PR_HISTORY_DATA = JSON.parse(document.getElementById('pr-history-data')?.textContent || '{}');
  const PR_META = PR_HISTORY_DATA.players || {};
  const PR_HISTORY = PR_HISTORY_DATA.checkpoints || [];
  // Region/country names + flags for the Location filter (buildLocationFilterData in aggregate_players.js).
  const LOCATION_FILTER = JSON.parse(document.getElementById('location-filter-data')?.textContent || '{"regions":{},"countries":{}}');
  const PR_UNCERTAIN_RD_THRESHOLD = ${glickoUncertainRdThreshold};

  function enableSorting(table) {
    const tbody = table.tBodies[0];
    const headers = [...table.querySelectorAll('th')];
    headers.forEach((th, colIndex) => {
      if (th.classList.contains('no-sort')) return;
      th.addEventListener('click', () => {
        const asc = !th.classList.contains('sorted-asc');
        headers.forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');

        const rows = [...tbody.rows];
        const type = th.dataset.type;
        rows.sort((a, b) => {
          const cellA = a.cells[colIndex];
          const cellB = b.cells[colIndex];
          if (type === 'number') {
            const valA = Number(cellA.dataset.sort !== undefined ? cellA.dataset.sort : cellA.textContent);
            const valB = Number(cellB.dataset.sort !== undefined ? cellB.dataset.sort : cellB.textContent);
            return asc ? valA - valB : valB - valA;
          }
          const valA = (cellA.dataset.sort !== undefined ? cellA.dataset.sort : cellA.textContent).trim().toLowerCase();
          const valB = (cellB.dataset.sort !== undefined ? cellB.dataset.sort : cellB.textContent).trim().toLowerCase();
          if (th.dataset.blankLast === 'true') {
            const blankA = valA === '';
            const blankB = valB === '';
            if (blankA !== blankB) return blankA ? 1 : -1;
          }
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }

  // Positions indicator (a .tab-underline or .view-toggle-indicator) to
  // sit under/behind target within container, sized to match — called on
  // init and again on every switch so it slides there via the element's
  // own CSS transition instead of just appearing in the new spot.
  function moveIndicator(indicator, container, target) {
    if (!indicator || !container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    indicator.style.left = (targetRect.left - containerRect.left) + 'px';
    indicator.style.width = targetRect.width + 'px';
  }

  const TAB_HEADERS = { 'players-tab': 'DeathBall Players', 'tournaments-tab': 'DeathBall Tournaments', 'doubles-tab': 'DeathBall Doubles', 'rankings-tab': 'DeathBall Power Rankings', 'map-tab': 'DeathBall Map', 'events-tab': 'Upcoming DeathBall Events' };

  const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const SCRAMBLE_WINDOW = 8;
  const SCRAMBLE_STEP_MS = 30;

  // Sweeps a small window of characters left to right across the heading:
  // characters inside the window flicker through random letters each tick,
  // characters the window has already passed settle onto the new heading's
  // text, and characters not yet reached still show the old heading's text.
  // The first frame is drawn synchronously (not on the first interval tick)
  // so the sweep visibly starts the instant the tab is clicked.
  function scrambleHeading(el, target) {
    if (el._scrambleTimer) clearInterval(el._scrambleTimer);
    const from = el.textContent;
    const len = Math.max(from.length, target.length);
    const fromPadded = from.padEnd(len, ' ');
    const targetPadded = target.padEnd(len, ' ');
    // Skip straight past a shared prefix/suffix: pos starts at the first
    // differing character (instead of 0) and the sweep stops once the last
    // differing character has cleared the window (instead of walking all
    // the way to len), so headers sharing most of their text (e.g. every
    // "DeathBall ..." tab) don't pay for ticking through characters that
    // were never going to change on screen.
    let firstDiff = 0;
    while (firstDiff < len && fromPadded[firstDiff] === targetPadded[firstDiff]) firstDiff++;
    if (firstDiff === len) {
      el.textContent = target;
      return;
    }
    let lastDiff = len - 1;
    while (lastDiff > firstDiff && fromPadded[lastDiff] === targetPadded[lastDiff]) lastDiff--;
    const maxPos = lastDiff + SCRAMBLE_WINDOW;
    let pos = firstDiff;
    function drawFrame() {
      let out = '';
      for (let i = 0; i < len; i++) {
        if (i < pos - SCRAMBLE_WINDOW) {
          out += targetPadded[i];
        } else if (i <= pos) {
          out += fromPadded[i] === targetPadded[i]
            ? targetPadded[i]
            : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        } else {
          out += fromPadded[i];
        }
      }
      el.textContent = out.replace(/\\s+$/, '');
    }
    drawFrame();
    el._scrambleTimer = setInterval(() => {
      pos++;
      if (pos > maxPos) {
        clearInterval(el._scrambleTimer);
        el._scrambleTimer = null;
        el.textContent = target;
        return;
      }
      drawFrame();
    }, SCRAMBLE_STEP_MS);
  }

  function setHeaderForTab(tabId) {
    const heading = document.getElementById('tab-heading');
    const label = TAB_HEADERS[tabId] || TAB_HEADERS['rankings-tab'];
    if (!heading || heading.textContent === label) return;
    scrambleHeading(heading, label);
  }

  // Keeps the URL's ?tab= param in sync with whichever tab is active, so the
  // address bar can be copied/bookmarked/shared and reopen on the same tab.
  // replaceState (not pushState) so clicking through tabs doesn't fill up
  // browser history with one entry per tab switch.
  function updateUrlForTab(tabId) {
    const url = new URL(location.href);
    url.searchParams.set('tab', tabId.replace(/-tab$/, ''));
    history.replaceState(null, '', url);
  }

  function enableTabs() {
    const buttons = [...document.querySelectorAll('.tab-button')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    const tabsEl = document.querySelector('.tabs');
    const underline = document.querySelector('.tab-underline');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(btn.dataset.tab);
        panel.classList.add('active');
        moveIndicator(underline, tabsEl, btn);
        setHeaderForTab(btn.dataset.tab);
        updateUrlForTab(btn.dataset.tab);
        updateDownloadVisibility();
        // Deferred to a rAF instead of running inline: this panel can hold
        // hundreds of cards, and fitText's measure-shrink-remeasure loop
        // forces a synchronous reflow per element, which was blocking the
        // main thread and starving the heading scramble's setInterval ticks
        // -- the animation would stall, then jump once this finished. Off
        // the critical path, it now runs after the browser has already
        // painted the tab switch and the scramble is free to animate.
        requestAnimationFrame(() => {
          // Cards were sized while this panel was display:none (offsetWidth
          // 0 at page load, or never resized since last becoming visible),
          // so names need a fresh fit now that the panel actually has layout.
          fitCardNames(panel);
          // Same story for any view-toggle pill(s) inside this panel (e.g.
          // the Map tab's Players/Tournaments switch, or the Rankings tab's
          // Grid/Table and rank-delta Hide/Show switches) — indicators were
          // positioned against a zero-width rect while hidden.
          for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
            const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
            const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
            if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
          }
        });
      });
    });
    moveIndicator(underline, tabsEl, buttons.find((b) => b.classList.contains('active')));
  }

  // Lets a link into the site land on a specific tab via a query string,
  // e.g. index.html?tab=tournaments -- used by the tournament pages' back
  // link so it returns to Tournaments instead of always Power Rankings.
  // Reuses the tab button's own click handler (rather than duplicating its
  // active-state/indicator/header logic here) so behavior stays identical
  // to a real click.
  function activateTabFromQuery() {
    const requested = new URLSearchParams(location.search).get('tab');
    if (!requested) return;
    const btn = document.querySelector('.tab-button[data-tab="' + requested + '-tab"]');
    if (btn && !btn.classList.contains('active')) btn.click();
  }

  // Mobile-only hamburger toggle for the tab row (see .tabs-toggle in
  // writeCss) -- .tabs-toggle is display:none above the mobile breakpoint,
  // so this is inert on desktop even though the listener is always attached.
  // .tabs slides in from the left as a fixed drawer over a dimming
  // .tabs-backdrop, which also closes the drawer when tapped.
  function enableTabsMenu() {
    const toggle = document.querySelector('.tabs-toggle');
    const tabsEl = document.querySelector('.tabs');
    const backdrop = document.querySelector('.tabs-backdrop');
    if (!toggle || !tabsEl) return;
    function setOpen(open) {
      tabsEl.classList.toggle('mobile-open', open);
      if (backdrop) backdrop.classList.toggle('mobile-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    }
    toggle.addEventListener('click', () => setOpen(!tabsEl.classList.contains('mobile-open')));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    // Selecting a tab closes the drawer again rather than leaving it open
    // over the newly-shown panel.
    tabsEl.querySelectorAll('.tab-button').forEach((btn) => {
      btn.addEventListener('click', () => setOpen(false));
    });
  }

  // Mobile-only collapse for the Power Rankings tab's filter/action row (see
  // .rankings-options-toggle in writeCss) -- off by default on mobile so the
  // grid/table of rankings isn't pushed down by a wall of selects before
  // anyone asks for them; the toggle itself is display:none on desktop,
  // where the panel is always visible regardless of this class.
  function enableOptionsToggle() {
    const toggle = document.querySelector('.rankings-options-toggle');
    const panel = document.getElementById('rankings-options-panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('options-open');
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', String(open));
      // The Grid/Table and Hide/Show-delta sliding pills were positioned (at
      // page load and on every filter change) while this panel's accordion
      // track was still collapsed (grid-template-rows: 0fr -- see
      // #rankings-options-panel in writeCss). Column widths aren't actually
      // affected by that (fr row-sizing only squeezes the block dimension),
      // but re-running the positioning once the track is open is a cheap
      // safety net against any layout edge case rather than trusting that.
      if (open) {
        for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
          const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
          const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
          if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
        }
      }
    });
  }

  // Location filter options, built from the rows' data-country / data-state
  // attributes: a Country group (every country with at least one player)
  // above a Region group (every state/province with at least one player,
  // all countries mixed), each ordered by player count. Option values are
  // prefixed c: / r: so applyFilters knows which attribute to match, and
  // data-flag carries the flag image the custom dropdown menu draws next to
  // the entry (enhanceDropdowns) -- a native option can't show one.
  function populateStateFilter(panel) {
    const select = panel.querySelector('.state-filter-select');
    const tbody = panel.querySelector('table tbody');
    if (!select || !tbody) return;
    const countryCounts = new Map();
    const regionCounts = new Map();
    for (const row of tbody.rows) {
      const country = row.dataset.country;
      const region = row.dataset.state;
      if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
      if (region) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
    }
    const regionName = (abbr) => (LOCATION_FILTER.regions[abbr] || {}).name || STATE_NAMES[abbr] || abbr;
    const byCountThenName = (nameOf) => (a, b) => (b[1] - a[1]) || nameOf(a[0]).localeCompare(nameOf(b[0]));
    const addGroup = (label, entries, prefix, nameOf, flagOf) => {
      if (!entries.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const [key] of entries) {
        const opt = document.createElement('option');
        opt.value = prefix + key;
        opt.dataset.label = nameOf(key);
        opt.textContent = opt.dataset.label;
        const flag = flagOf(key);
        if (flag && flag.src) opt.dataset.flag = flag.src;
        group.appendChild(opt);
      }
      select.appendChild(group);
    };
    addGroup('Country', [...countryCounts].sort(byCountThenName((c) => c)), 'c:', (c) => c, (c) => (LOCATION_FILTER.countries[c] || {}).flag);
    addGroup('Region', [...regionCounts].sort(byCountThenName(regionName)), 'r:', regionName, (r) => (LOCATION_FILTER.regions[r] || {}).flag);
    // Stamp base label on the hardcoded "All locations" option too
    if (select.options[0]) select.options[0].dataset.label = select.options[0].textContent;
  }

  function applyFilters(panel) {
    const minGames = parseInt(panel.querySelector('.min-games-select')?.value || '0', 10);
    const maxRdVal = panel.querySelector('.max-rd-select')?.value || 'Infinity';
    const maxRd = maxRdVal === 'Infinity' ? Infinity : parseFloat(maxRdVal);
    // Location filter value is '' (all), 'c:<country>' or 'r:<region abbr>'
    // (see populateStateFilter) -- pick the data attribute to match on.
    const locationValue = panel.querySelector('.state-filter-select')?.value || '';
    const locationAttr = locationValue.startsWith('c:') ? 'country' : 'state';
    const location = locationValue.slice(2);
    const tbody = panel.querySelector('table tbody');
    const isRankingsTab = panel.id === 'rankings-tab';
    const DEFAULT_MIN_GAMES = 5;
    const DEFAULT_MAX_RD = 150;

    // Use card grid as count source for rankings (avoids double-counting with table).
    // Scoped to direct .pr-card children so the .pr-square promo tile (no
    // data-games/data-rd, not a real ranked player) is never counted, ranked,
    // or hidden by these filters.
    const grid = isRankingsTab ? panel.querySelector('.pr-grid') : null;
    const countSource = grid ? [...grid.querySelectorAll(':scope > .pr-card')] : (tbody ? [...tbody.rows] : []);

    // First pass: count per country and per region for items passing the
    // non-location filters
    const countryCounts = new Map();
    const regionCounts = new Map();
    let totalPassingNonState = 0;
    for (const el of countSource) {
      const games = parseInt(el.dataset.games || '0', 10);
      const rd = parseFloat(el.dataset.rd || '0');
      if (minGames && games < minGames) continue;
      if (maxRd !== Infinity && rd > maxRd) continue;
      const rowCountry = el.dataset.country || '';
      const rowState = el.dataset.state || '';
      countryCounts.set(rowCountry, (countryCounts.get(rowCountry) || 0) + 1);
      regionCounts.set(rowState, (regionCounts.get(rowState) || 0) + 1);
      totalPassingNonState++;
    }

    // Update dropdown option labels with counts
    const stateSelect = panel.querySelector('.state-filter-select');
    if (stateSelect) {
      for (const opt of stateSelect.options) {
        const label = opt.dataset.label || opt.textContent.replace(/\\s*\\(\\d+\\)$/, '');
        const count = opt.value === '' ? totalPassingNonState
          : opt.value.startsWith('c:') ? (countryCounts.get(opt.value.slice(2)) || 0)
          : (regionCounts.get(opt.value.slice(2)) || 0);
        opt.textContent = label + ' (' + count + ')';
      }
    }

    // Apply filters to table rows
    if (tbody) {
      let rank = 1;
      for (const row of tbody.rows) {
        const games = parseInt(row.dataset.games || '0', 10);
        const rd = parseFloat(row.dataset.rd || '0');
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !location || (row.dataset[locationAttr] || '') === location;
        const show = passesMinMax && passesState;
        row.hidden = !show;
        if (isRankingsTab) {
          const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
          row.classList.toggle('filter-dim', show && !meetsDefaults);
        } else {
          row.classList.remove('filter-dim');
        }
        if (show) {
          const rankCell = row.querySelector('.rank-num');
          if (rankCell) rankCell.textContent = rank++;
        }
      }
    }

    // Apply filters to card grid (rankings tab only)
    let visible = 0;
    if (grid) {
      let rank = 1;
      for (const card of grid.querySelectorAll(':scope > .pr-card')) {
        const games = parseInt(card.dataset.games || '0', 10);
        const rd = parseFloat(card.dataset.rd || '0');
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !location || (card.dataset[locationAttr] || '') === location;
        const show = passesMinMax && passesState;
        card.hidden = !show;
        const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
        card.classList.toggle('filter-dim', show && !meetsDefaults);
        if (show) {
          const rankEl = card.querySelector('.prc-rank .rank-plain');
          if (rankEl) rankEl.textContent = rank;
          rank++;
          visible++;
        }
      }
      fitCardNames(panel);
    } else if (tbody) {
      for (const row of tbody.rows) if (!row.hidden) visible++;
    }

    const countEl = panel.querySelector('.filter-count');
    if (countEl) {
      const noun = isRankingsTab ? 'players ranked' : 'unique players';
      // The sort hint only applies while the sortable table is actually the
      // visible view — grid mode has no columns to click.
      const table = panel.querySelector('table');
      const tableVisible = !grid || !table || table.style.display !== 'none';
      countEl.textContent = visible + ' ' + noun + (tableVisible ? '. Click a column header to sort.' : '.');
    }
  }

  function fitText(el, maxPx, minPx) {
    el.style.fontSize = maxPx + 'px';
    let size = maxPx;
    while (el.scrollWidth > el.offsetWidth && size > minPx) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  function fitCardNames(panel) {
    const scope = panel || document;
    for (const el of scope.querySelectorAll('.prc-name')) fitText(el, 18, 9);
  }

  // Sequential fill scale from dim (no data) up to bright green, using a
  // sqrt scale so a handful of high-count hubs (e.g. Texas/Minnesota) don't
  // wash out every other state to the same dim shade.
  function countColor(count, max) {
    if (!count) return 'rgba(255, 255, 255, 0.05)';
    const t = max > 0 ? Math.sqrt(count / max) : 0;
    const lightness = 16 + t * 44;
    return 'hsl(150, 70%, ' + lightness.toFixed(1) + '%)';
  }

  function updateMap(panel, view) {
    const regions = [...panel.querySelectorAll('.map-region')];
    const labels = [...panel.querySelectorAll('.map-label')];
    let max = 1;
    for (const r of regions) max = Math.max(max, parseInt(r.dataset[view] || '0', 10));
    regions.forEach((r) => {
      const count = parseInt(r.dataset[view] || '0', 10);
      r.style.fill = countColor(count, max);
    });
    labels.forEach((l) => {
      const count = parseInt(l.dataset[view] || '0', 10);
      l.textContent = count > 0 ? count : '';
    });
  }

  function enableMapToggle(panel) {
    if (!panel) return;
    const buttons = [...panel.querySelectorAll('.view-btn')];
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        moveIndicator(indicator, toggleEl, btn);
        updateMap(panel, btn.dataset.view);
        // Keep an open region's sidebar in sync with whichever list (players
        // vs tournaments) is now the active view, without touching zoom.
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
      });
    });
    const active = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, active);
    updateMap(panel, active ? active.dataset.view : 'players');
  }

  // Hand-picked box (same tuning approach as MAP_HOME_VIEWBOX in
  // aggregate_players.js) padding out mapShapes' actual world content bbox
  // (roughly x: -611..3784, y: -1142..1767, per every shape's projected
  // path) so panning/zooming out can reach every region -- including
  // Russia's mainland and Fiji/Kiribati/New Zealand's remaining islands --
  // without ever revealing empty space past the edge of the world. Doubles
  // as the zoomed-all-the-way-out box: MAP_ZOOM_OUT_MAX_WIDTH below equals
  // its own width, so at max zoom-out the viewBox exactly fills these
  // bounds and there's nowhere left to pan.
  const MAP_WORLD_BOUNDS = { minX: -700, minY: -1200, maxX: 3900, maxY: 1950 };
  const MAP_ZOOM_OUT_MAX_WIDTH = MAP_WORLD_BOUNDS.maxX - MAP_WORLD_BOUNDS.minX;

  // Clamps a candidate viewBox (as x, y, width, height) so it never drifts
  // outside MAP_WORLD_BOUNDS -- used by every pan/zoom entry point (drag,
  // wheel, pinch, click-to-zoom, the home reset) so none of them can
  // individually put the user somewhere with nothing to look at. If the box
  // itself is wider/taller than the bounds (shouldn't normally happen since
  // MAP_ZOOM_OUT_MAX_WIDTH is sized to fit, but the pinch-zoom path derives
  // height from a live aspect ratio that could theoretically overshoot),
  // that dimension is centered in the bounds instead of clamped, since a
  // min/max clamp is undefined when the box is bigger than the range.
  function clampMapBox(x, y, width, height) {
    const boundsW = MAP_WORLD_BOUNDS.maxX - MAP_WORLD_BOUNDS.minX;
    const boundsH = MAP_WORLD_BOUNDS.maxY - MAP_WORLD_BOUNDS.minY;
    const cx = width >= boundsW
      ? MAP_WORLD_BOUNDS.minX + (boundsW - width) / 2
      : Math.min(Math.max(x, MAP_WORLD_BOUNDS.minX), MAP_WORLD_BOUNDS.maxX - width);
    const cy = height >= boundsH
      ? MAP_WORLD_BOUNDS.minY + (boundsH - height) / 2
      : Math.min(Math.max(y, MAP_WORLD_BOUNDS.minY), MAP_WORLD_BOUNDS.maxY - height);
    return [cx, cy, width, height];
  }

  function animateViewBox(svg, toBox, duration) {
    const clampedTo = clampMapBox(toBox[0], toBox[1], toBox[2], toBox[3]);
    const fromBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const box = fromBox.map((v, i) => v + (clampedTo[i] - v) * eased);
      svg.setAttribute('viewBox', box.join(' '));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Mirrors the player page's tournament-history-list / recent-matches-list
  // styling (standings-list / standings-rank / hist-tourney-name /
  // standings-record) so this reads as the same kind of list elsewhere on
  // the site, rather than a one-off sidebar design. The sidebar always
  // shows a list — regionId '__ALL__' (the default) shows every
  // player/tournament; clicking a region filters this same list down
  // rather than swapping in a separate view.
  function mapFlagNameSpan(item) {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'hist-tourney-name';
    if (item.f) {
      const img = document.createElement('img');
      img.className = 'loc-flag';
      img.src = item.f.src;
      img.alt = item.f.title;
      img.title = item.f.title;
      nameSpan.appendChild(img);
    }
    if (item.h) {
      const a = document.createElement('a');
      a.href = item.h;
      a.textContent = item.n;
      nameSpan.appendChild(a);
    } else {
      nameSpan.appendChild(document.createTextNode(item.n));
    }
    return nameSpan;
  }

  // Column definitions per view -- key is the field on each item (see
  // toMapPlayerJson/toMapTournamentJson in aggregate_players.js), type
  // picks string vs numeric comparison. Tournament dates sort on the raw
  // ISO field (di), not the pre-formatted display date (d), for the same
  // reason as the main tables: comparing formatted strings would order by
  // month name instead of chronologically.
  const MAP_SIDEBAR_COLUMNS = {
    players: [
      { label: 'Player', key: 'n', type: 'string' },
      { label: 'Placement', key: 'rank', type: 'number' },
      { label: 'Rating', key: 'v', type: 'number' },
      { label: 'Last Active', key: 'la', type: 'string' },
    ],
    tournaments: [
      { label: 'Tournament', key: 'n', type: 'string' },
      { label: 'Date', key: 'di', type: 'string' },
    ],
  };

  function sortMapItems(items, sort, columns) {
    if (!sort) return items;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return items;
    const sorted = items.slice();
    sorted.sort((a, b) => {
      if (col.type === 'number') {
        const valA = Number(a[col.key]);
        const valB = Number(b[col.key]);
        return sort.asc ? valA - valB : valB - valA;
      }
      const valA = String(a[col.key] || '').toLowerCase();
      const valB = String(b[col.key] || '').toLowerCase();
      return sort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });
    return sorted;
  }

  function renderMapSidebar(panel, regionId, view) {
    const data = MAP_REGION_DATA[regionId];
    if (!data) return;
    const list = panel.querySelector('.map-sidebar-list');
    const colhead = panel.querySelector('.map-sidebar-colhead');
    const title = panel.querySelector('.map-sidebar-title');
    const backBtn = panel.querySelector('.map-sidebar-back');
    title.textContent = data.name;
    if (backBtn) backBtn.hidden = regionId === '__ALL__';

    const isTournaments = view === 'tournaments';
    list.classList.toggle('map-cols-players', !isTournaments);
    list.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.classList.toggle('map-cols-players', !isTournaments);
    colhead.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.innerHTML = '';
    if (!panel._mapSort) panel._mapSort = { players: null, tournaments: null };
    const sortKey = isTournaments ? 'tournaments' : 'players';
    const columns = MAP_SIDEBAR_COLUMNS[sortKey];
    const currentSort = panel._mapSort[sortKey];
    columns.forEach((col) => {
      const span = document.createElement('span');
      span.textContent = col.label;
      if (currentSort && currentSort.key === col.key) {
        span.classList.add(currentSort.asc ? 'sorted-asc' : 'sorted-desc');
      }
      span.addEventListener('click', () => {
        // Cycles ascending -> descending -> unsorted (back to the default
        // list order) rather than just flipping asc/desc forever, so there's
        // a way back to the original ordering without a page reload.
        const prev = panel._mapSort[sortKey];
        if (!prev || prev.key !== col.key) {
          panel._mapSort[sortKey] = { key: col.key, asc: true };
        } else if (prev.asc) {
          panel._mapSort[sortKey] = { key: col.key, asc: false };
        } else {
          panel._mapSort[sortKey] = null;
        }
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
        else renderMapSidebar(panel, regionId, view);
      });
      colhead.appendChild(span);
    });

    list.innerHTML = '';
    const items = sortMapItems(isTournaments ? data.tournamentsList : data.playersList, currentSort, columns);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'map-sidebar-empty';
      li.textContent = 'No ' + view + ' from here yet.';
      list.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.appendChild(mapFlagNameSpan(item));
      if (isTournaments) {
        const dateSpan = document.createElement('span');
        dateSpan.className = 'standings-record';
        dateSpan.textContent = item.d || '';
        li.appendChild(dateSpan);
      } else {
        const rankSpan = document.createElement('span');
        rankSpan.className = 'standings-record';
        // A doubles-only player has no Power Ranking placement/rating (never
        // touches the Glicko engine) -- shown as an em dash / "Unranked"
        // instead of "#null"/"null ± null".
        rankSpan.textContent = item.rank != null ? '#' + item.rank : '—';
        li.appendChild(rankSpan);
        const ratingSpan = document.createElement('span');
        ratingSpan.className = 'standings-record';
        ratingSpan.textContent = item.v != null ? item.v + ' ± ' + item.rd : 'Unranked';
        li.appendChild(ratingSpan);
        const lastActiveSpan = document.createElement('span');
        lastActiveSpan.className = 'standings-record';
        lastActiveSpan.textContent = item.la || '';
        li.appendChild(lastActiveSpan);
      }
      list.appendChild(li);
    });
  }

  function zoomToRegion(svg, regionEl) {
    const bbox = regionEl.getBBox();
    const padFactor = 0.4;
    const minSize = 40;
    const w = Math.max(bbox.width * (1 + padFactor * 2), minSize);
    const h = Math.max(bbox.height * (1 + padFactor * 2), minSize);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    animateViewBox(svg, [cx - w / 2, cy - h / 2, w, h], 450);
  }

  function zoomMapHome(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length === 4 && home.every((n) => !isNaN(n))) animateViewBox(svg, home, 450);
  }

  // Two-finger pinch zoom on the map SVG specifically (touch-only — desktop
  // mouse users are unaffected). touch-action:none on .map-svg (see writeCss)
  // stops the browser from treating this as a page-level gesture first.
  // Zoom is anchored at the pinch midpoint (converted to the SVG's own user
  // space via getScreenCTM, not just the viewBox center) so the point under
  // the fingers stays under the fingers as the box shrinks/grows. Zooming in
  // is capped at 15% of the home width (any closer stops being useful); zoom
  // *out* goes much farther than the home view, all the way to
  // MAP_ZOOM_OUT_MAX_WIDTH (the whole-world box) -- pinching out is the
  // touch equivalent of the wheel-zoom-out below.
  function enableMapPinchZoom(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length !== 4 || home.some((n) => isNaN(n))) return;
    const maxW = MAP_ZOOM_OUT_MAX_WIDTH;
    const minW = home[2] * 0.15;
    let startDist = null;
    let startBox = null;
    let anchor = null;

    function touchDist(touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }
    function toSvgPoint(clientX, clientY) {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      return pt.matrixTransform(ctm.inverse());
    }
    function endPinch() {
      startDist = null;
      startBox = null;
      anchor = null;
    }

    svg.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      startDist = touchDist(e.touches);
      const vb = svg.viewBox.baseVal;
      startBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      anchor = toSvgPoint(
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        (e.touches[0].clientY + e.touches[1].clientY) / 2
      );
    }, { passive: false });

    svg.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !startDist || !startBox || !anchor) return;
      e.preventDefault();
      const scale = startDist / touchDist(e.touches);
      const newW = Math.max(minW, Math.min(maxW, startBox.width * scale));
      const newH = newW * (startBox.height / startBox.width);
      const fx = (anchor.x - startBox.x) / startBox.width;
      const fy = (anchor.y - startBox.y) / startBox.height;
      const [cx, cy, cw, ch] = clampMapBox(anchor.x - fx * newW, anchor.y - fy * newH, newW, newH);
      svg.setAttribute('viewBox', cx.toFixed(2) + ' ' + cy.toFixed(2) + ' ' + cw.toFixed(2) + ' ' + ch.toFixed(2));
    }, { passive: false });

    svg.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
    svg.addEventListener('touchcancel', endPinch);
  }

  // Scrolling/trackpad-swiping while the cursor is over the map zooms it
  // in/out instead of scrolling the page -- anchored at the cursor position
  // (same getScreenCTM technique as pinch zoom above) so the point under the
  // cursor stays under the cursor as the box shrinks/grows. Zooming in is
  // capped at 15% of the home width, same as pinch zoom, but zooming *out*
  // goes much farther than the home view -- all the way out to
  // MAP_ZOOM_OUT_MAX_WIDTH, the whole-world box -- since scrolling out to
  // get an overview is a much more common thing to want than the reverse.
  function enableMapWheelZoom(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length !== 4 || home.some((n) => isNaN(n))) return;
    const maxW = MAP_ZOOM_OUT_MAX_WIDTH;
    const minW = home[2] * 0.15;

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const anchor = pt.matrixTransform(ctm.inverse());
      const vb = svg.viewBox.baseVal;
      // Positive deltaY (scroll down / two-finger swipe down) zooms out,
      // negative zooms in -- matches the usual map-UI scroll convention.
      const factor = Math.exp(e.deltaY * 0.0015);
      const newW = Math.max(minW, Math.min(maxW, vb.width * factor));
      const newH = newW * (vb.height / vb.width);
      const fx = (anchor.x - vb.x) / vb.width;
      const fy = (anchor.y - vb.y) / vb.height;
      const [cx, cy, cw, ch] = clampMapBox(anchor.x - fx * newW, anchor.y - fy * newH, newW, newH);
      svg.setAttribute('viewBox', cx + ' ' + cy + ' ' + cw + ' ' + ch);
    }, { passive: false });
  }

  // Click-and-drag panning with the mouse (desktop only -- touch already has
  // pinch-zoom above, and a single-finger drag there is reserved for tapping
  // a region). Panning only translates the viewBox's x/y, never its
  // width/height, so it never changes zoom level. A drag is distinguished
  // from a plain click by total pointer movement: past DRAG_THRESHOLD px,
  // panel._mapWasDragged is set so enableMapRegions' click handler (added
  // below) can ignore the click a real drag's mouseup would otherwise fire
  // on whatever region element the cursor ends up over.
  const MAP_DRAG_THRESHOLD = 4;
  function enableMapDrag(panel, svg) {
    let dragging = false;
    let moved = false;
    let startClientX = 0;
    let startClientY = 0;
    let startBox = null;

    function svgUnitsPerPixel() {
      const ctm = svg.getScreenCTM();
      if (!ctm || !ctm.a || !ctm.d) return { x: 1, y: 1 };
      return { x: 1 / ctm.a, y: 1 / ctm.d };
    }

    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startClientX = e.clientX;
      startClientY = e.clientY;
      const vb = svg.viewBox.baseVal;
      startBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging || !startBox) return;
      const dxClient = e.clientX - startClientX;
      const dyClient = e.clientY - startClientY;
      if (!moved) {
        if (Math.hypot(dxClient, dyClient) < MAP_DRAG_THRESHOLD) return;
        moved = true;
        panel._mapWasDragged = true;
        svg.classList.add('dragging');
      }
      const scale = svgUnitsPerPixel();
      const dx = dxClient * scale.x;
      const dy = dyClient * scale.y;
      const [cx, cy, cw, ch] = clampMapBox(startBox.x - dx, startBox.y - dy, startBox.width, startBox.height);
      svg.setAttribute('viewBox', cx + ' ' + cy + ' ' + cw + ' ' + ch);
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      startBox = null;
      svg.classList.remove('dragging');
      // Cleared on the next tick rather than immediately so the click event
      // that follows this same mouseup (if any) still sees it set.
      if (moved) setTimeout(() => { panel._mapWasDragged = false; }, 0);
    });
  }

  function enableMapRegions(panel) {
    if (!panel) return;
    const svg = panel.querySelector('.map-svg');
    const regions = [...panel.querySelectorAll('.map-region')];
    const backBtn = panel.querySelector('.map-sidebar-back');
    let selectedId = '__ALL__';
    enableMapPinchZoom(svg);
    enableMapDrag(panel, svg);
    enableMapWheelZoom(svg);

    function currentView() {
      const active = panel.querySelector('.view-btn.active');
      return active ? active.dataset.view : 'players';
    }

    function deselect() {
      regions.forEach((r) => r.classList.remove('selected'));
      selectedId = '__ALL__';
      zoomMapHome(svg);
      renderMapSidebar(panel, selectedId, currentView());
    }

    // Re-clicking the already-selected region deselects it (back to the
    // full map) -- but the browser fires two ordinary click events for a
    // double-click before the dblclick event itself, so double-clicking a
    // region to zoom further in would otherwise immediately trigger this
    // same deselect on its second click. Give the deselect a brief grace
    // period to be canceled by a following dblclick instead of firing it
    // immediately, so a double-click just leaves the region zoomed in.
    let pendingDeselect = null;
    regions.forEach((r) => {
      r.addEventListener('click', () => {
        if (panel._mapWasDragged) return;
        if (selectedId === r.dataset.id) {
          if (pendingDeselect) clearTimeout(pendingDeselect);
          pendingDeselect = setTimeout(() => { pendingDeselect = null; deselect(); }, 300);
          return;
        }
        regions.forEach((other) => other.classList.remove('selected'));
        r.classList.add('selected');
        selectedId = r.dataset.id;
        zoomToRegion(svg, r);
        renderMapSidebar(panel, selectedId, currentView());
      });
      r.addEventListener('dblclick', () => {
        if (pendingDeselect) { clearTimeout(pendingDeselect); pendingDeselect = null; }
      });
    });
    if (backBtn) backBtn.addEventListener('click', deselect);

    // Sidebar always shows a list (the full unfiltered one by default), so
    // populate it immediately rather than waiting for a region click.
    renderMapSidebar(panel, selectedId, currentView());

    panel._mapRefreshSidebar = () => renderMapSidebar(panel, selectedId, currentView());
  }

  // html2canvas draws cross-origin <img> elements (CDN flags, the square's
  // logo) via a raw ctx.drawImage, which silently no-ops on a tainted
  // source instead of throwing -- the image just never appears. Pre-fetch
  // each one and swap its src for a same-origin data: URI before capture
  // sidesteps that entirely (see downloadRankingsImage).
  async function inlineImages(root) {
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map(async (img) => {
      try {
        const resp = await fetch(img.src);
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        img.src = dataUrl;
      } catch (_) {
        // Leave the original src; ignoreElements below drops it from the
        // render instead of leaving a broken/cross-origin image in place.
      }
    }));
  }

  // html2canvas doesn't honor object-fit on <img> (a longstanding upstream
  // limitation) -- it just stretches the source bitmap to fill the element's
  // full box, ignoring .prc-flag's object-fit: contain. Live, that CSS
  // letterboxes each flag to its own real aspect ratio inside the 1.5em x
  // 1.15em box (so e.g. the UK flag's wider ~2:1 shape renders smaller than
  // the box rather than stretched to fill it); in the export every flag was
  // instead coming out uniformly squashed to the box's own ~1.3:1 shape.
  // Bake the same contain math into real pixels instead: draw each flag
  // (already same-origin after inlineImages) onto a canvas sized to the
  // box's own rendered dimensions, scaled/centered exactly like
  // object-fit: contain would, and swap the <img> src for that -- so the
  // stretch has nothing left to distort. Must run after inlineImages (needs
  // a decodable same-origin/data: src) and after the clone is attached with
  // its final layout (needs real getBoundingClientRect() sizes).
  async function bakeFlagAspect(root) {
    const imgs = [...root.querySelectorAll('img.prc-flag')];
    await Promise.all(imgs.map(async (img) => {
      if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;
      const rect = img.getBoundingClientRect();
      const boxW = Math.max(1, Math.round(rect.width * 2));
      const boxH = Math.max(1, Math.round(rect.height * 2));
      const scale = Math.min(boxW / iw, boxH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const canvas = document.createElement('canvas');
      canvas.width = boxW;
      canvas.height = boxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (boxW - dw) / 2, (boxH - dh) / 2, dw, dh);
      img.src = canvas.toDataURL('image/png');
    }));
  }

  // Captures the top 100 ranked cards passing the default min-games/max-RD
  // filter (same 5+/<=150 thresholds as the default view, regardless of
  // whatever the live min-games/max-RD/state selects are currently set to)
  // plus the .pr-square promo tile into an offscreen clone forced to the
  // 8-column desktop layout, so the exported image is consistent regardless
  // of the current viewport width or filter state.
  async function downloadRankingsImage(panel) {
    const grid = panel.querySelector('.pr-grid');
    if (!grid || !window.html2canvas) throw new Error('Power Ranking grid or html2canvas unavailable');
    // Custom fonts may not have finished loading yet, and this also ensures
    // the metrics fitCardNames() measures below are accurate.
    await document.fonts.ready;
    const square = grid.querySelector('.pr-square');
    const qualifying = [...grid.querySelectorAll(':scope > .pr-card')].filter((c) => {
      const games = parseInt(c.dataset.games || '0', 10);
      const rd = parseFloat(c.dataset.rd || '0');
      return games >= 5 && rd <= 150;
    });
    const cards = qualifying.slice(0, 100);
    const clone = document.createElement('div');
    // Carries the live rank-delta toggle state along into the export --
    // .show-rank-delta isn't #rankings-tab-scoped specifically so this plain
    // <body> child can match it too (see the CSS rule for why).
    clone.className = 'pr-grid pr-export-grid' + (panel.classList.contains('show-rank-delta') ? ' show-rank-delta' : '');
    clone.style.gridTemplateColumns = 'repeat(8, 1fr)';
    // Pinned to this specific width (rather than the live grid's current
    // width) so every download comes out identically sized -- this is
    // whatever .pr-grid measured on the developer's own screen, not a
    // computed/responsive value. Retune by hand if it ever needs to change.
    // box-sizing is forced back to content-box here (overriding the site's
    // global * { box-sizing: border-box } reset) so this width is the actual
    // content/column width, matching .pr-grid's own measured width exactly --
    // otherwise the padding below would eat into it and every card would
    // render slightly narrower than the live site's.
    clone.style.boxSizing = 'content-box';
    clone.style.width = '1472px';
    clone.style.padding = '24px';
    clone.style.background = '#050505';
    if (square) {
      const squareClone = square.cloneNode(true);
      squareClone.style.display = 'flex';
      clone.appendChild(squareClone);
    }
    // Cards already passed the games/RD check above, but may still carry a
    // hidden attribute from a live state-filter selection (cloneNode
    // preserves it, and left alone it'd collapse the clone to zero size) --
    // force every one of the top 100 visible and renumbered 1-100, since the
    // export always shows all locations regardless of the live state filter.
    cards.forEach((c, idx) => {
      const cardClone = c.cloneNode(true);
      cardClone.hidden = false;
      cardClone.classList.remove('filter-dim', 'uncertain');
      // Only the numeral, not the whole .prc-rank -- that would also wipe
      // out the sibling .rank-delta badge (and rank-plain's color class),
      // which should survive the renumbering since the rating-point change
      // it shows isn't tied to rank position.
      const rankEl = cardClone.querySelector('.prc-rank .rank-plain');
      if (rankEl) rankEl.textContent = idx + 1;
      clone.appendChild(cardClone);
    });
    document.body.appendChild(clone);
    // html2canvas's own gradient renderer doesn't size a radial-gradient's
    // implicit farthest-corner extent correctly (tried it explicit, tried an
    // explicit percentage size, tried hand-deriving and painting the
    // ellipse ourselves via Canvas2D -- none matched the live page's actual
    // rendered gradient). Instead of reimplementing it at all, literally
    // copy the real thing: render an actual .pr-card.card-green/.card-purple
    // through an SVG foreignObject, which uses the browser's own genuine CSS
    // engine (not a reimplementation), rasterize that to a bitmap, and use
    // it as a background-image -- html2canvas draws real images reliably,
    // just not live CSS gradients.
    const glowCache = {};
    // Same as .pr-card.card-green/.card-purple's CSS -- inlined directly
    // rather than referenced by class, since the foreignObject below is
    // serialized to a standalone SVG document with no access to the page's
    // external stylesheet (a class name alone rendered with no styling at
    // all, confirmed by sampling the result: flat, no color whatsoever).
    const glowBackgrounds = {
      'card-green': 'radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%)',
      'card-purple': 'radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%)',
    };
    async function glowDataUri(cardClass, w, h) {
      const key = cardClass + '|' + w + '|' + h;
      if (glowCache[key]) return glowCache[key];
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const fo = document.createElementNS(svgNS, 'foreignObject');
      fo.setAttribute('width', '100%');
      fo.setAttribute('height', '100%');
      const div = document.createElement('div');
      div.style.width = w + 'px';
      div.style.height = h + 'px';
      div.style.margin = '0';
      div.style.background = glowBackgrounds[cardClass];
      fo.appendChild(div);
      svg.appendChild(fo);
      const svgStr = new XMLSerializer().serializeToString(svg);
      const svgUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = svgUri; });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const uri = canvas.toDataURL('image/png');
      glowCache[key] = uri;
      return uri;
    }
    await Promise.all([...clone.querySelectorAll('.pr-card')].map(async (c) => {
      const isGreen = c.classList.contains('card-green');
      const isPurple = c.classList.contains('card-purple');
      if (isGreen || isPurple) {
        const rect = c.getBoundingClientRect();
        const uri = await glowDataUri(isGreen ? 'card-green' : 'card-purple', rect.width, rect.height);
        c.style.background = 'url(' + uri + ')';
        c.style.backgroundSize = '100% 100%';
      } else {
        c.style.background = '#0f0f0f';
      }
    }));
    // cloneNode copies each name's live inline font-size (set by
    // fitCardNames() against the ORIGINAL grid's column width) verbatim --
    // that size is wrong whenever the live grid's current width doesn't
    // match this clone's pinned export width, so names clipped fine on-page
    // can overflow their card here. Re-fit against the clone's actual width
    // now that it's attached to the DOM.
    fitCardNames(clone);
    await inlineImages(clone);
    await bakeFlagAspect(clone);
    // Not wrapped in try/finally -- the caller (the download button's click
    // handler) needs a genuine rejection on failure so it knows to flip back
    // to a clickable, non-"loading" state rather than staying stuck.
    try {
      const canvas = await html2canvas(clone, {
        backgroundColor: '#050505',
        scale: 2,
        useCORS: true,
        ignoreElements: (node) => node.tagName === 'IMG' && !node.src.startsWith('data:'),
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Local date parts (not toISOString(), which is UTC and can read as
      // tomorrow/yesterday depending on the visitor's timezone) -- date
      // only, no time, so repeated same-day downloads share one filename.
      const now = new Date();
      const dateStamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      a.download = 'deathball-power-rankings-' + dateStamp + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      clone.remove();
    }
  }

  // Data behind both CSV-export buttons -- see CSV_PLAYER_DATA/
  // CSV_TOURNAMENT_DATA below and csvPlayerData/csvTournamentData in
  // aggregate_players.js, which build these with their own column set and
  // sort order (seed-ascending for players, oldest-first for tournaments)
  // independent of whatever the visible tables show.
  const CSV_PLAYER_DATA = JSON.parse(document.getElementById('csv-player-data')?.textContent || '[]');
  const CSV_TOURNAMENT_DATA = JSON.parse(document.getElementById('csv-tournament-data')?.textContent || '[]');

  const CSV_DATASETS = {
    players: {
      headers: ['Seed', 'Player', 'Rating', 'RD', 'City', 'State', 'Country', 'Wins', 'Losses', 'Games', 'Win %', 'Last Active', 'Tournaments Attended'],
      rows: () => CSV_PLAYER_DATA.map((p) => [
        p.seed ?? '', p.name, p.rating ?? '', p.rd ?? '', p.city, p.state, p.country, p.wins, p.losses, p.games,
        p.winPct != null ? p.winPct.toFixed(1) + '%' : '', p.lastActive, p.tournamentCount,
      ]),
    },
    tournaments: {
      headers: ['Tournament', 'Date', 'Venue', 'City', 'State', 'Country', 'Source', 'Participants', 'Matches', 'Tournament Type', 'Bracket Type', 'Bracket URL', 'VOD URL'],
      rows: () => CSV_TOURNAMENT_DATA.map((t) => [
        t.name, t.date, t.venue, t.city, t.state, t.country, t.source, t.participants, t.matches,
        t.tournamentType, t.bracketType, t.bracketUrl, t.videoUrl,
      ]),
    },
  };

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsvDataset(datasetKey, filenamePrefix) {
    const dataset = CSV_DATASETS[datasetKey];
    if (!dataset) throw new Error('Unknown CSV dataset: ' + datasetKey);
    const csv = [dataset.headers, ...dataset.rows()].map((row) => row.map(csvEscape).join(',')).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // Local date parts, not toISOString() -- same reasoning as the PNG
    // export's dateStamp (UTC can read as tomorrow/yesterday depending on
    // the visitor's timezone).
    const now = new Date();
    const dateStamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    a.href = url;
    a.download = filenamePrefix + '-' + dateStamp + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Wires every .csv-download-btn on the page (Power Rankings, Players, and
  // Tournaments tabs -- see csvDownloadButtonHtml in aggregate_players.js).
  // Each button's data-csv-key picks which CSV_DATASETS entry to export --
  // the Power Rankings tab's button deliberately shares the Players tab's
  // 'players' key, so both buttons export identical data.
  function enableCsvDownloadButtons() {
    document.querySelectorAll('.csv-download-btn').forEach((btn) => {
      const label = btn.querySelector('.download-btn-label');
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        try {
          downloadCsvDataset(btn.dataset.csvKey, btn.dataset.csvFilename || 'deathball-export');
        } catch (err) {
          btn.classList.add('failed');
          if (label) label.textContent = 'Failed — Retry';
          return;
        }
        btn.classList.remove('failed');
        if (label) label.textContent = 'Download CSV';
      });
    });
  }

  // Two download buttons exist in the DOM at once -- .download-btn-boxed
  // (desktop, inside the Power Rankings tab-controls row) and
  // .download-btn-icon (mobile, top-right of .page-title-row, so it stays
  // reachable regardless of whether the mobile Options panel is collapsed)
  // -- CSS shows exactly one of them per viewport (see writeCss), but both
  // need the same show/hide state, which depends on which tab and which
  // view (Grid vs Table) are active. Both enableTabs (tab switch) and
  // enableViewToggle (view switch) call this after they change either one.
  function updateDownloadVisibility() {
    const btns = document.querySelectorAll('.download-btn');
    if (!btns.length) return;
    const rankingsPanel = document.getElementById('rankings-tab');
    const rankingsActive = !!rankingsPanel && rankingsPanel.classList.contains('active');
    const gridActive = !!rankingsPanel && !!rankingsPanel.querySelector('.view-btn[data-view="grid"].active');
    const hide = !(rankingsActive && gridActive);
    btns.forEach((btn) => { btn.hidden = hide; });
  }

  // The Power Rankings tab's CSV button (unlike the Players/Tournaments
  // tabs' own, which are always shown) is grid/table-gated the opposite way
  // to the PNG button above -- a full CSV export of every player doesn't
  // pair with "top 100 grid" the way the PNG image does, so it only makes
  // sense once Table view is active. Scoped to #rankings-tab specifically so
  // it never touches the Players/Tournaments tabs' own CSV buttons.
  function updateCsvDownloadVisibility() {
    const rankingsPanel = document.getElementById('rankings-tab');
    if (!rankingsPanel) return;
    const csvBtn = rankingsPanel.querySelector('.csv-download-btn');
    if (!csvBtn) return;
    const tableActive = !!rankingsPanel.querySelector('.view-btn[data-view="table"].active');
    csvBtn.hidden = !tableActive;
  }

  function enableViewToggle(panel) {
    const buttons = [...panel.querySelectorAll('.view-btn')];
    if (!buttons.length) return;
    const grid = panel.querySelector('.pr-grid');
    const table = panel.querySelector('table');
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    // The rank-delta badge only ever exists in the card markup (see
    // rankDeltaHtml's call sites), so its show/hide pill is meaningless --
    // and would sit there inert -- once the Table view is active.
    const rankDeltaToggle = panel.querySelector('.rank-delta-toggle');
    // Loading state disables the button entirely (so a second click can't
    // start a second concurrent export mid-generation, which is otherwise
    // easy to trigger since generation takes a couple of seconds and gave
    // no visible feedback before this). A failed attempt clears back to the
    // normal enabled state (not "loading") so the button is clickable again
    // to retry, rather than getting stuck disabled forever. Only one of the
    // two buttons is ever visible/clickable at once (see writeCss), but the
    // listener is attached to both independently -- each just drives its
    // own loading/failed state and the same downloadRankingsImage call.
    document.querySelectorAll('.download-btn').forEach((downloadBtn) => {
      const downloadLabel = downloadBtn.querySelector('.download-btn-label');
      const iconSlot = downloadBtn.querySelector('.download-icon-slot');
      const check = downloadBtn.querySelector('.t-success-check');
      downloadBtn.addEventListener('click', async () => {
        if (downloadBtn.disabled) return;
        downloadBtn.disabled = true;
        downloadBtn.classList.remove('failed');
        downloadBtn.classList.add('loading');
        if (iconSlot) iconSlot.dataset.state = 'loading';
        if (downloadLabel) downloadLabel.textContent = 'Preparing…';
        try {
          await downloadRankingsImage(panel);
          if (downloadLabel) downloadLabel.textContent = 'Download Top 100';
          // Brief success-check flash (see the transitions-dev success-check
          // + icon-swap pairing) before settling back to the idle icon --
          // paired instead of left showing indefinitely since this button
          // gets clicked repeatedly, not once like a form submit.
          if (iconSlot) iconSlot.dataset.state = 'success';
          if (check) {
            check.dataset.state = 'out';
            void check.offsetWidth;
            check.dataset.state = 'in';
          }
          setTimeout(() => {
            if (iconSlot) iconSlot.dataset.state = 'idle';
            if (check) check.dataset.state = 'out';
          }, 1400);
        } catch (err) {
          downloadBtn.classList.add('failed');
          if (downloadLabel) downloadLabel.textContent = 'Failed — Retry';
          if (iconSlot) iconSlot.dataset.state = 'idle';
        } finally {
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('loading');
        }
      });
    });
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (grid) grid.style.display = view === 'grid' ? '' : 'none';
        if (table) table.style.display = view === 'table' ? '' : 'none';
        updateDownloadVisibility();
        updateCsvDownloadVisibility();
        // Desktop collapses this pill entirely on Table view (see
        // .rank-delta-toggle[hidden] in writeCss); mobile overrides that
        // same [hidden] rule back to display:flex + visibility:hidden so it
        // still reserves its space instead of shifting the Min Games/Max RD
        // controls next to it.
        if (rankDeltaToggle) rankDeltaToggle.hidden = view !== 'grid';
        moveIndicator(indicator, toggleEl, btn);
        // Also refreshes the "Click a column header to sort." hint for the
        // view just switched to.
        applyFilters(panel);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    updateDownloadVisibility();
    updateCsvDownloadVisibility();
    if (rankDeltaToggle) rankDeltaToggle.hidden = !activeBtn || activeBtn.dataset.view !== 'grid';
    moveIndicator(indicator, toggleEl, activeBtn);
  }

  // Show/Hide pill for the rank-delta (up/down/new) badge on Power Ranking
  // cards -- see #rankings-tab.show-rank-delta in the generated CSS, which
  // is the only thing that actually reveals .rank-delta. Off by default
  // (see the "hide" button's initial "active" class in writeHtml()) so the
  // badge doesn't compete for attention on the grid every time.
  function enableRankDeltaToggle(panel) {
    const toggleEl = panel.querySelector('.rank-delta-toggle');
    if (!toggleEl) return;
    const buttons = [...toggleEl.querySelectorAll('.delta-btn')];
    const indicator = toggleEl.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        panel.classList.toggle('show-rank-delta', btn.dataset.delta === 'show');
        moveIndicator(indicator, toggleEl, btn);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, activeBtn);
  }

  // Rebuilds .pr-card/.pr-card accents and the rank-delta badge from raw
  // row data -- mirrors cardAccent()/rankDeltaState()/rankDeltaHtml() in
  // aggregate_players.js. Kept in sync by hand: the "View rankings at"
  // dropdown (PR_HISTORY, see enablePrHistorySelect below) only ships each
  // checkpoint's *data*, not pre-rendered HTML, so switching checkpoints
  // re-renders the grid/table client-side the same way the map tab's
  // sidebar re-renders from MAP_REGION_DATA.
  function prCardAccent(id, colorOverride) {
    if (colorOverride === 'green' || colorOverride === 'purple') return 'card-' + colorOverride;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    return (h & 1) ? 'card-purple' : 'card-green';
  }

  function prRankDeltaState(row) {
    if (row.isNew) return 'new';
    if (!row.placementChange) return null;
    return row.placementChange > 0 ? 'up' : 'down';
  }

  function prRankDeltaBadge(row) {
    const state = prRankDeltaState(row);
    if (!state) return null;
    const span = document.createElement('span');
    if (state === 'new') {
      span.className = 'rank-delta rank-delta-new';
      span.textContent = 'NEW';
    } else if (state === 'up') {
      span.className = 'rank-delta rank-delta-up';
      span.textContent = '▲' + row.placementChange;
    } else {
      span.className = 'rank-delta rank-delta-down';
      span.textContent = '▼' + Math.abs(row.placementChange);
    }
    return span;
  }

  function prFlagImg(flag, className) {
    if (!flag) return null;
    const img = document.createElement('img');
    img.className = className;
    img.src = flag.src;
    img.title = flag.title;
    img.alt = flag.title;
    return img;
  }

  function buildRankingCard(row, meta, rank) {
    const card = document.createElement('div');
    card.className = 'pr-card ' + prCardAccent(row.id, meta.color) + (row.uncertain ? ' uncertain' : '');
    card.dataset.games = row.games;
    card.dataset.rd = row.rd;
    if (meta.state) card.dataset.state = meta.state;
    if (meta.country) card.dataset.country = meta.country;

    const top = document.createElement('div');
    top.className = 'prc-top';

    const rankSpan = document.createElement('span');
    rankSpan.className = 'prc-rank';
    const rankPlain = document.createElement('span');
    const deltaState = prRankDeltaState(row);
    rankPlain.className = 'rank-plain' + (deltaState ? ' rank-plain-' + deltaState : '');
    rankPlain.textContent = rank;
    rankSpan.appendChild(rankPlain);
    const badge = prRankDeltaBadge(row);
    if (badge) rankSpan.appendChild(badge);
    top.appendChild(rankSpan);

    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    nameEl.className = 'prc-name';
    nameEl.title = meta.name;
    nameEl.textContent = meta.name;
    if (meta.href) nameEl.href = meta.href;
    top.appendChild(nameEl);

    const flagImg = prFlagImg(meta.flag, 'prc-flag');
    if (flagImg) top.appendChild(flagImg);

    card.appendChild(top);

    const stats = document.createElement('div');
    stats.className = 'prc-stats';
    const addVal = (text, cls) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      stats.appendChild(span);
    };
    addVal(String(row.r), 'prc-val');
    addVal('±', 'prc-dim');
    addVal(String(row.rd), 'prc-val');
    addVal('|', 'prc-sep');
    addVal(String(Math.round(row.winPct * 100)), 'prc-val');
    addVal('W%', 'prc-dim');
    addVal('|', 'prc-sep');
    addVal(String(row.games), 'prc-val');
    addVal('gp', 'prc-dim');
    if (meta.locAbbr) {
      const abbrSpan = document.createElement('span');
      abbrSpan.className = 'prc-loc-abbr';
      abbrSpan.title = meta.location;
      abbrSpan.textContent = meta.locAbbr;
      stats.appendChild(abbrSpan);
    }
    card.appendChild(stats);
    return card;
  }

  function buildRankingTableRow(row, meta, rank) {
    const tr = document.createElement('tr');
    tr.dataset.games = row.games;
    tr.dataset.rd = row.rd;
    if (meta.state) tr.dataset.state = meta.state;
    if (meta.country) tr.dataset.country = meta.country;
    if (row.uncertain) tr.className = 'uncertain';

    const rankTd = document.createElement('td');
    rankTd.className = 'rank-num';
    rankTd.textContent = rank;
    tr.appendChild(rankTd);

    const nameTd = document.createElement('td');
    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    if (meta.href) nameEl.href = meta.href;
    nameEl.textContent = meta.name;
    nameTd.appendChild(nameEl);
    tr.appendChild(nameTd);

    const addNumeric = (text, sort) => {
      const td = document.createElement('td');
      td.className = 'numeric';
      if (sort !== undefined) td.dataset.sort = sort;
      td.textContent = text;
      tr.appendChild(td);
    };
    addNumeric(String(row.r));
    addNumeric('±' + row.rd, row.rd);
    addNumeric(String(row.wins), row.wins);
    addNumeric(String(row.losses), row.losses);
    addNumeric(String(row.games), row.games);
    addNumeric((row.winPct * 100).toFixed(1) + '%', row.winPct);

    const lastActiveTd = document.createElement('td');
    lastActiveTd.textContent = meta.lastActive || '';
    tr.appendChild(lastActiveTd);

    const locTd = document.createElement('td');
    locTd.className = 'col-location';
    locTd.dataset.sort = meta.locationSort;
    const flagImg = prFlagImg(meta.flag, 'loc-flag');
    if (flagImg) locTd.appendChild(flagImg);
    locTd.appendChild(document.createTextNode(meta.location));
    tr.appendChild(locTd);

    return tr;
  }

  // Mirrors toClientRow()'s array order in aggregate_players.js:
  // [id, r, rd, wins, losses, games, isNew, placementChange]. winPct/uncertain
  // aren't shipped (cheap to recompute) so they're filled back in here.
  function normalizeRow(arr) {
    const [id, r, rd, wins, losses, games, isNew, placementChange] = arr;
    return {
      id, r, rd, wins, losses, games,
      winPct: games > 0 ? wins / games : 0,
      uncertain: rd > PR_UNCERTAIN_RD_THRESHOLD,
      isNew, placementChange,
    };
  }

  function renderRankingHistory(panel, checkpoint) {
    const grid = panel.querySelector('.pr-grid');
    const tbody = panel.querySelector('table tbody');
    const rows = checkpoint.rows.map(normalizeRow);
    if (grid) {
      [...grid.querySelectorAll(':scope > .pr-card')].forEach((el) => el.remove());
      rows.forEach((row, i) => grid.appendChild(buildRankingCard(row, PR_META[row.id] || {}, i + 1)));
    }
    if (tbody) {
      tbody.innerHTML = '';
      rows.forEach((row, i) => tbody.appendChild(buildRankingTableRow(row, PR_META[row.id] || {}, i + 1)));
    }
    applyFilters(panel);
    fitCardNames(panel);
  }

  // Populates the Rankings tab's "View rankings at" dropdown from PR_HISTORY
  // (one entry per tournament group, chronological) -- most-recent first,
  // with a clock icon marking the current/latest entry. Selecting an older
  // entry swaps the grid/table to that point-in-time standings; filters and
  // the download button both operate on whatever's currently rendered, so
  // they keep working unchanged.
  function enablePrHistorySelect(panel) {
    const select = panel.querySelector('.pr-history-select');
    const label = select ? select.closest('label') : null;
    if (!select || PR_HISTORY.length < 2) {
      if (label) label.hidden = true;
      return;
    }
    for (let i = PR_HISTORY.length - 1; i >= 0; i--) {
      const checkpoint = PR_HISTORY[i];
      const opt = document.createElement('option');
      opt.value = String(i);
      const dateLabel = checkpoint.dateLabel ? checkpoint.dateLabel + ' - ' : '';
      opt.textContent = (checkpoint.isLatest ? '🕒 ' : '') + dateLabel + checkpoint.label;
      if (checkpoint.isLatest) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const checkpoint = PR_HISTORY[parseInt(select.value, 10)];
      if (checkpoint) renderRankingHistory(panel, checkpoint);
    });
  }

  // Progressive enhancement for every select in a .tab-controls row: hides
  // the native select behind a styled button + listbox (see .dd-* in
  // writeCss). The select stays in the DOM as the source of truth -- the
  // custom menu is rebuilt from select.options every time it opens, picking
  // an option sets select.selectedIndex and dispatches a real change event,
  // and a MutationObserver on the select keeps the closed trigger's text in
  // sync when other code rewrites option labels (applyFilters appends live
  // counts to every location option) or appends options after the fact
  // (populateStateFilter, enablePrHistorySelect). So the existing filter
  // code reads/listens to the select exactly as before and never has to
  // know the enhancement exists.
  //
  // Each menu is appended to body and position:fixed'd under its trigger on
  // open (re-measured on scroll/resize while open) rather than nested in the
  // .dd wrapper, because the mobile Power Rankings options accordion is an
  // overflow:hidden box with a filter on it -- nothing positioned inside it
  // could escape that clip.
  let openDropdown = null;
  const DROPDOWN_CLOSE_MS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')) || 150;
  const DROPDOWN_MENU_MAX_PX = 288; // 18rem
  const DROPDOWN_MENU_MAX_WIDTH_PX = 416; // 26rem
  const DROPDOWN_VIEWPORT_PAD = 8;
  const DROPDOWN_GAP = 4;
  let dropdownSeq = 0;

  function svgIcon(cls, viewBox, w, h, d, strokeWidth) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', strokeWidth);
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function enhanceDropdown(select) {
    if (select.dataset.ddEnhanced) return;
    select.dataset.ddEnhanced = '1';
    const id = 'dd-' + (++dropdownSeq);
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    // The select's own class (min-games-select etc.) so CSS can target one
    // dropdown's trigger specifically, e.g. the pr-history clip width.
    wrap.dataset.for = [...select.classList].find((c) => c.endsWith('-select')) || '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dd-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id + '-menu');
    // Flag of the chosen option (only options with data-flag ever show one).
    const triggerFlag = document.createElement('img');
    triggerFlag.className = 'dd-flag';
    triggerFlag.alt = '';
    triggerFlag.hidden = true;
    trigger.appendChild(triggerFlag);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'dd-label';
    trigger.appendChild(labelSpan);
    trigger.appendChild(svgIcon('dd-chevron', '0 0 10 6', '10', '6', 'M1 1l4 4 4-4', '1.5'));
    const menu = document.createElement('ul');
    menu.className = 'dd-menu t-dropdown';
    menu.id = id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    menu.dataset.origin = 'top-left';
    // Name the listbox after the visible "Min games:" / "Location:" label
    // text so screen readers announce what the list is for.
    const label = select.closest('label');
    if (label) {
      const text = [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim().replace(/:$/, '');
      if (text) { trigger.setAttribute('aria-label', text); menu.setAttribute('aria-label', text); }
    }

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(trigger);
    wrap.appendChild(select);
    select.hidden = true;
    select.tabIndex = -1;
    document.body.appendChild(menu);

    let isOpen = false;
    let closeTimer = null;
    let activeIndex = -1;
    let typeBuffer = '';
    let typeTimer = null;

    function syncTrigger() {
      const opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : '';
      const flagSrc = opt ? opt.dataset.flag : '';
      if (flagSrc) {
        if (triggerFlag.getAttribute('src') !== flagSrc) triggerFlag.src = flagSrc;
        triggerFlag.hidden = false;
      } else {
        triggerFlag.hidden = true;
        triggerFlag.removeAttribute('src');
      }
    }
    // The menu's selectable rows (group headers excluded); activeIndex is a
    // position in this list, and each row's data-index is the index of the
    // native option it stands for.
    function items() {
      return [...menu.querySelectorAll('.dd-option')];
    }
    function itemIndexOfOption(optionIndex) {
      return items().findIndex((li) => parseInt(li.dataset.index, 10) === optionIndex);
    }
    function setActive(i, scroll) {
      const list = items();
      if (!list.length) { activeIndex = -1; trigger.removeAttribute('aria-activedescendant'); return; }
      activeIndex = Math.max(0, Math.min(list.length - 1, i));
      list.forEach((li, idx) => li.classList.toggle('is-active', idx === activeIndex));
      const li = list[activeIndex];
      trigger.setAttribute('aria-activedescendant', li.id);
      if (scroll) {
        // Keep the group header above the first row of a group in view too.
        const prev = li.previousElementSibling;
        const top = prev && prev.classList.contains('dd-group') ? prev.offsetTop : li.offsetTop;
        const bottom = li.offsetTop + li.offsetHeight;
        if (top < menu.scrollTop) menu.scrollTop = top;
        else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
      }
    }
    function chooseActive() {
      const li = items()[activeIndex];
      if (li) choose(parseInt(li.dataset.index, 10));
    }
    function renderOptions() {
      menu.textContent = '';
      const addOption = (opt) => {
        const li = document.createElement('li');
        li.className = 'dd-option';
        li.id = id + '-opt-' + opt.index;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(opt.index === select.selectedIndex));
        li.dataset.index = String(opt.index);
        if (opt.dataset.flag) {
          const img = document.createElement('img');
          img.className = 'dd-flag';
          img.src = opt.dataset.flag;
          img.alt = '';
          img.loading = 'lazy';
          li.appendChild(img);
        }
        const span = document.createElement('span');
        span.className = 'dd-option-label';
        span.textContent = opt.textContent;
        li.appendChild(span);
        li.appendChild(svgIcon('dd-option-check', '0 0 12 10', '12', '10', 'M1 5.5l3.2 3L11 1.5', '1.8'));
        menu.appendChild(li);
      };
      // Walk the select's own children so optgroups become section headers.
      for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
          const head = document.createElement('li');
          head.className = 'dd-group';
          head.setAttribute('role', 'presentation');
          head.textContent = child.label;
          menu.appendChild(head);
          for (const opt of child.children) if (opt.tagName === 'OPTION') addOption(opt);
        } else if (child.tagName === 'OPTION') {
          addOption(child);
        }
      }
    }
    function position() {
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const below = vh - r.bottom - DROPDOWN_GAP - DROPDOWN_VIEWPORT_PAD;
      const above = r.top - DROPDOWN_GAP - DROPDOWN_VIEWPORT_PAD;
      menu.style.minWidth = r.width + 'px';
      menu.style.maxWidth = Math.max(r.width, Math.min(vw - DROPDOWN_VIEWPORT_PAD * 2, DROPDOWN_MENU_MAX_WIDTH_PX)) + 'px';
      menu.style.maxHeight = Math.max(96, Math.min(DROPDOWN_MENU_MAX_PX, Math.max(below, above))) + 'px';
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const up = mh > below && above > below;
      let left = r.left;
      if (left + mw > vw - DROPDOWN_VIEWPORT_PAD) left = Math.max(DROPDOWN_VIEWPORT_PAD, vw - DROPDOWN_VIEWPORT_PAD - mw);
      const top = up ? r.top - DROPDOWN_GAP - mh : r.bottom + DROPDOWN_GAP;
      menu.style.left = left + 'px';
      menu.style.top = Math.max(DROPDOWN_VIEWPORT_PAD, top) + 'px';
      menu.dataset.origin = up ? 'bottom-left' : 'top-left';
    }
    function open() {
      if (isOpen) return;
      if (openDropdown && openDropdown !== api) openDropdown.close();
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      renderOptions();
      isOpen = true;
      openDropdown = api;
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.classList.remove('is-closing');
      position();
      menu.classList.add('is-open');
      setActive(itemIndexOfOption(select.selectedIndex), true);
      // Safari/Firefox-on-mac don't focus a button on click, so pull focus
      // in explicitly -- the key handlers and aria-activedescendant live on
      // the trigger.
      trigger.focus();
      window.addEventListener('scroll', position, { capture: true, passive: true });
      window.addEventListener('resize', position);
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (openDropdown === api) openDropdown = null;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      menu.classList.remove('is-open');
      menu.classList.add('is-closing');
      closeTimer = setTimeout(() => { menu.classList.remove('is-closing'); closeTimer = null; }, DROPDOWN_CLOSE_MS);
      window.removeEventListener('scroll', position, { capture: true });
      window.removeEventListener('resize', position);
    }
    function choose(i) {
      if (i < 0 || i >= select.options.length) return;
      const changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      syncTrigger();
      close();
      trigger.focus();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Native-select style type-to-jump: typing letters hops to the first
    // option starting with them; repeating one letter cycles through its
    // matches. Works on the closed control too (picks directly).
    function typeahead(ch) {
      if (typeTimer) clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typeBuffer = ''; }, 600);
      const repeat = typeBuffer.length > 0 && typeBuffer.split('').every((c) => c === ch);
      typeBuffer += ch;
      const needle = repeat ? ch : typeBuffer;
      const list = isOpen ? items() : (renderOptions(), items());
      const labels = list.map((li) => li.querySelector('.dd-option-label').textContent.trim().toLowerCase());
      const current = isOpen ? activeIndex : itemIndexOfOption(select.selectedIndex);
      const start = current + (needle.length === 1 ? 1 : 0);
      for (let k = 0; k < labels.length; k++) {
        const idx = (start + k) % labels.length;
        if (labels[idx].startsWith(needle)) {
          if (isOpen) setActive(idx, true); else choose(parseInt(list[idx].dataset.index, 10));
          return;
        }
      }
    }

    trigger.addEventListener('click', () => { if (isOpen) close(); else open(); });
    trigger.addEventListener('keydown', (e) => {
      const n = select.options.length;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) open(); else setActive(activeIndex + 1, true);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!isOpen) open(); else setActive(activeIndex - 1, true);
          break;
        case 'Home':
          if (isOpen) { e.preventDefault(); setActive(0, true); }
          break;
        case 'End':
          if (isOpen) { e.preventDefault(); setActive(n - 1, true); }
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (isOpen) chooseActive(); else open();
          break;
        case 'Escape':
          if (isOpen) { e.preventDefault(); close(); }
          break;
        case 'Tab':
          close();
          break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            typeahead(e.key.toLowerCase());
          }
      }
    });
    // Keep keyboard focus on the trigger while the mouse works the menu, so
    // aria-activedescendant and the key handlers above stay live.
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('mouseover', (e) => {
      const li = e.target.closest('.dd-option');
      if (li) setActive(items().indexOf(li), false);
    });
    menu.addEventListener('click', (e) => {
      const li = e.target.closest('.dd-option');
      if (li) choose(parseInt(li.dataset.index, 10));
    });

    new MutationObserver(() => {
      syncTrigger();
      if (isOpen) { renderOptions(); setActive(activeIndex, false); position(); }
    }).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    syncTrigger();

    const api = { close, contains: (node) => wrap.contains(node) || menu.contains(node) || (!!label && label.contains(node)) };
    return api;
  }

  function enhanceDropdowns() {
    document.querySelectorAll('.tab-controls select').forEach(enhanceDropdown);
    // Click/tap anywhere outside the open dropdown closes it. The wrapping
    // label counts as inside: a click on its text re-dispatches a click on
    // the trigger, which would otherwise close-then-reopen the menu.
    document.addEventListener('pointerdown', (e) => {
      if (openDropdown && !openDropdown.contains(e.target)) openDropdown.close();
    }, true);
  }

  function initPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    populateStateFilter(panel);
    applyFilters(panel);
    if (panelId === 'rankings-tab') enablePrHistorySelect(panel);
    panel.querySelectorAll('.min-games-select, .max-rd-select, .state-filter-select').forEach((el) => {
      el.addEventListener('change', () => applyFilters(panel));
    });
    enableViewToggle(panel);
    enableRankDeltaToggle(panel);
    document.fonts.ready.then(() => fitCardNames(panel));
  }

  // Both the Events tab grid and the pr-square's "Next Tournament" callout
  // are baked at generation time using the build machine's today (see
  // sortedUpcomingEvents() / buildEventsTabHtml() in aggregate_players.js).
  // If the site isn't regenerated the same day an event's date passes, the
  // static HTML still shows it as upcoming. Re-filter both against the
  // *visitor's* today here so a stale build still self-corrects in the
  // browser instead of waiting on a rebuild.
  function setupLiveEventFiltering() {
    // Built from local date parts, not toISOString(), for the same reason
    // as todayIso() server-side: UTC parsing can read as tomorrow/yesterday
    // depending on the visitor's timezone.
    const d = new Date();
    const today = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;

    const grid = document.getElementById('events-grid');
    if (grid) {
      const cards = [...grid.querySelectorAll('.event-card[data-date]')];
      // A blank data-date (no date on file for that event) can't be checked
      // against today, so it's always kept rather than treated as expired.
      cards.forEach((card) => { card.hidden = Boolean(card.dataset.date) && card.dataset.date < today; });
      const anyVisible = cards.some((card) => !card.hidden);
      grid.hidden = !anyVisible;
      const empty = document.getElementById('events-empty');
      const footer = document.getElementById('events-footer');
      if (empty) empty.hidden = anyVisible;
      if (footer) footer.hidden = !anyVisible;
    }

    const candidatesWrap = document.getElementById('pr-square-next-candidates');
    if (candidatesWrap) {
      const candidates = [...candidatesWrap.querySelectorAll('.next-event-candidate[data-date]')];
      // Same blank-date carve-out as the grid above -- a dateless candidate
      // never "expires" client-side.
      const chosen = candidates.find((c) => !c.dataset.date || c.dataset.date >= today);
      candidates.forEach((c) => { c.hidden = c !== chosen; });
      const single = document.getElementById('pr-square-latest-single');
      const plural = document.getElementById('pr-square-latest-plural');
      if (single) single.hidden = !chosen;
      if (plural) plural.hidden = !!chosen;
    }
  }

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  enableTabsMenu();
  activateTabFromQuery();
  enableOptionsToggle();
  initPanel('players-tab');
  initPanel('rankings-tab');
  enhanceDropdowns();
  enableCsvDownloadButtons();
  enableMapToggle(document.getElementById('map-tab'));
  enableMapRegions(document.getElementById('map-tab'));
  setupLiveEventFiltering();

  // Every indicator above was positioned/sized against whatever font was
  // rendering at that moment — on first paint that's often the fallback
  // font, since Rajdhani/Orbitron load async, so the underline/pill can end
  // up too wide or narrow until something else (a click) recomputes it.
  // Re-measure the tab underline and any currently-visible view-toggle pill
  // once the real fonts are in so page load always lands on the right size.
  document.fonts.ready.then(() => {
    moveIndicator(document.querySelector('.tab-underline'), document.querySelector('.tabs'), document.querySelector('.tab-button.active'));
    document.querySelectorAll('.view-toggle').forEach((toggleEl) => {
      if (!toggleEl.offsetWidth) return; // hidden panel — its own tab click handler will fix this when it opens
      const indicator = toggleEl.querySelector('.view-toggle-indicator');
      const active = toggleEl.querySelector('.view-btn.active, .delta-btn.active');
      if (indicator && active) moveIndicator(indicator, toggleEl, active);
    });
  });
})();
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.js'), stripJsComments(js));
}

// Strips comments out of the <style>/<script> blocks inside an HTML
// fragment while leaving the surrounding markup untouched -- running
// stripJsComments over raw HTML directly is unsafe (a "</script>" tag's "/"
// reads as regex-context to the JS tokenizer and it goes hunting for a
// closing "/" through the rest of the markup), so each block's inner text
// is extracted and stripped with the matching CSS/JS stripper instead.
function stripCommentsInHeadBlocks(html) {
  return html
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, open, body, close) => open + stripCssComments(body) + close)
    .replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g, (m, open, body, close) => open + stripJsComments(body) + close);
}

module.exports = { writeCss, writeJs, stripCssComments, stripJsComments, stripCommentsInHeadBlocks };
