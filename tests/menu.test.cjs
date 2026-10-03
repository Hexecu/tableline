"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { menuTemplate, setMenuLanguage, languages } = require("../electron/menu.cjs");
test("native menus cover all five languages and preserve standard edit/window/quit roles", () => {
 const fileLabels = { en: "File", it: "File", fr: "Fichier", de: "Datei", es: "Archivo" };
 for (const language of languages) {
  const template = menuTemplate(language, "darwin");
  assert.equal(template[0].label, "Tableline");
  assert.equal(template[1].label, fileLabels[language]);
  const roles = template.flatMap(item=>item.submenu || []).map(item=>item.role).filter(Boolean);
  for (const role of ["about", "quit", "undo", "redo", "cut", "copy", "paste", "selectAll", "close", "togglefullscreen", "minimize", "zoom"]) assert.ok(roles.includes(role));
  assert.equal(JSON.stringify(template).includes("safeStorage"), false);
  assert.equal(menuTemplate(language,"linux")[0].label,fileLabels[language]);
 }
});
test("native menu language rejects non-string, unsupported and prototype inputs before native dispatch", () => {
 let calls=0;
 const Menu = { buildFromTemplate(){calls++;}, setApplicationMenu(){calls++;} };
 for (const value of [undefined, null, 42, ["en"], {toString:()=>"en"}, "en-US", "__proto__", "../../keys"])
  assert.throws(()=>setMenuLanguage(Menu,value), /language/);
 assert.equal(calls,0);
});
