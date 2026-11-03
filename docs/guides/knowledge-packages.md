# Knowledge packages (ZIM files)

A knowledge package is a ZIM file: a compressed copy of a whole site such as Wikipedia, built by the [Kiwix](https://www.kiwix.org/) project. Importing one gives you thousands of articles that work offline, appear in search and open from the address bar, without NoConBrain crawling anything.

For Wikipedia a package is the better choice: it adds no load to Wikipedia, and it is far more than a topic crawl can reasonably fetch. A package is also never removed by the storage planner; you remove it yourself.

## Get a file

NoConBrain does not download packages. Download one from <https://download.kiwix.org/zim/> yourself and put it in a folder the server can read. Sizes as listed on 1 November 2026:

| File | What it holds | Size |
|---|---|---|
| `wikipedia_en_all_maxi` | All English articles with images | about 119 GB |
| `wikipedia_en_all_nopic` | All articles, no images | about 49 GB |
| `wikipedia_en_all_mini` | The introduction of each article | about 13 GB |
| `wikipedia_en-simple_all_nopic` | Simple English Wikipedia | about 1 GB |
| Topic sets, for example chemistry | One subject, three sizes | from 22 MB to a few hundred MB |

Check the file against the `.sha256` file Kiwix publishes next to it. On a slow link, a topic set is a good way to try the feature first.

## Make the folder visible to the server

The server reads files only under the folders listed in `NCB_VOLUMES_ALLOWED_ROOTS` (default `/volumes`). The simplest way is to put the file in the storage folder you chose at set-up, for example `/mnt/ssd/noconbrain/zim/` on the host, which appears as `/volumes/default/zim/` in the container. To use another folder, mount it in `compose.yml` under `server` and add its container path to `NCB_VOLUMES_ALLOWED_ROOTS`.

## Import

1. Open **Library, Packages** (the same list is at Storage and settings, Knowledge packages).
2. Choose **Add a package** and enter the path as the container sees it, for example `/volumes/default/zim/wikipedia_en_chemistry_nopic_2026-10.zim`.
3. Leave **Copy** off to use the file where it is, or turn it on to copy it into a storage volume. A copy needs the free space and takes a while; an interrupted copy leaves no half-finished file behind.
4. The package appears in the list. Open it to see its title, language, licence, article count and state. **Check** reads it end to end and reports damage.

Registration is quick whatever the size; opening a 13 GB package took a few milliseconds in the measurements in [benchmarks.md](../benchmarks.md). Search over a very large package on a slow disk has not been measured.

## Use

- **Address bar.** Type or paste a Wikipedia address. If a package holds the article it opens from the package, offline, even if the address is `en.wikipedia.org`. If you also saved that article yourself, your saved copy opens first, and the page offers a switch to the package copy.
- **Search.** The Packages category searches only packages. In a combined search, package hits are merged with your own pages (**mixed**), shown beside them (**separate**), or left out (**off**); the control is on the search page. A package search has a time budget (`NCB_ZIM_SEARCH_BUDGET_MS`, 800 ms) so a slow package cannot hold up the page.
- **Bookmarks and history** work for package articles, and a package article can be a link target from saved pages.

Every package page shows the package's licence bar. Wikipedia text is CC BY-SA 4.0; if you republish anything, follow the licence shown.

## Remove

Remove a package from its detail page. If you chose to copy it, the copy is deleted; a file you registered in place is left where it is. Removing a package never touches your saved pages.

## Limits and what to expect

- A damaged file is marked as such and the rest of the app carries on. The package reader runs in its own thread, so a crash in it restarts the reader, not the server.
- `NCB_ZIM_CACHE_MB` (16) is the cache for each open package. Raise it on a machine with spare memory.
- Images exist only in `maxi` and topic sets with pictures. The `nopic` and `mini` files show placeholders or none.
- Tested on small fixture packages in the automated suite (`tests/integration/zim/`, `tests/e2e/30-packages-library.spec.ts` to `tests/e2e/32-package-search.spec.ts`) and on a 132 MB chemistry package by hand. A complete English Wikipedia package has not been imported.
- Kiwix catalogue browsing and in-app downloads are not built (Z-11 in the [plan](../implementation-plan.md)).
