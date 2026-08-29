#!/usr/bin/env node
// Trawlia as an MCP server.
//
//   TRAWLIA_API_KEY=twl_... npx trawlia-mcp
//
// Two tools, matching the two endpoints. Deliberately a thin wrapper: the
// ranking and extraction all happen server-side, and
// anything this file did beyond shaping arguments and formatting a result would
// be logic that only MCP callers get.
//
// The interesting decisions here are about what a MODEL needs that an HTTP
// client does not.
//
//   - Tool descriptions carry the cost of calling them. A model choosing
//     between basic and advanced depth has no other way to know that one is
//     twice the price and ten times slower, and left to itself it will reach
//     for the most thorough option every time.
//
//   - Errors come back as readable text with the reason, not a status code. A
//     model handed `{"error":"credits_exhausted"}` will retry it; one told
//     "out of credits until the 1st, this call needed 2" will stop.
//
//   - A result whose page could not be read still comes back, marked with the
//     reason, because "the page says nothing" and "we could not read the page"
//     ask the model to do completely different things next.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = process.env.TRAWLIA_BASE_URL ?? "https://api.trawlia.co";
const KEY = process.env.TRAWLIA_API_KEY;

if (!KEY) {
  // stderr, not stdout: stdout is the JSON-RPC channel and writing prose to it
  // corrupts the transport. Exit non-zero so the host reports a failed server
  // rather than an idle one.
  process.stderr.write(
    "trawlia-mcp: TRAWLIA_API_KEY is not set.\n" +
      "Get a free key at https://trawlia.co/signup and set it in your MCP client config.\n",
  );
  process.exit(1);
}

const TOOLS = [
  {
    name: "trawlia_search",
    description:
      "Search the live web and get back ranked, deduplicated results. " +
      "Use search_depth 'basic' (1 credit, ~10x faster) for most questions: it returns titles, URLs and snippets, " +
      "which is enough to answer or to decide what to read. " +
      "Use 'advanced' (2 credits) only when you need the actual text of the pages, because it fetches and extracts every result. " +
      "Set topic 'news' for anything time-sensitive; it is tuned for recent events and returns publication dates.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question, in natural language rather than keywords.",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          default: "basic",
          description:
            "'basic' costs 1 credit and returns snippets. 'advanced' costs 2 and returns full page text. Prefer basic.",
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          default: "general",
          description: "'news' for recent events; it returns publication dates that 'general' usually lacks.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "Fewer is usually better; these results go into your context.",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to these hosts. Subdomains are included.",
        },
        exclude_domains: { type: "array", items: { type: "string" } },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description:
            "Window back from now. Drops results with no publication date, so it filters hard on topic 'general'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "trawlia_extract",
    description:
      "Fetch URLs you already have and return their readable content, with navigation, " +
      "cookie banners and newsletter modals removed. Costs 1 credit per 5 URLs, so pass the whole list at once " +
      "rather than calling this repeatedly. Use it when you already know which pages you want; use trawlia_search when you do not.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "Up to 20 http(s) URLs.",
        },
      },
      required: ["urls"],
    },
  },
];

/** One HTTP call, with errors turned into something a model can act on. */
async function call(path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Trawlia at ${API}: ${err.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Trawlia returned a non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }

  if (res.ok) return json;

  // Say what happened AND whether retrying is worth it, because those are
  // different instructions and a bare status code conveys neither.
  const id = json.request_id ? ` (request ${json.request_id})` : "";
  switch (json.error) {
    case "unsupported_parameters":
      throw new Error(
        `Trawlia does not support: ${(json.unsupported ?? []).join(", ")}. Remove them and try again${id}.`,
      );
    case "credits_exhausted":
      throw new Error(
        `Out of Trawlia credits: ${json.used}/${json.limit} used, this call needed ${json.cost}. ` +
          `The allowance resets on the 1st. Do not retry${id}.`,
      );
    case "rate_limited":
      throw new Error(`Rate limited by Trawlia. Retry in ${json.retry_after ?? 60}s${id}.`);
    case "search_paced":
      throw new Error(
        `Trawlia search is briefly pacing itself. Nothing is broken; retry in ${json.retry_after ?? 60}s${id}.`,
      );
    case "search_failed":
      throw new Error(`Trawlia could not run this search, so this is not an empty result${id}. Retry later.`);
    case "answer_unavailable":
      throw new Error(`Answer synthesis is not enabled on this deployment${id}.`);
    default:
      throw new Error(`Trawlia error ${res.status}: ${json.message ?? json.error ?? text.slice(0, 200)}${id}`);
  }
}

/**
 * Format results for a model rather than for a parser.
 *
 * This used to append a coverage line built from `body.providers`, reporting
 * how many indexes answered. That field was removed from the API, and the `??
 * []` guarding it turned its disappearance into silence rather than an error -
 * the line simply stopped appearing and nothing said so.
 *
 * It is not coming back. What a model needs is carried by the status codes and
 * by `fetch_error` on the individual result: a search that could not run raises,
 * pacing raises, and reaching here with an empty list means the search found
 * nothing. How the answer was assembled is not the caller's business.
 */
function renderSearch(body) {
  const lines = [];

  if (body.answer) {
    lines.push(`**Answer.** ${body.answer}`);
    if (body.answer_citations?.length) {
      lines.push(`Sources: ${body.answer_citations.join(", ")}`);
    }
    lines.push("");
  }

  if (!body.results?.length) {
    lines.push("No results. The search ran and found nothing for this query.");
  }

  for (const [i, r] of (body.results ?? []).entries()) {
    lines.push(`## ${i + 1}. ${r.title}`);
    lines.push(r.url);
    if (r.published_date) lines.push(`Published: ${r.published_date}`);
    if (r.fetched === false && r.fetch_error) {
      // Said plainly, because the difference between "the page says nothing"
      // and "we could not read the page" changes what the model should do next.
      lines.push(`_Page text unavailable: ${r.fetch_error}. The snippet below is all there is._`);
    }
    lines.push("");
    lines.push(r.content ?? "");
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderExtract(body) {
  const lines = [];
  for (const r of body.results ?? []) {
    lines.push(`## ${r.title ?? r.url}`);
    lines.push(r.url);
    lines.push("");
    lines.push(r.content);
    lines.push("");
  }
  for (const f of body.failed ?? []) {
    lines.push(`_Could not extract ${f.url}: ${f.error}_`);
  }
  return lines.join("\n").trim();
}

const server = new Server(
  { name: "trawlia", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === "trawlia_search") {
      const body = await call("/v1/search", args);
      return { content: [{ type: "text", text: renderSearch(body) }] };
    }
    if (name === "trawlia_extract") {
      const body = await call("/v1/extract", args);
      return { content: [{ type: "text", text: renderExtract(body) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    // isError so the host marks the call failed, with the reason as text so the
    // model can decide whether to change the request, wait, or give up.
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
