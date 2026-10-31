// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { reviewAudit, ADVISORY_URL } = require("../scripts/audit.cjs");

const report = (vulnerabilities = {}) => ({
  metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
  vulnerabilities,
});
const minimatch = {
  severity: "moderate", nodes: ["node_modules/minimatch"],
  via: [{ name: "minimatch", severity: "moderate", url: ADVISORY_URL }],
};
const glob = {
  severity: "moderate", nodes: ["node_modules/glob"], via: ["minimatch"],
};
const lock = { packages: {
  "node_modules/minimatch": { dev: true },
  "node_modules/glob": { dev: true },
} };
const input = (full = report({ minimatch, glob })) => ({
  production: report(), full, lock, now: "2026-10-31T00:00:00Z",
});

test("audit permits only the time-limited, development-only minimatch advisory chain", () => {
  assert.deepEqual(reviewAudit(input()), {
    count: 2, packages: ["glob", "minimatch"], exception: true,
  });
  assert.deepEqual(reviewAudit(input(report())), {
    count: 0, packages: [], exception: false,
  });
});

test("audit rejects any production finding or production dependency path", () => {
  assert.throws(() => reviewAudit({ ...input(), production: report({ minimatch }) }), /Production dependencies/);
  const unsafe = structuredClone(lock);
  unsafe.packages["node_modules/glob"].dev = false;
  assert.throws(() => reviewAudit({ ...input(), lock: unsafe }), /not confined to development/);
});

test("audit rejects another advisory, higher severity and an unknown dependency chain", () => {
  const other = { severity: "moderate", nodes: ["node_modules/glob"],
    via: [{ name: "glob", severity: "moderate", url: "https://github.com/advisories/GHSA-other" }] };
  assert.throws(() => reviewAudit(input(report({ minimatch, glob: other }))), /Unreviewed audit advisory/);
  assert.throws(() => reviewAudit(input(report({ minimatch: { ...minimatch, severity: "high" } }))), /Unreviewed audit finding/);
  assert.throws(() => reviewAudit(input(report({ glob }))), /Unreviewed audit finding/);
});

test("audit permits a transitive dependency cycle only when it reaches minimatch", () => {
  const cyclic = report({ minimatch, glob: { ...glob, via: ["minimatch", "temp"] },
    temp: { severity: "moderate", nodes: ["node_modules/temp"], via: ["glob"] } });
  const withTemp = structuredClone(lock);
  withTemp.packages["node_modules/temp"] = { dev: true };
  assert.equal(reviewAudit({ ...input(cyclic), lock: withTemp }).count, 3);
  const disconnected = report({ ...cyclic.vulnerabilities,
    unrelated: { severity: "moderate", nodes: ["node_modules/unrelated"], via: ["other"] },
    other: { severity: "moderate", nodes: ["node_modules/other"], via: ["unrelated"] } });
  withTemp.packages["node_modules/unrelated"] = { dev: true };
  withTemp.packages["node_modules/other"] = { dev: true };
  assert.throws(() => reviewAudit({ ...input(disconnected), lock: withTemp }), /Unrelated audit dependency chain/);
});

test("audit rejects an expired exception and malformed audit counts", () => {
  assert.throws(() => reviewAudit({ ...input(), now: "2026-12-01T00:00:00Z" }), /expired/);
  const malformed = report({ minimatch });
  malformed.metadata.vulnerabilities.total = 0;
  assert.throws(() => reviewAudit(input(malformed)), /count does not match/);
});
