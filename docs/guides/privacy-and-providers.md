# Privacy and search providers

NoConBrain keeps what you save and what you search on your own machine. Nothing is sent anywhere unless you turn something on. This page lists what can leave the machine, what is stored, and how to set up search providers.

## What leaves the machine

| Action | What is sent, and to whom | When |
|---|---|---|
| Saving or crawling a page | A normal web request to the site, with a `User-Agent` that names NoConBrain, its version, the project's address and, if you set it, `NCB_CONTACT` | Only for pages you save or sources you run |
| Online search | The words you typed, and your server's IP address, to each provider you enabled | Only when online search is on, at least one provider is enabled, and the server is online |
| Wikipedia features | Requests to Wikipedia, one at a time, with `NCB_CONTACT` in the `User-Agent` | Only when `NCB_CONTACT` is set and you save or crawl Wikipedia |
| Connectivity probe | A request to the address in `NCB_CONNECTIVITY_PROBE_URL` | Only if you set it. Empty by default |
| Software update checks, analytics, crash reports | Nothing. There are none | Never |

The footer link to the source code is an ordinary link. Nothing is requested unless you click it.

**Work offline** (the switch in the header) stops all of it: no provider calls, no crawling, no discovery. Archived pages never cause an outside request whatever the switch says. The end-to-end test `tests/e2e/37-offline-end-to-end.spec.ts` checks that the browser makes no request outside the app and that the server contacts nothing while the switch is on.

## What is stored about you

- **Sessions.** A random token in a cookie called `ncb_session`; only its hash is kept on the server. Sessions expire after 30 days of no use, or 90 days at most, and can be revoked.
- **History and bookmarks.** Pages you visited and pages you bookmarked, for the signed-in user. Browsing history is on by default; switch it off or clear it in the app.
- **Search history.** On by default, and it records your queries only while it is on. Turn it off and clear it under the search settings. When it is off, no search text is stored by the history or by Discovery (`tests/discovery/` checks this).
- **Provider keys.** API keys for Brave and Mojeek are encrypted with `NCB_SECRET_KEY` (or a key generated in `/data/secrets`) and are never sent back to the browser. If you lose the key, enter them again.
- **The activity log.** What the server did, kept for `NCB_ACTIVITY_LOG_RETENTION_DAYS` (30). Archive links in it are redacted.

## Turning on online search

1. Open **Storage and settings, Online search**.
2. Read the disclosure: "Online search sends the words you type to the search providers you enable. Those providers can see the query and your server's IP address." Confirm it. This is asked once.
3. Add one or more providers (below), then switch online search on.

Local results always appear first and never wait for a provider. If a provider is slow, fails or runs out of quota, its row says so and the other results stay.

### SearXNG (self-hosted metasearch)

SearXNG forwards your query to several search engines, so those engines see it, but they see SearXNG's address rather than a profile of you. It needs no key.

1. `docker compose --profile searxng up -d --wait`
2. Add a provider of type SearXNG with the address `http://searxng:8080`.
3. Use Test to check it answers.

Alternatively point the provider at a SearXNG you already run. The server's SSRF guard refuses private addresses for everything else, but the address of a provider is allowed for that provider.

### Brave Search API

1. Get a key from Brave's search API programme (their site and terms apply, including any charge).
2. Add a provider of type Brave and paste the key.

Brave's terms allow no storage of results. NoConBrain therefore keeps them in memory for the current search only and never writes a Brave title, snippet or address to disk. If you save a result page, NoConBrain fetches the original page itself; that copy is yours.

### Mojeek

1. Get a key from Mojeek's API programme (their terms apply).
2. Add a provider of type Mojeek and paste the key.

Mojeek's terms allow caching only for a limited time, so NoConBrain keeps its results for at most the time set on the provider (one hour by default) and then drops them.

### Limits you can set

Each provider has a timeout, a rate limit and optional daily and monthly caps, so a runaway query loop cannot use up a paid quota. Usage is shown on the provider's row.

Google Custom Search and Bing are not offered: Google's is closed to new customers and Bing's search API was retired.

## Discovery and privacy

Discovery suggests pages to save from links in what you have saved and, if you allow it, from your online searches. It is off by default. The searches it can use are never stored as search text. Its automatic mode needs a second confirmation. A kill switch stops it at once. See [api.md](../api.md) section 9 for the limits.

## Reporting a privacy problem

If you find the app sending something this page does not list, or storing search text that a setting says it does not, that is a security issue: report it as [SECURITY.md](../../SECURITY.md) describes.
