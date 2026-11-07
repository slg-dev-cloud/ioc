# Fixtures

Test fixtures only. Nothing here is presented as live data (CLAUDE.md rule 1).

| File | Kind | Origin |
|---|---|---|
| `rss/fed-press.recorded.xml` | Recorded response | `https://www.federalreserve.gov/feeds/press_all.xml`, 2026-11-07. Public domain (Federal Reserve Board). |
| `federal_register/documents.recorded.json` | Recorded response | Federal Register API `documents.json`, 2026-11-07. US government publication. |
| `gdelt/artlist.recorded.json` | Recorded response, trimmed to 3 articles | GDELT DOC API ArtList, 2026-11-07. Titles and links of third-party articles as indexed by GDELT. |
| `gdelt/rate-limit-notice.recorded.txt` | Recorded response | GDELT's plain-text 429 body, 2026-11-07. |
| `cisa_kev/catalog.recorded.json` | Recorded response, trimmed to 3 entries | CISA KEV feed, 2026-11-07. US government work. |
| `cpsc_recalls/recalls.recorded.json` | Recorded response, trimmed to 2 recalls | SaferProducts.gov Recall API, 2026-11-07. US government data. |
| `cfpb_complaints/week.recorded.json` | Recorded response (aggregates only) | CFPB complaint search API, week of 2026-10-19, 2026-11-07. CC0. |
| `rss/synthetic-*.xml`, `hn_algolia/*.synthetic.json`, `sam_gov/*.synthetic.json`, `html_page/*.synthetic.html` | **Synthetic** | Hand-written to exercise parsers. `example.invalid` URLs. HN and SAM.gov are synthetic because HN posts are user content and SAM.gov can't be recorded without a key. |

Recorded fixtures from commercial publishers are deliberately avoided so the repo doesn't redistribute their content.
