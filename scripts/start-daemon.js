#!/usr/bin/env node
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const daemonIndex = path.join(__dirname, "..", "src", "daemon", "index.js");
const logFile = fs.openSync(path.join(__dirname, "..", ".data", "daemon.log"), "a");
const child = spawn(process.execPath, [daemonIndex, "--foreground"], {
  detached: true,
  stdio: ["ignore", logFile, logFile],
  env: process.env,
});
fs.closeSync(logFile);
child.unref();
console.log("spawned daemon pid", child.pid);