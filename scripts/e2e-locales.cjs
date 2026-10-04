// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
// This suite uses disposable local data and forbids every OS credential operation.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const packaged = Boolean(process.env.TABLELINE_E2E_EXECUTABLE);
const artifacts = path.join(root, 'artifacts/e2e/locales', packaged ? 'packaged' : 'source');
const languages = ['en', 'it', 'fr', 'de', 'es'];
const { menuTemplate } = require('../electron/menu.cjs');
const checks = [], errors = [];
let app, page, directory, nativeCalls = 0;
const SQL = "SELECT id, name, country FROM customers ORDER BY id LIMIT 5; -- Müller 東京";
const unsent = 'Unsent prompt: customer Müller 東京';
const bounded = async (work, label, ms = 20000) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]);
  } finally { clearTimeout(timer); }
};
async function launch() {
  app = await electron.launch({
    executablePath: process.env.TABLELINE_E2E_EXECUTABLE || require('electron'),
    args: [...(packaged ? [] : [path.join(root,'electron/main.cjs')]), '--tableline-qa', `--tableline-data=${directory}`],
    env: {...process.env, ELECTRON_RUN_AS_NODE: '', TABLELINE_DEV_URL: ''},
    timeout: 20000,
  });
  await app.evaluate(({safeStorage}) => {
    globalThis.tablelineLocaleNativeCalls = 0;
    for (const method of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) safeStorage[method] = async () => {
      globalThis.tablelineLocaleNativeCalls++;
      throw new Error('Native credential access is forbidden in locale QA.');
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('language-selector').waitFor();
}
async function close() {
  if (!app) return;
  const instance = app;
  nativeCalls += await app.evaluate(() => globalThis.tablelineLocaleNativeCalls || 0);
  const child = instance.process();
  const exited = new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  await bounded(Promise.all([instance.close(), exited]), 'Electron shutdown', 8000);
  app = null;
}
const call = (method, ...args) => bounded(page.evaluate(({method,args}) => window.tableline.call(method,...args), {method,args}), method);
async function check(name, work) {
  const start = performance.now();
  try {
    await work();
    checks.push({name,status:'passed',durationMs:Math.round(performance.now()-start)});
    console.log('PASS', name);
  } catch (error) {
    checks.push({name,status:'failed',error:error.message});
    throw error;
  }
}
async function selectLanguage(language) {
  await page.getByTestId('language-selector').selectOption(language);
  await page.waitForFunction(lang => document.documentElement.lang === lang, language);
}
const gridRows = () => page.locator('.data-grid tbody').innerText();
(async () => {
  const { translateForLanguage: t, resolveLanguage } = await import('../locales/runtime.mjs');
  await fs.mkdir(artifacts,{recursive:true});
  directory = await fs.mkdtemp(path.join(os.tmpdir(),'tableline-locale-qa-'));
  await launch();
  await check('First launch follows supported browser language and English fallback', async () => {
    const preferred = await page.evaluate(() => navigator.languages);
    const expected = resolveLanguage(null, preferred);
    assert.equal(await page.getByTestId('language-selector').inputValue(), expected);
    assert.equal(await page.locator('html').getAttribute('lang'), expected);
    assert.equal(await page.getByTestId('language-selector').getAttribute('aria-label'), t(expected,'Lingua'));
  });
  await selectLanguage('en');
  await check('English home creates a real local demo without credentials', async () => {
    await page.getByRole('button',{name:'Open local demo',exact:true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.data-grid tbody tr').length === 100);
    assert.equal(await page.getByLabel('Active connection',{exact:true}).inputValue(),'demo');
  });
  const before = (await call('db.query',{connectionId:'demo',sql:'SELECT id, status, total FROM orders ORDER BY id',limit:1000})).rows;
  await check('SQL result, draft, and assistant conversation are seeded', async () => {
    await page.getByRole('button',{name:'SQL',exact:true}).click();
    await page.getByLabel('SQL editor',{exact:true}).fill(SQL);
    await page.locator('.run-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.data-grid tbody tr').length === 5 && !document.querySelector('.run-button:disabled'));
    await page.getByLabel('Question about data',{exact:true}).fill('How many customers are there?');
    await page.getByLabel('Send question',{exact:true}).click();
    await page.locator('.answer-text').last().waitFor();
    assert.match(await page.locator('.answer-text').last().innerText(), /120 customers/);
    await page.getByLabel('Question about data',{exact:true}).fill(unsent);
  });
  const rows = await gridRows();
  for (const language of languages) {
    await check(`${language}: instant switch retains SQL, rows, assistant history, and unsent prompt`, async () => {
      const oldConversation = await page.locator('.user-message, .answer-text, .query-evidence pre').allTextContents();
      await selectLanguage(language);
      assert.equal(await page.getByLabel(t(language,'Editor SQL'),{exact:true}).inputValue(),SQL);
      assert.equal(await gridRows(),rows);
      assert.equal(await page.getByLabel(t(language,'Domanda sui dati'),{exact:true}).inputValue(),unsent);
      assert.deepEqual(await page.locator('.user-message, .answer-text, .query-evidence pre').allTextContents(),oldConversation);
      assert.equal(await page.getByLabel(t(language,'Domanda sui dati'),{exact:true}).getAttribute('placeholder'),t(language,'Chiedi ai tuoi dati…'));
      assert.equal(await page.locator('.assistant > header > span').innerText(),t(language,'Assistente'));
      assert.equal(await page.evaluate(() => localStorage.getItem('tableline.language')),language);
      const expectedMenus = menuTemplate(language).map(item=>item.label);
      await page.waitForFunction(() => !document.querySelector('.thinking'));
      await bounded((async () => {
        for (let attempt=0;attempt<50;attempt++) {
          const labels = await app.evaluate(({Menu}) => Menu.getApplicationMenu().items.map(item=>item.label));
          if (JSON.stringify(labels)===JSON.stringify(expectedMenus)) return;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.fail('Native menu language did not follow the renderer');
      })(),'native menus');
    });
    await check(`${language}: localized connection dialog preserves entered values across switches`, async () => {
      await page.getByLabel(t(language,'Nuova connessione'),{exact:true}).click();
      await page.getByRole('dialog',{name:t(language,'Scegli il database'),exact:true}).waitFor();
      await page.locator('.engine-grid button').filter({hasText:'PostgreSQL'}).first().click();
      await page.getByLabel(t(language,'Nome connessione'),{exact:true}).fill('QA connection Müller 東京');
      await selectLanguage(languages[(languages.indexOf(language)+1)%languages.length]);
      await selectLanguage(language);
      assert.equal(await page.getByLabel(t(language,'Nome connessione'),{exact:true}).inputValue(),'QA connection Müller 東京');
      assert.equal(await page.getByLabel(t(language,'Host'),{exact:true}).inputValue(),'localhost');
      assert.equal(await page.getByLabel(t(language,'Password'),{exact:true}).getAttribute('placeholder'),t(language,'Salvata nel portachiavi del sistema'));
      await page.getByRole('button',{name:t(language,'Test connessione'),exact:true}).waitFor();
      await page.getByRole('button',{name:t(language,'Salva e apri'),exact:true}).waitFor();
      await page.getByRole('dialog').getByLabel(t(language,'Chiudi'),{exact:true}).click();
    });
    await check(`${language}: localized provider form preserves model and entered profile`, async () => {
      await page.getByLabel(t(language,'Impostazioni AI'),{exact:true}).click();
      await page.getByRole('dialog',{name:t(language,'Provider AI'),exact:true}).waitFor();
      await page.getByLabel(t(language,'Nome profilo AI'),{exact:true}).fill('QA profile 東京');
      await page.getByLabel(t(language,'Modello AI'),{exact:true}).fill('exact-model-id');
      await selectLanguage(languages[(languages.indexOf(language)+1)%languages.length]);
      await selectLanguage(language);
      assert.equal(await page.getByLabel(t(language,'Nome profilo AI'),{exact:true}).inputValue(),'QA profile 東京');
      assert.equal(await page.getByLabel(t(language,'Modello AI'),{exact:true}).inputValue(),'exact-model-id');
      await page.getByRole('button',{name:t(language,'Salva e attiva'),exact:true}).waitFor();
      await page.getByRole('dialog').getByLabel(t(language,'Chiudi'),{exact:true}).click();
    });
    await check(`${language}: command palette, quick guide, save, and write-review dialogs are localized`, async () => {
      const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.press(`${shortcut}+k`);
      await page.getByRole('dialog', { name: t(language, 'Comandi'), exact: true }).waitFor();
      assert.equal(await page.getByLabel(t(language, 'Cerca comando'), { exact: true }).getAttribute('placeholder'), t(language, 'Dove vuoi andare?'));
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(t(language, 'Nuova query')) }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByLabel(t(language, 'Guida rapida'), { exact: true }).click();
      await page.getByRole('dialog', { name: t(language, 'Vai più veloce'), exact: true }).waitFor();
      await page.getByRole('dialog').getByLabel(t(language, 'Chiudi'), { exact: true }).click();
      await page.getByLabel(t(language, 'Salva query'), { exact: true }).click();
      await page.getByRole('dialog', { name: t(language, 'Salva query'), exact: true }).waitFor();
      assert.equal(await page.getByLabel(t(language, 'Nome query'), { exact: true }).getAttribute('placeholder'), t(language, 'Ricavi mensili'));
      await page.getByRole('dialog').getByLabel(t(language, 'Chiudi'), { exact: true }).click();
      const previewSQL = "UPDATE orders SET status='paid' WHERE id=1;";
      await page.getByLabel(t(language, 'Editor SQL'), { exact: true }).fill(previewSQL);
      await page.locator('.run-button').click();
      await page.getByRole('dialog', { name: t(language, 'Rivedi la modifica'), exact: true }).waitFor();
      assert.equal(await page.locator('.proposal-summary strong').innerText(), t(language, '{count} righe interessate', { count: '1' }));
      assert.equal(await page.locator('.proposal-sql').innerText(), previewSQL.replace(/;$/, ''));
      await page.getByRole('button', { name: t(language, 'Conferma scrittura'), exact: true }).waitFor();
      assert.equal(await page.locator('.proposal-warning').innerText(), t(language, 'Preview was rolled back. Affected row count is checked again at commit; live row values may change.'));
      await page.screenshot({ animations:"disabled", path: path.join(artifacts, `${language}-write-review.png`) });
      await page.getByRole('button', { name: t(language, 'Scarta'), exact: true }).click();
      await page.getByLabel(t(language, 'Editor SQL'), { exact: true }).fill(SQL);
      assert.equal(await gridRows(), rows);
    });
    await check(`${language}: translated demo question returns localized grounded count`, async () => {
      await page.getByLabel(t(language,'Domanda sui dati'),{exact:true}).fill(t(language,'Quanti clienti ci sono?'));
      const previous = await page.locator('.answer-text').count();
      await page.getByLabel(t(language,'Invia domanda'),{exact:true}).click();
      await page.waitForFunction(count => document.querySelectorAll('.answer-text').length === count+1,previous);
      assert.equal(await page.locator('.answer-text').last().innerText(),t(language,'Ci sono {count} {entity}.',{count:'120',entity:t(language,'clienti')}));
      await page.getByLabel(t(language,'Domanda sui dati'),{exact:true}).fill(unsent);
      await page.locator('.answer-text').last().scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:path.join(artifacts,`${language}.png`)});
    });
  }
  for (const language of languages) {
    await check(`${language}: language and unsaved SQL persist after renderer reload`, async () => {
      await selectLanguage(language);
      await page.evaluate(() => window.dispatchEvent(new Event('tableline-flush-drafts')));
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.data-grid tbody tr').length === 100);
      assert.equal(await page.getByTestId('language-selector').inputValue(),language);
      assert.equal(await page.locator('html').getAttribute('lang'),language);
      await page.getByRole('button',{name:'SQL',exact:true}).click();
      assert.equal(await page.getByLabel(t(language,'Editor SQL'),{exact:true}).inputValue(),SQL);
    });
  }
  await check('Native process restart restores the persisted language and SQL draft', async () => {
    await close();
    await launch();
    await page.waitForFunction(() => document.querySelectorAll('.data-grid tbody tr').length === 100);
    assert.equal(await page.getByTestId('language-selector').inputValue(),'es');
    await page.getByRole('button',{name:'SQL',exact:true}).click();
    assert.equal(await page.getByLabel(t('es','Editor SQL'),{exact:true}).inputValue(),SQL);
  });
  await check('All locale flows keep database rows unchanged and make zero OS credential calls', async () => {
    const after = (await call('db.query',{connectionId:'demo',sql:'SELECT id, status, total FROM orders ORDER BY id',limit:1000})).rows;
    assert.deepEqual(after,before);
    assert.deepEqual(errors,[]);
    assert.equal(nativeCalls + await app.evaluate(()=>globalThis.tablelineLocaleNativeCalls||0),0);
  });
})().catch(async error => {
  console.error(error.stack);
  process.exitCode=1;
  await page?.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
}).finally(async () => {
  await close().catch(error=>{process.exitCode=1;errors.push(error.message);});
  await fs.mkdir(artifacts,{recursive:true});
  await fs.writeFile(path.join(artifacts,'report.json'),JSON.stringify({date:new Date().toISOString(),runtime:packaged?'packaged Electron':'source Electron',status:process.exitCode?'failed':'passed',languages,checks,rendererErrors:errors,nativeCredentialCalls:nativeCalls},null,2));
  if (directory && !app) await fs.rm(directory,{recursive:true,force:true});
});
