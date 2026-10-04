// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import { translate, formatNumber, formatDate, getLanguage, languageNames, supportedLanguages } from "./i18n";
import { useI18n } from "./LocaleProvider";
import { useEffect, useState, useRef } from "react";
import {
  X,
  ArrowLeft,
  Database,
  Check,
  LoaderCircle,
  FolderOpen,
  FlaskConical,
  Plus,
  Trash2,
  RefreshCw,
  KeyRound,
  ShieldCheck,
  ArrowUpRight,
} from "lucide-react";
import { call } from "./api";
import type { Connection, Driver, AIProfile, AIConfig } from "./types";
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useI18n();

  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>(
      "input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])",
    );
    first?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            const list = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
              ) || [],
            ).filter((el) => el.offsetParent !== null);
            const first = list[0],
              last = list.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label={translate("Chiudi")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
const driverMarks: Record<string, string> = {
  sqlite: "Sq",
  postgres: "Pg",
  mysql: "My",
  mariadb: "Ma",
  databricks: "Db",
  "aurora-postgresql": "Au",
  "aurora-mysql": "Au",
  redshift: "Rs",
  cockroachdb: "Cr",
  sqlserver: "Ms",
  clickhouse: "Ch",
  mongodb: "Mo",
  redis: "Re",
};
export function EngineMark({
  driver,
  small = false,
}: {
  driver: string;
  small?: boolean;
}) {
  return (
    <span className={"engine-mark " + driver + " " + (small ? "small" : "")}>
      {driverMarks[driver] || driver.slice(0, 2)}
    </span>
  );
}
export function Connections({
  catalog,
  onClose,
  onSaved,
  existing,
}: {
  catalog: Driver[];
  onClose: () => void;
  onSaved: (c: Connection) => void;
  existing?: Connection;
}) {
  useI18n();

  const [engine, setEngine] = useState(existing?.driver || "");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Record<string, any>>(
    existing
      ? { ...existing }
      : {
          name: "",
          host: "localhost",
          database: "",
          username: "",
          readOnly: true,
          tls: true,
        },
  );
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tested, setTested] = useState("");
  const selected = catalog.find((d) => d.id === engine);
  const local = engine === "sqlite";
  const dbx = engine === "databricks";
  const mongo = engine === "mongodb";
  function set(k: string, v: any) {
    setForm((f) => ({ ...f, [k]: v }));
    setTested("");
    setError("");
  }
  async function save(test = false) {
    setBusy(test ? "test" : "save");
    setError("");
    try {
      const profile: Record<string, any> = {
        ...form,
        driver: engine,
        name: form.name.trim() || selected?.name || engine,
        port: form.port ? Number(form.port) : undefined,
        readOnly:
          selected?.capabilities?.write === false ? true : form.readOnly,
      };
      const credentials = password
        ? {
            [dbx ? "token" : mongo ? "connectionString" : "password"]: password,
          }
        : {};
      if (test) {
        const r = await call("db.testConnection", profile, credentials);
        setTested(r.version || translate("Connessione riuscita"));
        return;
      }
      const response = await call("db.saveConnection", profile, credentials);
      const list = Array.isArray(response)
        ? response
        : await call<Connection[]>("db.connections");
      const c =
        list.find((item: Connection) => item.id === profile.id) ||
        list.find(
          (item: Connection) =>
            item.name === profile.name && item.driver === engine,
        );
      if (!c) throw Error(translate("Connessione non salvata."));
      if (test) {
        const r = await call("db.connect", c.id);
        setForm((f) => ({ ...f, id: c.id }));
        setTested(r.version || translate("Connessione riuscita"));
      } else {
        onSaved(c);
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal
      title={
        engine
          ? existing
            ? translate("Modifica connessione")
            : translate("Nuova connessione")
          : translate("Scegli il database")
      }
      subtitle={
        engine
          ? translate("Tutto resta sul tuo computer.")
          : translate("Un unico spazio, per tutti i tuoi dati.")
      }
      onClose={onClose}
      wide
    >
      {!engine ? (
        <>
          <div className="modal-search">
            <input
              aria-label={translate("Cerca database")}
              placeholder={translate("Cerca database…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="engine-grid">
            {catalog
              .filter((d) =>
                d.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setEngine(d.id);
                    setForm((f) => ({
                      ...f,
                      port: d.defaultPort,
                      name: d.name,
                    }));
                  }}
                >
                  <EngineMark driver={d.id} />
                  <span>
                    {d.name}
                    <small>{d.family}</small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
          </div>
          <footer className="modal-footer">
            <span>
              {formatNumber(catalog.length)} {translate("connettori · SQL, documenti e key-value")}</span>
          </footer>
        </>
      ) : (
        <>
          <div className="connection-head">
            <button className="text-button" onClick={() => setEngine("")}>
              <ArrowLeft size={14} /> {translate("Database")}</button>
            <EngineMark driver={engine} />
            <strong>{selected?.name}</strong>
          </div>
          <div className="form-grid">
            <label className="full">
              {translate("Nome")}<input
                aria-label={translate("Nome connessione")}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={translate("Analytics · produzione")}
              />
            </label>
            {local ? (
              <label className="full">
                {translate("File SQLite")}<div className="input-action">
                  <input
                    aria-label={translate("File SQLite")}
                    value={form.filePath || ""}
                    placeholder={translate("/percorso/database.sqlite")}
                    onChange={(e) => set("filePath", e.target.value)}
                  />
                  <button
                    aria-label={translate("Scegli file")}
                    onClick={async () => {
                      const file = await call("native.pickFile", {
                        kind: "database",
                      });
                      if (file) set("filePath", file);
                    }}
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </label>
            ) : (
              <>
                <label className={dbx ? "full" : ""}>
                  {translate("Host")}<input
                    aria-label={translate("Host")}
                    value={form.host || ""}
                    placeholder={
                      dbx ? "workspace.cloud.databricks.com" : "localhost"
                    }
                    onChange={(e) => set("host", e.target.value)}
                  />
                </label>
                {!dbx && (
                  <label>
                    {translate("Porta")}<input
                      aria-label={translate("Porta")}
                      type="number"
                      value={form.port || ""}
                      onChange={(e) => set("port", e.target.value)}
                    />
                  </label>
                )}
                {dbx ? (
                  <>
                    <label className="full">
                      {translate("HTTP path")}<input
                        value={form.httpPath || ""}
                        placeholder="/sql/1.0/warehouses/…"
                        onChange={(e) => set("httpPath", e.target.value)}
                      />
                    </label>
                    <label>
                      {translate("Catalogo")}<input
                        value={form.catalog || ""}
                        placeholder="main"
                        onChange={(e) => set("catalog", e.target.value)}
                      />
                    </label>
                    <label>
                      {translate("Schema")}<input
                        value={form.schema || ""}
                        placeholder="default"
                        onChange={(e) => set("schema", e.target.value)}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      {translate("Database")}<input
                        aria-label={translate("Database")}
                        value={form.database || ""}
                        onChange={(e) => set("database", e.target.value)}
                      />
                    </label>
                    <label>
                      {translate("Utente")}<input
                        aria-label={translate("Utente")}
                        value={form.username || ""}
                        onChange={(e) => set("username", e.target.value)}
                      />
                    </label>
                  </>
                )}
                <label className="full">
                  {dbx
                    ? translate("Access token")
                    : mongo
                      ? translate("Connection string (opzionale)")
                      : translate("Password")}
                  <input
                    type="password"
                    aria-label={translate("Password")}
                    value={password}
                    autoComplete="off"
                    placeholder={
                      existing?.hasCredential
                        ? translate("Credenziale salvata · lascia vuoto per mantenerla")
                        : translate("Salvata nel portachiavi del sistema")
                    }
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="check-row full">
                  <input
                    type="checkbox"
                    checked={!!form.tls}
                    onChange={(e) => set("tls", e.target.checked)}
                  />
                  <ShieldCheck size={16} /> {translate("Connessione TLS")}</label>
                {form.tls &&
                  ["postgres", "mysql"].includes(selected?.family || "") && (
                    <label className="full ca-field">
                      <details>
                        <summary>{translate("Certificato CA opzionale")}</summary>
                        <textarea
                          aria-label={translate("Certificato CA PEM")}
                          value={form.sslCA || ""}
                          placeholder="-----BEGIN CERTIFICATE-----"
                          onChange={(e) => set("sslCA", e.target.value)}
                        />
                      </details>
                    </label>
                  )}
              </>
            )}
            {selected?.capabilities?.write === false && (
              <div className="connection-capability full">
                {translate("Questo connettore supporta la lettura. Le scritture non sono disponibili.")}</div>
            )}
            <label className="check-row full protection">
              <input
                type="checkbox"
                checked={
                  selected?.capabilities?.write === false || !!form.readOnly
                }
                disabled={selected?.capabilities?.write === false}
                onChange={(e) => set("readOnly", e.target.checked)}
              />
              <span>
                <strong>{translate("Solo lettura")}</strong>
                <small>{translate("Disattiva per preparare e approvare modifiche.")}</small>
              </span>
            </label>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {translate(error)}
            </div>
          )}
          {tested && (
            <div className="form-success">
              <Check size={15} />
              {translate(tested)}
            </div>
          )}
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => save(true)}
            >
              {busy === "test" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <FlaskConical size={14} />
              )}{" "}
              {translate("Test connessione")}</button>
            <button
              className="primary"
              disabled={!!busy || (local && !form.filePath)}
              onClick={() => save()}
            >
              {busy === "save" && <LoaderCircle size={14} className="spin" />}{" "}
              {translate("Salva e apri")}</button>
          </footer>
        </>
      )}
    </Modal>
  );
}
const providers = [
  ["ollama", "Ollama", "http://127.0.0.1:11434"],
  ["openai", "OpenAI", "https://api.openai.com/v1"],
  ["anthropic", "Anthropic", "https://api.anthropic.com"],
  ["azure", "Azure OpenAI", ""],
  ["google", "Google AI Studio", "https://generativelanguage.googleapis.com"],
  ["vertex", "Vertex AI", ""],
  ["bedrock", "Amazon Bedrock", ""],
  ["litellm", "LiteLLM", "http://127.0.0.1:4000/v1"],
  ["compatible", "OpenAI compatible", "http://127.0.0.1:1234/v1"],
];
export function Providers({
  onClose,
  onConfig,
}: {
  onClose: () => void;
  onConfig: (c: AIConfig) => void;
}) {
  useI18n();

  const [config, setConfig] = useState<AIConfig>({
    profiles: [],
    activeProfileId: null,
  });
  const [form, setForm] = useState<Partial<AIProfile>>({
    provider: "ollama",
    name: translate("Ollama locale"),
    baseUrl: "http://127.0.0.1:11434",
    model: "",
  });
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    call<AIConfig>("ai.getConfig")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  function update(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setMessage("");
    setError("");
  }
  async function save() {
    const c = await call<AIConfig>(
      "ai.saveProfile",
      form,
      ...(Object.keys(creds).some((k) => creds[k]) ? [creds] : []),
    );
    setConfig(c);
    onConfig(c);
    const saved =
      c.profiles.find((p) => p.id === form.id) ||
      c.profiles.find(
        (p) => p.name === form.name && p.provider === form.provider,
      );
    if (saved) setForm(saved);
    setCreds({});
    return saved;
  }
  async function action(kind: string) {
    setBusy(kind);
    setMessage("");
    setError("");
    try {
      const p = await save();
      if (!p) throw Error(translate("Profilo non salvato."));
      if (kind === "models") {
        const r = await call("ai.discoverModels", p.id);
        setModels(r.models || []);
        setMessage(r.note || translate("{count} modelli disponibili", { count: formatNumber(r.models.length) }));
      } else if (kind === "test") {
        const r = await call("ai.test", p.id);
        setMessage(translate("Connesso · {latency} ms · {model}", { latency: formatNumber(r.latencyMs), model: r.model }));
      } else {
        const c = await call<AIConfig>("ai.selectProfile", p.id);
        setConfig(c);
        onConfig(c);
        setMessage(translate("Profilo attivo"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal
      title={translate("Provider AI")}
      subtitle={translate("Scegli dove inviare le domande e i dati richiesti.")}
      onClose={onClose}
      wide
    >
      <div className="provider-layout">
        <aside>
          <button
            className="profile-row"
            onClick={() => {
              setForm({
                provider: "ollama",
                name: translate("Nuovo profilo"),
                baseUrl: providers[0][2],
                model: "",
              });
              setCreds({});
              setMessage("");
              setError("");
            }}
          >
            <Plus size={15} /> {translate("Nuovo profilo")}</button>
          <div className="divider" />
          {config.profiles.map((p) => (
            <button
              key={p.id}
              className={"profile-row " + (p.id === form.id ? "active" : "")}
              onClick={() => {
                setForm(p);
                setCreds({});
                setModels([]);
                setMessage("");
                setError("");
              }}
            >
              <span className="provider-dot" />
              <span>
                {p.name}
                <small>{p.model || translate("Scegli modello")}</small>
              </span>
              {p.id === config.activeProfileId && <Check size={14} />}
            </button>
          ))}
          <div className="local-note">
            <ShieldCheck size={16} />
            <p>
              {translate("Le chiavi restano cifrate nel portachiavi. I dati vengono inviati solo quando fai una domanda.")}</p>
          </div>
        </aside>
        <div className="provider-form">
          <div className="form-grid">
            <label>
              {translate("Nome")}<input
                aria-label={translate("Nome profilo AI")}
                value={form.name || ""}
                onChange={(e) => update("name", e.target.value)}
              />
            </label>
            <label>
              {translate("Provider")}<select
                aria-label={translate("Provider AI")}
                value={form.provider}
                onChange={(e) => {
                  const d = providers.find((p) => p[0] === e.target.value)!;
                  setForm({
                    name: d[1],
                    provider: d[0],
                    baseUrl: d[2],
                    model: "",
                    authMode:
                      d[0] === "bedrock"
                        ? "awsProfile"
                        : d[0] === "vertex"
                          ? "adc"
                          : "apiKey",
                  });
                  setModels([]);
                  setCreds({});
                }}
              >
                {providers.map((p) => (
                  <option key={p[0]} value={p[0]}>
                    {p[1]}
                  </option>
                ))}
              </select>
            </label>
            {!["bedrock", "vertex"].includes(form.provider || "") && (
              <label className="full">
                {translate("Endpoint")}<input
                  aria-label={translate("Endpoint AI")}
                  value={form.baseUrl || ""}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://…"
                />
              </label>
            )}
            {form.provider === "azure" && (
              <label className="full">
                {translate("API version")}<input
                  value={form.apiVersion || ""}
                  placeholder="2024-10-21"
                  onChange={(e) => update("apiVersion", e.target.value)}
                />
              </label>
            )}
            {form.provider === "vertex" && (
              <>
                <label>
                  {translate("Progetto")}<input
                    value={form.project || ""}
                    onChange={(e) => update("project", e.target.value)}
                  />
                </label>
                <label>
                  {translate("Location")}<input
                    value={form.location || ""}
                    placeholder="global"
                    onChange={(e) => update("location", e.target.value)}
                  />
                </label>
                <label className="full">
                  {translate("Autenticazione")}<select
                    value={form.authMode || "adc"}
                    onChange={(e) => update("authMode", e.target.value)}
                  >
                    <option value="adc">{translate("Application Default Credentials")}</option>
                    <option value="serviceAccount">{translate("Service account JSON")}</option>
                    <option value="bearer">{translate("Access token")}</option>
                  </select>
                </label>
                {form.authMode === "serviceAccount" && (
                  <label className="full">
                    {translate("Service account JSON")}<textarea
                      value={creds.serviceAccount || ""}
                      onChange={(e) =>
                        setCreds({ serviceAccount: e.target.value })
                      }
                    />
                  </label>
                )}
              </>
            )}
            {form.provider === "bedrock" && (
              <>
                <label>
                  {translate("Regione")}<input
                    value={form.region || ""}
                    placeholder="eu-west-1"
                    onChange={(e) => update("region", e.target.value)}
                  />
                </label>
                <label>
                  {translate("Profilo AWS")}<input
                    value={form.awsProfile || ""}
                    placeholder="default"
                    onChange={(e) => update("awsProfile", e.target.value)}
                  />
                </label>
                <label className="full">
                  {translate("Autenticazione")}<select
                    value={form.authMode || "awsProfile"}
                    onChange={(e) => update("authMode", e.target.value)}
                  >
                    <option value="awsProfile">{translate("Profilo AWS")}</option>
                    <option value="aws">{translate("Catena AWS / access key")}</option>
                    <option value="apiKey">{translate("Bedrock API key")}</option>
                  </select>
                </label>
                {form.authMode === "aws" && (
                  <>
                    <label>
                      {translate("Access key ID")}<input
                        autoComplete="off"
                        value={creds.accessKeyId || ""}
                        onChange={(e) =>
                          setCreds((c) => ({
                            ...c,
                            accessKeyId: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      {translate("Secret access key")}<input
                        type="password"
                        value={creds.secretAccessKey || ""}
                        onChange={(e) =>
                          setCreds((c) => ({
                            ...c,
                            secretAccessKey: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="full">
                      {translate("Session token")}<input
                        type="password"
                        value={creds.sessionToken || ""}
                        onChange={(e) =>
                          setCreds((c) => ({
                            ...c,
                            sessionToken: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
              </>
            )}
            {(!["ollama", "vertex", "bedrock"].includes(form.provider || "") ||
              (form.provider === "bedrock" && form.authMode === "apiKey") ||
              (form.provider === "vertex" && form.authMode === "bearer")) && (
              <label className="full">
                <span>
                  <KeyRound size={12} />{" "}
                  {form.authMode === "bearer" ? translate("Access token") : translate("API key")}
                </span>
                <input
                  type="password"
                  aria-label={translate("API key")}
                  autoComplete="off"
                  value={creds.apiKey || creds.bearerToken || ""}
                  placeholder={
                    form.hasCredential
                      ? translate("Salvata · lascia vuoto per mantenerla")
                      : translate("La tua chiave")
                  }
                  onChange={(e) =>
                    setCreds({
                      [form.authMode === "bearer" ? "bearerToken" : "apiKey"]:
                        e.target.value,
                    })
                  }
                />
              </label>
            )}
            <label className="full">
              {translate("Modello")}<div className="input-action">
                <input
                  aria-label={translate("Modello AI")}
                  list="model-list"
                  value={form.model || ""}
                  onChange={(e) => update("model", e.target.value)}
                  placeholder={translate("ID modello o deployment esatto")}
                />
                <button
                  aria-label={translate("Scopri modelli")}
                  disabled={!!busy}
                  onClick={() => action("models")}
                >
                  <RefreshCw
                    size={15}
                    className={busy === "models" ? "spin" : ""}
                  />
                </button>
              </div>
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {translate(error)}
            </div>
          )}
          {message && (
            <div className="form-success">
              <Check size={14} />
              {translate(message)}
            </div>
          )}
          <div className="provider-actions">
            {form.id && (
              <button
                className="text-button danger"
                aria-label={translate("Elimina profilo AI")}
                onClick={async () => {
                  const c = await call<AIConfig>("ai.removeProfile", form.id);
                  setConfig(c);
                  onConfig(c);
                  setForm({
                    provider: "ollama",
                    name: translate("Nuovo profilo"),
                    baseUrl: providers[0][2],
                    model: "",
                  });
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              className="secondary"
              disabled={!!busy || !form.model}
              onClick={() => action("test")}
            >
              <FlaskConical size={14} /> {translate("Test")}</button>
            <button
              className="primary"
              disabled={!!busy || !form.model}
              onClick={() => action("save")}
            >
              {busy && <LoaderCircle size={14} className="spin" />} {translate("Salva e attiva")}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
