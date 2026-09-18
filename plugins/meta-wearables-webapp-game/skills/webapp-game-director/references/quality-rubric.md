# The quality rubric

Reference for the `webapp-game-director` skill — read at survey time (step 1) to score the build.

Score each dimension (e.g. 1–5, or weak / okay / strong) and note the specific evidence. Not
every dimension matters equally at every stage — an early prototype lives or dies on the core
loop; a near-ship build is about pacing, onboarding, and polish. Pick the 2–3 that matter now,
but glance at all of them so nothing rots unnoticed.

Anything you could not observe is scored **`unassessed`**, never a number.

1. **Core loop / moment-to-moment fun.** Is the smallest repeated action satisfying *on its own*,
   before any progression or content? *Ask:* would this be fun for 30 seconds with no score, no
   unlocks, no story? *Fails as:* a loop that's only "fun" because of numbers going up; tedium
   papered over with rewards.

2. **Game feel & juice.** Feedback, animation, sound, hit-stop, screenshake, easing, input
   responsiveness. *Ask:* does every meaningful action produce immediate, proportional, tactile
   feedback? *Fails as:* actions that feel mushy, silent, or laggy; no distinction between a
   small event and a big one.

3. **Clarity & readability.** Can the player parse the screen and understand their options and
   the consequences of actions at a glance? *Ask:* on first sight of any screen, does the player
   know what they're looking at, what to do, and what just happened? *Fails as:* visual noise,
   ambiguous affordances, important state that's easy to miss.

4. **Onboarding / the first 60 seconds.** How fast does a new player go from launch to *doing the
   fun thing*? *Ask:* is anything taught before it's needed? Is the player ever confused about
   the very next action? *Fails as:* front-loaded tutorials, walls of text, dead time before
   agency.

5. **Difficulty curve & pacing.** The rhythm of tension and release, ramp of challenge, and
   distribution of new ideas. *Ask:* where does the player get bored, and where do they get
   unfairly stuck? *Fails as:* flat difficulty, spikes, or a mid-section lull.

6. **Depth, mastery & replayability.** Does skill/understanding grow? Are there meaningful
   decisions, not just correct ones? *Ask:* would an expert play differently from a novice, and
   enjoy it more? *Fails as:* dominant strategies, shallow choices, one-and-done content.

7. **Aesthetic cohesion & theme.** Do art, audio, UI, and mechanics feel like one intentional
   thing? *Ask:* does every element reinforce the same fantasy/tone? *Fails as:* mismatched asset
   styles, UI that fights the mood, mechanics that contradict the theme.

8. **Performance & platform fit.** Frame rate, load times, input latency, and respect for the
   target device's constraints. *Ask:* is it smooth on the actual target hardware, not just the
   dev machine? *Fails as:* jank, hitches, controls that don't suit the platform's input. (On
   Meta Display Glasses this ties directly to the display/perf budgets — see
   [meta-wearables-webapp-game.md](meta-wearables-webapp-game.md).)

9. **Accessibility.** Colorblind-safe palettes, text legibility, remappable/forgiving input,
   difficulty options, no reliance on a single sensory channel. *Ask:* who is quietly excluded
   from playing this well? *Fails as:* tiny text, color-only signaling, punishing timing with no
   alternative.

Record the survey in the project's `docs/critique.md` — the milestone board: rubric scores, the
evidence, and the ranked issue slate with per-issue status.
