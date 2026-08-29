#!/usr/bin/env node
"use strict";

const { run } = require("../src/cli/index.js");

run(process.argv.slice(2)).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});