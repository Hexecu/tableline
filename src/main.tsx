// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./LocaleProvider";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider><App /></I18nProvider>
  </React.StrictMode>,
);
