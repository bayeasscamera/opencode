import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpBody } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["brave", "tavily", "exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(
  sessionID: string,
  flags: { brave?: boolean; tavily?: boolean; exa?: boolean; parallel?: boolean } = {},
): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "brave" || override === "tavily" || override === "exa" || override === "parallel") return override
  if (flags.brave) return "brave"
  if (flags.tavily) return "tavily"
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "brave") return "Brave Web Search"
  if (provider === "tavily") return "Tavily Web Search"
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
const TAVILY_URL = "https://api.tavily.com/search"

type SearchHit = {
  readonly title?: string
  readonly url?: string
  readonly description?: string
  readonly content?: string
}

function callBrave(
  http: HttpClient.HttpClient,
  query: string,
  numResults: number,
): Effect.Effect<string | undefined, Error> {
  const url = new URL(BRAVE_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("count", String(numResults))
  url.searchParams.set("safesearch", "moderate")

  const headers: Record<string, string> = {}
  if (process.env.BRAVE_API_KEY) headers["X-Subscription-Token"] = process.env.BRAVE_API_KEY

  const request = HttpClientRequest.get(url.toString()).pipe(
    HttpClientRequest.accept("application/json"),
    HttpClientRequest.setHeaders(headers),
  )

  return Effect.gen(function* () {
    const response = yield* HttpClient.filterStatusOk(http).execute(request)
    const body = yield* response.text
    const json: { web?: { results?: SearchHit[] } } = JSON.parse(body)
    const results = json.web?.results
    if (!Array.isArray(results) || results.length === 0) return undefined
    return results
      .slice(0, numResults)
      .map((r) => `## ${r.title ?? "Sans titre"}\n${(r.description ?? "").replace(/<[^>]+>/g, "")}\n${r.url ?? ""}`)
      .join("\n\n")
  }).pipe(
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.die(new Error("Brave request timed out")) }),
  )
}

function callTavily(
  http: HttpClient.HttpClient,
  query: string,
  numResults: number,
): Effect.Effect<string | undefined, Error> {
  const requestBody = JSON.stringify({
    api_key: process.env.TAVILY_API_KEY,
    query,
    max_results: numResults,
    search_depth: "basic",
  })

  const request = HttpClientRequest.post(TAVILY_URL).pipe(
    HttpClientRequest.accept("application/json"),
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.setBody(HttpBody.text(requestBody, "application/json")),
  )

  return Effect.gen(function* () {
    const response = yield* HttpClient.filterStatusOk(http).execute(request)
    const body = yield* response.text
    const json: { results?: SearchHit[] } = JSON.parse(body)
    const results = json.results
    if (!Array.isArray(results) || results.length === 0) return undefined
    return results
      .slice(0, numResults)
      .map((r) => `## ${r.title ?? "Sans titre"}\n${r.content ?? ""}\n${r.url ?? ""}`)
      .join("\n\n")
  }).pipe(
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.die(new Error("Tavily request timed out")) }),
  )
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "brave") {
    return callBrave(http, params.query, params.numResults || 8)
  }
  if (provider === "tavily") {
    return callTavily(http, params.query, params.numResults || 8)
  }
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
            brave: Boolean(process.env.BRAVE_API_KEY),
            tavily: Boolean(process.env.TAVILY_API_KEY),
          })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const result = yield* callProvider(http, provider, params, ctx)

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
