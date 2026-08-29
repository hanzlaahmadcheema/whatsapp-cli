"use strict";

const pc = require("picocolors");

const EMOJI = {
  ok: pc.green("✓"),
  fail: pc.red("✗"),
  warn: pc.yellow("⚠"),
  arrow: pc.dim("→"),
  bullet: pc.dim("•"),
  caret: pc.gray("›"),
};

function header(title) {
  const line = pc.bold(pc.cyan(title));
  const sep = pc.dim("─".repeat(Math.max(2, title.length + 2)));
  return `${sep}\n${line}\n${sep}`;
}

function section(title) {
  return `${pc.bold(pc.green(`▸ ${title}`))}`;
}

function pair(key, value) {
  return `${pc.dim(key + ":")} ${pc.bold(value)}`;
}

function stripAnsi(str) {
  return String(str).replace(/\u001b\[[0-9;]*m/g, "");
}

function table(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, stripAnsi(cell).length);
    });
  }
  return rows
    .map(
      (row) =>
        "  " +
        row
          .map((cell, i) => {
            const pad = " ".repeat((widths[i] || 0) - stripAnsi(cell).length);
            return i === row.length - 1 ? cell : cell + pad;
          })
          .join(pc.dim("  ·  ")),
    )
    .join("\n");
}

function delimiter() {
  return pc.dim("─".repeat(40));
}

module.exports = { pc, EMOJI, header, section, pair, table, delimiter };