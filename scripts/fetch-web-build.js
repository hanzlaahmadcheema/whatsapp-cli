"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { paths } = require("../src/config/paths");
const { WEB_VERSION_PIN } = require("../src/config");

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function buildSourceUrl(version) {
  return WEB_VERSION_PIN.source.replace(":version", version);
}

async function listVersions() {
  const json = JSON.parse(await fetchText(WEB_VERSION_PIN.versionsApi));
  return {
    current: json.currentVersion,
    versions: (json.versions || []).map((v) => v.version),
  };
}

async function downloadVersion(version, dest) {
  const html = await fetchText(buildSourceUrl(version));
  fs.writeFileSync(dest, html, "utf8");
  return html;
}

async function fetchWebBuild(overrides = {}) {
  const wantedVersion = overrides.version || WEB_VERSION_PIN.version;
  fs.mkdirSync(paths.cacheDir, { recursive: true });

  const candidates = [wantedVersion];
  try {
    const { current, versions } = await listVersions();
    if (current && !candidates.includes(current)) candidates.push(current);
    // Some current versions are not downloadable yet; fall back through the
    // newest published ones so a fresh install always resolves a build.
    candidates.push(
      ...versions.filter((v) => !candidates.includes(v))
    );
  } catch (_) {}

  for (const version of candidates) {
    const dest = path.join(paths.cacheDir, `${version}.html`);
    if (!overrides.force && fs.existsSync(dest)) {
      return { dest, cached: true, version, source: "cache" };
    }
    try {
      await downloadVersion(version, dest);
      return { dest, cached: false, version, source: "downloaded" };
    } catch (err) {
      // try the next candidate
    }
  }
  throw new Error(
    `Could not fetch any web build (tried ${candidates.length} versions). ` +
      `Pin one that exists upstream or run --force after network access.`
  );
}

module.exports = { fetchWebBuild };

if (require.main === module) {
  fetchWebBuild({ force: process.argv.includes("--force") })
    .then((r) => console.log(r))
    .catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    });
}