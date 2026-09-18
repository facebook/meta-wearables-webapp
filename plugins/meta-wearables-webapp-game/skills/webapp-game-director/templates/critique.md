# Milestone board — <game name> — milestone <n> — opened <date> — build/commit <ref>

_Copy this template into the project as `docs/critique.md` on the first milestone and maintain it
there — the copy in the plugin is read-only._

_How I experienced it:_ <ran via …; on-device / desktop / couldn't run (why)>

## Rubric snapshot (this survey)

Score each 1–5 (or weak/okay/strong). Note the specific evidence, not a verdict. A dimension you
could not actually observe — no device, no reachable browser, the build wouldn't run — is
**`unassessed`**, with the reason. Never infer a score from reading the source; an unassessed
dimension is a gap to close, and scoring it anyway hides that.

| Dimension | Score | Evidence (exact moment / screen / input) |
|---|---|---|
| Core loop / moment-to-moment fun | | |
| Game feel & juice | | |
| Clarity & readability | | |
| Onboarding / first 60s | | |
| Difficulty curve & pacing | | |
| Depth, mastery & replayability | | |
| Aesthetic cohesion & theme | | |
| Performance & platform fit | | |
| Accessibility | | |

## The issue slate

The milestone = working this slate to completion. Ranked by leverage (director's recommendation);
the user sets the actual order and may add issues.

Statuses: `open` · `in progress` · `playtesting` · `resolved` · `unverified` · `deferred`.
**`resolved` requires playtest feedback.** A change that is built and passes the gate but that no
player has confirmed is `unverified` (note why) — it stays on the board and returns at the next
survey.

| # | Issue (one line) | Evidence | Leverage | Status |
|---|---|---|---|---|
| 1 | <highest-leverage issue> | <exact moment/file> | high | open |
| 2 | | | | open |
| 3 | | | | open |

_Open playtest questions (only a real player can answer):_ <…>

## Per-issue log (fill as each is worked)

### Issue <#> — <title>
- **Hypothesis / fix:** …
- **Plan / change made:** …
- **Playtest feedback (from the user):** … → **resolved / re-opened because … / unverified (no
  playtest yet because …)**

---

_When every issue is considered → re-survey and open milestone <n+1> with a fresh board._
