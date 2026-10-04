// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import { translate, formatNumber, formatDate, getLanguage, languageNames, supportedLanguages } from "./i18n";
import { useI18n } from "./LocaleProvider";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Hash,
  KeyRound,
  Play,
  Plus,
  Search,
  Table2,
  X,
  Code2,
  Braces,
  CornerDownLeft,
  LoaderCircle,
  Sparkles,
  ArrowUpRight,
  ShieldCheck,
  Settings2,
} from "lucide-react";
import type {
  Result,
  Table,
  Column,
  Answer,
  AIConfig,
  Connection,
  Proposal,
} from "./types";
import { call, labelValue, prettyValue, number } from "./api";
export function DataGrid({
  result,
  loading,
  sort,
  onSort,
  onSelect,
  onEdit,
  selected,
}: {
  result: Result | null;
  loading: boolean;
  sort?: { column: string; direction: string };
  onSort?: (name: string) => void;
  onSelect: (
    row: Record<string, unknown>,
    column: string,
    index: number,
  ) => void;
  onEdit?: (row: Record<string, unknown>, column: string) => void;
  selected?: { index: number; column: string } | null;
}) {
  useI18n();

  const grid = useRef<HTMLDivElement>(null);
  return (
    <div
      className={"grid-scroll " + (loading ? "loading" : "")}
      ref={grid}
      aria-label={translate("Risultati")}
    >
      <table className="data-grid">
        <thead>
          <tr>
            <th className="row-number">#</th>
            {result?.columns.map((c, i) => (
              <th key={c.name + "-" + i}>
                <button
                  onClick={() => onSort?.(c.name)}
                  className={!onSort ? "no-sort" : ""}
                >
                  <span>{c.name}</span>
                  {sort?.column === c.name ? (
                    sort.direction === "asc" ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    )
                  ) : (
                    <span className="column-type">
                      {c.type?.toLowerCase().replace(/\(.*/, "").slice(0, 12) ||
                        translate("field")}
                    </span>
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result?.rows.map((row, index) => (
            <tr
              key={index}
              className={selected?.index === index ? "selected-row" : ""}
            >
              <td className="row-number">{formatNumber(index + 1)}</td>
              {result.columns.map((c, ci) => {
                const value = row[c.name];
                const text = labelValue(value);
                const status = [
                  "active",
                  "paid",
                  "completed",
                  "pending",
                  "cancelled",
                  "trial",
                  "shipped",
                  "inactive",
                  "refunded",
                  "delivered",
                ].includes(text.toLowerCase());
                return (
                  <td
                    key={c.name + "-" + ci}
                    className={
                      (selected?.index === index && selected?.column === c.name
                        ? "selected-cell "
                        : "") +
                      (value === null ? "null-cell" : "") +
                      (typeof value === "number" ? " numeric" : "")
                    }
                    tabIndex={0}
                    title={text}
                    onClick={() => onSelect(row, c.name, index)}
                    onFocus={() => onSelect(row, c.name, index)}
                    onDoubleClick={() => onEdit?.(row, c.name)}
                    onKeyDown={(e) => {
                      if (
                        [
                          "ArrowUp",
                          "ArrowDown",
                          "ArrowLeft",
                          "ArrowRight",
                          "Home",
                          "End",
                        ].includes(e.key)
                      ) {
                        e.preventDefault();
                        const cell = e.currentTarget;
                        const rowEl =
                          cell.parentElement! as HTMLTableRowElement;
                        const col = cell.cellIndex;
                        const rowIndex = rowEl.sectionRowIndex;
                        const tbody =
                          rowEl.parentElement! as HTMLTableSectionElement;
                        const nextRow =
                          e.key === "ArrowUp"
                            ? rowIndex - 1
                            : e.key === "ArrowDown"
                              ? rowIndex + 1
                              : rowIndex;
                        const nextCol =
                          e.key === "ArrowLeft"
                            ? col - 1
                            : e.key === "ArrowRight"
                              ? col + 1
                              : e.key === "Home"
                                ? 1
                                : e.key === "End"
                                  ? rowEl.cells.length - 1
                                  : col;
                        if (
                          nextRow >= 0 &&
                          nextRow < tbody.rows.length &&
                          nextCol >= 1 &&
                          nextCol < rowEl.cells.length
                        )
                          tbody.rows[nextRow].cells[nextCol].focus();
                      }
                      if (e.key === "Enter") onSelect(row, c.name, index);
                      if (e.key === "F2") onEdit?.(row, c.name);
                      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
                        e.preventDefault();
                        navigator.clipboard.writeText(text);
                      }
                    }}
                  >
                    {value === null ? (
                      <span className="null">NULL</span>
                    ) : status ? (
                      <span className={"status-pill " + text.toLowerCase()}>
                        {text}
                      </span>
                    ) : (
                      <span>{text}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && (!result || !result.rows.length) && (
        <div className="grid-empty">
          <Table2 size={28} />
          <strong>
            {result ? translate("Nessun risultato") : translate("Uno spazio per le tue query")}
          </strong>
          <span>
            {result
              ? translate("Prova a cambiare filtro o query.")
              : translate("Scrivi SQL e premi ⌘ Invio.")}
          </span>
        </div>
      )}
      {loading && (
        <div className="grid-progress" role="status">
          <LoaderCircle className="spin" size={16} />
          <span>{translate("Caricamento…")}</span>
        </div>
      )}
    </div>
  );
}
export function Structure({ table }: { table: Table | null }) {
  useI18n();

  return (
    <div className="structure-view">
      <div className="section-label">
        {translate("COLONNE")}<span>{formatNumber(table?.columns.length || 0)}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>{translate("Nome")}</th>
            <th>{translate("Tipo")}</th>
            <th>{translate("Null")}</th>
            <th>{translate("Chiave")}</th>
          </tr>
        </thead>
        <tbody>
          {table?.columns.map((c) => (
            <tr key={c.name}>
              <td>
                {c.primaryKey ? <KeyRound size={13} /> : <Hash size={13} />}
                <strong>{c.name}</strong>
              </td>
              <td>
                <code>{c.type}</code>
              </td>
              <td>{c.nullable ? translate("Sì") : translate("No")}</td>
              <td>
                {c.primaryKey ? (
                  <span className="soft-badge">PRIMARY KEY</span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function RowInspector({
  row,
  columns,
  onClose,
  onEdit,
}: {
  row: Record<string, unknown>;
  columns: Column[];
  onClose: () => void;
  onEdit?: (column: string) => void;
}) {
  useI18n();

  const [copied, setCopied] = useState("");
  return (
    <aside className="row-inspector">
      <header>
        <span>
          <Braces size={15} /> {translate("Dettaglio riga")}</span>
        <button
          className="icon-button"
          aria-label={translate("Chiudi dettaglio")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="inspector-fields">
        {columns.map((c) => (
          <section key={c.name}>
            <div>
              <span>{c.name}</span>
              <button
                className="icon-button"
                aria-label={translate("Copia {name}", { name: c.name })}
                onClick={() => {
                  navigator.clipboard.writeText(labelValue(row[c.name]));
                  setCopied(c.name);
                  setTimeout(() => setCopied(""), 1500);
                }}
              >
                {copied === c.name ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
            <pre onDoubleClick={() => onEdit?.(c.name)}>
              {prettyValue(row[c.name])}
            </pre>
            <small>{c.type || typeof row[c.name]}</small>
          </section>
        ))}
      </div>
    </aside>
  );
}
const highlight = (sql: string) =>
  sql
    .split(
      /('(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\b(?:SELECT|FROM|WHERE|GROUP|BY|ORDER|LIMIT|OFFSET|AS|JOIN|LEFT|RIGHT|INNER|ON|AND|OR|NOT|NULL|IS|UPDATE|SET|DELETE|INSERT|INTO|VALUES|COUNT|SUM|AVG|DESC|ASC|DISTINCT|HAVING|WITH|UNION|ALL|CASE|WHEN|THEN|ELSE|END)\b|\b\d+(?:\.\d+)?\b)/gi,
    )
    .map((s, i) => (
      <span
        key={i}
        className={
          s.startsWith("--")
            ? "sql-comment"
            : s.startsWith("'")
              ? "sql-string"
              : /^\d/.test(s)
                ? "sql-number"
                : /^[A-Z_]+$/i.test(s.trim())
                  ? "sql-keyword"
                  : ""
        }
      >
        {s}
      </span>
    ));
export function Editor({
  sql,
  onChange,
  onRun,
  busy,
  tables,
}: {
  sql: string;
  onChange: (sql: string) => void;
  onRun: (selected?: string) => void;
  busy: boolean;
  tables: Table[];
}) {
  useI18n();

  const input = useRef<HTMLTextAreaElement>(null);
  const code = useRef<HTMLPreElement>(null);
  const [completion, setCompletion] = useState(false);
  const [choice, setChoice] = useState(0);
  const [prefix, setPrefix] = useState("");
  const suggestions = [
    ...tables.map((t) => t.name),
    ...new Set(tables.flatMap((t) => t.columns.map((c) => c.name))),
    ..."SELECT FROM WHERE JOIN GROUP BY ORDER BY LIMIT COUNT SUM UPDATE SET INSERT INTO VALUES DELETE".split(
      " ",
    ),
  ]
    .filter(
      (s, i, a) =>
        a.indexOf(s) === i && s.toLowerCase().startsWith(prefix.toLowerCase()),
    )
    .slice(0, 8);
  function accept(word: string) {
    const el = input.current!;
    const p = el.selectionStart;
    const before = sql.slice(0, p).replace(/[a-zA-Z_][a-zA-Z_0-9]*$/, "");
    const next = before + word + sql.slice(p);
    onChange(next);
    setCompletion(false);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length + word.length;
    });
  }
  useEffect(() => {
    const listener = () => input.current?.focus();
    window.addEventListener("focus-sql", listener);
    return () => window.removeEventListener("focus-sql", listener);
  }, []);
  return (
    <div className="sql-editor">
      <div className="line-numbers">
        {sql.split("\n").map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="editor-input">
        <pre ref={code} aria-hidden="true">
          {highlight(sql)}
          {"\n"}
        </pre>
        <textarea
          ref={input}
          aria-label={translate("Editor SQL")}
          spellCheck={false}
          value={sql}
          onChange={(e) => {
            onChange(e.target.value);
            if (completion) {
              setPrefix(
                e.target.value
                  .slice(0, e.target.selectionStart)
                  .match(/[a-zA-Z_][a-zA-Z_0-9]*$/)?.[0] || "",
              );
              setChoice(0);
            }
          }}
          onScroll={(e) => {
            if (code.current) {
              code.current.scrollTop = e.currentTarget.scrollTop;
              code.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!busy)
                onRun(
                  e.currentTarget.value.slice(
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  ) || undefined,
                );
            } else if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
              e.preventDefault();
              setPrefix(
                sql
                  .slice(0, e.currentTarget.selectionStart)
                  .match(/[a-zA-Z_][a-zA-Z_0-9]*$/)?.[0] || "",
              );
              setCompletion(true);
              setChoice(0);
            } else if (completion && e.key === "ArrowDown") {
              e.preventDefault();
              setChoice((i) => Math.min(i + 1, suggestions.length - 1));
            } else if (completion && e.key === "ArrowUp") {
              e.preventDefault();
              setChoice((i) => Math.max(0, i - 1));
            } else if (
              completion &&
              (e.key === "Tab" || e.key === "Enter") &&
              suggestions[choice]
            ) {
              e.preventDefault();
              accept(suggestions[choice]);
            } else if (e.key === "Escape") setCompletion(false);
            else if (e.key === "Tab") {
              e.preventDefault();
              const p = e.currentTarget.selectionStart;
              onChange(
                sql.slice(0, p) +
                  "  " +
                  sql.slice(e.currentTarget.selectionEnd),
              );
              requestAnimationFrame(() => {
                if (input.current)
                  input.current.selectionStart = input.current.selectionEnd =
                    p + 2;
              });
            }
          }}
        />
        {completion && suggestions.length > 0 && (
          <div className="completions">
            {suggestions.map((s, i) => (
              <button
                key={s}
                className={i === choice ? "active" : ""}
                onClick={() => accept(s)}
              >
                <Code2 size={12} />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
export function Assistant({
  connection,
  config,
  onSettings,
  onClose,
  onResult,
  onProposal,
  onSQL,
}: {
  connection: Connection | null;
  config: AIConfig;
  onSettings: () => void;
  onClose: () => void;
  onResult: (r: Result, sql?: string) => void;
  onProposal: (p: Proposal) => void;
  onSQL: (sql: string) => void;
}) {
  useI18n();

  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<
    { prompt: string; answer?: Answer; error?: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"read" | "write">("read");
  const configuredProfile = config.profiles.find(
    (p) => p.id === config.activeProfileId && p.model.trim(),
  );
  const [profile, setProfile] = useState(configuredProfile?.id || "demo");
  const selectedProfile = config.profiles.find((p) => p.id === profile);
  const profileReady = profile === "demo" || !!selectedProfile?.model.trim();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Saving/activating a provider must also select it on the local demo.
    // Discovery can persist a profile before it has a model: keep those local.
    setProfile(configuredProfile?.id || "demo");
  }, [config, connection?.id]);
  useEffect(() => {
    setMessages([]);
    setPrompt("");
    setMode("read");
  }, [connection?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);
  async function ask(text = prompt) {
    if (!text.trim() || busy || !connection || !profileReady) return;
    setBusy(true);
    setPrompt("");
    setMessages((m) => [...m, { prompt: text }]);
    try {
      const a = await call<Answer>("assistant.ask", {
        connectionId: connection.id,
        language: getLanguage(),
        prompt: text,
        profileId: profile,
        mode,
        history: messages
          .slice(-3)
          .flatMap((m) => [
            { role: "user", content: m.prompt },
            ...(m.answer
              ? [{ role: "assistant", content: m.answer.answer }]
              : []),
          ]),
      });
      setMessages((m) =>
        m.map((item, i) =>
          i === m.length - 1 ? { ...item, answer: a } : item,
        ),
      );
    } catch (e) {
      setMessages((m) =>
        m.map((item, i) =>
          i === m.length - 1 ? { ...item, error: (e as Error).message } : item,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="assistant">
      <header>
        <span>
          <Sparkles size={17} /> {translate("Assistente")}</span>
        <div>
          <button
            className="icon-button"
            aria-label={translate("Impostazioni AI")}
            onClick={onSettings}
          >
            <Settings2 size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={translate("Chiudi assistente")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="assistant-controls">
        <select
          aria-label={translate("Profilo assistente")}
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
        >
          <option value="demo">{translate("Demo locale · nessun LLM")}</option>
          {config.profiles.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.model.trim()}>
              {p.name} · {p.model || translate("Scegli modello")}
            </option>
          ))}
        </select>
        <div className="assistant-mode">
          <button
            className={mode === "read" ? "active" : ""}
            onClick={() => setMode("read")}
          >
            <ShieldCheck size={12} /> {translate("Leggi")}</button>
          <button
            className={mode === "write" ? "active" : ""}
            disabled={connection?.readOnly}
            title={
              connection?.readOnly
                ? translate("Abilita le scritture nella connessione")
                : ""
            }
            onClick={() => setMode("write")}
          >
            {translate("Prepara modifica")}</button>
        </div>
        {profile !== "demo" && (
          <div className="destination">
            {translate("Dati →")}{" "}
            {selectedProfile?.baseUrl || selectedProfile?.provider}{" "}
            · {selectedProfile?.model}
          </div>
        )}
      </div>
      <div className="conversation">
        {!messages.length && (
          <div className="assistant-empty">
            <span className="sparkle-disc">
              <Sparkles size={25} />
            </span>
            <h3>{translate("Dai dati, alle risposte.")}</h3>
            <p>{translate("Esplora lo schema, trova un dato o prepara una modifica.")}</p>
            <div className="suggestions">
              {[
                translate("Quanti clienti ci sono?"),
                translate("Ricavi per paese"),
                translate("Mostrami gli ordini in attesa"),
              ].map((p) => (
                <button key={p} onClick={() => ask(p)}>
                  {p}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
            <small>
              {profile === "demo"
                ? translate("Demo deterministica su dati reali.")
                : translate("Le risposte si basano su query al database.")}
            </small>
          </div>
        )}
        {messages.map((m, i) => (
          <div className="exchange" key={i}>
            <div className="user-message">{m.prompt}</div>
            {m.error && <div className="form-error">{translate(m.error)}</div>}
            {m.answer && (
              <div className="assistant-message">
                <span className="answer-icon">
                  <Sparkles size={13} />
                  {m.answer.isMock && <small>DEMO</small>}
                </span>
                <div className="answer-text">{m.answer.answer}</div>
                {m.answer.sql && (
                  <details className="query-evidence">
                    <summary>
                      <Code2 size={12} /> {translate("Query eseguita")}<ChevronDown size={12} />
                    </summary>
                    <pre>{m.answer.sql}</pre>
                    <button
                      className="text-button"
                      onClick={() => onSQL(m.answer!.sql!)}
                    >
                      {translate("Apri nell’editor")}<ArrowUpRight size={12} />
                    </button>
                  </details>
                )}
                {m.answer.result && (
                  <button
                    className="answer-result"
                    onClick={() => onResult(m.answer!.result!, m.answer!.sql)}
                  >
                    <Table2 size={14} />
                    {number(m.answer.result.rowCount)}  {translate("righe ·", { count: m.answer.result.rowCount })}{" "}
                    {formatNumber(m.answer.result.durationMs, { maximumFractionDigits: 0 })} ms
                    <ChevronRight size={14} />
                  </button>
                )}
                {m.answer.proposal && (
                  <button
                    className="primary review-ai"
                    onClick={() => onProposal(m.answer!.proposal!)}
                  >
                    {translate("Rivedi modifica")}<ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="thinking">
            <LoaderCircle size={15} className="spin" />
            {translate("Interrogo i dati…")}</div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="assistant-compose"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          aria-label={translate("Domanda sui dati")}
          placeholder={
            mode === "read" ? translate("Chiedi ai tuoi dati…") : translate("Descrivi la modifica…")
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <div>
          <span>
            {mode === "read"
              ? translate("Sola lettura")
              : translate("Ogni scrittura richiede la tua revisione")}
          </span>
          <button
            className="send-button"
            aria-label={translate("Invia domanda")}
            disabled={busy || !prompt.trim() || !connection || !profileReady}
            type="submit"
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </div>
      </form>
      <div className="assistant-footnote">
        {profile === "demo"
          ? translate("Demo locale · nessun dato inviato")
          : translate("Verifica le risposte e il SQL prima di usarli")}
      </div>
    </aside>
  );
}
