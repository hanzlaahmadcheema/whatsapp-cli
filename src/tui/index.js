"use strict";

const { TuiApp } = require("./app");

async function runTui(opts = {}) {
  const app = new TuiApp(opts);
  await app.run();
  return app;
}

module.exports = { runTui, TuiApp };