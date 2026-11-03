# Accessibility (H-05)

The target is WCAG 2.2 AA. This page says what the test suite checks on every push, what was found and fixed in the Phase 9 audit, and the manual checks that a person still has to do, because a script cannot judge them.

## What the suite checks

| Check | Where | What it covers |
|---|---|---|
| axe, WCAG 2.0 to 2.2 A and AA, no serious or critical violation | `05-a11y`, `24-storage-a11y`, `28-discovery-a11y`, `34-packages-a11y`, `12`, `14` and `39-a11y-flows` | Every route in the app (33 routes, including the 404 page and the detail pages), in the light and the dark theme. The archive frame is excluded: it holds someone else's page |
| Landmarks and headings | `39-a11y-flows` | One `main`, a banner and the "Areas" navigation on every page, one `h1`, no skipped heading level |
| Keyboard only | `05`, `12`, `39-a11y-flows` | Sign-in, search from the home page to a result, the area navigation, the skip link, dialogs (Tab stays inside, Escape closes, focus returns to the control that opened it) |
| Visible focus | `05`, `39-a11y-flows` | Up to 45 Tab stops on eight busy pages: each focused control has an outline of 2 px or more, or a ring |
| Reduced motion | `05`, `28`, `39-a11y-flows` | With `prefers-reduced-motion: reduce`: no transition or animation longer than a blink, none repeating for ever (the loading placeholder included) |
| Reflow | `39-a11y-flows` | At 320 CSS pixels wide (what 400% zoom gives on a 1280 pixel window): no sideways page scroll on any route, the heading inside the window, the area navigation scrolls inside its own strip |
| Live regions | `39-a11y-flows`, `09`, `17` | Loading placeholders are `role="status"`, failures are `role="alert"` with a Try again button, the connection badge, search results and capture progress are announced politely |

## Found and fixed in the Phase 9 audit

- The Downloads tab strip scrolled sideways inside itself, but its visually hidden text was positioned against the page, so the whole page was 641 px wide at 320 px. The strip is now the positioning parent. Any new scrolling strip with `sr-only` text inside needs `relative`.
- The Downloads tab panel (focusable, because it scrolls) had its outline switched off. It now uses the global focus style.
- Find in page: the match counter could jump back to the first match a moment after stepping (the count restarted when the frame's address changed). A keyboard user stepping with Enter would lose their place. Fixed; see HB-09.

Tree items in the Collections tree show focus on the row inside the item, not on the item. The test follows that on purpose.

## Manual checklist (to be done by a person before a release)

Not done by the agent that built the suite: no screen reader was available. Record the date, the browser and the reader next to each line when it is done.

- [ ] VoiceOver with Safari on macOS: sign in, search, open a result, open a package article, change a setting. Landmarks, headings and the "Areas" list read in a sensible order.
- [ ] NVDA with Firefox on Windows: the same path, and the Downloads page while a download runs (progress is announced, not repeated every second).
- [ ] Search results: the "N results" status is announced once when the results settle, and late online results do not move the focus.
- [ ] The archive frame: Tab enters it and leaves it again; the address bar and the find bar keep their labels.
- [ ] Browser zoom to 400% on a real window (not just a narrow one) on Library, Search and Storage: nothing is cut off and no control is out of reach.
- [ ] Forced colours (Windows High Contrast): focus outlines, switches and badges stay visible.
- [ ] Touch: targets on the Browser page and the Downloads rows are at least 24 by 24 CSS pixels (WCAG 2.5.8), and dragging in Collections has the menu alternative.
