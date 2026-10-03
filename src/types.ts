export interface Connection {
  id: string;
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  filePath?: string;
  schema?: string;
  catalog?: string;
  httpPath?: string;
  tls?: boolean;
  readOnly: boolean;
  color?: string;
  hasCredential?: boolean;
  isDemo?: boolean;
  [key: string]: unknown;
}
export interface Driver {
  id: string;
  name: string;
  family: string;
  defaultPort?: number;
  fields?: unknown;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Column {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}
export interface Table {
  name: string;
  schema?: string;
  kind?: string;
  columns: Column[];
  rowCount?: number;
}
export interface Result {
  columns: Column[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated?: boolean;
  total?: number;
  requestId?: string;
  cursor?: string;
}
export interface Proposal {
  id: string;
  sql: string;
  params?: unknown[];
  affectedRows?: number;
  previewRows?: Record<string, unknown>[];
  expiresAt?: number | string;
  warning?: string;
}
export interface AIProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  region?: string;
  project?: string;
  location?: string;
  awsProfile?: string;
  authMode?: string;
  apiVersion?: string;
  hasCredential?: boolean;
}
export interface AIConfig {
  profiles: AIProfile[];
  activeProfileId: string | null;
}
export interface Answer {
  answer: string;
  sql?: string;
  result?: Result;
  proposal?: Proposal;
  steps?: unknown[];
  provider?: unknown;
  isMock?: boolean;
}
declare global {
  interface Window {
    tableline?: { call: (method: string, ...args: unknown[]) => Promise<any> };
  }
}
