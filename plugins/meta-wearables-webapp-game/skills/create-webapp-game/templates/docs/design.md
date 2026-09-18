# REPLACE_WITH_GAME_TITLE — design

The design document for this game. Keep docs granular — split into more files under `docs/`
as the project grows rather than letting this become one mega-doc.

## Concept

_One or two sentences: what is the game, what's the core loop, what makes it fun?_

## Player goal

_What is the player trying to do? How do they win / lose / score?_

## Core loop

_The moment-to-moment loop: perceive -> decide -> act -> feedback. Keep it tight._

## Controls

The glasses provide two EMG gesture families (both also work on desktop for development):

- **D-pad swipe** (thumb on the side of the index finger / arrow keys): _what does each direction do?_
- **Index tap** (pad pinch / **Enter** on desktop → `pinchTap`): _what does select do?_
  A mouse **click is not an input** — the desktop stand-in for the index pinch is `Enter`.
- **Index drag** (pad pinch-and-move / left-mouse drag) — **OPT-IN, off by default**:
  _what does a drag do — aim? move? look?_ Leave this out unless a drag genuinely drives
  gameplay; enabling it changes how the device delivers the pinch. Never enable it to make
  desktop mouse clicks work. (If you do opt in, the tap line above flips: a click becomes the
  select and `Enter` is ignored.)

## Visual style

Bright vector / low-poly art (3D) or bright sprites (2D) on a transparent (black) background —
the additive display shows only emitted light. Keep bounded surfaces — cards, panels, modals —
dark gray (not pure black) so they read as opaque. The always-on HUD gets no background fill:
bright text over the black page, since a filled full-width strip is a permanently lit band across
the wearer's view. HUD text >= 16px.

## Scope / milestones

1. _Vertical slice: the smallest playable version of the core loop._
2. _..._

## Out of scope (for now)

_Things explicitly deferred, so the scope stays honest._
