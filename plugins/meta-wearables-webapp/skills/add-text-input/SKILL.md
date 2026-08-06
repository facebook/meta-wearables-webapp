---
name: add-text-input
description: >-
  Add text entry to a Meta Display Glasses webapp. Standard HTML inputs open
  the on-glasses composer (handwriting + voice) when focused and tapped. Use
  when the user wants a text field, search box, form input, or notes area.
argument-hint: "[field: text|search|textarea|form]"
---

## Required reading

Before generating or modifying any code, read both:

- `../../references/display-guidelines.md`
- `../../references/performance-guidelines.md`

These define the non-negotiable display physics, input model, and performance budgets for Meta Display Glasses webapps. Do not skip — generated UI that ignores these will fail on-device.

If these reference files are unavailable in an isolated eval, do not search `/`, home directories, or unrelated workspaces. Apply the requirements already present in this skill and continue.

# Add Text Input to Meta Display Glasses WebApp

Add text entry to a webapp using **standard HTML form controls**. On the glasses, a focusable text control opens the on-device **composer** (handwriting + voice) when the wearer focuses it and taps. Whatever they enter is committed back into the field. **No SDK call is needed** — you do not build the composer; the glasses provide it.

## Prerequisites

- Existing webapp created via `/create-webapp`

## How It Works

Any standard focusable text control becomes voice + handwriting capable for free:

- `<input type="text">`, `type="search"`, `type="email"`, `type="url"`, `type="tel"`, `type="number"`
- `<textarea>`
- `contenteditable` elements

The interaction is **focus the field, then tap** to open the composer. Text is committed back to your field and fires the standard `input` and `change` events — read the value there, not from `keydown`.

## ⚠️ Caveats (must-include)

- The composer opens on **focus + tap**, not on focus alone. A programmatic `.focus()` will **not** surface it — the wearer must tap a focused field.
- `inputmode`, `enterkeyhint`, and `type` do **not** change the composer. `type` only controls **eligibility**.
- **Avoid `type=password`** (and `date`, `checkbox`, `radio`, etc.) — the composer won't open for them. Never rely on the composer for a password field.
- You **cannot** choose handwriting-only vs dictation-only from the page — the wearer picks in the composer.
- On some builds the composer may be unavailable. Keep fields usable and don't make required input depend on it without a fallback (e.g. D-pad selection).
- Read committed text from `input` / `change` events — **not** `keydown` (there is no hardware keyboard).

## Steps

### 1. Add the Field with a Hint

Give every field a `placeholder` (or `aria-label`) — it's the hint the wearer sees for what the field is for:

```html
<label for="note">Note</label>
<textarea id="note" class="focusable" placeholder="Tap to write or speak"></textarea>
```

For a search box:

```html
<input id="q" type="search" class="focusable" placeholder="Tap to search">
```

### 2. Make It Focusable + Read the Value

Standard form controls are focusable by default; ensure they participate in your D-pad focus order. Read the value on `input` (fires as the composer commits) or `change`:

```javascript
var note = document.getElementById('note');
note.addEventListener('input', function () {
  console.log('value:', note.value);   // composer commits fire 'input'
  // e.g. persist via /add-local-storage, or run a search
});
```

### 3. Wire Search / Submit (optional)

```javascript
var q = document.getElementById('q');
q.addEventListener('change', function () {
  runSearch(q.value);
});
```

## Verify

- [ ] Field is focusable and reachable via D-pad
- [ ] Focus-then-tap opens the on-glasses composer
- [ ] Committed text appears in the field
- [ ] An `input` (or `change`) handler reads `field.value` — not `keydown`
- [ ] Every field has a `placeholder` or `aria-label` hint
- [ ] No `type=password` (or other non-text type) used for composer entry
- [ ] App stays usable if the composer is unavailable on a build

## Related Skills

- `/add-ui` — Add forms, search bars, and other UI around the field
