# Fixtures

Test fixtures only. Nothing here is presented as live data (CLAUDE.md rule 1).

| File | Kind | Origin |
|---|---|---|
| `rss/fed-press.recorded.xml` | Recorded response | `https://www.federalreserve.gov/feeds/press_all.xml`, 2026-11-07. Public domain (Federal Reserve Board). |
| `federal_register/documents.recorded.json` | Recorded response | Federal Register API `documents.json`, 2026-11-07. US government publication. |
| `gdelt/artlist.recorded.json` | Recorded response, trimmed to 3 articles | GDELT DOC API ArtList, 2026-11-07. Titles and links of third-party articles as indexed by GDELT. |
| `gdelt/rate-limit-notice.recorded.txt` | Recorded response | GDELT's plain-text 429 body, 2026-11-07. |
| `rss/synthetic-*.xml` | **Synthetic** | Hand-written to exercise parser edge cases. `example.invalid` URLs. |

Recorded fixtures from commercial publishers are deliberately avoided so the repo doesn't redistribute their content.
