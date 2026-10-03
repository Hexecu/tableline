"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Menu,
  session,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { DatabaseService } = require("./database.cjs");
const { AIService } = require("./ai.cjs");
const { AssistantService } = require("./assistant.cjs");
const { AIVault } = require("./ai-vault.cjs");
const { setMenuLanguage } = require("./menu.cjs");
const { armShutdownGuard } = require("./shutdown-guard.cjs");
const {
  CHANNEL,
  assertRequest,
  assertSender,
  allowedDocument,
  safeError,
  exportContent,
  failure,
} = require("./runtime-security.cjs");

app.setName("Tableline");
const qaMode = process.argv.includes("--tableline-qa");
const argument = (prefix) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
if (qaMode && argument("--tableline-data="))
  app.setPath("userData", path.resolve(argument("--tableline-data=")));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
const indexPath = path.join(__dirname, "..", "dist", "index.html");
const devURL =
  !app.isPackaged && process.env.TABLELINE_DEV_URL
    ? process.env.TABLELINE_DEV_URL
    : null;
if (devURL && !/^http:\/\/127\.0\.0\.1:5188\/?$/.test(devURL))
  throw new Error("Invalid local development URL.");
const documentOptions = { indexPath, devURL };
let window;
let database;

function createWindow() {
  window = new BrowserWindow({
    width: 1512,
    height: 980,
    minWidth: 1050,
    minHeight: 660,
    title: "Tableline",
    backgroundColor: "#080b13",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 17 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged || qaMode,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!allowedDocument(url, documentOptions)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => {
    window.show();
    if (!qaMode) window.focus();
  });
  if (devURL) window.loadURL(devURL);
  else window.loadFile(indexPath);
  window.on("closed", () => {
    window = null;
  });
}

app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
if (hasInstanceLock)
  app
    .whenReady()
    .then(async () => {
      const directory = app.getPath("userData");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const vault = new AIVault({ directory, safeStorage });
      database = new DatabaseService({ directory, vault });
      const ai = new AIService({
        file: path.join(directory, "ai-profiles.json"),
        vault,
      });
      const assistant = new AssistantService({ ai, database });
      const services = { db: database, ai, assistant };
      const csp = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        devURL
          ? "connect-src http://127.0.0.1:5188 ws://127.0.0.1:5188"
          : "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      session.defaultSession.webRequest.onHeadersReceived(
        (details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [csp],
              "X-Content-Type-Options": ["nosniff"],
            },
          });
        },
      );
      const clipboardWrite = (contents, permission) =>
        permission === "clipboard-sanitized-write" &&
        contents === window?.webContents &&
        allowedDocument(contents.getURL(), documentOptions);
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback) =>
          callback(clipboardWrite(contents, permission)),
      );
      session.defaultSession.setPermissionCheckHandler((contents, permission) =>
        clipboardWrite(contents, permission),
      );
      ipcMain.handle(CHANNEL, async (event, method, args) => {
        try {
          assertSender(event, window, documentOptions);
          assertRequest(method, args);
          let value;
          if (method === "runtime.info") {
            value = {
              name: "Tableline",
              version: app.getVersion(),
              platform: process.platform,
              encryptedCredentials: vault.status() === "available",
              credentialStatus: vault.status(),
              qaMode,
            };
          } else if (method === "runtime.setLanguage") {
            value = setMenuLanguage(Menu, args[0]);
          } else if (method === "native.pickFile") {
            const options = args[0] || {};
            const result = await dialog.showOpenDialog(window, {
              properties: ["openFile"],
              filters:
                options.kind === "database"
                  ? [
                      {
                        name: "SQLite databases",
                        extensions: ["db", "sqlite", "sqlite3"],
                      },
                      { name: "All files", extensions: ["*"] },
                    ]
                  : undefined,
            });
            value = result.canceled ? null : result.filePaths[0];
          } else if (method === "native.export") {
            const payload = args[0];
            const body = exportContent(payload);
            const filename = path.basename(
              payload.filename || `tableline-export.${payload.format}`,
            );
            let filePath;
            if (qaMode && argument("--tableline-export=")) {
              const exportDirectory = path.resolve(
                argument("--tableline-export="),
              );
              await fs.mkdir(exportDirectory, { recursive: true });
              filePath = path.join(exportDirectory, filename);
            } else {
              const result = await dialog.showSaveDialog(window, {
                defaultPath: filename,
                filters: [
                  {
                    name: payload.format.toUpperCase(),
                    extensions: [payload.format],
                  },
                ],
              });
              if (!result.canceled) filePath = result.filePath;
            }
            if (!filePath) value = { canceled: true };
            else {
              await fs.writeFile(filePath, body, { mode: 0o600 });
              value = {
                canceled: false,
                path: filePath,
                bytes: Buffer.byteLength(body),
              };
            }
          } else {
            const [group, operation] = method.split(".");
            const service = services[group];
            if (typeof service?.[operation] !== "function")
              throw failure(
                "This operation is unavailable.",
                "METHOD_NOT_ALLOWED",
              );
            value = await service[operation](...args);
          }
          return { ok: true, value: value === undefined ? null : value };
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      });
      createWindow();
      app.on("activate", () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
      });
    })
    .catch((error) => {
      console.error(safeError(error).message);
      app.exit(1);
    });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || qaMode) app.quit();
});
let quitting = false;
app.on("before-quit", (event) => {
  if (!database) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  let flushTimer;
  const flush =
    typeof window?.webContents?.executeJavaScript === "function"
      ? Promise.race([
          window.webContents
            .executeJavaScript(
              "window.dispatchEvent(new Event('tableline-flush-drafts'))",
            )
            .catch(() => {}),
          new Promise((resolve) => {
            flushTimer = setTimeout(resolve, 1000);
          }),
        ]).finally(() => clearTimeout(flushTimer))
      : Promise.resolve();
  flush
    .then(() => database.close())
    .catch(() => {})
    .finally(async () => {
      // Native Keychain work can outlive its Promise deadline during shutdown.
      // Exit after database closure without draining unrelated native workers.
      await armShutdownGuard().catch(() => {});
      app.exit(0);
    });
});
