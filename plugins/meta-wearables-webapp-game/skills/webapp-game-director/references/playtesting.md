# Playtesting is paramount

Reference for the `webapp-game-director` skill — read when handing a build back to the user
(step 7).

This is the heart of the skill — the step that decides whether a change is real. Taste generates
*hypotheses*; playing the game on the real device turns them into *knowledge*.

**Know your limits, and hand the controller to the user.** You (the agent) cannot wear the
glasses, feel the EMG pinch, judge the additive display in daylight, or notice that a gesture is
tiring. That is **structurally the user's job.** Don't substitute your own read for theirs: after
every build, tell the user to put the glasses on and play it, then report back. Keep the push
short and concrete (see the brief below). If they skip it, say plainly you're now on a weaker
signal (your judgment), mark the issue `unverified` rather than `resolved` (step 8), and press to
get it on-device before trusting any conclusion.

Principles that hold for any playtest:

- **Weight observed behavior over stated opinion.** What a player *does* (where they hesitate,
  backtrack, misread, quit) beats what they *say* — and both beat what you assumed. "It's fine"
  while they're visibly lost is a failing screen, not a passing one.
- **Watch, don't coach.** When observing a fresh player, don't explain, hint, or defend. The
  moment you have to explain something is the moment you found a design bug. Note it; don't fix it
  live.
- **Small N, fast N.** A single fresh player reveals more than a week of opinion. Get it in front
  of *someone new* often — and the user themselves should replay every build.
- **Feedback overrides taste — including yours and the user's.** When play contradicts a cherished
  design choice, name the contradiction directly and recommend following the player.
- **Compound it.** Log every session in the project's `docs/playtest-log.md`. Patterns across
  sessions are more trustworthy than any single reaction.

## Coach the user's on-glasses playtest (do this every build)

When handing a build back, give the user a short, concrete brief — not just "go try it." Good
on-device playtesting practice to encourage:

- **Play on the real hardware, not the desktop preview or a screenshot.** The desktop hides the
  additive display, EMG feel, and latency. Get the build on-device first (for Meta Display Glasses, hand off
  to `meta-wearables-webapp:test-on-device`).
- **Test in real conditions.** Try it in **bright light / outdoors** (the additive display washes
  out — this is where legibility lives or dies), and while **standing or moving**, not just seated
  at a desk. Rest the arm naturally so the EMG/gesture comfort is honest.
- **Do a hypothesis run and a naïve run.** First, deliberately test the change you just made
  ("does a hit that doesn't kill now clearly register?"). Then just *play* for a minute and notice
  what your hands and eyes do without thinking.
- **Get a fresh pair of eyes.** Have someone who's never seen it put the glasses on while the user
  watches silently. First-timers expose onboarding and clarity gaps the developer is blind to.
- **Capture it while it's fresh.** On-glasses impressions evaporate fast — jot (or dictate) the
  first confused moment, first drop in engagement, moments of genuine delight, and where you'd
  have quit. A/B it against the previous build if you can.
- **Report specifics back.** "The brute now flashes so I can tell hits land, but the hitstop feels
  sluggish" is gold; "it's better" is not. Push for the specific.

Then take what comes back as the verdict — feed it into "resolve or re-open," and let it overrule
your taste when they disagree.
