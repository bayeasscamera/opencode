export * as McpStoreCatalog from "./catalog"

/** A curated entry in the MCP store. */
export interface McpStoreEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly package: string
  readonly command: string
  readonly env?: Record<string, string>
  readonly category: "search" | "database" | "devtools" | "browser" | "filesystem" | "productivity"
}

export const CATALOG: McpStoreEntry[] = [
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Search the web using Brave Search API. Requires a free Brave API key.",
    package: "@modelcontextprotocol/server-brave-search",
    command: "npx -y @modelcontextprotocol/server-brave-search",
    env: { BRAVE_API_KEY: "your-brave-api-key" },
    category: "search",
  },
  {
    id: "postgres",
    name: "PostgreSQL Explorer",
    description: "Inspect PostgreSQL schemas and run read-only queries.",
    package: "@modelcontextprotocol/server-postgres",
    command: "npx -y @modelcontextprotocol/server-postgres",
    env: { POSTGRES_CONNECTION_STRING: "postgresql://user:pass@localhost:5432/db" },
    category: "database",
  },
  {
    id: "github",
    name: "GitHub Automator",
    description: "Manage GitHub issues, PRs, and commits.",
    package: "@modelcontextprotocol/server-github",
    command: "npx -y @modelcontextprotocol/server-github",
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "your-github-pat" },
    category: "devtools",
  },
  {
    id: "puppeteer",
    name: "Puppeteer Browser Control",
    description: "Automate browser interactions for testing and scraping.",
    package: "@modelcontextprotocol/server-puppeteer",
    command: "npx -y @modelcontextprotocol/server-puppeteer",
    category: "browser",
  },
  {
    id: "filesystem",
    name: "Extended Filesystem Sandbox",
    description: "Secure access to designated directories outside the workspace.",
    package: "@modelcontextprotocol/server-filesystem",
    command: "npx -y @modelcontextprotocol/server-filesystem /allowed/path",
    category: "filesystem",
  },
  {
    id: "sqlite",
    name: "SQLite Explorer",
    description: "Query and inspect SQLite databases.",
    package: "@modelcontextprotocol/server-sqlite",
    command: "npx -y @modelcontextprotocol/server-sqlite",
    env: { SQLITE_DB_PATH: "/path/to/database.db" },
    category: "database",
  },
  {
    id: "sentry",
    name: "Sentry Error Tracker",
    description: "Query Sentry for errors, issues, and performance data.",
    package: "@modelcontextprotocol/server-sentry",
    command: "npx -y @modelcontextprotocol/server-sentry",
    env: { SENTRY_AUTH_TOKEN: "your-sentry-token", SENTRY_ORG: "your-org" },
    category: "devtools",
  },
  {
    id: "slack",
    name: "Slack Integration",
    description: "Read channels, post messages, and search Slack workspace.",
    package: "@modelcontextprotocol/server-slack",
    command: "npx -y @modelcontextprotocol/server-slack",
    env: { SLACK_BOT_TOKEN: "xoxb-your-token", SLACK_TEAM_ID: "your-team-id" },
    category: "productivity",
  },
]

export function listByCategory(category?: McpStoreEntry["category"]): McpStoreEntry[] {
  return category ? CATALOG.filter((e) => e.category === category) : CATALOG
}

export function findById(id: string): McpStoreEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}
