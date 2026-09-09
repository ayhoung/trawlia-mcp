# trawlia-mcp

Trawlia as an MCP server: web search and page extraction, as two tools any MCP client can call.

Get a free key at [trawlia.co/signup](https://trawlia.co/signup) - 100 credits a month, no card.

## Claude Code

```bash
claude mcp add trawlia --env TRAWLIA_API_KEY=twl_... -- npx -y trawlia-mcp
```

## Claude Desktop, Cursor, and anything else reading a JSON config

```json
{
  "mcpServers": {
    "trawlia": {
      "command": "npx",
      "args": ["-y", "trawlia-mcp"],
      "env": { "TRAWLIA_API_KEY": "twl_..." }
    }
  }
}
```

## The tools

### `trawlia_search`

Ranked, deduplicated results from the live web.

| Argument | Default | Notes |
|---|---|---|
| `query` | required | Natural language, not keywords. |
| `search_depth` | `basic` | `basic` is 1 credit and returns snippets. `advanced` is 2 and returns full page text. |
| `topic` | `general` | `news` reaches news indexes and returns publication dates. |
| `max_results` | 20 | Up to 20. These go into your context, so ask for fewer when the task is narrow. |
| `include_domains` / `exclude_domains` | - | Host filters. Subdomains are included. |
| `time_range` | - | `day`, `week`, `month`, `year`. |

### `trawlia_extract`

Fetches URLs you already have and returns their readable content, with navigation, cookie banners and newsletter modals removed.
1 credit per 5 URLs, so pass the whole list at once.

## What the model sees

Results come back as readable text rather than raw JSON, and carry two things a
plain response would lose:

- **When a page could not be read**, the result says so and why, instead of
  presenting a snippet as though it were the article.
- **A coverage line** when a source was unavailable, so the model can weigh a
  thin result set properly rather than reporting it as a confident nothing.

Errors are readable sentences that say whether retrying is worth it. Running out
of credits says so and says not to retry; a rate limit says how long to wait.

## Costs

| Operation | Credits |
|---|---|
| Basic search | 1 |
| Advanced search | 2 |
| Extraction | 1 per 5 URLs |

Charged before the work and refunded on hard failure.
Full price list at [trawlia.co/pricing](https://trawlia.co/pricing).

## Not available

Search and extraction, and nothing else. There is no crawler and no long-running
job to poll. If your agent needs to walk a whole site, this is the wrong server
for it.

## Checking it works

```bash
TRAWLIA_API_KEY=twl_... node smoke.mjs
```

Spends a few credits against the real API and prints what a client sees: the
tool list, a rendered search, a rejected parameter, and an extraction.
Not in CI, because it costs money and depends on the live web.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `TRAWLIA_API_KEY` | yes | A `search`-scoped key is enough and is what you should deploy. |
| `TRAWLIA_BASE_URL` | no | Defaults to `https://api.trawlia.co`. For pointing at a local server. |
