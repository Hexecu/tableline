// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const METHODS = new Set([
  "db.catalog",
  "db.connections",
  "db.saveConnection",
  "db.testConnection",
  "db.removeConnection",
  "db.connect",
  "db.schema",
  "db.query",
  "db.browse",
  "db.prepareWrite",
  "db.commitWrite",
  "db.discardWrite",
  "db.cancel",
  "db.demo",
  "db.close",
  "ai.getConfig",
  "ai.saveProfile",
  "ai.selectProfile",
  "ai.removeProfile",
  "ai.discoverModels",
  "ai.test",
  "ai.providerDestination",
  "assistant.ask",
  "runtime.info",
  "runtime.setLanguage",
  "native.pickFile",
  "native.export",
]);

contextBridge.exposeInMainWorld(
  "tableline",
  Object.freeze({
    call: async (method, ...args) => {
      if (!METHODS.has(method))
        throw new Error("This operation is unavailable.");
      const result = await ipcRenderer.invoke("tableline:call", method, args);
      if (!result?.ok) {
        const error = new Error(
          result?.error?.message || "The operation failed.",
        );
        error.code = result?.error?.code || "OPERATION_FAILED";
        throw error;
      }
      return result.value;
    },
  }),
);
