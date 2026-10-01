---
name: ai-glasses-webapp-webmcp
description: "Make an existing Meta Ray-Ban Display web app controllable by the on-device assistant. Use when the wearer should operate the app by speaking to Meta AI, when the assistant should read or change app state, or for WebMCP, model context, tool registration, or hands-free control."
argument-hint: "[app-directory] [example-utterance]"
---

# Make a web app agent-controllable

Register WebMCP tools so the assistant on the glasses can operate an app that
already works. The wearer speaks to Meta AI, Meta AI calls your tools, the app
updates. No SDK, no speech recognition, no wake word: the browser provides the
surface.

This is additive. The app must stay fully usable by D-pad with no assistant at
all. Use `ai-glasses-webapp-build` for the app itself and
`ai-glasses-webapp-device` for sensors and text composition.

WebMCP is off by default and enabled per device, by Developer Mode or by
rollout. Eligibility is decided once when the app launches and does not change
for the rest of that session, so turning it on does not affect an already
running app — relaunch before concluding the tools are broken.

## Collect utterances before designing tools

Do not write tools from a feature list. Ask the user for three to five whole
sentences as a wearer would say them aloud, for example "add coffee and sugar
and cream to my cart", "what's in my cart?", "clear it and start over". Then ask
what the assistant should say back, and what it must never do without
confirmation. Restate the derived tool set and get agreement before writing
code.

Every app needs one read-only tool that reports current state, so the assistant
can orient itself before acting.

## One utterance is one call

A sentence that names three things must resolve in a single tool call. Splitting
it into three costs three round trips, three spoken confirmations, and risks the
last one being dropped. Take the whole list in one parameter.

## Only scalar parameters reach the assistant

Parameters are carried as boolean, integer, number, or string. There is no array
or object parameter type.

Declaring `array` or `object` carries the value as a JSON-encoded string, and
the call fails outright when what arrives is not valid JSON of the declared
kind. Nothing in the parameter contract asks the assistant for JSON, so prefer a
delimited string for a spoken list and split it yourself:

```ts
items: {
  type: 'string',
  description: 'Comma-separated item names, e.g. "coffee, sugar, cream".',
}
```

Use `array` or `object` only when the elements carry structure a delimiter
cannot express, and state the encoding in the description, because that is the
only channel that can carry it.

Only each property's `type` and `description` and the schema's top-level
`required` are read. `enum`, `items`, `minimum`, `maximum`, `default`, and
nested schemas are dropped and never enforced, so express those constraints in
the description. Parameter descriptions are truncated near 256 characters and
tool descriptions near 1024; keep both short, since they are spent on every
turn.

## Register on `document.modelContext`

The browser installs `document.modelContext` before page scripts run. Register
there and install no WebMCP polyfill: a library that defines its own model
context can capture the registration, leaving tools somewhere the assistant
never reads, with no error raised.

Registration must not be able to break the app. `registerTool` throws
synchronously when a required member is missing, and its return value is not
guaranteed: some implementations return a promise, others a registration handle
or nothing. Chaining `.catch` directly on the call therefore raises
`registerTool(...).catch is not a function` on those builds. An escaping
exception aborts the remaining registrations, and in React, thrown from an
effect in an app with no error boundary, it unmounts the whole app — taking the
D-pad path down with it. Register each tool through one guarded helper instead.

```ts
// Tool definitions are plain data and plain functions: identical in a vanilla
// TS app and a React one. Only the lifecycle below differs.

// A handled condition is an ordinary result, not a protocol failure: Meta AI reads
// the JSON and follows next_action. There is no failure flag — a fulfilled result is
// always reported as success, and `isError` is dropped — so never signal failure with
// one. Throw or reject only for what the model cannot act on, and for cancellation.
function problem(message: string, next_action: string) {
  return JSON.stringify({error: true, message, next_action});
}

// Hosts flatten a list argument differently — some join the values into prose,
// others JSON-encode the array into the string slot — so try JSON first and fall
// back to separators. Unwrap brackets and quotes only for identifiers; free text
// may legitimately contain them.
function splitList(input: unknown): string[] {
  let value = input;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value.trim());
      if (Array.isArray(parsed)) value = parsed;
    } catch {
      /* fall through to separators */
    }
  }
  if (Array.isArray(value)) {
    return value.map(p => String(p ?? '').trim()).filter(Boolean);
  }
  const text = String(value ?? '').trim();
  const chunks = text.includes('\n') ? text.split('\n') : text.split(',');
  return chunks.map(c => c.trim()).filter(Boolean);
}

function safeRegister(ctx: ModelContext, tool: ModelContextTool, signal?: AbortSignal) {
  try {
    const result = ctx.registerTool(tool, signal ? {signal} : undefined); // may throw
    // Promise on some builds, a handle or undefined on others: only chain if thenable,
    // and use then(undefined, ...) rather than assuming .catch exists.
    if (typeof (result as PromiseLike<unknown>)?.then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, (err: unknown) =>
        console.error(`${tool.name} registration failed`, err),
      );
    }
  } catch (err) {
    console.error(`${tool.name} registration failed`, err);
  }
}

// One call per tool, so a failed registration cannot strand the ones after it.
export function registerCartTools(ctx: ModelContext, signal?: AbortSignal) {
  safeRegister(ctx, {
    name: 'cart_add_items',
    description:
      'Add one or more items to the cart. Pass every item named in a single call. ' +
      'Returns the cart contents and total.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'string',
          description: 'Comma-separated item names, e.g. "coffee, sugar, cream".',
        },
      },
      required: ['items'],
    },
    execute: async ({items}: {items: unknown}) => {
      const names = splitList(items);
      const unknown = names.filter(n => !isKnownItem(n));
      if (unknown.length) {
        // Name what would work, so the assistant can retry instead of giving up.
        return problem(
          `Not on the menu: ${unknown.join(', ')}.`,
          `Offer these and call again: ${menuNames().join(', ')}.`,
        );
      }
      addItems(names); // same state update the buttons call, so the screen re-renders
      return JSON.stringify({
        added: names,
        cart: getCart(),
        total: getTotal(),
        next_action: 'Confirm the additions in one short sentence. Stop and talk.',
      });
    },
  }, signal);
}
```

Wire it up per framework — the definitions above do not change:

```ts
// Vanilla TS: once at startup, after the state it closes over exists.
const ctx = document.modelContext;
if (ctx?.registerTool) registerCartTools(ctx);
```

```tsx
// React: an effect owns the lifetime, and the AbortSignal unregisters on unmount.
useEffect(() => {
  const ctx = document.modelContext;
  if (!ctx?.registerTool) return; // surface absent: D-pad path still works
  const ac = new AbortController();
  registerCartTools(ctx, ac.signal);
  return () => ac.abort();
}, []);
```


Name tools `appprefix_verb_noun`. Registration fails on an empty or duplicate
name, an unserializable schema, or an already-aborted signal, and reports it
either by throwing or by rejecting depending on the build — `safeRegister`
covers both, so a failed tool is logged rather than silently absent or fatal.
Always return the cleanup that aborts the controller; skipping it leaves tools
registered against an unmounted tree.

`name` accepts 128 characters, but the assistant re-registers it under a prefix
inside a 64-character budget, leaving **57** for yours. Longer names are
shortened without rewriting characters, so two that agree in their first 57
collide. Differ early — `cart_add` and `cart_remove`, not a long shared prefix
with the distinguishing word last.

These names are reserved for the browser's own tools and are rejected:
`openUrl`, `goBack`, `goForward`, `reload`, `getCurrentUrl`, `getPageTitle`,
`getPageText`. The rejection happens *after* registration resolves, so it is
silent from the page — nothing throws, nothing rejects, and the tool simply
never reaches Meta AI.

A property is required only if listed in the schema's `required` array. An
absent or empty array means nothing is required, so the assistant may call
without it and `execute` has to cope.

`execute` gets a 10-second deadline for assistant-originated calls. Forward its
`signal` to any `fetch` or long-running work; on expiry the invocation is
aborted best-effort and a late result is ignored.

`execute` receives the arguments object and `{signal}`, and may be async. Return
a string, an object (serialized for you), or `{content: [{type: 'text', text}]}`,
with enough state for the assistant's next decision rather than an
acknowledgement.

**There is no failure flag in a result.** A fulfilled result is always reported
as success, and `isError` is dropped along with every non-text field. For a
*handled* condition — an item not on the menu — return an ordinary result whose
JSON describes it (`{error, message, next_action}`) so Meta AI can explain it
and continue. **Throw or reject** only for what the model cannot act on, and to
signal cancellation; that is the only real failure channel.

Mutate through the same state path the UI uses. The wearer is looking at the
screen while speaking, so a tool that changes state without re-rendering leaves
a stale display. Mark a read-only tool with `annotations: {readOnlyHint: true}`.

## Write results the model can steer on

A `description` is read once, when Meta AI decides which tool to call; after
that it steers on the most recent result. Put the contract in the result.

**Speech ends the turn.** Meta AI speaks and its turn closes, so an instruction
shaped "say X, then call Y" never reaches Y. End every non-terminal result with
an explicit `next_action` saying whether to call another tool or stop and talk,
and make everything a result asks for deliverable in one utterance.

**The page is the referee.** Never accept Meta AI's account of what happened.
Tools return facts the page can verify, and if an outcome can be scored the page
scores it. When the model must both report what the wearer said and act on it,
fuse both into one call so there is no path to a result that skips the check.

**Return the new state with every mutation**, and make failure modes explicit in
the result — "wrong turn", "nothing found", "not your move" — so Meta AI
explains rather than guesses.

**Never put a real answer, or any value the model must not guess, in a parameter
description.** A model will send the example. `"coffee, sugar, cream"` is safe
because it is the menu; a puzzle solution or a target word is not.

**Validate arguments inside `execute`.** The assistant chooses them and nothing
enforces `inputSchema` against what arrives. Do not take an irreversible action
on plausible-looking arguments alone.

## Guardrails belong in the document head

Tool descriptions and the document `<title>` and `<meta name="description">`
are what the assistant always reads. Put behavior you cannot afford to lose
there, such as confirming in one short sentence rather than reading a whole list
back, or never completing a purchase without an explicit yes.

## Verify

Confirm `await document.modelContext.getTools()` lists **every** tool, not just
the first. A short list means a registration failed and the others were
stranded. A hidden page suspends timers and promises, so keep the display awake
and check `document.visibilityState === 'visible'` before trusting a result.

Check that a list argument survives all three shapes a host may send: a
JSON-encoded array, a comma-separated string, and a newline-separated string.

Check that no tool name is a reserved one, and that no two names agree in their
first 57 characters — both fail silently, with the tool simply never reaching
Meta AI.

Run `ai-glasses-webapp-test` with the assistant path exercised and with the app
driven by D-pad only, plus a build where the surface is absent.

Do not let a hand-written test double define the contract. A stub returning
`Promise.resolve()` passes whatever the code assumes about the return value and
proves nothing about the browser. Cover a stub that returns a non-thenable and
one that throws synchronously, and assert the app still renders and every other
tool still registers.
