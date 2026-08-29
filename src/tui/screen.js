"use strict";

const readline = require("readline");

const RESET = "\x1b[0m";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_OFF = "\x1b[?25l";
const CURSOR_ON = "\x1b[?25h";
const NORMAL_KEYPAD = "\x1b>";
const CLEAN_AFTER = "\x1b[2J";

class Screen {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.cells = null;
    this._listenersAttached = false;
    this._handlers = [];

    process.stdout.on("resize", () => {
      this.width = process.stdout.columns || 80;
      this.height = process.stdout.rows || 24;
      this.resize();
    });
  }

  init() {
    process.stdout.write(ALT_ON + CURSOR_OFF);
    this.cells = this.emptyCells();
    return this;
  }

  resize() {
    this.cells = this.emptyCells();
    this.render();
  }

  emptyCells() {
    return Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => null)
    );
  }

  clear() {
    this.cells = this.emptyCells();
  }

  // style keys: fg, bg, bold, dim, italic, underline, inverse
  set(x, y, ch, style) {
    if (ch === null || ch === undefined) return;
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.cells[y][x] = { ch, st: style || null };
  }

  text(x, y, str, style) {
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      this.set(x + i, y, str[i], style);
    }
  }

  fill(x, y, w, h, ch, style) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        this.set(xx, yy, ch, style);
      }
    }
  }

  hline(x, y, w, ch, style) {
    for (let i = 0; i < w; i++) this.set(x + i, y, ch, style);
  }

  vline(x, y, h, ch, style) {
    for (let i = 0; i < h; i++) this.set(x, y + i, ch, style);
  }

  box(x, y, w, h, style, title) {
    for (let i = 0; i < w; i++) {
      this.set(x + i, y, "─", style);
      this.set(x + i, y + h - 1, "─", style);
    }
    for (let i = 0; i < h; i++) {
      this.set(x, y + i, "│", style);
      this.set(x + w - 1, y + i, "│", style);
    }
    this.set(x, y, "┌", style);
    this.set(x + w - 1, y, "┐", style);
    this.set(x, y + h - 1, "└", style);
    this.set(x + w - 1, y + h - 1, "┘", style);
    if (title) {
      let t = ` ${title} `;
      if (t.length > w - 2) t = t.slice(0, Math.max(0, w - 2));
      this.text(x + 1, y, t, Object.assign({}, style, { bold: true }));
    }
  }

  render() {
    const w = this.width;
    const h = this.height;
    let out = "\x1b[H";
    let run = [];
    let prevStyleKey = "__none__";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = this.cells[y][x];
        const ch = cell ? cell.ch : " ";
        const st = cell ? cell.st : null;
        const key = st === null ? "__none__" : styleKey(st);
        if (key !== prevStyleKey) {
          if (run.length) out += run.join("");
          run = [];
          out += RESET + (st ? stToString(st) : "");
          prevStyleKey = key;
        }
        run.push(ch);
      }
      if (run.length) out += run.join("");
      run = [];
      prevStyleKey = "__none__";
      if (y < h - 1) out += "\x1b[E";
    }
    out += "\x1b[0m\x1b[H";
    process.stdout.write(out);
  }

  cursorTo(x, y) {
    process.stdout.write(`\x1b[${y + 1};${x + 1}H`);
  }

  showCursor(on) {
    process.stdout.write(on ? CURSOR_ON : CURSOR_OFF);
  }

  // Render, then place and reveal the terminal cursor at (x, y). Used by
  // input modes (compose, command line) so the user sees a real caret.
  renderWithCursor(x, y) {
    this.render();
    this.cursorTo(x, y);
    this.showCursor(true);
  }

  hideCursor() {
    this.showCursor(false);
  }

  // ---- input ----
  onKey(cb) {
    if (!this._listenersAttached) {
      this._listenersAttached = true;
      readline.emitKeypressEvents(process.stdin);
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("keypress", (str, key) => {
        for (const h of this._handlers) {
          try {
            h(str, key);
          } catch (_) {}
        }
      });
    }
    this._handlers.push(cb);
    return () => {
      const i = this._handlers.indexOf(cb);
      if (i !== -1) this._handlers.splice(i, 1);
    };
  }

  detach() {
    if (this._listenersAttached) {
      this._listenersAttached = false;
      process.stdin.removeAllListeners("keypress");
      process.stdin.pause();
      try {
        process.stdin.setRawMode(false);
      } catch (_) {}
    }
  }

  destroy() {
    this.showCursor(true);
    process.stdout.write(NORMAL_KEYPAD + RESET + CLEAN_AFTER + ALT_OFF);
    this.detach();
  }
}

const _STYLE_CODES = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
};

const _FG_COLORS = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34,
  magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90,
  brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};

const _BG_COLORS = Object.fromEntries(
  Object.entries(_FG_COLORS).map(([k, v]) => [k, v + 10])
);

function styleKey(st) {
  const parts = [];
  for (const k in _STYLE_CODES) if (st[k]) parts.push(_STYLE_CODES[k]);
  if (st.fg) parts.push(_FG_COLORS[st.fg] || 0);
  if (st.bg) parts.push(_BG_COLORS[st.bg] || 0);
  return parts.join(";");
}

function stToString(st) {
  const key = styleKey(st);
  return key ? `\x1b[${key}m` : "";
}

const pc = {
  fg(name) {
    return `\x1b[${_FG_COLORS[name] || 0}m`;
  },
  bg(name) {
    return `\x1b[${_BG_COLORS[name] || 0}m`;
  },
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

module.exports = { Screen };