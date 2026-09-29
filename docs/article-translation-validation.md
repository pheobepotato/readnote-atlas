# Article translation coverage

The original Expedia report reproduced with three bare list items between two paragraphs: only the paragraphs reached the provider. The old selector recognized `h1`, `h2`, and `p`; a 50-character minimum also discarded short prose. Deduplicating DOM blocks by text discarded later visible occurrences. Invalid response values could throw during `.trim()` or leave a pending indicator forever.

The collector now walks visible text and assigns each node to one owning block. It covers all heading levels, paragraphs, lists, quotations, captions, definition lists, table cells, and direct prose in containers. Wrapped list paragraphs remain part of the list item; nested lists are independent. UI, hidden content, editable drafts and code blocks are excluded. Translation nodes have explicit in-memory ownership so a parent and child cannot overwrite one another. Requests are deduplicated independently of rendering.

Partial valid responses are retained; only invalid entries retry individually. Count mismatches retry individually because alignment is untrustworthy. Empty, whitespace, object and placeholder values cannot enter the cache. Repeated clicks share a single active run. Provider, companion and reader timeouts are bounded at 110, 120 and 130 seconds respectively; the former shared 10-second companion timeout was too short for translation.

## Verification

Run `npm run check` to build the shipped script, typecheck, run all tests and validate release files. The DOM tests execute the actual shipped content script with deterministic provider responses. `tests/article-list-translation.test.js` covers the original bullets, nested/ordered lists, short content, headings, other block structures, duplicate occurrences, parent/child targets, hidden content, cache reuse, retry, partial malformed responses, repeated clicks, dynamically added content, and a lost runtime reply. Companion/background tests cover partial results, count mismatches and the translation-specific timeout. All 130 tests pass.

## Scope

This collector handles the page's ordinary light DOM at the time Translate is clicked. Cross-origin frames, closed shadow roots, canvas-rendered text and text not yet loaded by a site are outside this coverage. Clicking Translate again picks up newly loaded content. Provider prose quality and semantic completeness still require human review; structural response validation cannot prove them. Existing valid cached translations are preserved.
