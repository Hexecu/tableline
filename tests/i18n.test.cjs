'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const runtime = () => import('../locales/runtime.mjs');
const placeholders = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]).sort();

test('Five complete catalogs preserve all interpolation parameters', async () => {
  const { catalogs, supportedLanguages } = await runtime();
  assert.deepEqual(supportedLanguages, ['en', 'it', 'fr', 'de', 'es']);
  const expected = Object.keys(catalogs.en).sort();
  assert.ok(expected.length >= 450);
  for (const language of supportedLanguages) {
    assert.deepEqual(Object.keys(catalogs[language]).sort(), expected);
    for (const key of expected) {
      const message = catalogs[language][key];
      assert.equal(typeof message, 'string', `${language}: ${key}`);
      assert.ok(message.trim().length, `${language}: ${key}`);
      assert.deepEqual(placeholders(message), placeholders(key), `${language}: ${key}`);
    }
  }
});

test('Language selection handles browser regions, unsupported languages, and saved preferences', async () => {
  const { normalizeLanguage, resolveLanguage } = await runtime();
  assert.equal(normalizeLanguage('fr-CA'), 'fr');
  assert.equal(normalizeLanguage('DE_de'), 'de');
  assert.equal(normalizeLanguage('../../bad'), 'en');
  assert.equal(resolveLanguage('it', ['fr-CA']), 'it');
  assert.equal(resolveLanguage(null, ['pt-BR', 'es-MX', 'en-US']), 'es');
  assert.equal(resolveLanguage('bad', ['ja-JP']), 'en');
  assert.equal(resolveLanguage(null, []), 'en');
});

test('Translation preserves data, SQL, identifiers, and nonrecursive parameters', async () => {
  const { translateForLanguage: t } = await runtime();
  const sql = 'SELECT country, name FROM customers WHERE name = \'Müller 東京\'';
  assert.equal(t('de', sql), sql);
  assert.equal(t('fr', 'customers'), 'customers');
  assert.equal(t('es', 'OpenAI'), 'OpenAI');
  assert.equal(t('de', 'Copia {name}', { name: 'customer_{count}' }), 'customer_{count} kopieren');
  assert.equal(t('fr', 'Ci sono {count} {entity}.', { count: '1\u202f000', entity: 'clients' }), 'Il y a 1\u202f000 clients.');
  assert.equal(t('en', 'Modifica salvata · 12 righe'), 'Change saved · 12 rows');
  assert.equal(t('en', '{count} righe', { count: 1 }), '1 row');
  assert.equal(t('de', '{count} colonne', { count: 1 }), '1 Spalte');
  assert.equal(t('es', 'righe ·', { count: 1 }), 'fila ·');
  assert.equal(t('fr', '{count} modelli disponibili', { count: 2 }), '2 modèles disponibles');
  assert.equal(t('de', 'Connection not found.'), 'Verbindung nicht gefunden.');
  assert.equal(t('fr', 'Redis write command EVAL is not supported.'), 'La commande d’écriture Redis EVAL n’est pas prise en charge.');
  assert.equal(t('en', 'model non valido.'), 'Invalid model.');
  assert.equal(t('es', 'Il provider ha bloccato la richiesta (SAFETY).'), 'El proveedor bloqueó la solicitud (SAFETY).');
  assert.equal(t('it', 'Connection not found.'), 'Connessione non trovata.');
});

test('Renderer text and human-facing attributes all use the explicit translator', () => {
  const allowedText = new Set(['tableline','⌘ K','⌘ T','⌘ ↵','DEMO','CSV','JSON','ESC','ms','NULL','PRIMARY KEY','#','·','…',':','–']);
  const technicalAttributes = new Set(['/sql/1.0/warehouses/…','main','default','-----BEGIN CERTIFICATE-----','https://…','2024-10-21','global','eu-west-1']);
  for (const file of ['App.tsx', 'Settings.tsx', 'Workspace.tsx']) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root,'src',file),'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function walk(node) {
      if (ts.isJsxText(node) && node.text.trim()) {
        const text = node.text.replace(/\s+/g,' ').trim();
        assert.ok(allowedText.has(text), `${file} unlocalized text: ${text}`);
      }
      if (ts.isJsxAttribute(node) && ['aria-label','title','placeholder'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer))
        assert.ok(technicalAttributes.has(node.initializer.text), `${file} unlocalized attribute: ${node.initializer.text}`);
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
});

test('All exposed static backend errors have a translated catalog entry', async () => {
  const { catalogs } = await runtime();
  const internal = new Set(['Unavailable', 'Shutdown guard did not start.', 'Invalid local development URL.']);
  const files = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
      const file = path.join(dir,item.name);
      if (item.isDirectory()) visit(file);
      else if (file.endsWith('.cjs')) files.push(file);
    }
  }
  visit(path.join(root,'electron'));
  for (const file of files) {
    const source = ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const normalized = value => value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '{}');
    const catalogPatterns = new Set(Object.keys(catalogs.en).map(normalized));
    function inspectArgument(argument) {
      if (ts.isStringLiteral(argument)) {
        const message = argument.text;
        if (message.length > 10 && !internal.has(message)) assert.ok(Object.hasOwn(catalogs.en,message), `${path.relative(root,file)} missing: ${message}`);
      } else if (ts.isConditionalExpression(argument)) {
        inspectArgument(argument.whenTrue);
        inspectArgument(argument.whenFalse);
      } else if (ts.isTemplateExpression(argument)) {
        let candidates = [argument.head.text];
        for (const span of argument.templateSpans) {
          const expression = span.expression;
          const values = ts.isConditionalExpression(expression) && ts.isStringLiteral(expression.whenTrue) && ts.isStringLiteral(expression.whenFalse)
            ? [expression.whenTrue.text, expression.whenFalse.text] : ['{}'];
          candidates = candidates.flatMap(prefix => values.map(value => prefix + value + span.literal.text));
        }
        for (const candidate of candidates) {
          // Deadline labels have four app-owned call sites with complete literal messages below.
          if (candidate === '{}: timeout.') continue;
          assert.ok(catalogPatterns.has(candidate), `${path.relative(root,file)} missing template: ${candidate}`);
        }
      }
    }
    function walk(node) {
      if ((ts.isNewExpression(node)||ts.isCallExpression(node)) && ['Error','failure'].includes(node.expression.getText(source)) && node.arguments?.[0]) inspectArgument(node.arguments[0]);
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'deadline' && node.arguments?.[2] && ts.isStringLiteral(node.arguments[2]))
        assert.ok(Object.hasOwn(catalogs.en, node.arguments[2].text + ': timeout.'), `Missing deadline label: ${node.arguments[2].text}`);
      ts.forEachChild(node,walk);
    }
    walk(source);
  }
});
