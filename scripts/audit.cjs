// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only
"use strict";

// A short-lived exception for one upstream advisory in build-only packages.
// Production findings, other advisories and expired exceptions always fail.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const ADVISORY_URL = "https://github.com/advisories/GHSA-g3hv-75wg-m249";
const EXPIRES_AFTER = "2026-11-30";

function findings(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report) || report.error ||
      !report.vulnerabilities || typeof report.vulnerabilities !== "object" ||
      Array.isArray(report.vulnerabilities) ||
      !Number.isSafeInteger(report.metadata?.vulnerabilities?.total) ||
      report.metadata.vulnerabilities.total < 0)
    throw new Error(`${label} did not return a valid npm audit report.`);
  const entries = Object.entries(report.vulnerabilities);
  if (entries.length !== report.metadata.vulnerabilities.total)
    throw new Error(`${label} vulnerability count does not match its findings.`);
  return entries;
}

function reviewAudit({ production, full, lock, now = new Date() }) {
  if (!lock?.packages || typeof lock.packages !== "object")
    throw new Error("The dependency lockfile is missing its package inventory.");
  if (findings(production, "Production audit").length)
    throw new Error("Production dependencies have audit findings.");
  const entries = findings(full, "Full audit");
  if (!entries.length) return { count: 0, packages: [], exception: false };
  const date = new Date(now);
  if (Number.isNaN(date.getTime()) || date >= new Date("2026-12-01T00:00:00Z"))
    throw new Error(`The ${ADVISORY_URL} exception expired after ${EXPIRES_AFTER}.`);
  const vulnerabilities = full.vulnerabilities;
  for (const [name, entry] of entries) {
    if (!entry || entry.severity !== "moderate" || !Array.isArray(entry.via) || !entry.via.length ||
        !Array.isArray(entry.nodes) || !entry.nodes.length)
      throw new Error(`Unreviewed audit finding: ${name}.`);
    for (const node of entry.nodes)
      if (typeof node !== "string" || lock.packages[node]?.dev !== true)
        throw new Error(`Audit finding is not confined to development dependencies: ${name}.`);
    for (const via of entry.via) {
      if (typeof via === "string") {
        if (name === "minimatch" || !vulnerabilities[via])
          throw new Error(`Unreviewed audit finding: ${name}.`);
      } else if (name !== "minimatch" || !via || via.name !== "minimatch" ||
          via.url !== ADVISORY_URL || via.severity !== "moderate")
        throw new Error(`Unreviewed audit advisory: ${name}.`);
    }
  }
  if (!vulnerabilities.minimatch ||
      vulnerabilities.minimatch.via.some(via => typeof via === "string"))
    throw new Error("Audit exception has no matching minimatch finding.");
  // npm can report dependency cycles (for example app-builder-lib/dmg-builder).
  // Every transitive finding must still have a path to the single allowed root.
  function reachesMinimatch(name, seen = new Set()) {
    if (name === "minimatch") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return vulnerabilities[name].via.some(via => typeof via === "string" &&
      reachesMinimatch(via, new Set(seen)));
  }
  for (const [name] of entries)
    if (!reachesMinimatch(name)) throw new Error(`Unrelated audit dependency chain: ${name}.`);
  return { count: entries.length, packages: entries.map(([name]) => name).sort(), exception: true };
}

function runNpmAudit(args, label) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check through npm run audit.");
  const result = spawnSync(process.execPath, [npmCli, "audit", "--json", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error(`${label} could not complete.`);
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`${label} returned unreadable JSON.`); }
  findings(report, label);
  if ((report.metadata.vulnerabilities.total === 0) !== (result.status === 0))
    throw new Error(`${label} exit status does not match its findings.`);
  return report;
}

if (require.main === module) {
  try {
    const production = runNpmAudit(["--omit=dev"], "Production audit");
    const full = runNpmAudit([], "Full audit");
    const lock = require(path.join(root, "package-lock.json"));
    const result = reviewAudit({ production, full, lock });
    console.log(`Production dependency audit: ${production.metadata.vulnerabilities.total} findings.`);
    console.log(`Full dependency audit: ${result.count} findings.`);
    if (result.exception) {
      console.log(`Temporary development-only exception through ${EXPIRES_AFTER}: ${ADVISORY_URL}`);
      console.log(`Affected packages: ${result.packages.join(", ")}`);
    }
  } catch (error) {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { reviewAudit, findings, ADVISORY_URL, EXPIRES_AFTER };
