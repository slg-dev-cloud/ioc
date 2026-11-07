# Task 0 — Source verification (spec §6.3)

Run: 2026-11-07, from the Claude Code cloud sandbox (shared egress IP).
**Owner decision (2026-11-07):** 16 sources enabled: the 11 recommended, SAM.gov (stays `auth_required` until a key is set), and USNI, TechCrunch, LawSites, and Artificial Lawyer.
Still disabled under CLAUDE.md rule 4: DoD contracts (access blocked), War on the Rocks (terms ban AI use), Breaking Defense (terms ban automated access), The Diplomat (AI rights reserved), Ars Technica (terms unread). Each can be revisited with written permission from the publisher.

Method: each endpoint was requested once or twice with an honest user agent (`IOC-source-verification/0.1`). For every host, robots.txt was read and the terms page was fetched where reachable. Where a terms page could not be reached from the sandbox, that is stated; nothing below is assumed.

## Summary

| Source | Endpoint | Format | Terms / robots | Recommendation |
|---|---|---|---|---|
| gdelt-indopacific, gdelt-ai-tech, gdelt-economy, gdelt-military-family | Works, intermittently | JSON | Open use with citation + link (from search results; terms page unreachable) | **Enable as `limited`** |
| federal-register-fin-reg | Works | JSON | US government work; no key | **Enable** |
| federal-register-defense-tech | Works | JSON | US government work; no key | **Enable** |
| dod-contracts | **403 (Akamai "Access Denied")** | — | Can't be reached without bypassing access controls | **`unsupported`** |
| sam-gov-opportunities | Needs API key | JSON | Key required; per-day limit by role | **Enable after key** (see differences) |
| cisa-kev | Works | JSON | US government work | **Enable** |
| fed-press | Works | RSS | Public domain; cite the Board (verified) | **Enable** |
| cfpb-complaints | Works | JSON (aggregations) | US government data; terms page unreachable | **Enable** |
| cpsc-recalls | Works | JSON | US government data; terms page unreachable | **Enable** |
| hn-search | Works | JSON | ~10k req/hour/IP (third-party sources only) | **Enable after query fix** |
| usni-news | Works | RSS (full text) | robots allows `*`; `ai-train=no`; terms page 403 | **Owner decision** |
| breaking-defense | Works | RSS | ToS bans robots/automatic access and storage | **Don't enable** without permission |
| the-diplomat | Works | RSS | Blocks `anthropic-ai`/GPTBot; reserves AI-development rights (unofficial copy) | **Don't enable** without permission |
| war-on-the-rocks | Works | RSS | **ToS explicitly bans LLM summarization, embeddings, RAG** | **`unsupported`** |
| ars-technica | Works | RSS (full text) | Condé Nast terms unreachable; reported to bar AI use | **Don't enable** until terms are read |
| techcrunch-ai | Works | RSS | RSS terms: display only, with attribution and link, no modification | **Owner decision** |
| lawsites | Works | RSS | robots permissive; no terms page found | **Owner decision** |
| artificial-lawyer | Works | RSS | robots permissive; no terms page found | **Owner decision** |

Likely enabled set once approved: 4 GDELT, 2 Federal Register, CISA KEV, Fed press, CFPB, CPSC, HN. That's 11 sources, plus SAM.gov once a key is supplied.

## Differences from config or spec (reported, not silently adapted)

1. **DoD contracts is blocked.** `www.defense.gov/News/Contracts/`, `/News/RSS/`, and `/robots.txt` all return Akamai "Access Denied" (403). Per CLAUDE.md rule 4 this becomes `unsupported`. A possible lawful substitute is SAM.gov award notices (`ptype=a`), once the key works.
2. **SAM.gov:**
   - The key goes in the `api_key` **query parameter** (docs). It can't be injected as a header, so it must come from `SAM_GOV_API_KEY` at runtime and must never appear in stored URLs, `evidence_raw`, or logs.
   - The docs list production as `https://api.sam.gov/opportunities/v2/search`, while examples use `/prod/opportunities/v2/search`. Without a key the endpoint returns an empty 404, so I can't say which path is live.
   - `postedFrom`/`postedTo` are required (`MM/dd/yyyy`, at most 1 year apart); `limit` max 1000.
   - **`uiLink` doesn't work as a public link.** Docs: "user must have either a contracting officer or a Contracting Specialist role. If user hits the link without logging in, user is directed to 404 not found page." Spec §6.2.1 uses `uiLink` as `canonicalUrl`. That needs a decision: use it anyway, labeled as login-only, or find a public notice URL in the response once we have a key.
   - The `description` field is a link that needs the API key appended. Never store it with the key.
   - The docs list a `title` filter, not a free-text `keywords` parameter. The connector will run one `title` query per configured keyword unless testing shows a better option.
   - The per-day request limit depends on account role and isn't published on that page.
3. **GDELT:**
   - The rate limit is "one every 5 seconds" (from the 429 body). From this shared IP, even 15-second spacing still gave a 429 or a connection reset 2 times out of 3. Production on its own IP may behave better.
   - **No excerpt**: ArtList returns only `url, title, seendate, domain, language, sourcecountry, socialimage, url_mobile`. GDELT evidence will have a title and no excerpt, which weakens classification and leaves the §7.3 number check almost no numbers to match.
   - Many results aren't in English (expected; spec §6.2 covers this).
   - The config key `max_records` maps to the API parameter `maxrecords`.
4. **HN Algolia:**
   - Plain `query=open banking` matched loosely. The top hit was an unrelated "Launch HN: Rivet" post with 118 points. Queries need to be quoted phrases, restricted to titles (`restrictSearchableAttributes=title`), or both. I'll test this in M2 with fixtures.
   - `numericFilters=points>=20` works server-side, as spec v1.1 assumes.
5. **Full article text in feeds.** USNI and Ars Technica include full article bodies (`content:encoded`). Per §6.2 we store only title and summary, so the RSS connector must ignore `content:encoded` for these.
6. **CISA KEV:**
   - Matches the spec: 1,769 entries; fields `cveID, vendorProject, product, vulnerabilityName, dateAdded, shortDescription, requiredAction, dueDate, knownRansomwareCampaignUse, notes, cwes` (plus `forensicTriage`).
   - `notes` often includes an NVD link for the CVE, which is a per-entry URL taken from the source. It could serve as the evidence link instead of the catalog URL. Owner or spec decision.
   - The HTML pages on cisa.gov return 403; the JSON feed is fine.
7. **CFPB:** the search API returns `aggregations` for product, issue, company, and more. The weekly aggregate design in spec §6.2.1 is feasible. The sample record had no narrative field.
8. **CPSC:** 55 recalls since 2026-10-01; fields include `RecallID`, `RecallNumber`, `RecallDate`, `Title`, `Description`, `URL` (a public cpsc.gov page), `Hazards`, and `Remedies`.
9. **Federal Register:**
   - All eight agency slugs in the config exist in `/api/v1/agencies`. Documents include `document_number`, `html_url`, `abstract`, and `publication_date`.
   - The API docs and legal-status HTML pages redirect to `unblock.federalregister.gov` (a bot check). The JSON API itself works without a key.

## Per-source detail

### GDELT DOC API (4 sources)
- Endpoint: `https://api.gdeltproject.org/api/v2/doc/doc`. Returned JSON with `format=json`.
- Rate limit: 1 request per 5 seconds (server message). All four GDELT sources must share one limiter.
- Terms: the GDELT About page (via web search; `www.gdeltproject.org` isn't reachable from the sandbox) says the datasets are open for "unlimited and unrestricted use for any academic, commercial, or governmental use", and that use or redistribution must cite the GDELT Project with a link. Whether the DOC API counts as a "dataset" isn't stated explicitly.
- Excerpt storage: there is no excerpt to store. Titles and links come from third-party publishers; we store only those.
- Sources: [GDELT About](https://www.gdeltproject.org/about.html), [jwatte.com note on DOC API reliability](https://jwatte.com/blog/gdelt-open-data-kalev-leetaru/)

### Federal Register (2 sources)
- `https://www.federalregister.gov/api/v1/documents.json` works with `conditions[agencies][]=…`; no key. Robots disallows only search and account paths.
- Terms page not readable (bot check). Federal Register documents are US government publications.
- Excerpts: `abstract` is safe to store.

### DoD contracts
- 403 on every defense.gov URL tried, including robots.txt. → `unsupported`.

### SAM.gov
- See differences, item 2. Status `auth_required` until `SAM_GOV_API_KEY` is set.

### CISA KEV
- `known_exploited_vulnerabilities.json`, catalog version 2026.11.06, 1,769 entries. US government work.

### Federal Reserve press
- RSS, 20 items, summaries only. Terms verified at federalreserve.gov/disclaimer.htm: "Unless otherwise indicated, information on Board's website is in the public domain and may be copied and distributed without permission. Please cite to the Board as the source of the information."

### CFPB complaints
- Search API works. Aggregations are available. **License: CC0**, stated in every API response (`_meta.license`), verified during M2. Date filters are inclusive at both ends. Phase 1 stores aggregates only (spec §6.2.1).

### CPSC recalls
- `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=…` works. robots.txt on saferproducts.gov returns 403. API terms on cpsc.gov aren't reachable from the sandbox.

### Hacker News (Algolia)
- Works; see differences, item 4. Rate limit: about 10,000 requests/hour/IP according to several third-party guides; I couldn't find it stated on the official page.
- Sources: [HN Search API](https://hn.algolia.com/api), [dev.to guide](https://dev.to/agenthustler/scraping-hacker-news-in-2026-complete-guide-algolia-api-date-filters-3iep)

### USNI News
- Feed works (30 items, full text). robots.txt: `User-agent: * … Content-Signal: search=yes,ai-train=no,use=reference`. `ai-input` isn't set, which the file defines as "neither grants nor restricts". It fully blocks named AI crawlers including `ClaudeBot` and `anthropic-ai`. Terms page returned 403.
- Our use isn't training, and our fetcher isn't one of the blocked crawlers. Classification and summarization are still "AI input", which USNI neither grants nor restricts. **Owner decision.**

### Breaking Defense
- Feed works. robots.txt is permissive. [Terms of Service](https://breakingdefense.com/terms-of-service/): use is "for your personal, non-commercial use only or legitimate business purposes related to your role as a current or prospective customer, supplier or distributor"; prohibits using "any robot, spider or other automatic device, process or means to access the Website" and to "download or store … any of the material on our site without the prior written consent". Polling the feed is automated access. **Don't enable without written permission.**

### The Diplomat
- Feed works (96 items). robots.txt fully blocks `anthropic-ai`, `GPTBot`, `CCBot`, `Google-Extended`. Terms page returned 403 to the sandbox. A third-party copy of the terms dated 2026-01-07 (unofficial; [proxy copy](https://proxy-gateway.pages.dev/https://thediplomat.com/terms-of-use/)) says the site "expressly reserves all rights in its content for the purposes of text and data mining, machine learning training, and artificial intelligence development". **Don't enable without permission.**

### War on the Rocks
- Feed works. [Terms](https://warontherocks.com/terms-use-privacy-policies/) prohibit using "any … artificial intelligence system, large language model … or other automated means to access, retrieve, copy, monitor, extract, index … Service Content", and using content "as input to … any dataset, model, retrieval-augmented generation system, vector database, embedding … intended to enable an artificial intelligence or automated system to … summarize" it. → **`unsupported`.**

### Ars Technica
- Feed works (full text). Terms are on Condé Nast's site, which isn't reachable from the sandbox. A third-party summary says Condé Nast "expressly prohibits use for training & operating LLMs/AI" ([zuva.ai](https://zuva.ai/blog/llm-breach-of-terms-of-use/)); I couldn't confirm that against the agreement. **Don't enable until the terms are read.**

### TechCrunch AI
- Feed works. robots.txt fully blocks named AI crawlers (`ClaudeBot`, `anthropic-ai`, `GPTBot`, `ChatGPT-User`, …). [RSS terms](https://techcrunch.com/rss-terms-of-use/): "you are only permitted to display the content that is provided in the feed, with attribution to TechCrunch, and you must link to the full article", and "You may not remove our attribution or links, or otherwise modify our feed content." [ToS](https://techcrunch.com/terms-of-service/): "solely for your personal noncommercial use." Showing the headline verbatim with a link fits. Feeding it to an LLM that writes summaries is arguably "modifying feed content". **Owner decision.**

### LawSites (lawnext.com)
- Feed works (100 items, summaries). robots.txt blocks only `ia_archiver`. No terms-of-use page linked from the homepage, and the guessed URL 404s. **Owner decision**, or ask the publisher.

### Artificial Lawyer
- Feed works (10 items, summaries). robots.txt is permissive. No terms page found. **Owner decision.**

## Still open from the config TODO
The fintech trade outlet, healthcare IT outlet, Japan MoD / Japan-focused source, and cyber advisories feed haven't been chosen or checked. Given the pattern above, prefer government feeds and publishers that explicitly permit feed reuse.
