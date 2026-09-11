"use strict";

// Palette from github.com/yocox/meowdoku/issues/1 ("bright12"). It is two rings
// of six: a light and a dark version of the same six hues (紅 橘 黃 青 藍 紫).
//
// The order below looks shuffled but is not — it is the ring order permuted by
// slot = (regionId * 7) % 12, baked in. Regions are handed out in order, so
// consecutive ids would otherwise land on neighbouring hues, the hardest pair
// to tell apart side by side. A stride of 7 is coprime with 12, so every slot
// is still used exactly once while consecutive ids always land 5 slots apart —
// the widest separation a 12-colour cycle allows. Re-sorting this list back
// into hue order would silently destroy that, so don't.
//
// This is the factory default. The active palette (REGION_COLORS below) can
// be overwritten by the user via the palette editor in Settings; this array
// is what "恢復預設" restores.
const DEFAULT_REGION_COLORS = [
  "#FF9676",  // 亮紅
  "#B66C00",  // 暗橘
  "#BCDD76",  // 亮黃
  "#009865",  // 暗青
  "#41D1FF",  // 亮藍
  "#946DC5",  // 暗紫
  "#C25A6F",  // 暗紅
  "#FDC35E",  // 亮橘
  "#828900",  // 暗黃
  "#4FEACF",  // 亮青
  "#3584CD",  // 暗藍
  "#FF9FDB",  // 粉桃
];

// Same twelve, dimmed for crossed-out cells: OKLab lightness ×0.7, chroma ×0.5.
// Scaling in OKLab rather than with `filter: brightness() saturate()` matters —
// that filter works in sRGB, which washes the light ring out to a flat grey
// instead of a dimmer version of itself. OKLab's separate lightness and chroma
// axes keep the hue, so a crossed-out cell still reads as its own region.
// Precomputed because the input is a fixed list; a custom palette's dimmed
// variant is instead computed at runtime by dimColor() below, using the same
// OKLab math (verified to reproduce this table exactly).
const DEFAULT_REGION_COLORS_DIM = [
  "#926253",  // 亮紅
  "#664522",  // 暗橘
  "#778659",  // 亮黃
  "#275841",  // 暗青
  "#467E93",  // 亮藍
  "#57466D",  // 暗紫
  "#6D3D45",  // 暗紅
  "#957A50",  // 亮橘
  "#4E5223",  // 暗黃
  "#4F8C7F",  // 亮青
  "#2F5071",  // 暗藍
  "#946883",  // 粉桃
];

// Active palette. Starts as the defaults; loadPalette() below overwrites both
// arrays in place if the user saved a custom palette in an earlier session.
let REGION_COLORS = DEFAULT_REGION_COLORS.slice();
let REGION_COLORS_DIM = DEFAULT_REGION_COLORS_DIM.slice();

const EMPTY = 0, MARK = 1, CAT = 2, HYPO = 3, WRONG = 4;
const HEARTS_MAX = 3;
const DOUBLE_TAP_MS = 300;
const DRAG_THRESHOLD_PX = 6;

// ── Color math (sRGB <-> linear <-> OKLab) ──────────────────────────────────
// Used to derive a dimmed variant of any user-chosen region color. Matrices
// from Björn Ottosson's OKLab writeup; verified against DEFAULT_REGION_COLORS_DIM
// above (same ×0.7 lightness / ×0.5 chroma scaling) before wiring this up.

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
  const h = (v) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}
function linearRgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}
function oklabToLinearRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}
function dimColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  let { L, a, b: bb } = linearRgbToOklab(lr, lg, lb);
  L *= 0.7; a *= 0.5; bb *= 0.5;
  const o = oklabToLinearRgb(L, a, bb);
  return rgbToHex(linearToSrgb(o.r), linearToSrgb(o.g), linearToSrgb(o.b));
}

// ── Custom palette persistence ──────────────────────────────────────────────

function loadPalette() {
  try {
    const raw = JSON.parse(localStorage.getItem("meowdoku_palette") || "null");
    if (Array.isArray(raw) && raw.length === 12 && raw.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) {
      REGION_COLORS = raw.slice();
      REGION_COLORS_DIM = REGION_COLORS.map(dimColor);
    }
  } catch { }
}
function savePalette() {
  try { localStorage.setItem("meowdoku_palette", JSON.stringify(REGION_COLORS)); } catch { }
}
function refreshBoardColors() {
  if (!state.n) return;
  for (let r = 0; r < state.n; r++) for (let c = 0; c < state.n; c++) updateCellView(r, c);
}
function setPaletteColor(idx, hex) {
  REGION_COLORS[idx] = hex;
  REGION_COLORS_DIM[idx] = dimColor(hex);
  savePalette();
  refreshBoardColors();
}
function resetPalette() {
  REGION_COLORS = DEFAULT_REGION_COLORS.slice();
  REGION_COLORS_DIM = DEFAULT_REGION_COLORS_DIM.slice();
  try { localStorage.removeItem("meowdoku_palette"); } catch { }
  renderPaletteEditor();
  refreshBoardColors();
}
loadPalette();

// User-facing toggles — persisted across sessions.
const settings = (() => {
  try {
    const s = JSON.parse(localStorage.getItem("meowdoku_settings") || "{}");
    return { sound: s.sound !== false, vibrate: s.vibrate !== false, autoElim: !!s.autoElim, hypo: !!s.hypo, showHelp: s.showHelp !== false };
  } catch { return { sound: true, vibrate: true, autoElim: false, hypo: false, showHelp: true }; }
})();

function saveSettings() {
  try { localStorage.setItem("meowdoku_settings", JSON.stringify(settings)); } catch { }
}

// Star tracking: { "n:idx": 1|2|3 }. Migrates old array format to object.
function getStars() {
  try {
    const raw = JSON.parse(localStorage.getItem("meowdoku_done") || "{}");
    if (Array.isArray(raw)) { const o = {}; raw.forEach(k => { o[k] = 1; }); return o; }
    return (typeof raw === "object" && raw !== null) ? raw : {};
  } catch { return {}; }
}
function saveStars(n, idx, stars) {
  const data = getStars();
  const key = `${n}:${idx}`;
  if ((data[key] || 0) < stars) data[key] = stars;
  try { localStorage.setItem("meowdoku_done", JSON.stringify(data)); } catch { }
}

const state = {
  sizes: {},        // { "8": levelCount, ... }
  n: null,
  levelIdx: null,
  regions: null,     // n x n array of region ids (0..n-1)
  solution: null,    // solution[row] = column of the true cat
  board: null,       // n x n array of EMPTY/MARK/CAT
  hearts: HEARTS_MAX,
  gameOver: false,
  timerStart: null,     // Date.now() at first board interaction this level, or null
  timerFrozenMs: null,  // elapsed ms once the timer has stopped (win/loss), or null while running
};

const el = {
  sizeButtons: document.getElementById("size-buttons"),
  levelButtons: document.getElementById("level-buttons"),
  screenSelect: document.getElementById("screen-select"),
  screenGame: document.getElementById("screen-game"),
  appHeader: document.querySelector(".app-header"),
  board: document.getElementById("board"),
  gameTitle: document.getElementById("game-title"),
  timer: document.getElementById("timer"),
  hearts: document.getElementById("hearts"),
  statusBanner: document.getElementById("status-banner"),
  btnBack: document.getElementById("btn-back"),
  btnRestart: document.getElementById("btn-restart"),
  btnUndo: document.getElementById("btn-undo"),
  btnRedo: document.getElementById("btn-redo"),
  winModal: document.getElementById("win-modal"),
  winTime: document.getElementById("win-time"),
  btnNextLevel: document.getElementById("btn-next-level"),
  btnReplay: document.getElementById("btn-replay"),
  btnModalBack: document.getElementById("btn-modal-back"),
  helpModal: document.getElementById("help-modal"),
  btnHelpClose: document.getElementById("btn-help-close"),
  btnToggleHypo: document.getElementById("btn-toggle-hypo"),
  btnSettings: document.getElementById("btn-settings"),
  settingsModal: document.getElementById("settings-modal"),
  btnSettingsClose: document.getElementById("btn-settings-close"),
  btnHelpOpen: document.getElementById("btn-help-open"),
  btnToggleSound: document.getElementById("btn-toggle-sound"),
  btnToggleVibrate: document.getElementById("btn-toggle-vibrate"),
  btnToggleAuto: document.getElementById("btn-toggle-auto"),
  paletteEditor: document.getElementById("palette-editor"),
  btnPaletteReset: document.getElementById("btn-palette-reset"),
};

// ── Audio ────────────────────────────────────────────────────────────────────
// All sounds are synthesised with Web Audio API — no external assets needed.

let _ctx = null;
function _getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

function _tone(freq, type, vol, dur, t) {
  const ctx = _getCtx();
  const s = t !== undefined ? t : ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, s);
  gain.gain.setValueAtTime(vol, s);
  gain.gain.exponentialRampToValueAtTime(0.001, s + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(s);
  osc.stop(s + dur);
}

// Short soft tick for marking/unmarking cells (including each cell during drag).
function playMark() { if (settings.sound) _tone(660, "sine", 0.08, 0.10); }

// Warm ding (fundamental + octave) when a cat is placed correctly.
function playCat() {
  if (!settings.sound) return;
  _tone(880, "sine", 0.18, 0.45); _tone(1760, "sine", 0.08, 0.45);
}

// Sharp descending buzz when a cat guess is wrong.
function playWrong() {
  if (!settings.sound) return;
  const ctx = _getCtx(), t = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(240, t);
  osc.frequency.linearRampToValueAtTime(110, t + 0.40);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.40);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.40);
}

// C-major arpeggio (C E G C) spread over 0.3 s for the win moment.
function playWin() {
  if (!settings.sound) return;
  const ctx = _getCtx(), now = ctx.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => _tone(f, "sine", 0.18, 0.4, now + i * 0.1));
}

// ── Haptic ───────────────────────────────────────────────────────────────────

function vibrate(ms) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(ms); }

// ── Timer ────────────────────────────────────────────────────────────────────
// Starts on the player's first tap/drag on the board, not on level load — so
// the clock doesn't punish thinking ahead before touching anything.

let timerIntervalId = null;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function updateTimerDisplay() {
  if (!el.timer) return;
  if (state.timerStart === null) { el.timer.textContent = "0:00"; return; }
  const elapsed = state.timerFrozenMs !== null ? state.timerFrozenMs : Date.now() - state.timerStart;
  el.timer.textContent = formatElapsed(elapsed);
}
function resetTimer() {
  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
  state.timerStart = null;
  state.timerFrozenMs = null;
  updateTimerDisplay();
}
function startTimerIfNeeded() {
  if (state.timerStart !== null) return;
  state.timerStart = Date.now();
  state.timerFrozenMs = null;
  timerIntervalId = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();
}
function stopTimer() {
  if (state.timerStart !== null && state.timerFrozenMs === null) {
    state.timerFrozenMs = Date.now() - state.timerStart;
  }
  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
  updateTimerDisplay();
}

// ── Undo / redo ──────────────────────────────────────────────────────────────
// Each move is a list of {r, c, prev, cur} cell diffs plus the hearts count
// before/after. A "move" spans one user gesture (a tap, a drag, or a resolved
// double-tap cat placement) so one Undo click reverts exactly what the player
// perceives as one action.

let undoStack = [];
let redoStack = [];
let currentMove = null;

function beginMove() {
  currentMove = { diffMap: new Map(), heartsBefore: state.hearts };
}
function setCell(r, c, val) {
  if (currentMove) {
    const key = r * 1000 + c;
    if (!currentMove.diffMap.has(key)) currentMove.diffMap.set(key, { r, c, prev: state.board[r][c] });
  }
  state.board[r][c] = val;
  updateCellView(r, c);
}
function endMove() {
  if (!currentMove) return;
  const diffs = [...currentMove.diffMap.values()]
    .map((d) => ({ ...d, cur: state.board[d.r][d.c] }))
    .filter((d) => d.prev !== d.cur);
  const heartsBefore = currentMove.heartsBefore;
  const heartsAfter = state.hearts;
  currentMove = null;
  if (diffs.length > 0 || heartsBefore !== heartsAfter) {
    undoStack.push({ diffs, heartsBefore, heartsAfter });
    redoStack = [];
    updateUndoRedoButtons();
  }
}
function pushUndoMove(diffs, heartsBefore, heartsAfter) {
  const real = diffs.filter((d) => d.prev !== d.cur);
  if (real.length === 0 && heartsBefore === heartsAfter) return;
  undoStack.push({ diffs: real, heartsBefore, heartsAfter });
  redoStack = [];
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  if (el.btnUndo) el.btnUndo.disabled = state.gameOver || undoStack.length === 0;
  if (el.btnRedo) el.btnRedo.disabled = state.gameOver || redoStack.length === 0;
}
function doUndo() {
  if (pendingTap) commitPendingTap();
  if (state.gameOver || undoStack.length === 0) return;
  const move = undoStack.pop();
  for (const d of move.diffs) { state.board[d.r][d.c] = d.prev; updateCellView(d.r, d.c); }
  state.hearts = move.heartsBefore;
  renderHearts();
  redoStack.push(move);
  updateUndoRedoButtons();
}
function doRedo() {
  if (state.gameOver || redoStack.length === 0) return;
  const move = redoStack.pop();
  for (const d of move.diffs) { state.board[d.r][d.c] = d.cur; updateCellView(d.r, d.c); }
  state.hearts = move.heartsAfter;
  renderHearts();
  undoStack.push(move);
  updateUndoRedoButtons();
  if (state.hearts <= 0) triggerGameOver();
  else checkWin();
}
function resetUndoRedo() {
  undoStack = [];
  redoStack = [];
  currentMove = null;
  if (pendingTap) { clearTimeout(pendingTap.timer); pendingTap = null; }
  updateUndoRedoButtons();
}

// Per-cell DOM elements, indexed [row][col], created once per level load.
let cellEls = [];

function updateToggleUI() {
  el.btnToggleSound.textContent = settings.sound ? "🔊" : "🔇";
  el.btnToggleVibrate.textContent = settings.vibrate ? "📳" : "📴";
  el.btnToggleAuto.textContent = settings.autoElim ? "開" : "關";
  el.btnToggleSound.classList.toggle("off", !settings.sound);
  el.btnToggleVibrate.classList.toggle("off", !settings.vibrate);
  el.btnToggleAuto.classList.toggle("off", !settings.autoElim);
  el.btnToggleHypo?.classList.toggle("off", !settings.hypo);
}

function renderPaletteEditor() {
  if (!el.paletteEditor) return;
  el.paletteEditor.innerHTML = "";
  REGION_COLORS.forEach((color, idx) => {
    const label = document.createElement("label");
    label.className = "swatch";
    label.title = `區域 ${String.fromCharCode(65 + idx)}`;
    const input = document.createElement("input");
    input.type = "color";
    input.value = color;
    input.addEventListener("input", () => setPaletteColor(idx, input.value));
    label.appendChild(input);
    el.paletteEditor.appendChild(label);
  });
}

async function init() {
  // Bind all event listeners synchronously BEFORE any async operations so that
  // browser caching of an older JS file can never leave buttons unresponsive.
  updateToggleUI();
  renderPaletteEditor();
  updateUndoRedoButtons();
  try { history.replaceState({ screen: "select" }, ""); } catch { }

  el.btnBack.addEventListener("click", () => history.back());
  el.btnRestart.addEventListener("click", () => startLevel(state.n, state.levelIdx));
  el.btnUndo?.addEventListener("click", doUndo);
  el.btnRedo?.addEventListener("click", doRedo);
  el.btnNextLevel?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    startLevel(state.n, state.levelIdx + 1);
  });
  el.btnReplay?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    startLevel(state.n, state.levelIdx);
  });
  el.btnModalBack?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    history.back();
  });

  el.btnHelpClose?.addEventListener("click", () => {
    el.helpModal.classList.add("hidden")
    settings.showHelp = false;
    saveSettings();
  });
  el.helpModal?.addEventListener("click", (e) => {
    if (e.target === el.helpModal) el.helpModal.classList.add("hidden");
  });

  el.btnSettings?.addEventListener("click", () => el.settingsModal.classList.remove("hidden"));
  el.btnSettingsClose?.addEventListener("click", () => el.settingsModal.classList.add("hidden"));
  el.settingsModal?.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) el.settingsModal.classList.add("hidden");
  });
  el.btnHelpOpen?.addEventListener("click", () => {
    el.settingsModal.classList.add("hidden");
    el.helpModal.classList.remove("hidden");
  });
  el.btnPaletteReset?.addEventListener("click", resetPalette);

  window.addEventListener("popstate", () => {
    if (!el.screenGame.classList.contains("hidden")) {
      el.winModal.classList.add("hidden");
      showSelectScreen();
    }
  });

  el.btnToggleSound?.addEventListener("click", () => {
    settings.sound = !settings.sound;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleVibrate?.addEventListener("click", () => {
    settings.vibrate = !settings.vibrate;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleAuto?.addEventListener("click", () => {
    settings.autoElim = !settings.autoElim;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleHypo?.addEventListener("click", () => {
    settings.hypo = !settings.hypo;
    saveSettings();
    updateToggleUI();
  });

  el.board.addEventListener("pointerdown", onPointerDown);
  el.board.addEventListener("pointermove", onPointerMove);
  el.board.addEventListener("pointerup", onPointerUp);
  el.board.addEventListener("pointercancel", onPointerUp);

  const res = await fetch("levels_index.json");
  state.sizes = await res.json();
  renderSizeButtons();
}

function renderSizeButtons() {
  el.sizeButtons.innerHTML = "";
  Object.keys(state.sizes).sort((a, b) => a - b).forEach((n) => {
    const btn = document.createElement("button");
    btn.textContent = `${n} x ${n}`;
    btn.addEventListener("click", () => selectSize(Number(n)));
    el.sizeButtons.appendChild(btn);
  });
}

function selectSize(n) {
  state.n = n;
  [...el.sizeButtons.children].forEach((b) => {
    b.classList.toggle("selected", b.textContent.startsWith(`${n} `));
  });

  const count = state.sizes[n];
  const stars = getStars();
  el.levelButtons.innerHTML = "";
  for (let i = 1; i <= count; i++) {
    const btn = document.createElement("button");
    btn.textContent = String(i);
    const s = stars[`${n}:${i}`] || 0;
    if (s > 0) { btn.classList.add("done"); btn.dataset.stars = String(s); }
    btn.addEventListener("click", () => startLevel(n, i));
    el.levelButtons.appendChild(btn);
  }
}

function refreshDoneMarks() {
  if (!state.n) return;
  const stars = getStars();
  [...el.levelButtons.children].forEach((btn, i) => {
    const s = stars[`${state.n}:${i + 1}`] || 0;
    btn.classList.toggle("done", s > 0);
    if (s > 0) btn.dataset.stars = String(s);
    else delete btn.dataset.stars;
  });
}

async function startLevel(n, idx) {
  const path = `levels/${n}/level_${n}_${String(idx).padStart(8, "0")}.txt`;
  const res = await fetch(path);
  const text = await res.text();
  const { regions, solution } = parseLevel(text);

  state.n = n;
  state.levelIdx = idx;
  state.regions = regions;
  state.solution = solution;
  state.board = Array.from({ length: n }, () => Array(n).fill(EMPTY));
  state.hearts = HEARTS_MAX;
  state.gameOver = false;

  resetUndoRedo();
  resetTimer();

  el.gameTitle.textContent = `${n} x ${n} — 第 ${idx} 關`;
  el.statusBanner.classList.add("hidden");
  showGameScreen();
  renderBoard();
  renderHearts();
  if (settings.showHelp)
    el.helpModal.classList.remove("hidden");
}

function parseLevel(text) {
  const allLines = text.split("\n");
  const solutionLine = allLines.find((l) => l.startsWith("# solution:"));
  const solution = solutionLine.replace("# solution:", "").trim().split(/\s+/).map(Number);

  const lines = allLines.filter((l) => !l.startsWith("#") && l.trim() !== "");
  const n = parseInt(lines[0], 10);
  const regions = [];
  for (let r = 0; r < n; r++) {
    regions.push(lines[1 + r].split("").map((ch) => ch.charCodeAt(0) - 65));
  }
  return { n, regions, solution };
}

function showGameScreen() {
  el.screenSelect.classList.add("hidden");
  el.screenGame.classList.remove("hidden");
  el.appHeader?.classList.add("hidden");
  // Push only when coming from the select screen; replace when already in-game (next level).
  if (history.state?.screen !== "game") history.pushState({ screen: "game" }, "");
  else history.replaceState({ screen: "game" }, "");
}

function showSelectScreen() {
  el.screenGame.classList.add("hidden");
  el.screenSelect.classList.remove("hidden");
  el.appHeader?.classList.remove("hidden");
  refreshDoneMarks();
}

function renderBoard() {
  const n = state.n;
  el.board.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  el.board.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  el.board.innerHTML = "";

  cellEls = Array.from({ length: n }, () => Array(n));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cellEl = document.createElement("div");
      cellEl.className = "cell";
      cellEl.innerHTML = '<span class="mark"><span class="bar"></span><span class="bar"></span></span>'
        + '<span class="cat-icon">🐱</span>'
        + '<span class="hypo-icon">△</span>';
      cellEls[r][c] = cellEl;
      el.board.appendChild(cellEl);
      updateCellView(r, c);
    }
  }
}

function updateCellView(r, c) {
  const st = state.board[r][c];
  const cell = cellEls[r][c];
  cell.dataset.state = String(st);
  const palette = st === MARK ? REGION_COLORS_DIM : REGION_COLORS;
  cell.style.background = palette[state.regions[r][c] % palette.length];
}

function renderHearts() {
  el.hearts.textContent = "❤️".repeat(state.hearts) + "🤍".repeat(HEARTS_MAX - state.hearts);
}

function checkWin() {
  const n = state.n;
  let cats = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (state.board[r][c] === CAT) cats++;
  if (cats === n) {
    state.gameOver = true;
    stopTimer();
    updateUndoRedoButtons();
    saveStars(state.n, state.levelIdx, state.hearts);
    playWin(); vibrate(300);
    const hasNext = state.levelIdx < state.sizes[state.n];
    el.btnNextLevel.style.display = hasNext ? "" : "none";
    if (el.winTime) el.winTime.textContent = state.timerFrozenMs !== null ? `用時 ${formatElapsed(state.timerFrozenMs)}` : "";
    setTimeout(() => el.winModal.classList.remove("hidden"), 300);
  }
}

function triggerGameOver() {
  state.gameOver = true;
  stopTimer();
  updateUndoRedoButtons();
  el.statusBanner.textContent = "💔 掰了，按「重來」再試一次";
  el.statusBanner.className = "status-banner lose";
}


// Auto-eliminate: when a cat is correctly placed, mark same row, same column,
// surrounding 8 cells, and entire same-region (same color) as MARK.
function autoEliminate(r, c) {
  const n = state.n;
  const region = state.regions[r][c];
  const mark = (mr, mc) => {
    if (state.board[mr][mc] === EMPTY) setCell(mr, mc, MARK);
  };
  for (let j = 0; j < n; j++) if (j !== c) mark(r, j);
  for (let i = 0; i < n; i++) if (i !== r) mark(i, c);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < n && nc >= 0 && nc < n) mark(nr, nc);
    }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (state.regions[i][j] === region) mark(i, j);
}

function attemptPlaceCat(r, c) {
  if (state.gameOver || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  beginMove();
  if (state.solution[r] === c) {
    setCell(r, c, CAT);
    playCat(); vibrate(100);
    if (settings.autoElim) autoEliminate(r, c);
    endMove();
    checkWin();
  } else {
    state.hearts--;
    setCell(r, c, WRONG);
    renderHearts();
    playWrong(); vibrate(200);
    endMove();
    if (state.hearts <= 0) triggerGameOver();
  }
}

function applyMarkToggle(r, c) {
  const val = state.board[r][c] === EMPTY ? MARK : EMPTY;
  state.board[r][c] = val;
  updateCellView(r, c);
  playMark(); vibrate(50);
  return val;
}

function applyHypoToggle(r, c) {
  const val = state.board[r][c] === HYPO ? EMPTY : HYPO;
  state.board[r][c] = val;
  updateCellView(r, c);
  playMark(); vibrate(50);
  return val;
}

// --- Pointer handling: single tap toggles a mark, double tap on the same
// cell attempts a cat, and press-and-drag paints every swept cell to match
// the cell where the drag started (not a per-cell toggle). ---

let pointerId = null;
let dragging = false;
let dragTargetState = null;
let dragOrigin = null;
let lastPaintedKey = null;
let startX = 0, startY = 0;
let pendingTap = null; // { key, r, c, prevState, timer }
let activeCellEl = null;

function cellFromPoint(clientX, clientY) {
  const n = state.n;
  const rect = el.board.getBoundingClientRect();
  const relX = clientX - rect.left, relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return null;
  const c = Math.floor((relX / rect.width) * n);
  const r = Math.floor((relY / rect.height) * n);
  if (r < 0 || r >= n || c < 0 || c >= n) return null;
  return { r, c };
}

function onPointerDown(e) {
  if (state.gameOver || pointerId !== null) return;
  const cell = cellFromPoint(e.clientX, e.clientY);
  if (!cell) return;
  e.preventDefault(); // only suppress default when pointer is actually over the board
  startTimerIfNeeded();

  const startState = state.board[cell.r][cell.c];
  if (startState !== WRONG) {
    activeCellEl = cellEls[cell.r][cell.c];
    activeCellEl.classList.add("active");
  }

  pointerId = e.pointerId;
  el.board.setPointerCapture(pointerId);
  dragOrigin = cell;
  dragging = false;
  lastPaintedKey = null;
  startX = e.clientX;
  startY = e.clientY;

  if (startState === CAT || startState === WRONG) dragTargetState = null;
  else if (settings.hypo) dragTargetState = startState === HYPO ? EMPTY : HYPO;
  else dragTargetState = startState === EMPTY ? MARK : EMPTY;
}

function onPointerMove(e) {
  if (e.pointerId !== pointerId) return;
  const cell = cellFromPoint(e.clientX, e.clientY);

  if (!dragging) {
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD_PX;
    const leftOrigin = cell && (cell.r !== dragOrigin.r || cell.c !== dragOrigin.c);
    if (!moved && !leftOrigin) return;
    dragging = true;
    if (activeCellEl) { activeCellEl.classList.remove("active"); activeCellEl = null; }
    if (pendingTap) commitPendingTap();
    beginMove();
    paintDragCell(dragOrigin.r, dragOrigin.c);
  }

  if (cell) paintDragCell(cell.r, cell.c);
}

function paintDragCell(r, c) {
  const key = `${r},${c}`;
  if (key === lastPaintedKey) return;
  lastPaintedKey = key;
  if (dragTargetState === null || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  if (state.board[r][c] === dragTargetState) return;
  const cur = state.board[r][c];
  if (settings.hypo ? (cur !== EMPTY && cur !== HYPO) : (cur !== EMPTY && cur !== MARK)) return;
  setCell(r, c, dragTargetState);
  playMark(); vibrate(100);
}

function onPointerUp(e) {
  if (e.pointerId !== pointerId) return;
  el.board.releasePointerCapture(pointerId);
  if (activeCellEl) { activeCellEl.classList.remove("active"); activeCellEl = null; }
  const wasDragging = dragging;
  const origin = dragOrigin;
  pointerId = null;
  dragging = false;
  dragOrigin = null;

  if (wasDragging) endMove();
  else handleTap(origin.r, origin.c);
}

function handleTap(r, c) {
  if (state.gameOver || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  const key = `${r},${c}`;
  if (pendingTap && pendingTap.key === key) {
    clearTimeout(pendingTap.timer);
    // Undo the mark applied on first tap (without a separate undo entry —
    // it was never committed), then place the cat as one clean move.
    if (pendingTap.prevState !== undefined) {
      state.board[r][c] = pendingTap.prevState;
      updateCellView(r, c);
    }
    pendingTap = null;
    attemptPlaceCat(r, c);
    return;
  }
  // Flush any pending tap on a different cell as its own committed move.
  if (pendingTap) commitPendingTap();
  // Apply mark/hypo immediately for instant feedback; committed to the undo
  // stack only once we know a follow-up double-tap didn't revert it.
  const prevState = state.board[r][c];
  if (settings.hypo) applyHypoToggle(r, c); else applyMarkToggle(r, c);
  pendingTap = {
    key, r, c, prevState,
    timer: setTimeout(() => commitPendingTap(), DOUBLE_TAP_MS),
  };
}

function commitPendingTap() {
  if (!pendingTap) return;
  clearTimeout(pendingTap.timer);
  const { r, c, prevState } = pendingTap;
  pendingTap = null;
  pushUndoMove([{ r, c, prev: prevState, cur: state.board[r][c] }], state.hearts, state.hearts);
}

init();
