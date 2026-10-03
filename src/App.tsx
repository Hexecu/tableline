import { translate, formatNumber, formatDate, getLanguage, languageNames, supportedLanguages } from "./i18n";
import { useI18n } from "./LocaleProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Command,
  Copy,
  Database,
  FolderOpen,
  History,
  LayoutPanelLeft,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Table2,
  Terminal,
  Trash2,
  X,
  Play,
  PanelRightClose,
  Sun,
  Moon,
  AlertTriangle,
  Bookmark,
  GripHorizontal,
  KeyRound,
} from "lucide-react";
import { call, number, quote, labelValue } from "./api";
import { loadDraft, saveDraft, MAX_DRAFT_TABS } from "./drafts";
import type { Draft } from "./drafts";
import { Connections, EngineMark, Modal, Providers } from "./Settings";
import {
  Assistant,
  DataGrid,
  Editor,
  RowInspector,
  Structure,
} from "./Workspace";
import type {
  AIConfig,
  Connection,
  Driver,
  Proposal,
  Result,
  Table,
} from "./types";
type QueryTab = {
  id: string;
  name: string;
  sql: string;
  result: Result | null;
  error: string;
  busy: boolean;
  requestId?: string;
};
type HistoryEntry = {
  sql: string;
  connectionId: string;
  time: number;
  rows: number;
  ms: number;
  error?: string;
};
const emptySQL = "SELECT *\nFROM customers\nLIMIT 100;";
const blank = (): QueryTab => ({
  id: crypto.randomUUID(),
  name: "Query",
  sql: emptySQL,
  result: null,
  error: "",
  busy: false,
});
function readSaved<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem("tableline." + key) || "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
const paramsAt = (n: number, driver: string) =>
  ["postgres", "aurora-postgresql", "cockroachdb", "redshift"].includes(driver)
    ? "$" + n
    : driver === "sqlserver"
      ? "@p" + n
      : "?";
export default function App() {
  const { language, setLanguage } = useI18n();

  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<Driver[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [schema, setSchema] = useState<Table[]>([]);
  const [table, setTable] = useState<Table | null>(null);
  const [view, setView] = useState<"data" | "sql" | "structure">("data");
  const [side, setSide] = useState<"tables" | "history" | "saved">("tables");
  const [assistant, setAssistant] = useState(readSaved("assistant", true));
  const [theme, setTheme] = useState(readSaved("theme", "light"));
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [tableSearch, setTableSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [cursors, setCursors] = useState<string[]>(["0"]);
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<
    { column: string; direction: string } | undefined
  >();
  const [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<{
    row: Record<string, unknown>;
    column: string;
    index: number;
  } | null>(null);
  const [inspector, setInspector] = useState(false);
  const [tabs, setTabs] = useState<QueryTab[]>([blank()]);
  const [activeTab, setActiveTab] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>(
    readSaved("history", []),
  );
  const [saved, setSaved] = useState<{ name: string; sql: string }[]>(
    readSaved("saved", []),
  );
  const [modal, setModal] = useState<
    "connection" | "providers" | "palette" | "edit" | "save" | "help" | null
  >(null);
  const [editingConnection, setEditingConnection] = useState<
    Connection | undefined
  >();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [edit, setEdit] = useState<{
    row: Record<string, unknown>;
    column: string;
    value: string;
    isNull: boolean;
  } | null>(null);
  const [saveName, setSaveName] = useState("");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [notification, setNotification] = useState("");
  const [aiConfig, setAIConfig] = useState<AIConfig>({
    profiles: [],
    activeProfileId: null,
  });
  const [editorHeight, setEditorHeight] = useState(190);
  const sequence = useRef(0);
  const connectSequence = useRef(0);
  const mounted = useRef(true);
  const connectionRef = useRef(connection);
  const tableRef = useRef(table);
  const draftOwner = useRef<string | null>(null);
  const draftSnapshot = useRef<Draft | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const draftWarning = useRef(false);
  draftSnapshot.current =
    connection && draftOwner.current === connection.id
      ? {
          connectionId: connection.id,
          tabs: tabs.map(({ id, name, sql }) => ({ id, name, sql })),
          activeTab,
        }
      : null;
  const flushDraft = useCallback(() => {
    clearTimeout(draftTimer.current);
    const snapshot = draftSnapshot.current;
    if (!snapshot) return;
    const stored = saveDraft(localStorage, snapshot, () => {
      setNotification(
        translate("Ripristino limitato: le bozze più vecchie sono state rimosse. Salva le query importanti con ⌘ S."),
      );
      setTimeout(() => setNotification(""), 5000);
    });
    if (!stored && !draftWarning.current) {
      draftWarning.current = true;
      setNotification(
        translate("Ripristino automatico non disponibile. Salva le query importanti."),
      );
      setTimeout(() => setNotification(""), 5000);
    }
  }, []);
  useEffect(() => {
    draftTimer.current = setTimeout(flushDraft, 350);
    return () => clearTimeout(draftTimer.current);
  }, [tabs, activeTab, connection?.id, flushDraft]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    window.addEventListener("tableline-flush-drafts", flushDraft);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flushDraft();
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
      window.removeEventListener("tableline-flush-drafts", flushDraft);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [flushDraft]);
  const tab = tabs.find((t) => t.id === activeTab) || tabs[0];
  const output = view === "sql" ? tab.result : result;
  const activeDriver = catalog.find((d) => d.id === connection?.driver);
  useEffect(() => {
    connectionRef.current = connection;
    tableRef.current = table;
  }, [connection, table]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tableline.theme", JSON.stringify(theme));
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("tableline.assistant", JSON.stringify(assistant));
  }, [assistant]);
  useEffect(() => {
    localStorage.setItem(
      "tableline.history",
      JSON.stringify(history.slice(0, 100)),
    );
  }, [history]);
  useEffect(() => {
    localStorage.setItem("tableline.saved", JSON.stringify(saved));
  }, [saved]);
  function notify(text: string) {
    setNotification(text);
    setTimeout(() => setNotification(""), 3500);
  }
  async function open(c: Connection) {
    flushDraft();
    const id = ++connectSequence.current;
    sequence.current++;
    setConnecting(true);
    setError("");
    try {
      await call("db.connect", c.id);
      const tables = await call<Table[]>("db.schema", c.id);
      if (id !== connectSequence.current) return;
      flushDraft();
      setSelected(null);
      setResult(null);
      setConnection(c);
      setFilter("");
      setOffset(0);
      setCursors(["0"]);
      setSort(undefined);
      setSchema(tables);
      setTable(tables[0] || null);
      setView("data");
      setSide("tables");
      localStorage.setItem("tableline.lastConnection", c.id);
      const first = tables[0];
      const sql = first
        ? c.driver === "mongodb"
          ? JSON.stringify(
              {
                collection: first.name,
                operation: "find",
                filter: {},
                limit: 100,
              },
              null,
              2,
            )
          : c.driver === "redis"
            ? JSON.stringify(
                { command: "SCAN", args: ["0", "COUNT", "100"] },
                null,
                2,
              )
            : `SELECT ${c.driver === "sqlserver" ? "TOP (100) " : ""}*\nFROM ${first.schema ? quote(first.schema, c.driver) + "." : ""}${quote(first.name, c.driver)}${c.driver === "sqlserver" ? ";" : "\nLIMIT 100;"}`
        : "";
      const newTab = { ...blank(), sql: sql || emptySQL };
      const draft = loadDraft(localStorage, c.id);
      draftOwner.current = c.id;
      setTabs(
        draft
          ? draft.tabs.map((item) => ({
              ...item,
              result: null,
              error: "",
              busy: false,
            }))
          : [newTab],
      );
      setActiveTab(draft?.activeTab || newTab.id);
    } catch (e) {
      if (id === connectSequence.current) setError((e as Error).message);
    } finally {
      if (id === connectSequence.current) setConnecting(false);
    }
  }
  async function loadDemo() {
    setConnecting(true);
    setError("");
    try {
      await call("db.demo");
      const list = await call<Connection[]>("db.connections");
      setConnections(list);
      const c =
        list.find(
          (c) =>
            c.id === "demo" ||
            c.isDemo ||
            c.name.toLowerCase().includes("demo"),
        ) || list[0];
      if (c) await open(c);
    } catch (e) {
      setError((e as Error).message);
      setConnecting(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    Promise.all([
      call<Driver[]>("db.catalog"),
      call<Connection[]>("db.connections"),
      call<AIConfig>("ai.getConfig"),
    ])
      .then(([cat, list, ai]) => {
        if (!mounted.current) return;
        setCatalog(cat);
        setConnections(list);
        setAIConfig(ai);
        const last = localStorage.getItem("tableline.lastConnection");
        const c = list.find((c) => c.id === last);
        if (c) open(c);
      })
      .catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
      connectSequence.current++;
      sequence.current++;
    };
  }, []);
  async function refreshSchema() {
    if (!connection) return;
    try {
      const s = await call<Table[]>("db.schema", connection.id);
      setSchema(s);
      setTable(
        (t) =>
          s.find((x) => x.name === t?.name && x.schema === t?.schema) ||
          s[0] ||
          null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const load = useCallback(async () => {
    if (!connection || !table || view !== "data" || connecting) return;
    const seq = ++sequence.current;
    setLoading(true);
    setError("");
    setSelected(null);
    try {
      const r = await call<Result>("db.browse", {
        connectionId: connection.id,
        table: table.name,
        schema: table.schema,
        search: filter,
        sortColumn: sort?.column,
        sortDirection: sort?.direction,
        offset,
        limit,
        cursor:
          connection.driver === "redis"
            ? cursors[Math.floor(offset / limit)] || "0"
            : undefined,
      });
      if (seq === sequence.current) setResult(r);
    } catch (e) {
      if (seq === sequence.current) {
        setError((e as Error).message);
        setResult(null);
      }
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [
    connection,
    table,
    filter,
    sort,
    offset,
    limit,
    view,
    connecting,
    cursors,
  ]);
  useEffect(() => {
    const timer = setTimeout(load, filter ? 180 : 0);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [load]);
  function selectTable(t: Table) {
    setTable(t);
    setView("data");
    setOffset(0);
    setCursors(["0"]);
    setFilter("");
    setSort(undefined);
    setSelected(null);
    setError("");
  }
  function updateTab(id: string, values: Partial<QueryTab>) {
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, ...values } : x)));
  }
  function openSQL(sql?: string, name = "Query") {
    if (tabs.length >= MAX_DRAFT_TABS) {
      notify(translate("Sono aperte 16 query. Chiudi una scheda per continuare."));
      return;
    }
    if (tabs.length >= MAX_DRAFT_TABS) {
      notify(translate("Chiudi una scheda per aprire un'altra query."));
      return;
    }
    const t = { ...blank(), name, sql: sql ?? "" };
    setTabs((prev) => [...prev, t]);
    setActiveTab(t.id);
    setView("sql");
    setSelected(null);
    setTimeout(() => window.dispatchEvent(new Event("focus-sql")), 50);
  }
  async function run(selectedSQL?: string) {
    if (!connection || tab.busy || connecting) return;
    const c = connection,
      tid = tab.id,
      requestId = crypto.randomUUID();
    const sql = (selectedSQL || tab.sql).trim();
    if (!sql) return;
    updateTab(tid, { busy: true, error: "", requestId });
    const start = performance.now();
    try {
      let jsonWrite = false;
      if (["mongodb", "redis"].includes(c.driver)) {
        try {
          const cmd = JSON.parse(sql);
          jsonWrite =
            ["insertOne", "updateMany", "deleteMany"].includes(cmd.operation) ||
            [
              "SET",
              "DEL",
              "HSET",
              "HDEL",
              "LPUSH",
              "RPUSH",
              "SADD",
              "SREM",
              "ZADD",
              "ZREM",
              "EXPIRE",
              "PERSIST",
            ].includes(String(cmd.command).toUpperCase());
        } catch {}
      }
      const isWrite =
        jsonWrite ||
        /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(UPDATE|INSERT|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(
          sql,
        );
      if (isWrite) {
        if (c.readOnly)
          throw Error(
            translate("Connessione in sola lettura. Abilita le scritture nelle impostazioni della connessione."),
          );
        const p = await call<Proposal>("db.prepareWrite", {
          connectionId: c.id,
          sql,
        });
        if (connectionRef.current?.id !== c.id) return;
        setProposal(p);
        setMutationError("");
      } else {
        const r = await call<Result>("db.query", {
          connectionId: c.id,
          sql,
          limit: 1000,
          requestId,
        });
        updateTab(tid, { result: r });
        setHistory((h) =>
          [
            {
              sql,
              connectionId: c.id,
              time: Date.now(),
              rows: r.rowCount,
              ms: r.durationMs,
            },
            ...h,
          ].slice(0, 100),
        );
        setSelected(null);
      }
    } catch (e) {
      const err = (e as Error).message;
      updateTab(tid, { error: err });
      setHistory((h) =>
        [
          {
            sql,
            connectionId: c.id,
            time: Date.now(),
            rows: 0,
            ms: performance.now() - start,
            error: err,
          },
          ...h,
        ].slice(0, 100),
      );
    } finally {
      updateTab(tid, { busy: false, requestId: undefined });
    }
  }
  async function cancelQuery() {
    if (!tab.requestId) return;
    try {
      const r = await call("db.cancel", tab.requestId);
      if (!r.cancelled)
        notify(
          translate("Il connettore non supporta l’annullamento. Timeout massimo: 30 secondi."),
        );
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function startEdit(row: Record<string, unknown>, column: string) {
    if (!connection || !table || view !== "data") return;
    if (["mongodb", "redis"].includes(connection.driver)) {
      notify(translate("Prepara la modifica tramite una query JSON."));
      return;
    }
    if (connection.readOnly) {
      notify(translate("Connessione in sola lettura"));
      return;
    }
    const pk = table.columns.filter((c) => c.primaryKey);
    if (!pk.length) {
      notify(translate("Per modificare una cella è necessaria una chiave primaria."));
      return;
    }
    setEdit({
      row,
      column,
      value: row[column] === null ? "" : labelValue(row[column]),
      isNull: row[column] === null,
    });
    setMutationError("");
    setModal("edit");
  }
  async function prepareEdit() {
    if (!edit || !connection || !table) return;
    setCommitBusy(true);
    setMutationError("");
    try {
      const driver = connection.driver;
      let value: unknown = edit.isNull ? null : edit.value;
      const old = edit.row[edit.column];
      if (!edit.isNull && typeof old === "number") {
        if (!edit.value.trim() || !Number.isFinite(Number(edit.value)))
          throw Error(translate("Inserisci un numero valido."));
        value = Number(edit.value);
      }
      const params: unknown[] = [value];
      const where = table.columns
        .filter((c) => c.primaryKey)
        .map((c) => {
          params.push(edit.row[c.name]);
          return `${quote(c.name, driver)} = ${paramsAt(params.length, driver)}`;
        });
      if (old === null) where.push(`${quote(edit.column, driver)} IS NULL`);
      else {
        params.push(old);
        where.push(
          `${quote(edit.column, driver)} = ${paramsAt(params.length, driver)}`,
        );
      }
      const sql = `UPDATE ${table.schema ? quote(table.schema, driver) + "." : ""}${quote(table.name, driver)} SET ${quote(edit.column, driver)} = ${paramsAt(1, driver)} WHERE ${where.join(" AND ")}`;
      const p = await call<Proposal>("db.prepareWrite", {
        connectionId: connection.id,
        sql,
        params,
      });
      setProposal(p);
      setModal(null);
      setEdit(null);
    } catch (e) {
      setMutationError((e as Error).message);
    } finally {
      setCommitBusy(false);
    }
  }
  function discardProposal() {
    if (commitBusy) return;
    if (proposal) call("db.discardWrite", { id: proposal.id }).catch(() => {});
    setProposal(null);
    setMutationError("");
  }
  async function commit() {
    if (!proposal) return;
    setCommitBusy(true);
    setMutationError("");
    try {
      const r = await call("db.commitWrite", { id: proposal.id });
      notify(
        translate("Modifica salvata · {count} righe", { count: formatNumber(r.affectedRows ?? r.rowCount ?? proposal.affectedRows ?? 0) }),
      );
      setProposal(null);
      await refreshSchema();
      if (view === "data") await load();
      else updateTab(tab.id, { result: null, error: "" });
    } catch (e) {
      setMutationError((e as Error).message);
    } finally {
      setCommitBusy(false);
    }
  }
  async function exportData(format: "csv" | "json") {
    if (!output) return;
    try {
      const r = await call("native.export", {
        format,
        filename:
          (view === "sql" ? "query" : table?.name || "dati") + "." + format,
        columns: output.columns.map((c) => ({ name: c.name, key: c.name })),
        rows: output.rows,
      });
      if (!r.canceled)
        notify(translate("Esportate {count} righe · {path}", { count: formatNumber(output.rows.length), path: r.path }));
    } catch (e) {
      notify((e as Error).message);
    }
  }
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModal(null);
        if (!commitBusy) discardProposal();
        return;
      }
      if (modal || proposal) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m === "palette" ? null : "palette"));
        setPaletteSearch("");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        openSQL();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setAssistant((a) => !a);
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "s" &&
        view === "sql"
      ) {
        e.preventDefault();
        setModal("save");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && view === "data") {
        e.preventDefault();
        load();
      }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [view, load, tabs, tab, commitBusy, proposal, modal]);
  const total = result?.total;
  const selectedRow = selected?.row;
  const paletteActions = [
    { label: translate("Nuova query"), hint: "⌘ T", action: () => openSQL() },
    {
      label: translate("Nuova connessione"),
      hint: "",
      action: () => {
        setEditingConnection(undefined);
        setModal("connection");
      },
    },
    { label: translate("Apri demo locale"), hint: "", action: () => loadDemo() },
    { label: translate("Provider AI"), hint: "", action: () => setModal("providers") },
    {
      label: assistant ? translate("Nascondi assistente") : translate("Apri assistente"),
      hint: "⌘ I",
      action: () => setAssistant((a) => !a),
    },
    {
      label: translate("Cambia tema"),
      hint: "",
      action: () => setTheme((t) => (t === "light" ? "dark" : "light")),
    },
    { label: translate("Aggiorna dati"), hint: "⌘ ↵", action: () => load() },
    { label: translate("Esporta CSV"), hint: "", action: () => exportData("csv") },
    ...schema.map((t) => ({
      label: t.name,
      hint: t.schema || translate("Tabella"),
      action: () => selectTable(t),
    })),
  ].filter((x) => x.label.toLowerCase().includes(paletteSearch.toLowerCase()));
  return (
    <div className="app">
      <div className="titlebar">
        <div className="window-space" />
        <div className="wordmark">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          tableline<span className="version">{translate("workspace")}</span>
        </div>
        <label className="language-picker"><span className="sr-only">{translate("Lingua")}</span><select data-testid="language-selector" aria-label={translate("Lingua")} value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{supportedLanguages.map(locale => <option key={locale} value={locale}>{languageNames[locale]}</option>)}</select></label>
        <div className="titlebar-center">
          {connection ? (
            <>
              <EngineMark driver={connection.driver} small />
              <span>{connection.name}</span>
              <span className="connection-dot" />
            </>
          ) : (
            <span>{translate("Il tuo spazio per i dati")}</span>
          )}
        </div>
        <button
          className="command-trigger"
          onClick={() => {
            setModal("palette");
            setPaletteSearch("");
          }}
        >
          <Search size={13} />  {translate("Cerca o esegui un comando")} <kbd>⌘ K</kbd>
        </button>
      </div>
      <div className="app-body" inert={!!modal || !!proposal}>
        <aside className="sidebar">
          <div className="sidebar-top">
            <span className="section-label">{translate("CONNESSIONI")}</span>
            <button
              className="icon-button"
              aria-label={translate("Nuova connessione")}
              onClick={() => {
                setEditingConnection(undefined);
                setModal("connection");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="connection-switch">
            <div className="connection-select">
              <EngineMark driver={connection?.driver || "sqlite"} small />
              <select
                aria-label={translate("Connessione attiva")}
                value={connection?.id || ""}
                onChange={(e) => {
                  const c = connections.find((c) => c.id === e.target.value);
                  if (c) open(c);
                }}
              >
                <option value="" disabled>
                  {translate("Scegli connessione")}</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
            {connection && (
              <div className="connection-meta">
                <span>
                  {connection.driver === "sqlite"
                    ? translate("Locale")
                    : connection.host || connection.driver}
                </span>
                <button
                  className="icon-button"
                  aria-label={translate("Modifica connessione")}
                  onClick={() => {
                    setEditingConnection(connection);
                    setModal("connection");
                  }}
                >
                  <Settings2 size={12} />
                </button>
              </div>
            )}
          </div>
          <div className="sidebar-tabs">
            <button
              className={side === "tables" ? "active" : ""}
              aria-label={translate("Tabelle")}
              onClick={() => setSide("tables")}
            >
              <Table2 size={15} />
            </button>
            <button
              className={side === "saved" ? "active" : ""}
              aria-label={translate("Query salvate")}
              onClick={() => setSide("saved")}
            >
              <Bookmark size={15} />
            </button>
            <button
              className={side === "history" ? "active" : ""}
              aria-label={translate("Cronologia query")}
              onClick={() => setSide("history")}
            >
              <Clock3 size={15} />
            </button>
          </div>
          {side === "tables" ? (
            <>
              <div className="sidebar-search">
                <Search size={13} />
                <input
                  aria-label={translate("Cerca tabelle")}
                  placeholder={translate("Cerca tabelle…")}
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                />
              </div>
              <div className="sidebar-section">
                <span className="section-label">
                  {schema[0]?.schema || translate("DATABASE")}
                  <span>{formatNumber(schema.length)}</span>
                </span>
                <button
                  className="icon-button"
                  aria-label={translate("Aggiorna schema")}
                  onClick={refreshSchema}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              <nav className="table-list">
                {schema
                  .filter((t) =>
                    t.name.toLowerCase().includes(tableSearch.toLowerCase()),
                  )
                  .map((t) => (
                    <button
                      key={(t.schema || "") + t.name}
                      className={
                        table?.name === t.name && table?.schema === t.schema
                          ? "active"
                          : ""
                      }
                      onClick={() => selectTable(t)}
                    >
                      <Table2 size={14} />
                      <span>{t.name}</span>
                      <small>{formatNumber(t.columns.length)}</small>
                    </button>
                  ))}
                {!schema.length && !connecting && (
                  <p className="sidebar-empty">
                    {translate("Apri una connessione per esplorare le tabelle.")}</p>
                )}
              </nav>
            </>
          ) : side === "history" ? (
            <div className="history-list">
              <div className="sidebar-section">
                <span className="section-label">{translate("CRONOLOGIA")}</span>
                <button
                  className="icon-button"
                  aria-label={translate("Svuota cronologia")}
                  onClick={() => setHistory([])}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {history
                .filter((h) => h.connectionId === connection?.id)
                .map((h, i) => (
                  <button key={i} onClick={() => openSQL(h.sql, translate("Cronologia"))}>
                    <span className={h.error ? "error-dot" : "success-dot"} />
                    <code>{h.sql.replace(/\s+/g, " ").slice(0, 84)}</code>
                    <small>
                      {formatDate(h.time, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · {h.error ? translate("Errore") : translate("{count} righe", { count: formatNumber(h.rows) })}
                    </small>
                  </button>
                ))}
              {!history.filter((h) => h.connectionId === connection?.id)
                .length && (
                <p className="sidebar-empty">
                  {translate("Le query eseguite appariranno qui.")}</p>
              )}
            </div>
          ) : (
            <div className="saved-list">
              <div className="sidebar-section">
                <span className="section-label">{translate("QUERY SALVATE")}</span>
              </div>
              {saved.map((s, i) => (
                <div key={i}>
                  <button onClick={() => openSQL(s.sql, s.name)}>
                    <Bookmark size={13} />
                    {s.name}
                  </button>
                  <button
                    aria-label={translate("Elimina query {name}", { name: s.name })}
                    className="icon-button"
                    onClick={() => setSaved((p) => p.filter((_, j) => j !== i))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {!saved.length && (
                <p className="sidebar-empty">
                  {translate("Salva una query con ⌘ S per ritrovarla subito.")}</p>
              )}
            </div>
          )}
          <div className="sidebar-bottom">
            <button onClick={() => setModal("providers")}>
              <Sparkles size={15} />
              <span>{translate("Provider AI")}</span>
              <span className="tiny-badge">
                {aiConfig.profiles.length || "+"}
              </span>
            </button>
            <div>
              <button
                className="icon-button"
                aria-label={translate("Cambia tema")}
                onClick={() =>
                  setTheme((t) => (t === "light" ? "dark" : "light"))
                }
              >
                {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
              </button>
              <button
                className="icon-button"
                aria-label={translate("Guida rapida")}
                onClick={() => setModal("help")}
              >
                <BookOpen size={15} />
              </button>
              <span>{translate("LOCAL FIRST")}</span>
              <ShieldCheck size={13} />
            </div>
          </div>
        </aside>
        <main className="workspace">
          {!connection ? (
            <div className="welcome">
              <div className="welcome-grid" />
              <span className="welcome-logo">
                <span className="brand-mark">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="eyebrow">
                {translate("UN SOLO SPAZIO. TUTTI I TUOI DATI.")}</span>
              <h1>
                {translate("Meno attrito.")}<br />
                <span>{translate("Più chiarezza.")}</span>
              </h1>
              <p>
                {translate("Esplora i database, scrivi query e chiedi ai dati.")}<br />
                {translate("Veloce, locale, sotto il tuo controllo.")}</p>
              <div>
                <button
                  className="primary"
                  onClick={loadDemo}
                  disabled={connecting}
                >
                  {connecting ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Play size={15} />
                  )}{" "}
                  {translate("Apri demo locale")}</button>
                <button
                  className="secondary"
                  onClick={() => {
                    setEditingConnection(undefined);
                    setModal("connection");
                  }}
                >
                  <Plus size={15} /> {translate("Nuova connessione")}</button>
              </div>
              <small>{translate("Un database reale. Nessun account necessario.")}</small>
              <div className="welcome-engines">
                {[
                  "postgres",
                  "mysql",
                  "databricks",
                  "sqlite",
                  "mongodb",
                  "redis",
                ].map((d) => (
                  <EngineMark key={d} driver={d} />
                ))}
              </div>
              {error && (
                <div className="form-error" role="alert">
                  {translate(error)}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="workspace-header">
                <div className="breadcrumb">
                  <Database size={15} />
                  <span>{connection.database || "demo"}</span>
                  <ChevronRight size={12} />
                  <strong>
                    {view === "sql" ? (tab.name === "Query" ? translate("Query") : tab.name) : table?.name || translate("Database")}
                  </strong>
                  {(connection.id === "demo" || connection.isDemo) && (
                    <span className="soft-badge">DEMO</span>
                  )}
                </div>
                <div>
                  <span
                    className={
                      "access-badge " + (!connection.readOnly ? "editable" : "")
                    }
                  >
                    <LockKeyhole size={11} />
                    {connection.readOnly
                      ? translate("Solo lettura")
                      : translate("Scritture con revisione")}
                  </span>
                  <button
                    className={
                      "assistant-toggle " + (assistant ? "active" : "")
                    }
                    onClick={() => setAssistant((a) => !a)}
                  >
                    <Sparkles size={14} /> {translate("Assistente")}</button>
                </div>
              </div>
              <div className="workspace-nav">
                <div className="view-tabs">
                  <button
                    className={view === "data" ? "active" : ""}
                    onClick={() => {
                      setView("data");
                      setSelected(null);
                    }}
                  >
                    <Table2 size={14} /> {translate("Dati")}</button>
                  <button
                    className={view === "structure" ? "active" : ""}
                    onClick={() => setView("structure")}
                  >
                    <Braces size={14} /> {translate("Struttura")}</button>
                  <button
                    className={view === "sql" ? "active" : ""}
                    onClick={() => {
                      setView("sql");
                      setSelected(null);
                    }}
                  >
                    <Code2 size={14} />{" "}
                    {["mongodb", "redis"].includes(connection.driver)
                      ? translate("Query")
                      : "SQL"}
                  </button>
                </div>
                <button className="text-button" onClick={() => openSQL()}>
                  <Plus size={14} />  {translate("Nuova query")} <kbd>⌘ T</kbd>
                </button>
              </div>
              {view === "sql" ? (
                <>
                  <div className="query-tabs">
                    {tabs.map((t, i) => (
                      <div
                        key={t.id}
                        className={t.id === tab.id ? "active" : ""}
                      >
                        <button
                          onClick={() => {
                            setActiveTab(t.id);
                            setSelected(null);
                          }}
                        >
                          <Code2 size={12} />
                          {t.name === "Query" ? translate("Query {count}", { count: formatNumber(i + 1) }) : t.name}
                          {t.busy && (
                            <LoaderCircle size={11} className="spin" />
                          )}
                        </button>
                        {tabs.length > 1 && (
                          <button
                            aria-label={translate("Chiudi query {count}", { count: formatNumber(i + 1) })}
                            className="close-query"
                            onClick={() => {
                              if (t.busy) return;
                              setTabs((ts) => ts.filter((x) => x.id !== t.id));
                              if (tab.id === t.id)
                                setActiveTab(
                                  tabs.find((x) => x.id !== t.id)!.id,
                                );
                            }}
                          >
                            <X size={11} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      className="icon-button"
                      aria-label={translate("Aggiungi query")}
                      onClick={() => openSQL()}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div
                    className="editor-region"
                    style={{ height: editorHeight }}
                  >
                    <Editor
                      sql={tab.sql}
                      onChange={(sql) => updateTab(tab.id, { sql })}
                      onRun={run}
                      busy={tab.busy}
                      tables={schema}
                    />
                    <div className="editor-toolbar">
                      <span>
                        {["mongodb", "redis"].includes(connection.driver)
                          ? "JSON"
                          : "SQL"}{" "}
                        · {connection.driver}{" "}
                        <span className="shortcut-hint">
                          {translate("Ctrl Space per completare")}</span>
                      </span>
                      <div>
                        <button
                          className="icon-button"
                          aria-label={translate("Salva query")}
                          onClick={() => {
                            setSaveName("");
                            setModal("save");
                          }}
                        >
                          <Bookmark size={14} />
                        </button>
                        {tab.busy && (
                          <button
                            className="text-button danger"
                            aria-label={translate("Interrompi query")}
                            onClick={cancelQuery}
                          >
                            <X size={12} /> {translate("Interrompi")}</button>
                        )}
                        <button
                          className="run-button"
                          onClick={() => run()}
                          disabled={tab.busy || !tab.sql.trim()}
                        >
                          {tab.busy ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <Play size={13} />
                          )}{" "}
                          {/^(UPDATE|INSERT|DELETE)/i.test(tab.sql.trim())
                            ? translate("Prepara modifica")
                            : translate("Esegui")}{" "}
                          <kbd>⌘ ↵</kbd>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div
                    className="resize-bar"
                    onPointerDown={(e) => {
                      const start = e.clientY,
                        initial = editorHeight;
                      const move = (e: PointerEvent) =>
                        setEditorHeight(
                          Math.max(
                            100,
                            Math.min(500, initial + e.clientY - start),
                          ),
                        );
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  >
                    <GripHorizontal size={12} />
                  </div>
                </>
              ) : view === "data" ? (
                <div className="table-toolbar">
                  <div className="filter-input">
                    <Search size={14} />
                    <input
                      aria-label={translate("Filtra righe")}
                      placeholder={translate("Filtra righe…")}
                      value={filter}
                      onChange={(e) => {
                        setFilter(e.target.value);
                        setOffset(0);
                        setCursors(["0"]);
                      }}
                    />
                    {filter && (
                      <button
                        className="icon-button"
                        aria-label={translate("Rimuovi filtro")}
                        onClick={() => setFilter("")}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div className="table-actions">
                    <button
                      className="icon-button"
                      aria-label={translate("Aggiorna dati")}
                      onClick={load}
                    >
                      <RefreshCw size={15} className={loading ? "spin" : ""} />
                    </button>
                    <div className="toolbar-divider" />
                    <button
                      className="text-button"
                      aria-label={translate("Esporta CSV")}
                      onClick={() => exportData("csv")}
                      disabled={!output?.rows.length}
                    >
                      <ArrowDownToLine size={14} /> CSV
                    </button>
                    <button
                      className="text-button"
                      aria-label={translate("Esporta JSON")}
                      onClick={() => exportData("json")}
                      disabled={!output?.rows.length}
                    >
                      JSON
                    </button>
                    <button
                      className={"icon-button " + (inspector ? "active" : "")}
                      aria-label={translate("Dettaglio riga")}
                      onClick={() => setInspector((a) => !a)}
                    >
                      <PanelRightClose size={15} />
                    </button>
                  </div>
                </div>
              ) : null}
              {(error || (view === "sql" && tab.error)) && (
                <div className="query-error" role="alert">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>{translate("Query non riuscita")}</strong>
                    <span>
                      {view === "sql" && tab.error ? tab.error : error}
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={translate("Chiudi errore")}
                    onClick={() => {
                      setError("");
                      updateTab(tab.id, { error: "" });
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {connecting ? (
                <div className="connecting">
                  <LoaderCircle className="spin" size={22} />
                  <span>{translate("Apro")} {connection.name}…</span>
                </div>
              ) : view === "structure" ? (
                <Structure table={table} />
              ) : (
                <div className="results-layout">
                  <DataGrid
                    result={output}
                    loading={view === "sql" ? tab.busy : loading}
                    sort={view === "data" ? sort : undefined}
                    onSort={
                      view === "data" && connection.driver !== "redis"
                        ? (column) => {
                            setSort((s) => ({
                              column,
                              direction:
                                s?.column === column && s.direction === "asc"
                                  ? "desc"
                                  : "asc",
                            }));
                            setOffset(0);
                          }
                        : undefined
                    }
                    selected={selected}
                    onSelect={(row, column, index) =>
                      setSelected({ row, column, index })
                    }
                    onEdit={view === "data" ? startEdit : undefined}
                  />
                  {inspector && selectedRow && (
                    <RowInspector
                      row={selectedRow}
                      columns={output?.columns || []}
                      onClose={() => setInspector(false)}
                      onEdit={(column) => startEdit(selectedRow, column)}
                    />
                  )}
                </div>
              )}
              {view !== "structure" && (
                <div className="results-footer">
                  <div>
                    <span className="success-dot" />
                    {output ? (
                      <>
                        <strong>{number(output.rowCount)}</strong>  {translate("righe", { count: output.rowCount })}{" "}
                        {view === "sql" && output.truncated && (
                          <span className="soft-badge">{translate("limite raggiunto")}</span>
                        )}
                        <span className="dot-separator">·</span>
                        <Clock3 size={12} />
                        {formatNumber(output.durationMs || 0, { maximumFractionDigits: 0 })} ms
                      </>
                    ) : (
                      <span>{translate("Pronto")}</span>
                    )}
                    {view === "sql" && output && (
                      <>
                        <span className="dot-separator">·</span>
                        <button
                          className="text-button"
                          aria-label={translate("Esporta CSV")}
                          onClick={() => exportData("csv")}
                        >
                          <ArrowDownToLine size={12} /> CSV
                        </button>
                        <button
                          className="text-button"
                          onClick={() => exportData("json")}
                        >
                          JSON
                        </button>
                      </>
                    )}
                  </div>
                  {view === "data" && (
                    <div className="pagination">
                      <select
                        aria-label={translate("Righe per pagina")}
                        value={limit}
                        onChange={(e) => {
                          setLimit(Number(e.target.value));
                          setOffset(0);
                          setCursors(["0"]);
                        }}
                      >
                        {[50, 100, 250, 500].map((n) => (
                          <option key={n} value={n}>
                            {formatNumber(n)} {translate("/ pagina")}</option>
                        ))}
                      </select>
                      <span>
                        {formatNumber(offset + ((output?.rows.length || 0) > 0 ? 1 : 0))}–
                        {formatNumber(offset + (output?.rows.length || 0))}
                        {total !== undefined && translate(" di {count}", { count: number(total) })}
                      </span>
                      <button
                        className="icon-button"
                        aria-label={translate("Pagina precedente")}
                        disabled={offset === 0 || loading}
                        onClick={() => setOffset((o) => Math.max(0, o - limit))}
                      >
                        <ArrowLeft size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={translate("Pagina successiva")}
                        disabled={
                          loading ||
                          (connection.driver === "redis"
                            ? !output?.cursor || output.cursor === "0"
                            : total !== undefined
                              ? offset + limit >= total
                              : (output?.rows.length || 0) < limit)
                        }
                        onClick={() => {
                          if (connection.driver === "redis" && output?.cursor)
                            setCursors((cs) => [
                              ...cs.slice(0, Math.floor(offset / limit) + 1),
                              String(output.cursor),
                            ]);
                          setOffset((o) => o + limit);
                        }}
                      >
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
        {assistant && connection && (
          <Assistant
            connection={connection}
            config={aiConfig}
            onSettings={() => setModal("providers")}
            onClose={() => setAssistant(false)}
            onResult={(r, sql) => {
              openSQL(sql || "", translate("Risultato AI"));
              setTabs((ts) =>
                ts.map((t, i) =>
                  i === ts.length - 1 ? { ...t, result: r } : t,
                ),
              );
              setView("sql");
            }}
            onProposal={(p) => {
              setProposal(p);
              setMutationError("");
            }}
            onSQL={(sql) => openSQL(sql, translate("Assistente"))}
          />
        )}
      </div>
      <footer className="statusbar">
        <div>
          <span
            className={connection && !error ? "success-dot" : "neutral-dot"}
          />
          {connection
            ? connection.driver === "sqlite"
              ? translate("SQLite · locale")
              : `${connection.driver} · ${connection.host || ""}`
            : translate("Nessuna connessione")}
          {connection && (
            <>
              <span className="statusbar-separator" /> {formatNumber(schema.length)} {translate("tabelle")}</>
          )}
        </div>
        <div>
          {connecting || loading
            ? translate("Caricamento…")
            : proposal
              ? translate("Modifica da approvare")
              : translate("Workspace locale")}
          <span className="statusbar-separator" />
          <span>⌘ K</span>
        </div>
      </footer>
      {notification && (
        <div className="toast" role="status">
          <Check size={16} />
          {translate(notification)}
        </div>
      )}
      {modal === "connection" && (
        <Connections
          catalog={catalog}
          existing={editingConnection}
          onClose={() => setModal(null)}
          onSaved={async (c) => {
            setConnections(await call("db.connections"));
            await open(c);
          }}
        />
      )}
      {modal === "providers" && (
        <Providers onClose={() => setModal(null)} onConfig={setAIConfig} />
      )}
      {modal === "palette" && (
        <div
          className="overlay palette-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section className="palette" role="dialog" aria-label={translate("Comandi")}>
            <div>
              <Search size={19} />
              <input
                autoFocus
                aria-label={translate("Cerca comando")}
                value={paletteSearch}
                onChange={(e) => setPaletteSearch(e.target.value)}
                placeholder={translate("Dove vuoi andare?")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && paletteActions[0]) {
                    setModal(null);
                    paletteActions[0].action();
                  }
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <nav>
              {paletteActions.map((a, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setModal(null);
                    a.action();
                  }}
                >
                  <Command size={14} />
                  <span>{a.label}</span>
                  <small>{a.hint}</small>
                </button>
              ))}
            </nav>
            <footer>
              {translate("Comandi, connessioni e tabelle. Tutto a portata di tastiera.")}</footer>
          </section>
        </div>
      )}
      {modal === "save" && (
        <Modal title={translate("Salva query")} onClose={() => setModal(null)}>
          <div className="form-grid">
            <label className="full">
              {translate("Nome")}<input
                aria-label={translate("Nome query")}
                autoFocus
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={translate("Ricavi mensili")}
              />
            </label>
          </div>
          <footer className="modal-footer">
            <span />
            <button
              className="primary"
              disabled={!saveName.trim()}
              onClick={() => {
                setSaved((s) => [
                  ...s,
                  { name: saveName.trim(), sql: tab.sql },
                ]);
                updateTab(tab.id, { name: saveName.trim() });
                setModal(null);
                notify(translate("Query salvata"));
              }}
            >
              {translate("Salva")}</button>
          </footer>
        </Modal>
      )}
      {modal === "edit" && edit && (
        <Modal
          title={translate("Modifica {name}", { name: edit.column })}
          subtitle={translate("La modifica viene applicata dopo la revisione SQL.")}
          onClose={() => setModal(null)}
        >
          <div className="edit-preview">
            <span>{translate("Valore attuale")}</span>
            <code>{labelValue(edit.row[edit.column])}</code>
          </div>
          <div className="form-grid">
            <label className="full">
              {translate("Nuovo valore")}<textarea
                aria-label={translate("Nuovo valore")}
                autoFocus
                disabled={edit.isNull}
                value={edit.value}
                onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              />
            </label>
            <label className="check-row full">
              <input
                type="checkbox"
                checked={edit.isNull}
                onChange={(e) => setEdit({ ...edit, isNull: e.target.checked })}
              />{" "}
              {translate("Imposta NULL")}</label>
          </div>
          {mutationError && (
            <div className="form-error" role="alert">
              {translate(mutationError)}
            </div>
          )}
          <footer className="modal-footer">
            <button className="secondary" onClick={() => setModal(null)}>
              {translate("Annulla")}</button>
            <button
              className="primary"
              onClick={prepareEdit}
              disabled={commitBusy}
            >
              {commitBusy && <LoaderCircle size={14} className="spin" />} {translate("Rivedi modifica")}</button>
          </footer>
        </Modal>
      )}
      {proposal && (
        <Modal
          title={translate("Rivedi la modifica")}
          subtitle={connection?.name}
          onClose={() => {
            if (!commitBusy) discardProposal();
          }}
          wide
        >
          <div className="proposal-summary">
            <span className="proposal-icon">
              <ShieldCheck size={21} />
            </span>
            <div>
              <strong>
                {proposal.affectedRows !== undefined
                  ? translate("{count} righe interessate", { count: number(proposal.affectedRows) })
                  : translate("Modifica preparata")}
              </strong>
              <p>{translate("Il database sarà aggiornato solo dopo la tua conferma.")}</p>
            </div>
          </div>
          <pre className="proposal-sql">{proposal.sql}</pre>
          {proposal.params && proposal.params.length > 0 && (
            <div className="proposal-params">
              <span>{translate("Parametri")}</span>
              {proposal.params.map((p, i) => (
                <code key={i}>
                  {i + 1}: {labelValue(p)}
                </code>
              ))}
            </div>
          )}
          {proposal.warning && (
            <div className="proposal-warning">
              <AlertTriangle size={15} />
              {translate(proposal.warning)}
            </div>
          )}
          {proposal.previewRows?.length ? (
            <div className="proposal-preview">
              <span className="section-label">{translate("ANTEPRIMA")}</span>
              <pre>
                {JSON.stringify(proposal.previewRows.slice(0, 3), null, 2)}
              </pre>
            </div>
          ) : null}
          {mutationError && (
            <div className="form-error" role="alert">
              {translate(mutationError)}
            </div>
          )}
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={commitBusy}
              onClick={() => discardProposal()}
            >
              {translate("Scarta")}</button>
            <button
              className="primary"
              disabled={commitBusy || proposal.affectedRows === 0}
              onClick={commit}
            >
              {commitBusy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}{" "}
              {translate("Conferma scrittura")}</button>
          </footer>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title={translate("Vai più veloce")}
          subtitle={translate("Uno spazio pensato per restare nel flusso.")}
          onClose={() => setModal(null)}
        >
          <div className="help-shortcuts">
            {[
              ["⌘ K", translate("Cerca comandi e tabelle")],
              ["⌘ T", translate("Apri una query")],
              ["⌘ Invio", translate("Esegui query o aggiorna dati")],
              ["Ctrl Space", translate("Completa SQL, tabelle e colonne")],
              ["⌘ S", translate("Salva la query")],
              ["⌘ I", translate("Apri o chiudi l’assistente")],
              [translate("Doppio clic"), translate("Modifica una cella con chiave primaria")],
              ["F2", translate("Modifica la cella selezionata")],
            ].map(([key, text]) => (
              <div key={key}>
                <span>{text}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <div className="help-note">
            {translate("Le query leggono i dati. Le scritture passano sempre dalla revisione. La demo usa un vero database SQLite locale.")}</div>
        </Modal>
      )}
    </div>
  );
}
