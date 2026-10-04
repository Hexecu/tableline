// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

export async function call<T = any>(
  method: string,
  ...args: unknown[]
): Promise<T> {
  if (window.tableline) {
    try {
      return await window.tableline.call(method, ...args);
    } catch (error) {
      if (error instanceof Error) {
        const localized = new Error(translate(error.message), { cause: error });
        Object.assign(localized, { code: (error as Error & { code?: string }).code });
        throw localized;
      }
      throw error;
    }
  }
  throw new Error(translate("Apri Tableline con npm run dev o dall’app desktop."));
}
export const labelValue = (v: unknown): string =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
export const prettyValue = (v: unknown): string =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "object"
      ? JSON.stringify(v, null, 2)
      : String(v);
export const number = (v: number) => formatNumber(v);
export const quote = (name: string, driver: string) =>
  driver.includes("mysql") ||
  driver === "mariadb" ||
  driver === "databricks" ||
  driver === "clickhouse"
    ? "`" + name.replace(/`/g, "``") + "`"
    : driver === "sqlserver"
      ? "[" + name.replace(/]/g, "]]") + "]"
      : '"' + name.replace(/"/g, '""') + '"';
import { translate, formatNumber } from "./i18n";
