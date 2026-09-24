#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the Apache License, Version 2.0 found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve(process.argv[2] ?? 'src');
const findings = [];
const inspectedFiles = [];
const surfaceContentWrappers = [];
const pagerChildComponents = [];
const scrollContentWrappers = [];
const fauxCompactSurfaces = [];

function wordCount(value) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(location);
    } else if (/\.(?:css|ts|tsx|js|jsx)$/.test(entry.name)) {
      const text = fs.readFileSync(location, 'utf8');
      inspectedFiles.push({ file: location, text });
      inspect(location, text);
    }
  }
}

function report(file, offset, text, message) {
  const line = text.slice(0, offset).split('\n').length;
  findings.push(`${path.relative(process.cwd(), file)}:${line}: ${message}`);
}

function getJsxExpression(source, propName) {
  const start = source.search(new RegExp(`\\b${propName}\\s*=\\s*\\{`));
  if (start < 0) return '';
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  return '';
}

function getNamedHandlerBody(source, name) {
  if (!name) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(
    new RegExp(`(?:const\\s+${escapedName}\\s*=\\s*\\([^)]*\\)\\s*=>|function\\s+${escapedName}\\s*\\([^)]*\\))\\s*\\{([\\s\\S]*?)\\n\\s*\\}`),
  )?.[1] ?? '';
}

function inspectActionExpression(file, text, offset, controlName, label, expression) {
  if (!expression) return;
  const normalizedLabel = label.trim();
  const promisesCollection = /^(?:Browse similar\b|(?:Browse|View)\s+\w+s\b)/i.test(normalizedLabel);
  const promisesCommunication = /^(?:Contact|Call|Message|Email)\b/i.test(normalizedLabel);
  const hasPlatformEffect = /\b(?:navigator\.(?:clipboard|contacts|share)|window\.open|location\.(?:assign|replace))\b/.test(expression) || /\b(?:mailto:|tel:)/.test(expression);
  if (
    /\bToast\.show\s*\(/.test(expression) &&
    !/\b(?:set|navigate|dispatch|update|toggle|open|reserve|cancel|mark|checkout|return|add|save|send|log)[A-Z][A-Za-z0-9_$]*\s*\(/i.test(expression) &&
    !/\b(?:navigate|dispatch|reserve|cancel|checkout|returnTool|add|save|send|log)\s*\(/.test(expression) &&
    !hasPlatformEffect &&
    !promisesCollection &&
    !promisesCommunication
  ) {
    report(file, offset, text, `${controlName} uses Toast as its only outcome; Toast is feedback, not the action itself`);
  }
  if (/\bif\s*\([^)]*\)\s*\{[^}]*\bToast\.show\s*\([^}]*\breturn\s*;[^}]*\}/s.test(expression)) {
    report(file, offset, text, `${controlName} has an enabled handler branch that only shows feedback and returns without completing an operation`);
  }
  const capability = label.match(/\b(map|chart|guide)\b/i)?.[1]?.toLowerCase();
  const route = expression.match(/\bnavigate\s*\(\s*(['"`])([^'"`]+)\1/)?.[2] ?? '';
  if (capability && route && !route.toLowerCase().includes(capability)) {
    report(file, offset, text, `${controlName} promises a ${capability} but navigates to an unrelated record route; make the label and destination agree`);
  }
  if (promisesCollection && /\$\{/.test(route)) {
    report(file, offset, text, `${controlName} promises a collection but navigates to one generated record detail; open the collection or name the specific destination`);
  } else if (promisesCollection && !/\b(?:navigate|open[A-Z][A-Za-z0-9_$]*)\s*\(/.test(expression)) {
    report(file, offset, text, `${controlName} promises a collection but does not open one; route to the named collection or remove the target`);
  }
  if (
    /^Share\b/i.test(label.trim()) &&
    !/\b(?:navigator\.share|navigator\.clipboard|dispatch|send[A-Z][A-Za-z0-9_$]*|share[A-Z][A-Za-z0-9_$]*)\s*(?:\.|\()/i.test(expression)
  ) {
    report(file, offset, text, `${controlName} is labeled Share but does not invoke a sharing/copy/send capability`);
  }
  if (/\bToast\.show\s*\([^)]*\bcopied\b/i.test(expression) && !/\b(?:navigator\.clipboard|writeText|copy[A-Z][A-Za-z0-9_$]*)\s*(?:\.|\()/.test(expression)) {
    report(file, offset, text, `${controlName} reports copied feedback without performing a clipboard/copy operation`);
  }
  if (
    promisesCommunication &&
    !/\b(?:mailto:|tel:|navigator\.(?:contacts|share)|contact[A-Z][A-Za-z0-9_$]*|call[A-Z][A-Za-z0-9_$]*|message[A-Z][A-Za-z0-9_$]*|send[A-Z][A-Za-z0-9_$]*|open[A-Z][A-Za-z0-9_$]*(?:Contact|Dialer|Message))\s*(?:\.|\(|['"])/i.test(expression)
  ) {
    report(file, offset, text, `${controlName} promises a communication action but does not open or perform a contact, call, message, or email capability`);
  }
}

function inspect(file, text) {
  const isStyle = file.endsWith('.css');
  const spacingTokens = new Set([
    '2xs',
    'xsmall',
    'small',
    'sm-med',
    'medium',
    'med-lg',
    'large',
    'xlarge',
    '2xl',
    '3xl',
    '4xl',
    '5xl',
  ]);
  for (const match of text.matchAll(/var\(\s*--uit-spacing-([\w-]+)\s*\)/g)) {
    if (!spacingTokens.has(match[1])) {
      report(file, match.index, text, `unknown toolkit spacing token --uit-spacing-${match[1]}`);
    }
  }
  const tokenFallback = /var\(\s*--uit-[^,)]+,\s*[^)]+\)/g;
  for (const match of text.matchAll(tokenFallback)) {
    report(file, match.index, text, 'the toolkit token uses a copied literal fallback');
  }

  const authoredVerticalOverflow = isStyle
    ? /overflow(?:-y)?\s*:\s*(?:auto|scroll)\b/g
    : /overflow(?:Y)?\s*:\s*['"](?:auto|scroll)['"]/g;
  for (const match of text.matchAll(authoredVerticalOverflow)) {
    report(file, match.index, text, 'authored vertical scrolling creates another scroll owner');
  }

  if (isStyle) {
    for (const match of text.matchAll(/grid-template-columns\s*:\s*repeat\([^,]+,\s*1fr\s*\)/g)) {
      report(file, match.index, text, 'responsive grid uses intrinsic 1fr tracks; use minmax(0, 1fr) and min-inline-size: 0 on variable-content cells');
    }
    for (const match of text.matchAll(/\b(?:font-size|font-weight|font-family|line-height|letter-spacing)\s*:/g)) {
      report(file, match.index, text, 'authored typography metric bypasses TextView/TextAppearance and the toolkit typography ownership');
    }
    for (const match of text.matchAll(/:\s*[^;{}]*\b(?!0(?:\.0+)?(?:px|r?em|ch)\b)\d+(?:\.\d+)?(?:px|r?em|ch)\b/g)) {
      report(file, match.index, text, 'literal CSS length bypasses the toolkit tokens or responsive measurement');
    }
    for (const match of text.matchAll(/border-radius\s*:\s*([^;}{]+)/g)) {
      if (!/^\s*var\(\s*--uit-corner-radius-[\w-]+\s*\)\s*$/.test(match[1])) {
        report(file, match.index, text, 'authored border-radius must use one semantic toolkit corner token');
      }
    }
    for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (
        /background(?:-color)?\s*:\s*var\(\s*--uit-color-background-[\w-]+\s*\)/.test(block[2]) &&
        /border-radius\s*:/.test(block[2]) &&
        !/(?:image|img|media|thumbnail|banner|avatar|artwork|photo)/i.test(block[1])
      ) {
        report(file, block.index, text, 'authored rounded background recreates a toolkit surface; use a semantic component or material host');
      }
    }
    for (const block of text.matchAll(/([^{}]*panel[^{}]*(?:content|inner|body)[^{}]*)\{([^}]*)\}/gi)) {
      for (const padding of block[2].matchAll(/padding(?:-[\w-]+)?\s*:\s*([^;]+)/g)) {
        if (!/var\(\s*--uit-spacing-large\s*\)/.test(padding[1])) {
          report(file, block.index + block[0].indexOf(padding[0]), text, 'authored Panel text/content inset must use --uit-spacing-large');
        }
      }
    }
    for (const block of text.matchAll(/([^{}]*content-inset[^{}]*)\{([^}]*)\}/gi)) {
      if (
        /display\s*:\s*flex\b/.test(block[2]) &&
        /flex-direction\s*:\s*column\b/.test(block[2]) &&
        !/gap\s*:\s*calc\(\s*var\(\s*--uit-spacing-large\s*\)\s*\+\s*var\(\s*--uit-spacing-xsmall\s*\)\s*\)/.test(block[2])
      ) {
        report(file, block.index, text, 'mixed content-inset text stack must use the prescribed large-plus-xsmall token rhythm');
      }
    }
    for (const block of text.matchAll(/([^{}]*(?:app|route|page|pager|shell)[^{}]*)\{([^}]*)\}/gi)) {
      if (
        !/data-app-root/.test(block[1]) &&
        /flex\s*:\s*1(?:\s+1\s+(?:auto|0))?\b/.test(block[2]) &&
        !/(?:block-size|height)\s*:\s*100%/.test(block[2])
      ) {
        report(file, block.index, text, 'flex-growing route shell has no explicit full-height containing block; flex growth only works when its immediate parent is flex');
      }
      if (
        /display\s*:\s*grid\b/.test(block[2]) &&
        /grid-template-rows\s*:/.test(block[2]) &&
        !/min-inline-size\s*:\s*0\b/.test(block[2])
      ) {
        report(file, block.index, text, 'grid route shell must set min-inline-size: 0 so intrinsic action or content width cannot expand it beyond the viewport');
      }
    }
    for (const block of text.matchAll(/([^{}]*action-dock[^{}]*)\{([^}]*)\}/gi)) {
      if (!/min-inline-size\s*:\s*0\b/.test(block[2])) {
        report(file, block.index, text, 'action dock must set min-inline-size: 0 so an intrinsic ButtonRail cannot expand the viewport');
      }
    }
    for (const match of text.matchAll(/(?:^|[;{])\s*background(?:-image)?\s*:\s*(?:#[\da-f]{3,8}|rgba?\(|(?:linear|radial)-gradient)/gim)) {
      report(file, match.index, text, 'raw color/gradient background requires semantic toolkit material review');
    }
  } else {
    for (const match of text.matchAll(/\b(?:fontSize|fontWeight|fontFamily|lineHeight|letterSpacing)\s*:/g)) {
      report(file, match.index, text, 'authored typography metric bypasses TextView/TextAppearance and the toolkit typography ownership');
    }
    for (const match of text.matchAll(/['"][^'"]*\b(?!0(?:\.0+)?(?:px|r?em|ch)\b)\d+(?:\.\d+)?(?:px|r?em|ch)\b[^'"]*['"]/g)) {
      report(file, match.index, text, 'literal CSS length bypasses the toolkit tokens or responsive measurement');
    }
    for (const match of text.matchAll(/\b(?:width|height|headerHeight|topFadingEdgeLength|bottomFadingEdgeLength|leftFadingEdgeLength|rightFadingEdgeLength)=\{\s*\d+(?:\.\d+)?\s*\}/g)) {
      report(file, match.index, text, 'literal component size should come from a toolkit token or responsive measurement');
    }
    for (const match of text.matchAll(/borderRadius\s*:\s*([^,}\n]+)/g)) {
      if (!/^(['"])var\(\s*--uit-corner-radius-[\w-]+\s*\)\1\s*$/.test(match[1].trim())) {
        report(file, match.index, text, 'authored borderRadius must use one semantic toolkit corner token');
      }
    }
    for (const style of text.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
      for (const match of style[1].matchAll(/\b(?:inlineSize|blockSize|width|height|padding|margin|gap|top|right|bottom|left)\s*:\s*(?!0\b)\d+(?:\.\d+)?\b/g)) {
        report(file, style.index + style[0].indexOf(match[0]), text, 'unitless authored layout length bypasses the toolkit tokens or responsive measurement');
      }
    }
    for (const match of text.matchAll(/(?:window\s*\.\s*)?(?:innerWidth|innerHeight)|screen\s*\.\s*(?:width|height)|document\.documentElement\.client(?:Width|Height)/g)) {
      const surrounding = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
      if (/(?:===?|!==?|[<>]=?)\s*\d+|\d+\s*(?:===?|!==?|[<>]=?)/.test(surrounding)) {
        report(file, match.index, text, 'layout branches on a hardcoded viewport dimension; derive composition from available constraints');
      }
    }
  }

  for (const match of text.matchAll(/\bas\s+(?:never|any|unknown\s+as\s+[^\s,;)]+)/g)) {
    report(file, match.index, text, 'type-suppression cast can hide an invalid toolkit public handle or prop contract');
  }
  for (const match of text.matchAll(/`[^`\n]*·[^`\n]*·[^`\n]*`|(['"])[^'"\n]*·[^'"\n]*·[^'"\n]*\1/g)) {
    report(file, match.index, text, 'compact product string serializes more than two fact groups; keep one essential fact pair and move remaining detail to its destination');
  }
  for (const match of text.matchAll(/@ts-(?:ignore|nocheck)|@ts-expect-error/g)) {
    report(file, match.index, text, 'TypeScript suppression is not allowed in generated production application code');
  }
  for (const match of text.matchAll(/\btextStyle=['"][^'"]+['"]/g)) {
    report(file, match.index, text, 'TextView textStyle must use the typed TextStyle enum, not a raw string value');
  }
  for (const match of text.matchAll(/\bset(?:ToastTick|RenderTick|RenderNonce|ForceRender|DummyState)\s*\(/g)) {
    report(file, match.index, text, 'dummy render state attempts to manufacture an outcome or evade validation; implement a real state/navigation result');
  }
  for (const match of text.matchAll(/\bon[A-Z][A-Za-z]*=\{\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\}/g)) {
    report(file, match.index, text, 'empty interaction callback creates a focusable control with no outcome');
  }
  for (const match of text.matchAll(/(['"])(?:[^'"\n]*\b(?:coming soon|not available yet|placeholder)\b[^'"\n]*)\1/gi)) {
    report(file, match.index, text, 'placeholder product action/copy is not a completed production interaction');
  }
  for (const match of text.matchAll(/\ba\s+(?:8|11|18)(?=\s|\b)/gi)) {
    report(file, match.index, text, 'user-facing copy uses the wrong indefinite article before a numeric phrase');
  }
  for (const match of text.matchAll(/\$\{[^}]+\}\s+(?:items|results|alerts|packages|tasks|days|hours|minutes)\b/g)) {
    report(file, match.index, text, 'dynamic count copy hardcodes a plural noun; handle the singular and plural forms explicitly');
  }
  for (const record of text.matchAll(
    /\{[^{}]*\btitle\s*:\s*(['"])([^'"]+)\1[^{}]*\bdescription\s*:\s*(['"])([^'"]+)\3[^{}]*\}/gs,
  )) {
    const title = record[2]
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const description = record[4]
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (title.length >= 8 && description.includes(title)) {
      report(
        file,
        record.index,
        text,
        `record description repeats its visible title (${record[2]}); begin with new capability or context`,
      );
    }
  }

  if (!/\.(?:tsx|jsx)$/.test(file)) return;

  const localLabelOnlyStates = new Map();
  const textWithoutButtons = text.replace(/<Button\b[\s\S]*?\/>/g, ' ');
  for (const state of text.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\b/g)) {
    const escapedState = state[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stateReferences = textWithoutButtons.match(new RegExp(`\\b${escapedState}\\b`, 'g')) ?? [];
    if (stateReferences.length <= 2) {
      localLabelOnlyStates.set(state[2], state[1]);
    }
  }

  const lineCount = text.split('\n').length;
  if (lineCount < 10 && text.length > 2000) {
    report(file, 0, text, 'source file is emitted as minified one-line code; keep production source formatted and reviewable');
  }
  if (lineCount > 400) {
    report(file, 0, text, 'view file is monolithic; separate route/pager pages, domain state, and shell composition by semantic ownership');
  }
  if (
    /<SubNavigationPager\b/.test(text) &&
    (text.match(/<(?:VerticalList|ScrollView)\b/g) ?? []).length >= 3 &&
    lineCount > 200
  ) {
    report(file, 0, text, 'large SubNavigationPager implementation combines several substantial pages; move each page to a focused component file');
  }
  if (/<Routes\b/.test(text) && /<SubNavigationPager\b/.test(text) && lineCount > 200) {
    report(file, 0, text, 'router shell and substantial pager implementation share one file; keep App routing declarative and move the pager view to its own module');
  }

  const routeReturnHandlerNames = new Set();
  for (const handler of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useCallback\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[[^\]]*\]\s*\)/g)) {
    if (/\bnavigate\s*\(\s*['"]\/['"]\s*\)/.test(handler[2])) {
      routeReturnHandlerNames.add(handler[1]);
    }
  }

  for (const match of text.matchAll(/<HashRouter\b/g)) {
    report(file, match.index, text, 'production WebView routes must use BrowserRouter unless a host Back bridge is separately verified');
  }

  for (const match of text.matchAll(/<Header\b/g)) {
    report(file, match.index, text, 'Header is Page-owned infrastructure; configure the application page header through Page props rather than rendering Header in route content');
  }

  for (const shell of text.matchAll(/<div\b[^>]*className=['"][^'"]*(?:detail|action)[^'"]*shell[^'"]*['"][^>]*>\s*<Page\b[\s\S]*?<\/Page>\s*<div\b[^>]*className=['"][^'"]*dock[^'"]*['"]/g)) {
    report(file, shell.index, text, 'Page is nested as one row of an authored action shell; Page must remain the route root and contain the content/dock shell');
  }

  for (const match of text.matchAll(/<Chip\b[^>]*\bonClick=/g)) {
    report(file, match.index, text, 'Chip is non-interactive status/metadata; use Button, ListItem, Container, or another semantic interactive component for an action');
  }
  for (const component of text.matchAll(/<(Chip|Header|Tag|Button|AppBadge)\b([^>]*)>/g)) {
    const attributes = component[2];
    if (/\b(?:width|height)=/.test(attributes) || /\benforceMaxWidth(?:=|\b)/.test(attributes)) {
      report(file, component.index, text, `${component[1]} must retain its component-owned intrinsic width and height; remove sizing props`);
    }
    const inlineStyle = attributes.match(/\bstyle=\{\{([\s\S]*?)\}\}/)?.[1] ?? '';
    if (/\b(?:width|height|inlineSize|blockSize|minWidth|maxWidth|minHeight|maxHeight|minInlineSize|maxInlineSize|minBlockSize|maxBlockSize|flex|flexGrow|flexShrink|flexBasis|transform|scale)\s*:/.test(inlineStyle)) {
      report(file, component.index, text, `${component[1]} inline style forces or constrains intrinsic size; remove all external sizing, flex sizing, and scale`);
    }
  }
  for (const column of text.matchAll(/<div\b[^>]*style=\{\{(?=[^}]*\bdisplay\s*:\s*['"]flex['"])(?=[^}]*\bflexDirection\s*:\s*['"]column['"])([^}]*)\}\}[^>]*>([\s\S]*?)<\/div>/g)) {
    if (/<(?:Chip|Header|Tag|Button|AppBadge)\b/.test(column[2]) && !/\balignItems\s*:\s*['"]flex-start['"]/.test(column[1]) && !/<(?:Chip|Header|Tag|Button|AppBadge)\b[^>]*\bstyle=\{\{[^}]*\balignSelf\s*:\s*['"]flex-start['"]/.test(column[2])) {
      report(file, column.index, text, 'flex column stretches intrinsic toolkit content; align Chip/Header/Tag/Button/AppBadge children to flex-start without resizing them');
    }
  }

  for (const emptyListState of text.matchAll(/if\s*\([^)]*\.length\s*={2,3}\s*0[^)]*\)\s*(?:\{\s*)?return\s*\(\s*<VerticalList\b[\s\S]*?<ListItem\b/g)) {
    report(file, emptyListState.index, text, 'empty collection state is rendered as a fake ListItem; use ScrollView insetForHeader with ordinary inset copy and a real recovery Button below it');
  }

  for (const match of text.matchAll(/<TextView\b[^>]*\bappearance=/g)) {
    report(file, match.index, text, 'TextView has no appearance prop; use the public textStyle prop with a TextStyle value from the package root');
  }
  for (const card of text.matchAll(/<Card\b([\s\S]*?)>[\s\S]*?<\/Card>/g)) {
    const markup = card[0];
    if (/<CardAboveScrim\b/.test(markup) && !/\b(?:top|bottom)Scrim=\{ScrimType\.(?:SMALL|MEDIUM|TALL|FULL)\}/.test(card[1])) {
      report(file, card.index, text, 'Card has above-scrim content but does not enable a visible Card scrim');
    }
    if (
      /<CardBelowScrim\b[^>]*>[\s\S]*?className=['"]media-image['"]/.test(markup) &&
      !/<CardBelowScrim\b(?=[^>]*\bstyle=\{\{(?=[^}]*\bposition\s*:\s*['"]absolute['"])(?=[^}]*\binset\s*:\s*0\b)[^}]*\}\})[^>]*>/.test(markup)
    ) {
      report(file, card.index, text, 'full-bleed Card media layer must be absolutely positioned through CardBelowScrim style');
    }
    if (
      /<CardAboveScrim\b/.test(markup) &&
      !/<CardAboveScrim\b(?=[^>]*\bstyle=\{\{(?=[^}]*\bposition\s*:\s*['"]absolute['"])(?=[^}]*\binsetBlockEnd\s*:\s*['"]var\(\s*--uit-spacing-[\w-]+\s*\)['"])[^}]*\}\})[^>]*>/.test(markup)
    ) {
      report(file, card.index, text, 'CardAboveScrim copy must be explicitly anchored over media through its public style prop');
    }
    const width = card[1].match(/\bwidth=\{?([`'"][\s\S]*?[`'"])\}?/)?.[1] ?? '';
    if (/100vi/.test(width) && !/100vb/.test(width)) {
      report(file, card.index, text, 'responsive Card width is bounded only by inline space; also reserve available block space for the Card and pagination');
    }
  }
  for (const match of text.matchAll(/<TextView\b[^>]*\btextStyle=\{TextStyle\.(?:BODY1(?:_EMPHASIZED)?|DISPLAY\w*|HEADING\w*|NUMERAL\w*)\}/g)) {
    report(file, match.index, text, 'authored TextView exceeds the routine BODY2 ceiling; use BODY2/BODY2_EMPHASIZED/label/metadata unless a specific exceptional need is verified on-device');
  }

  if (/<ReactRouterPageTransition\b/.test(text)) {
    if (!/<ReactRouterPageTransition\b[^>]*>\s*\{\s*\(\s*\{\s*location\s*\}\s*\)\s*=>/.test(text)) {
      report(file, text.indexOf('<ReactRouterPageTransition'), text, 'ReactRouterPageTransition render callback must consume its location snapshot');
    }
    if (!/<Routes\b[^>]*\blocation=\{location\}/.test(text)) {
      report(file, text.indexOf('<ReactRouterPageTransition'), text, 'Routes inside ReactRouterPageTransition must render with location={location} for retained-page focus/scroll restoration');
    }
    const browserIndex = text.indexOf('<BrowserRouter');
    const providerIndex = text.indexOf('<ReactRouterNavigationProvider');
    const appImport = text.match(/import\s*\{[^}]*\bApp\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}\s*from\s*['"]@meta\/wearables-ui-toolkit-mrbd['"]/);
    const appTag = appImport?.[1] ?? 'App';
    const appIndex = text.indexOf(`<${appTag}`);
    const transitionIndex = text.indexOf('<ReactRouterPageTransition');
    if (!(browserIndex >= 0 && browserIndex < providerIndex && providerIndex < appIndex && appIndex < transitionIndex)) {
      report(file, transitionIndex, text, 'use canonical router shell order: BrowserRouter > ReactRouterNavigationProvider > App > ReactRouterPageTransition');
    }
  }

  for (const page of text.matchAll(/<Page\b[\s\S]*?>/g)) {
    const metadata = page[0].match(/\bheaderMetadata=\{?`([^`]*)`\}?|\bheaderMetadata=['"]([^'"]*)['"]/);
    const metadataIdentifier = page[0].match(/\bheaderMetadata=\{([A-Za-z_$][\w$]*)\}/)?.[1];
    const metadataMember = page[0].match(/\bheaderMetadata=\{[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\}/)?.[1] ?? '';
    const escapedMetadataIdentifier = metadataIdentifier?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const resolvedMetadata = escapedMetadataIdentifier == null
      ? ''
      : text.match(new RegExp(`const\\s+${escapedMetadataIdentifier}\\s*=\\s*([\"'\\x60])([\\s\\S]*?)\\1`))?.[2] ?? '';
    const metadataBinding = escapedMetadataIdentifier == null
      ? ''
      : text.match(new RegExp(`const\\s+${escapedMetadataIdentifier}\\s*=([\\s\\S]*?);`))?.[1] ?? '';
    const value = metadata?.[1] ?? metadata?.[2] ?? resolvedMetadata;
    if (/[·•—]/.test(value)) {
      report(file, page.index, text, 'Page header metadata combines multiple facts in the fixed display overlay; keep one short supporting value and move detail into the route body');
    }
    if (value && !/[${}]/.test(value) && wordCount(value) > 2) {
      report(file, page.index, text, 'Page header metadata exceeds two words; keep every header subtitle/metadata field to at most two words');
    }
    if (/^(?:stall|duration|difficulty|servings?|count|identifier|id|track|category|room)$/i.test(metadataMember)) {
      report(file, page.index, text, 'Page header metadata uses a routine fact; omit optional metadata unless it adds high-value context that affects understanding or the next action');
    }
    if (/\b(?:count|duration|difficulty|servings?|identifier|stall)\w*\b/i.test(metadataBinding)) {
      report(file, page.index, text, 'Page header metadata is derived from routine facts; omit optional metadata unless it adds high-value context that affects understanding or the next action');
    }
    const templateHeaderText = page[0].match(/\bheaderText=\{(`[^`]*`)\}/)?.[1];
    const headerText = page[0].match(/\bheaderText=(?:\{([\s\S]*?)\}|['"]([^'"]*)['"])/);
    const headerValue = templateHeaderText ?? headerText?.[1] ?? headerText?.[2] ?? '';
    if (/[·—]/.test(headerValue)) {
      report(file, page.index, text, 'Page headerText combines identity with supporting facts; keep one concise identity and move other facts to headerMetadata');
    }
    const literalHeaderValue = headerText?.[2] ?? '';
    if (literalHeaderValue && wordCount(literalHeaderValue) > 2) {
      report(file, page.index, text, 'Page header title exceeds two words; keep every header title field to at most two words');
    }
  }

  for (const page of text.matchAll(/<Page\b[^>]*\bheaderText=[^>]*>[\s\S]*?<\/Page>/g)) {
    const owner = page[0].match(/<(?:ScrollView|VerticalList)\b([^>]*)>/);
    if (owner && !/\binsetForHeader\b/.test(owner[1])) {
      report(file, page.index + page[0].indexOf(owner[0]), text, 'Page child scroll owner must set insetForHeader so content clears the overlaid Page header');
    }
    const headerExpression = page[0].match(/\bheaderText=\{([^}]+)\}/)?.[1]?.trim();
    const escapedHeaderExpression = headerExpression?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pageBody = page[0].slice(page[0].indexOf('>') + 1);
    const repeatsInVisibleText = escapedHeaderExpression != null && (
      new RegExp(`<TextView\\b[^>]*>\\s*\\{\\s*${escapedHeaderExpression}\\s*\\}`).test(pageBody) ||
      new RegExp(`<(?:Button|ListItem|Chip|Tag)\\b[^>]*\\b(?:title|subtitle|text)=\\{\\s*${escapedHeaderExpression}\\s*\\}`).test(pageBody)
    );
    if (repeatsInVisibleText) {
      report(file, page.index, text, 'Page header identity is repeated as body content; keep the title in the Page header unless the body adds a distinct purpose');
    }
  }

  for (const match of text.matchAll(/<ToastContainer\b/g)) {
    report(file, match.index, text, 'App already owns the Toast presenter; do not mount a second ToastContainer');
  }

  for (const match of text.matchAll(/\bsetTimeout\s*\([\s\S]*?,\s*\d+(?:\.\d+)?\s*\)/g)) {
    report(file, match.index, text, 'raw UI timing delay must use event-driven state or a semantic motion token, not a literal timeout');
  }

  for (const match of text.matchAll(/@meta\/wearables-ui-toolkit-icons\/svg\/[^'"\s]*(?:__outline|gesture)[^'"\s]*\.svg/g)) {
    report(file, match.index, text, 'application icons must use semantically appropriate filled assets; outline and gesture assets are not allowed');
  }
  for (const match of text.matchAll(/from\s+['"]@meta\/wearables-ui-toolkit-icons['"]/g)) {
    report(file, match.index, text, 'import filled icons from explicit SVG subpaths; the aggregate icons barrel can retain unrelated outline assets');
  }
  for (const match of text.matchAll(/import\s+(?!type\b)\{([^}]+)\}\s+from\s+['"]@meta\/wearables-ui-toolkit-mrbd\/([A-Z][A-Za-z0-9]*)['"]/g)) {
    const componentName = match[2];
    const runtimeImports = match[1]
      .split(',')
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('type '))
      .map(value => value.split(/\s+as\s+/)[0].trim());
    if (runtimeImports.some(name => name !== componentName && /(?:Style|Color|Mode|Position|Corner|State|Alignment|Size)$/.test(name))) {
      report(file, match.index, text, 'import the toolkit runtime constants and enums from the package root; component subpaths may expose declarations that their JavaScript module does not export');
    }
  }

  for (const match of text.matchAll(/https?:\/\/(?:picsum\.photos|source\.unsplash\.com)\b/g)) {
    report(file, match.index, text, 'random/seeded placeholder imagery cannot represent semantically specific product content; use a stable relevant asset or omit the image');
  }

  for (const button of text.matchAll(/<Button\b(?=[^>]*\btitle=['"]More['"])[^>]*>/g)) {
    const icon = button[0].match(/\bicon=\{([^}]+)\}/)?.[1] ?? '';
    if (!/ellipsis/i.test(icon)) {
      report(file, button.index, text, 'a More/overflow action must use a filled ellipsis icon rather than an unrelated command icon');
    }
  }

  const repeatedStateActions = new Map();
  for (const button of text.matchAll(/<Button\b[\s\S]*?\/>/g)) {
    const title = button[0].match(/\btitle=['"]([^'"]+)['"]/)?.[1] ?? '';
    const dynamicTitle = getJsxExpression(button[0], 'title');
    const subtitleExpression = getJsxExpression(button[0], 'subtitle');
    const literalSubtitle = button[0].match(/\bsubtitle=['"]([^'"]+)['"]/)?.[1] ?? '';
    const directActionExpression = getJsxExpression(button[0], 'onClick');
    const namedHandler = directActionExpression.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    const resolvedActionExpression = namedHandler == null
      ? directActionExpression
      : getNamedHandlerBody(text, namedHandler);
    inspectActionExpression(
      file,
      text,
      button.index,
      'Button',
      title,
      resolvedActionExpression,
    );
    const normalizedStateAction = resolvedActionExpression.replace(/\s+/g, '');
    if (/\bset[A-Z][A-Za-z0-9_$]*\s*\(/.test(resolvedActionExpression)) {
      if (repeatedStateActions.has(normalizedStateAction)) {
        report(file, button.index, text, 'Button duplicates another local state action; expose one accurately labeled control for the product outcome');
      } else {
        repeatedStateActions.set(normalizedStateAction, button.index);
      }
    }
    if (/\bsetShow[A-Z][A-Za-z0-9_$]*\s*\(/.test(resolvedActionExpression) && dynamicTitle && !/\b(?:Show|Hide)\b/.test(dynamicTitle)) {
      report(file, button.index, text, 'Button toggles a disclosure but its title names content rather than the Show/Hide action');
    }
    if (/(?:\?\?|:)\s*['"]No\s/i.test(subtitleExpression) && /\bonClick=/.test(button[0]) && !/\bdisabled\b/.test(button[0])) {
      report(file, button.index, text, 'Button remains enabled when its optional disclosure content is absent; omit or disable the unavailable action');
    }
    const hasRecordDescription = /\.[Dd]escription\b/.test(subtitleExpression);
    if (hasRecordDescription) {
      report(file, button.index, text, 'Button subtitle contains a record description; keep command copy concise and move peer records to a dedicated VerticalList route');
    }
    if ((hasRecordDescription || literalSubtitle.length > 56) && !/\benforceMaxWidth\b/.test(button[0])) {
      report(file, button.index, text, 'Button has variable or long text without enforceMaxWidth and can expand beyond the viewport');
    }
    if (/^`Next:\s*\$\{/i.test(dynamicTitle.trim())) {
      report(file, button.index, text, 'Button implements generic Next-record navigation on a detail route; use a real pager/carousel for sequential browsing or rely on Back to the collection');
    }
    if (/^Copy\s+(?:highlight|summary|details?)$/i.test(title)) {
      report(file, button.index, text, 'Button invents a clipboard action for supporting copy; keep it only when copying that content is a genuine product task, not a focus sentinel');
    }
    if (/^(?:Clear|Delete|Remove)\s+(?:all|plan|list|saved|history)$/i.test(title) && !/\b(?:confirm|requestConfirmation|openConfirm|navigate)\w*\s*\(/i.test(resolvedActionExpression)) {
      report(file, button.index, text, 'bulk destructive Button executes without explicit confirmation; separate the command and confirm its named scope before mutation');
    }
    for (const [setter, state] of localLabelOnlyStates) {
      if (new RegExp(`\\b${setter}\\s*\\(`).test(resolvedActionExpression)) {
        report(file, button.index, text, `Button toggles ${state}, but that local state only relabels the control; implement the named product outcome instead of a focus sentinel`);
      }
    }
    if (/\btitle=['"](?:Browse|View)\s+\w+s['"]/i.test(button[0]) && /\bnavigate\s*\(\s*`[^`]*\$\{/.test(button[0])) {
      report(file, button.index, text, 'Button promises a collection but routes to one generated record detail; open the collection or name the specific destination');
    }
    if (/\btitle=\{[^}]*['"]Join waitlist['"][^}]*\}/i.test(button[0]) && !/\b(?:join|add|request|open|navigate)[A-Za-z0-9_$]*Waitlist[A-Za-z0-9_$]*\s*\(/i.test(resolvedActionExpression)) {
      report(file, button.index, text, 'Button can display Join waitlist but its handler does not implement a waitlist operation');
    }
    if (/^Back(?:\b|\s+to\b)/i.test(title)) {
      report(file, button.index, text, 'do not render an application Back button; use router history and the system Back path');
    }
    if (/^(?:Close|Done|Collected|Return\b|Continue browsing)/i.test(title) && /\bnavigate\s*\(\s*['"]\/[\w/-]*['"]\s*\)/.test(button[0])) {
      report(file, button.index, text, 'route-level return navigation substitutes for the system Back path; remove the in-app navigation button');
    }
    if (
      /^(?:Home|Main menu|Browse all|View all|Return to|Continue browsing)\b/i.test(title) &&
      /\bnavigate\s*\(\s*['"]\/['"]\s*\)/.test(resolvedActionExpression)
    ) {
      report(file, button.index, text, 'Button uses a named root-navigation handler as an in-app route-return control; remove it and rely on the system Back path');
    }
    if (
      /^(?:Home|Main menu|View|Open|Browse)\b/i.test(title) &&
      /\bnavigate\s*\(\s*['"]\/['"]\s*\)/.test(button[0])
    ) {
      report(file, button.index, text, 'button navigates to the application root as a route-return control; remove it and rely on the system Back path');
    }
    if (/\bnavigate\s*\(\s*-1\s*\)/.test(button[0])) {
      report(file, button.index, text, 'application button invokes history Back; remove it and rely on the system Back path');
    }
    if (namedHandler != null && routeReturnHandlerNames.has(namedHandler)) {
      report(file, button.index, text, 'Button invokes a named handler that returns to the application root; remove the in-app route-return control and rely on system Back');
    }
    if (/\btitle=\{[^}]*['"](?:Completed|Done)['"][^}]*\}/.test(button[0]) && /\bonClick=/.test(button[0]) && !/\bdisabled\b/.test(button[0])) {
      report(file, button.index, text, 'completed/done state is rendered as an enabled action; omit or disable the control when the command is no longer available');
    }
    if (/^(?:Completed|Done|Collected|Saved|Favorited|Observed|Reserved)$/i.test(title) && /\bonClick=/.test(button[0]) && !/\bdisabled\b/.test(button[0])) {
      report(file, button.index, text, 'current state is rendered as an enabled Button; disable/omit it or label the next available command');
    }
    if (/\btitle=\{[^}]*['"][^'"]*\b(?:visible|noted|logged|copied)['"][^}]*\}/i.test(button[0]) && /\bonClick=/.test(button[0]) && !/\bdisabled\b/.test(button[0])) {
      report(file, button.index, text, 'enabled Button uses a state phrase as its title; label the next command with an accurate verb such as Show/Hide or Add/Remove');
    }
    if (/\btitle=\{[^}]*['"](?:Saved|Favorited|Observed|Reserved)['"][^}]*\}/i.test(button[0]) && /\bonClick=/.test(button[0]) && !/\bdisabled\b/.test(button[0])) {
      report(file, button.index, text, 'enabled Button is titled with its current Saved/Favorited/Observed/Reserved state; label the reversible command it will perform next');
    }
    const nounAction = title.match(/^(?:Add|Log)\s+([A-Za-z]+)/i)?.[1];
    if (nounAction != null && namedHandler != null) {
      const escapedHandler = namedHandler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const handlerBody = text.match(new RegExp(`(?:const\\s+${escapedHandler}\\s*=\\s*\\([^)]*\\)\\s*=>|function\\s+${escapedHandler}\\s*\\([^)]*\\))\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))?.[1] ?? '';
      if (handlerBody && !new RegExp(`[A-Za-z_$][\\w$]*${nounAction}[A-Za-z0-9_$]*\\s*\\(`, 'i').test(handlerBody)) {
        report(file, button.index, text, `${title} action does not invoke a ${nounAction} capability; its named handler performs an unrelated outcome`);
      }
    }
    if (/\bonClick=\{[\s\S]*?Toast\.show\s*\(/.test(button[0]) && !/\b(?:navigate|set[A-Z]|dispatch|update|toggle|open|reserve|cancel|mark)[A-Za-z]*\s*\(/.test(button[0])) {
      report(file, button.index, text, 'Button uses Toast as its only outcome; Toast is feedback, not the action itself');
    }
    if (
      /\bonClick=\{[\s\S]*?\bset(?:Notice|Message|Feedback|ResultText|StatusText)\s*\(/.test(button[0]) &&
      !/\b(?:navigate|dispatch|update|toggle|open|reserve|cancel|mark|checkout|return)[A-Za-z]*\s*\(/i.test(button[0])
    ) {
      report(file, button.index, text, 'Button only changes transient notice/feedback copy; implement the command named by the action and use feedback only to confirm it');
    }
    if (/\btitle=(?:['"]Copy\b|\{[^}]*['"]Copy\b)/i.test(button[0]) && !/\b(?:navigator\.clipboard|writeText|copy[A-Z][A-Za-z0-9_$]*)\s*(?:\.|\()/.test(resolvedActionExpression)) {
      report(file, button.index, text, 'Copy action does not invoke a clipboard/copy capability; local confirmation state is not the named outcome');
    }
    if (/\btitle=\{[^}]*`[^`]*\b(?:PIN|code|password)\b[^`]*\$\{[^`]+`[^}]*\}/i.test(button[0]) && /\bsubtitle=\{[^}]*['"]Hidden['"][^}]*\}/i.test(button[0])) {
      report(file, button.index, text, 'Button displays a secret value while labeling it Hidden; concealed state must omit or mask visible and accessible secret content');
    }
    if (
      /\btitle=(?:['"](?:Log|Message|Contact|Call|Send|Notify|Scan)\b|\{[^}]*['"](?:Log|Message|Contact|Call|Send|Notify|Scan)\b)/i.test(button[0]) &&
      /\b(?:Toast\.show|set[A-Z][A-Za-z0-9_$]*)\s*\(/.test(button[0]) &&
      !/\b(?:dispatch|navigate|update|add|save|send|log)[A-Z][A-Za-z0-9_$]*\s*\(/.test(button[0])
    ) {
      report(file, button.index, text, 'action only toggles local feedback instead of performing the Log/Message/Contact/Call/Send/Notify/Scan capability named by its title');
    }
  }

  for (const label of text.matchAll(/<TextView\b([^>]*)>\s*([A-Z][A-Z\s/&-]{1,30})\s*<\/TextView>/g)) {
    const usesSecondary =
      /\btextColor=['"]secondary['"]/.test(label[1]) ||
      /\btextColor=\{TextColor\.SECONDARY\}/.test(label[1]);
    if (usesSecondary && !/\btextStyle=/.test(label[1])) {
      report(file, label.index, text, 'secondary all-caps eyebrow/category/field label needs an explicit semantic TextStyle');
    }
    if (
      /\btextStyle=\{TextStyle\.LABEL(?:_EMPHASIZED)?\}/.test(label[1]) &&
      !usesSecondary
    ) {
      report(file, label.index, text, 'all-caps eyebrow/category/field label must use the public textColor={TextColor.SECONDARY} prop');
    }
  }
  for (const label of text.matchAll(/<TextView\b[^>]*>\s*([^<{\n][^<{\n]*·[^<{\n]*·[^<{\n]*)\s*<\/TextView>/g)) {
    report(file, label.index, text, 'TextView serializes more than two compact fact groups; keep the essential pair and move remaining detail to another content role');
  }
  for (const label of text.matchAll(/<TextView\b[^>]*>([\s\S]*?)<\/TextView>/g)) {
    if (/\{/.test(label[1]) && (label[1].match(/(?:·|\\u00B7|\\xB7|&#183;)/g) ?? []).length > 1) {
      report(file, label.index, text, 'TextView combines more than two compact fact groups across JSX expressions; split the hierarchy into semantic text roles');
    }
    const repeatedTime = label[1].match(/\bformat[A-Za-z0-9_$]*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:At|Date|Time))\s*\)[\s\S]*?\bformat[A-Za-z0-9_$]*\(\s*\1\s*\)/i);
    if (repeatedTime != null) {
      report(file, label.index, text, `TextView renders relative and absolute forms of ${repeatedTime[1]} together; choose one time representation`);
    }
  }

  for (const wrapper of text.matchAll(/<div\b([^>]*)>((?:(?!<div\b)[\s\S])*?)<\/div>/g)) {
    const textViews = wrapper[2].match(/<TextView\b/g) ?? [];
    if (
      textViews.length >= 2 &&
      !/\bclassName=|\bdisplay\s*:|\bgap\s*:/.test(wrapper[1])
    ) {
      report(file, wrapper.index, text, 'adjacent TextViews have no explicit block/column layout and token gap; default inline text will concatenate');
    }
  }

  for (const item of text.matchAll(/<ListItem\b[\s\S]*?\/>/g)) {
    if (/\baria-selected=/.test(item[0])) {
      report(file, item.index, text, 'ListItem selection must use the integrated visible radio treatment with controlled checked state, not aria-selected on an ordinary row');
    }
    if (/\bonClick=/.test(item[0]) && /\bonCheckedChange=/.test(item[0])) {
      report(file, item.index, text, 'integrated switch/radio ListItem must have one state-change path; do not wire both onClick and onCheckedChange');
    }
    if (!/\bon[A-Z][A-Za-z]+\s*=|\b(?:href|to)\s*=/.test(item[0])) {
      report(file, item.index, text, 'ListItem has no row-level action or controlled-value callback and would create a misleading static focus stop');
    }
    const templateTitle = item[0].match(/\btitle=\{(`[^`]*`)\}/)?.[1];
    const titleSource = item[0].match(/\btitle=(?:\{([\s\S]*?)\}|['"]([^'"]*)['"])/);
    const authoredTitle = templateTitle ?? titleSource?.[1] ?? titleSource?.[2] ?? '';
    if (/\.[Dd]escription\b/.test(authoredTitle)) {
      report(file, item.index, text, 'ListItem title is bound to a generic description field; model a concise identity label and move variants/quantity/detail to supporting content');
    }
    if (/[·—]/.test(authoredTitle)) {
      report(file, item.index, text, 'ListItem title combines identity with a peer fact; keep one identity noun phrase and move the complementary fact to subtitle');
    }
    const simpleTitleExpression = titleSource?.[1]?.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    const subtitleExpressionSource = item[0].match(/\bsubtitle=\{([^}]*)\}/)?.[1] ?? '';
    if (
      simpleTitleExpression != null &&
      new RegExp(`(?:\\?|:)\\s*${simpleTitleExpression}\\s*$`).test(subtitleExpressionSource.trim())
    ) {
      report(file, item.index, text, 'ListItem subtitle conditionally repeats its title; omit redundant supporting copy and let the title/selected state carry the choice');
    }
    if (/\bonClick=\{[\s\S]*?Toast\.show\s*\(/.test(item[0]) && !/\b(?:navigate|set[A-Z]|dispatch|update|toggle|open)[A-Za-z]*\s*\(/.test(item[0])) {
      report(file, item.index, text, 'ListItem uses Toast as its only outcome; Toast is feedback, not a row action or destination');
    }
    const leadingIcon = item[0].match(/(?:^|\s)icon=\{([^}]+)\}/)?.[1]?.trim();
    const accessoryIcon = item[0].match(/\baccessoryIcon=\{([^}]+)\}/)?.[1]?.trim() ?? '';
    const rowAction = getJsxExpression(item[0], 'onClick');
    if (/play/i.test(accessoryIcon) && /\bnavigate\s*\(/.test(rowAction)) {
      report(file, item.index, text, 'ListItem shows a Play accessory but only navigates to detail; omit the inactive action glyph or make the row perform the promised action');
    }
    const secondaryIcon = item[0].match(/\bsecondaryIcon=\{([^}]+)\}/)?.[1]?.trim();
    if (leadingIcon && secondaryIcon && leadingIcon === secondaryIcon) {
      report(file, item.index, text, 'ListItem repeats the same icon in leading and secondary slots; each visible slot must communicate a distinct fact');
    }
    const statusIcons = item[0].match(/\bstatusIndicatorIcons=\{([\s\S]*?)\}(?=\s*[A-Za-z][\w-]*=|\s*\/>)/)?.[1] ?? '';
    if (leadingIcon) {
      const leadingIdentifiers = new Set(leadingIcon.match(/[A-Za-z_$][\w$]*/g) ?? []);
      if ((statusIcons.match(/[A-Za-z_$][\w$]*/g) ?? []).some(identifier => leadingIdentifiers.has(identifier))) {
        report(file, item.index, text, 'ListItem repeats a leading icon in its status-indicator slots; each visible slot must communicate a distinct fact');
      }
    }
    const trailingModes = [
      /\btimestamp=/.test(item[0]) ? 'timestamp' : '',
      /\baccessoryIcon=/.test(item[0]) ? 'accessory icon' : '',
      /\bshowSwitch\b/.test(item[0]) ? 'switch' : '',
      /\bshowRadioButton\b/.test(item[0]) ? 'radio' : '',
      /\b(?:statusIndicator|statusIndicatorIcons)=/.test(item[0]) ? 'status' : '',
      /\btrailingTag=/.test(item[0]) ? 'trailing tag' : '',
    ].filter(Boolean);
    if (trailingModes.length > 1) {
      report(file, item.index, text, `ListItem combines competing trailing treatments (${trailingModes.join(', ')}); choose one primary treatment so row content remains readable`);
    }
    const subtitleSource = item[0].match(/\bsubtitle=[\s\S]*?(?=\n\s*[A-Za-z][\w-]*=|\s*\/>)/)?.[0] ?? '';
    const subtitleCandidates = [...subtitleSource.matchAll(/(['"`])([\s\S]*?)\1/g)].map(match => match[2]);
    if (subtitleCandidates.some(candidate => (candidate.match(/·/g) ?? []).length > 1)) {
      report(file, item.index, text, 'ListItem subtitle serializes more than two fact groups; keep one essential fact pair and move remaining detail to the destination route');
    }
    const timestampSource = item[0].match(/\btimestamp=(?:\{([^}]+)\}|['"]([^'"]+)['"])/);
    let timestamp = timestampSource?.[1] ?? timestampSource?.[2] ?? '';
    const timestampMember = timestampSource?.[1]?.trim().match(/^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/)?.[1];
    if (timestampMember != null) {
      const memberBinding = text.match(new RegExp(`(?:const|let)\\s+${timestampMember}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\([^;]+;`));
      const memberHelper = memberBinding?.[1];
      if (memberHelper != null) {
        const helperStart = text.search(new RegExp(`function\\s+${memberHelper}\\b`));
        if (helperStart >= 0) {
          const followingFunction = text
            .slice(helperStart + 1)
            .search(/\n(?:export\s+)?function\s+[A-Za-z_$][\w$]*\b/);
          const helperEnd = followingFunction < 0
            ? text.length
            : helperStart + 1 + followingFunction;
          timestamp += text.slice(helperStart, helperEnd);
        }
      }
    }
    if (/^[A-Za-z_$][\w$]*$/.test(timestamp)) {
      const escapedName = timestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const binding = text.match(new RegExp(`(?:const|let)\\s+${escapedName}\\s*=([\\s\\S]*?);`));
      timestamp += binding?.[1] ?? '';
    }
    const timestampHelper = timestampSource?.[1]?.trim().match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    if (timestampHelper != null) {
      const escapedName = timestampHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      timestamp += text.match(new RegExp(`function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    }
    const timestampOutput = timestamp.includes('?') ? timestamp.slice(timestamp.indexOf('?') + 1) : timestamp;
    if (/\b(?:availability|available|reserved|hold|location|room|category|status|priority|severity|occupancy|count|duration|length|price|unit|upcoming|specialty|neighborhood|venue|skipped|completed|arrived|delayed|at stop|up next|open|caution|closed)\b|\$|formatPrice|estimatedMinutes|durationMinutes|(?:return)?DueLabel/i.test(timestampOutput)) {
      report(file, item.index, text, 'ListItem timestamp is reserved for a concise point in time; put location/status/category/duration metadata in the subtitle or detail route');
    }
    if (
      /\bonClick=\{\s*\(\)\s*=>\s*\{\s*if\s*\([^)]*\)\s*(?:\{\s*)?navigate\s*\(/.test(item[0]) &&
      !/\belse\b/.test(item[0])
    ) {
      report(file, item.index, text, 'ListItem remains focusable while its inline handler can have no outcome; disable/remove the row action or provide a result for every visible state');
    }
    if (timestamp && item[0].match(/\bsubtitle=\{([\s\S]*?)\}\s*(?:\n|\s)+[A-Za-z][\w-]*=/)?.[1]?.includes(timestamp)) {
      report(file, item.index, text, 'ListItem subtitle repeats the same expression supplied to timestamp; render the time only in the timestamp slot');
    }
    const subtitleExpression = item[0].match(/\bsubtitle=\{([^}]+)\}/)?.[1]?.trim() ?? '';
    let resolvedSubtitle = subtitleExpression;
    if (/^[A-Za-z_$][\w$]*$/.test(subtitleExpression)) {
      const escapedName = subtitleExpression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      resolvedSubtitle += text.match(new RegExp(`(?:const|let)\\s+${escapedName}\\s*=([\\s\\S]*?);`))?.[1] ?? '';
    }
    const subtitleHelper = subtitleExpression.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    if (subtitleHelper != null) {
      const escapedName = subtitleHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      resolvedSubtitle += text.match(new RegExp(`function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    }
    const timestampReferences = new Set(timestamp.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g) ?? []);
    const subtitleReferences = new Set(resolvedSubtitle.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g) ?? []);
    if ([...timestampReferences].some(reference => subtitleReferences.has(reference))) {
      report(file, item.index, text, 'ListItem subtitle repeats the same value supplied to timestamp through local bindings; render that time only in the timestamp slot');
    }
    if (timestampSource && (/(?:·|•|\\u00B7|\\u2022|\\xB7|&#183;|&#8226;)/.test(resolvedSubtitle) || /(?:·|•|\\u00B7|\\u2022|\\xB7|&#183;|&#8226;)/.test(subtitleSource))) {
      report(file, item.index, text, 'ListItem with a trailing timestamp must keep its subtitle to one concise complementary fact, not a delimiter-separated fact pair');
    }
    if (/\?\s*['"](?:Reserved|Full|Completed|Closed|Unavailable)['"]\s*:/.test(resolvedSubtitle)) {
      report(file, item.index, text, 'ListItem replaces its complementary subtitle with transient status; preserve identity/context and use a supported status treatment');
    }
    const subtitleValue = item[0].match(/\bsubtitle=\{\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\}/);
    const subtitleColor = item[0].match(/\bsubtitleTextColor=\{([\s\S]*?)\}(?=\s*[A-Za-z][\w-]*=|\s*\/>)/);
    let resolvedSubtitleColor = subtitleColor?.[1] ?? '';
    if (/^[A-Za-z_$][\w$]*$/.test(resolvedSubtitleColor.trim())) {
      const colorName = resolvedSubtitleColor.trim();
      resolvedSubtitleColor += text.match(new RegExp(`(?:const|let)\\s+${colorName}\\s*=([\\s\\S]*?);`))?.[1] ?? '';
    }
    if (
      subtitleValue &&
      resolvedSubtitleColor.includes(`${subtitleValue[1]}.`) &&
      /\.(?:available|availability|status|severity|priority|health)\b/i.test(resolvedSubtitleColor) &&
      !/(?:available|availability|status|severity|priority|health)/i.test(subtitleValue[2])
    ) {
      report(file, item.index, text, 'ListItem applies status color to an unrelated subtitle field; render the status itself instead of using color as an unlabeled code');
    }
    if (/\bkey=\{[^}]+\}/.test(item[0]) && /\bnavigate\s*\(\s*(['"`])\/[\w/-]*\1\s*\)/.test(item[0])) {
      report(file, item.index, text, 'generated record row navigates every item to one fixed route; route using the row record identity');
    }
    if (/\bnavigate\s*\(\s*['"]\/['"]\s*\)/.test(item[0])) {
      report(file, item.index, text, 'ListItem navigates to the application root as a return/peer-navigation control; use system Back or update the owning pager state with an accurately labeled action');
    }
    if (/\b(?:window\.)?history\.back\s*\(/.test(item[0])) {
      report(file, item.index, text, 'ListItem implements in-app Back navigation; remove it and rely on the system Back path');
    }
    if (/\btitle=['"][^'"]*\bempty\b[^'"]*['"]/i.test(item[0]) && /\bnavigate\s*\(\s*['"]\/[\w/-]+['"]\s*\)/.test(item[0])) {
      report(file, item.index, text, 'empty-state ListItem routes to one fixed record; present the recovery command after the empty-state content and open the promised collection');
    }
  }

  for (const derived of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.find\s*\(/g)) {
    const derivedName = derived[1];
    const collectionName = derived[2];
    if (
      new RegExp(`\\{${collectionName}\\.map\\s*\\(`).test(text) &&
      new RegExp(`\\{${derivedName}\\s*&&[\\s\\S]*?<ListItem\\b`).test(text)
    ) {
      report(file, derived.index, text, `derived ${derivedName} record is appended as another ListItem after mapping ${collectionName}; do not duplicate one record as a callout row`);
    }
  }

  const containerTagSource = text.replace(/=>/g, '==');
  for (const containerTag of containerTagSource.matchAll(/<Container\b[^>]*\/?>/g)) {
    if (/\b(?:title|subtitle|text|icon)=/.test(containerTag[0])) {
      report(file, containerTag.index, text, 'Container has no title/subtitle/text/icon convenience props; supply semantic children or use ListItem/Button for standard anatomy');
    }
    if (
      /\bnavigate\s*\(\s*['"]\/['"]\s*\)/.test(containerTag[0]) &&
      /\b(?:title|aria-label)=['"](?:Home|Main menu|View|Open|Browse|Contact|Call|Message)\b/i.test(containerTag[0])
    ) {
      report(file, containerTag.index, text, 'Container label and root-route handler do not form a valid product action; rely on system Back for route return and make action labels match their outcomes');
    }
  }
  for (const container of containerTagSource.matchAll(/<Container\b([^>]*)>([\s\S]*?)<\/Container>/g)) {
    if (!/\b(?:on[A-Z][A-Za-z]+|href|to)\s*=/.test(container[1])) {
      report(file, container.index, text, 'non-interactive Container should use StaticContainer or an appropriate semantic static surface');
    }
    const namedHandler = container[1].match(/\bonClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
    if (
      (namedHandler != null && routeReturnHandlerNames.has(namedHandler)) ||
      /\b(?:Back to|Go to overview|Return to)\b/i.test(container[2])
    ) {
      report(file, container.index, text, 'Container is used as an in-app route-return control; remove it and rely on the system Back path');
    }
    const handlerName = container[1].match(/\bonClick=\{([A-Za-z_$][\w$]*)\b/)?.[1];
    if (handlerName != null && !/\bdisabled(?:=|\b)/.test(container[1])) {
      const escapedName = handlerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const handler = text.match(new RegExp(`function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
      if (/if\s*\([^)]*\)\s*(?:\{\s*)?return\s*;/.test(handler?.[1] ?? '')) {
        report(file, container.index, text, 'Container remains focusable while its handler can return with no outcome; expose disabled state or remove the target');
      }
    }
    const directActionExpression = getJsxExpression(container[1], 'onClick');
    const actionHandlerName = directActionExpression.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    const resolvedActionExpression = actionHandlerName == null
      ? directActionExpression
      : getNamedHandlerBody(text, actionHandlerName);
    const ariaLabel = container[1].match(/\baria-label=['"]([^'"]+)['"]/)?.[1];
    const staticLabels = [...container[2].matchAll(/>\s*([^<>{}\n][^<>{}]*)\s*</g)]
      .map(match => match[1].trim())
      .filter(Boolean);
    const actionLabel = ariaLabel ?? staticLabels.at(-1) ?? container[2];
    inspectActionExpression(
      file,
      text,
      container.index,
      'Container',
      actionLabel,
      resolvedActionExpression,
    );
  }

  if (/<VerticalMenu\b/.test(text)) {
    if (!/\.stopPropagation\s*\(\s*\)/.test(text)) {
      report(file, text.indexOf('<VerticalMenu'), text, 'VerticalMenu item activation must stop portal click propagation before closing so the trigger cannot reopen it');
    }
    const restoresThroughTriggerHandle =
      /(?:Button|Container)Handle/.test(text) &&
      /getElement\(\)\?\.focus\s*\(/.test(text);
    const restoresThroughListItemElement =
      /Map\s*<\s*string\s*,\s*HTMLDivElement\s*>/.test(text) &&
      /\.current\.get\s*\([^)]*\)\?\.focus\s*\(/.test(text);
    if (!restoresThroughTriggerHandle && !restoresThroughListItemElement) {
      report(file, text.indexOf('<VerticalMenu'), text, 'anchored VerticalMenu must explicitly restore focus through the public trigger handle after dismissal');
    }
    for (const dismiss of text.matchAll(/onDismissRequest=\{\(\)\s*=>\s*set\w*(?:Open|Visible)\(false\)\}/g)) {
      report(file, dismiss.index, text, 'Back/Escape dismissal closes the menu without arming trigger-focus restoration');
    }
    for (const menu of text.matchAll(/<VerticalMenu\b[\s\S]*?<\/VerticalMenu>/g)) {
      const items = [...menu[0].matchAll(/<VerticalMenuButton\b/g)];
      if (items.length > 3) {
        report(file, menu.index, text, 'VerticalMenu has more than three actions; use concise priority actions and move the remainder to a route so the popup fits the display');
      }
      for (const label of menu[0].matchAll(/\btext=['"]([^'"]+)['"]/g)) {
        if (label[1].length > 18) {
          report(file, menu.index + label.index, text, 'VerticalMenu label is too long for its fixed-width action row; use a concise command');
        }
      }
    }
  }

  for (const rail of text.matchAll(/<ButtonRail\b[\s\S]*?<\/ButtonRail>/g)) {
    const conditionalButtons = rail[0].match(/(?:&&|\?)\s*\(?\s*<Button\b/g) ?? [];
    if (
      conditionalButtons.length > 0 &&
      !/(?:ButtonHandle|getElement\(\)\?\.focus\s*\()/.test(text)
    ) {
      report(file, rail.index, text, 'ButtonRail conditionally adds/removes actions without focus handoff; keep the activated Button stable or explicitly focus its intended successor before replacement');
    }
    const handlerOwners = new Map();
    const shieldedRail = rail[0].replace(/=>/g, '==');
    for (const button of shieldedRail.matchAll(/<Button\b[^>]*\/?>/g)) {
      const handler = button[0].match(/\bonClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
      if (handler == null) continue;
      if (handlerOwners.has(handler)) {
        const between = shieldedRail.slice(handlerOwners.get(handler), button.index);
        if (!/\)\s*:\s*\(/.test(between)) {
          report(file, rail.index + button.index, text, `ButtonRail exposes multiple peer actions with the same ${handler} handler and outcome`);
        }
      } else {
        handlerOwners.set(handler, button.index);
      }
    }
    const more = rail[0].match(/<Button\b(?=[^>]*\btitle=['"]More(?: options)?['"])[\s\S]*?\/>/);
    if (!more) continue;
    const afterMore = rail[0].slice(rail[0].indexOf(more[0]) + more[0].length);
    const isLastAction = !/<Button\b/.test(afterMore);
    if (isLastAction && !/VerticalMenuCorner\.ABOVE_RIGHT/.test(rail[0])) {
      report(file, rail.index + rail[0].indexOf(more[0]), text, 'right-edge More trigger in a bottom ButtonRail must use ABOVE_RIGHT so the popup grows upward and toward screen interior');
    }
  }

  if (/<ContextMenu\b/.test(text) && (!/(?:Button|Container)Handle/.test(text) || !/getElement\(\)\?\.focus\s*\(/.test(text))) {
    report(file, text.indexOf('<ContextMenu'), text, 'anchored ContextMenu must explicitly restore focus through the public trigger handle after dismissal');
  }

  for (const surface of text.matchAll(/<(Container|StaticContainer|Surface|Panel)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const componentName = surface[1];
    const content = surface[2];
    const openingTag = surface[0].slice(0, surface[0].indexOf('>') + 1);
    const compactContent = content
      .replace(/<\/?(?:div|span|section)\b[^>]*>/g, '')
      .trim()
      .match(/^<TextView\b[^>]*>\s*([^<{\n]{1,32})\s*<\/TextView>$/);
    if (compactContent != null) {
      const forcesFullWidth = /\bwidth=['"]100%['"]/.test(openingTag) || /\bstyle=\{\{[^}]*(?:width|inlineSize)\s*:\s*['"]100%['"]/.test(openingTag);
      if (forcesFullWidth) {
        report(file, surface.index, text, `${componentName} stretches one short label into a full-width rounded material and imitates a compact toolkit component; use an intrinsic semantic component or ordinary text`);
      }
      const className = openingTag.match(/\bclassName=['"]([^'"]+)['"]/)?.[1]?.split(/\s+/)[0];
      if (className != null) {
        fauxCompactSurfaces.push({ file, offset: surface.index, text, className, componentName });
      }
    }
    for (const padding of content.matchAll(/padding(?:[A-Z]\w*)?\s*:\s*['"]var\(\s*--uit-spacing-([^)]+)\s*\)['"]/g)) {
      if (padding[1].trim() !== 'large') {
        report(file, surface.index + surface[0].indexOf(padding[0]), text, `authored ${componentName} text/content inset must use --uit-spacing-large`);
      }
    }
    const needsInset = componentName === 'Panel' || /<TextView\b|<(?:p|h[1-6]|span)\b/.test(content);
    if (/<TextView\b[^>]*\btextStyle=\{TextStyle\.(?:BODY1(?:_EMPHASIZED)?|DISPLAY\w*|HEADING\w*|NUMERAL\w*)\}/.test(content)) {
      report(file, surface.index, text, `${componentName} uses text larger than the routine BODY2 ceiling; use BODY2/BODY2_EMPHASIZED/label/metadata hierarchy unless a specific exceptional need is verified on-device`);
    }
    if (!needsInset) continue;
    const contentWrapper = content.match(/^\s*<(?:div|section|article)\b[^>]*\bclassName=['"]([^'"]+)['"]/);
    if (contentWrapper) {
      surfaceContentWrappers.push({
        className: contentWrapper[1].split(/\s+/)[0],
        componentName,
        file,
        offset: surface.index + surface[0].indexOf(contentWrapper[0]),
        text,
      });
    } else if (
      /^\s*<(?:div|section|article)\b[^>]*\bstyle=\{\{[^}]*\bpadding\s*:\s*['"]var\(\s*--uit-spacing-large\s*\)['"][^}]*\}\}/.test(content)
    ) {
      // A single inline semantic wrapper can express the required token inset
      // without an otherwise unnecessary application class.
    } else {
      report(file, surface.index, text, `${componentName} non-full-bleed content needs one semantic wrapper inset on every edge with --uit-spacing-large`);
    }
  }

  const panels = [...text.matchAll(/<Panel\b/g)];
  for (let index = 1; index < panels.length; index += 1) {
    const betweenPanels = text.slice(
      panels[index - 1].index + panels[index - 1][0].length,
      panels[index].index,
    );
    if (
      !/\breturn\s*\(/.test(betweenPanels) &&
      !/\b(?:export\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(betweenPanels)
    ) {
      report(file, panels[index].index, text, 'repeated Panels simulate item/field rows; use one coherent informational backdrop, ListItem, or Container as appropriate');
      break;
    }
  }
  for (const panel of text.matchAll(/<Panel\b[^>]*\bonClick=/g)) {
    report(file, panel.index, text, 'Panel is an informational backdrop, not a generic interactive item; use Container or a semantic interactive component');
  }
  for (const panel of text.matchAll(/<Panel\b[^>]*>([\s\S]*?)<\/Panel>/g)) {
    const staticContainers = (panel[1].match(/<StaticContainer\b/g) ?? []).length;
    if (staticContainers > 1 || (staticContainers === 1 && /\.map\s*\(/.test(panel[1]))) {
      report(file, panel.index, text, 'Panel contains repeated StaticContainer text tiles that simulate Tags/Chips; use the semantic metadata component or plain layout');
    }
    const containers = (panel[1].match(/<Container\b/g) ?? []).length;
    if (containers > 1 || (containers === 1 && /\.map\s*\(/.test(panel[1]))) {
      report(file, panel.index, text, 'Panel contains repeated Container tiles; keep informational layout plain inside the Panel and place distinct interactive destinations outside it');
    }
    if (/<(?:Button|Container|Card|ListItem)\b/.test(panel[1])) {
      report(file, panel.index, text, 'Panel contains an interactive child; keep a static Panel informational, or make the whole Panel the single interaction target without focusable descendants');
    }
    const visibleValues = new Map();
    for (const value of panel[1].matchAll(/\{\s*([a-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\}/g)) {
      if (visibleValues.has(value[1])) {
        report(file, panel.index + value.index, text, `Panel repeats ${value[1]} in multiple visible representations; render each fact once`);
      } else {
        visibleValues.set(value[1], value.index);
      }
    }
  }


  for (const wrapper of text.matchAll(/<(div|section|nav|aside|span)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const directButtons = [...wrapper[2].matchAll(/<Button\b/g)].length;
    if (directButtons > 1 && !/<(?:ButtonRail|ButtonGroup)\b/.test(wrapper[2])) {
      report(file, wrapper.index, text, 'horizontal/peer Button actions must use ButtonRail or ButtonGroup rather than an authored wrapper');
    }
    if (directButtons <= 1 && /\.map\s*\(/.test(wrapper[2]) && /<Button\b/.test(wrapper[2]) && !/<(?:ButtonRail|ButtonGroup)\b/.test(wrapper[2])) {
      report(file, wrapper.index, text, 'generated peer Button actions must use ButtonRail or ButtonGroup rather than an authored wrapper');
    }
  }

  for (const divider of text.matchAll(/<div\b[^>]*\bclassName=['"]([^'"]*(?:row|item)[^'"]*)['"][^>]*>[\s\S]*?<\/div>\s*<Divider\b[^>]*\/?>\s*<div\b[^>]*\bclassName=['"]\1['"]/g)) {
    report(file, divider.index, text, 'Divider separates repeated peer fields/items; use it only between logical content sections');
  }

  const routeItems = [...text.matchAll(/<ListItem\b[\s\S]*?\/>/g)];
  for (const item of routeItems) {
    const title = item[0].match(/\btitle=['"]([^'"]+)['"]/)?.[1] ?? '';
    const action = getJsxExpression(item[0], 'onClick');
    const subtitle = (
      item[0].match(/\bsubtitle=['"]([^'"]+)['"]/)?.[1] ??
      getJsxExpression(item[0], 'subtitle')
    );
    if (
      /\b(?:overview|summary|directory|view all|browse all|all items)\b/i.test(title) &&
      /\bnavigate\s*\([\s\S]*(?:\[\s*0\s*\]|\.at\(\s*0\s*\))/i.test(action)
    ) {
      report(file, item.index, text, 'generic aggregate ListItem opens the first collection record; provide the promised aggregate destination or name the actual record');
    }
    if (/^(?:All fresh|Up to date|Nothing (?:due|pending)|No (?:matching )?(?:alerts|items|results))$/i.test(title) && action) {
      report(file, item.index, text, 'empty/status ListItem uses status copy as an action label; render a separately named recovery or navigation command');
    }
    if (/^(?:Clear|Delete|Remove|Reset)\s+(?:all\b|the\b|pantry\b|list\b|acquired\b)/i.test(title) && action && !/<(?:Modal|ContextMenu)\b|\bconfirm\s*\(/.test(text)) {
      report(file, item.index, text, 'bulk destructive ListItem executes without an explicit confirmation surface naming the affected scope');
    }
    if (/\b(?:remove|delete)\s+(?:the\s+)?first\b|\bquick remove\b/i.test(`${title} ${subtitle}`)) {
      report(file, item.index, text, 'ListItem exposes a synthetic first-record removal command; operate on a specifically identified item instead');
    }
    if (
      /\bshowSwitch\b/.test(item[0]) &&
      /(?:^|['"])(?:On|Off)\s*(?:·|$)/.test(subtitle)
    ) {
      report(file, item.index, text, 'integrated switch subtitle repeats On/Off state already conveyed by the switch; describe its effect or scope instead');
    }
    const subtitleColor = (
      item[0].match(/\bsubtitleTextColor=['"]([^'"]+)['"]/)?.[1] ??
      getJsxExpression(item[0], 'subtitleTextColor')
    );
    if (
      /\b(?:warning|negative|positive|status|days|due|overdue|health|needsAttention)\b/i.test(subtitleColor) &&
      !/\b(?:warning|error|healthy|health|attention|due|overdue|expired|expiry|alert|available|unavailable)\b/i.test(subtitle)
    ) {
      report(file, item.index, text, 'ListItem applies semantic status color to unrelated supporting text; render the status itself and keep quantities, identity, location, and category facts neutral');
    }
  }

  for (const control of text.matchAll(/<(?:Button|ListItem)\b[\s\S]*?\/>/g)) {
    const label = control[0].match(/\b(?:title|ariaLabel)=['"]([^'"]+)['"]/)?.[1] ?? '';
    const icon = control[0].match(/\bicon=\{([A-Za-z_$][\w$]*)\}/)?.[1] ?? '';
    if (/bell/i.test(icon) && !/\b(?:alert|notification|reminder|bell)\b/i.test(label)) {
      report(file, control.index, text, 'bell icon is used for an unrelated command; choose an icon that directly represents the visible action');
    }
    if (/camera/i.test(icon) && !/\b(?:camera|photo|capture|scan)\b/i.test(label)) {
      report(file, control.index, text, 'camera icon is used for an unrelated command; choose an icon that directly represents the visible action');
    }
  }
  for (const mapping of text.matchAll(/\{\s*label:\s*['"]([^'"]+)['"]\s*,\s*icon:\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    const [, label, icon] = mapping;
    if (/bell/i.test(icon) && !/\b(?:alert|notification|reminder|bell)\b/i.test(label)) {
      report(file, mapping.index, text, 'pager/navigation item uses a bell icon for a non-alert destination');
    }
    if (/camera/i.test(icon) && !/\b(?:camera|photo|capture|scan)\b/i.test(label)) {
      report(file, mapping.index, text, 'pager/navigation item uses a camera icon for a non-capture destination');
    }
  }
  const mapStarts = [...text.matchAll(/\b[A-Za-z_$][\w$]*\.map\s*\(/g)];
  const generatedCollections = mapStarts.map((match, index) => ({
    index: match.index,
    source: text.slice(match.index, mapStarts[index + 1]?.index ?? text.length),
  }));
  const generatedRadioCollection = generatedCollections.find(collection =>
    /<ListItem\b[\s\S]*?\bshowRadioButton\b[\s\S]*?\/>/.test(collection.source),
  );
  const generatedRecordCollection = generatedCollections.find(collection =>
    /<ListItem\b[\s\S]*?\bnavigate\s*\(/.test(collection.source),
  );
  if (
    generatedRadioCollection != null &&
    generatedRecordCollection != null &&
    generatedRadioCollection.index < generatedRecordCollection.index
  ) {
    report(file, generatedRadioCollection.index, text, 'generated persistent radio/filter rows displace the primary record collection; use one concise popup, a dedicated filter route, or peer subnavigation');
  }
  if (
    /\b[A-Za-z_$][\w$]*filter[\w$]*\.map\s*\(/i.test(text) &&
    /\bshowRadioButton\b/.test(text) &&
    /\b[A-Za-z_$][\w$]*\.map\s*\([^)]*=>\s*\([\s\S]*?<ListItem\b[\s\S]*?\bnavigate\s*\(/.test(text)
  ) {
    report(file, text.search(/\b[A-Za-z_$][\w$]*filter[\w$]*\.map\s*\(/i), text, 'generated persistent filter rows displace the primary record collection; use a concise popup, dedicated filter route, or peer subnavigation');
  }
  const literalRouteItem = routeItems.find(item => /onClick=\{\(\)\s*=>\s*navigate\(['"]\/[\w/-]*['"]\)\}/.test(item[0]));
  const recordRouteItem = routeItems.find(item => /onClick=\{\(\)\s*=>\s*navigate\(`[^`]*\$\{[^}]+\}[^`]*`\)\}/.test(item[0]));
  if (
    literalRouteItem &&
    recordRouteItem &&
    literalRouteItem.index < recordRouteItem.index &&
    !/\breturn\s*\(/.test(text.slice(literalRouteItem.index, recordRouteItem.index))
  ) {
    report(file, literalRouteItem.index, text, 'secondary navigation/settings rows precede the route primary record collection; put the primary task first and secondary destinations after it');
  }

  for (const match of text.matchAll(/(?:D-pad|primary task|use the \w+ row|use system back|open (?:a|an|any|the) (?:item|row|control)|open (?:a|an|any|the) [a-z][\w-]* for (?:details|more)|tap (?:a|an|the|for|to)|press (?:to|the)|focus (?:an?|the) (?:item|row|control)|the toolkit (?:controls?|rows?|components?|materials?)|focus moves|focusable and scrollable|pager handles|rail scrolls|additive display|Back (?:closes|returns|takes|goes)|(?:preserv|restor)(?:e|es|ing) (?:your )?(?:place|focus|scroll))/gi)) {
    report(file, match.index, text, 'implementation or design-system guidance appears in product UI source');
  }

  for (const owner of text.matchAll(/<(ScrollView|VerticalList)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const openingTag = owner[0].slice(0, owner[0].indexOf('>') + 1);
    if (
      owner[1] === 'ScrollView' &&
      /\btabIndex=\{0\}/.test(openingTag) &&
      !/\bariaLabel=/.test(openingTag)
    ) {
      report(file, owner.index, text, 'focusable ScrollView needs a concise ariaLabel; otherwise its complete text content becomes the accessible name');
    }
    if (/\bstyle=\{\{[^}]*\b(?:marginInline|marginLeft|marginRight|paddingInline|paddingLeft|paddingRight)\s*:/.test(openingTag)) {
      report(file, owner.index, text, `${owner[1]} component frame must extend fully to both screen edges; inset child content rather than the scroll owner`);
    }
    const action = owner[2].match(/<(?:ButtonRail|ButtonGroup)\b/);
    if (action?.index != null) {
      report(
        file,
        owner.index + owner[0].indexOf(action[0]),
        text,
        'page ButtonRail/ButtonGroup must be outside the vertical owner in a bottom action dock; the content scroller ends above it',
      );
    }
    if (owner[1] === 'ScrollView') {
      const content = owner[2];
      const wrapper = content.match(/^\s*<(?:div|section|article)\b([^>]*)>/);
      const hasDirectFullBleedComponent = /^\s*<(?:Panel|Carousel|Card|StaticContainer|Container|Surface)\b/.test(content);
      if (wrapper == null && !hasDirectFullBleedComponent) {
        report(file, owner.index, text, 'ScrollView authored content needs one wrapper inset inline with --uit-spacing-large; keep only the viewport itself edge-to-edge');
      } else if (wrapper != null) {
        const inlineStyle = wrapper[1];
        const hasInlineInset = /padding\s*:\s*['"]var\(\s*--uit-spacing-large\s*\)['"]/.test(inlineStyle) || /paddingInline\s*:\s*['"]var\(\s*--uit-spacing-large\s*\)['"]/.test(inlineStyle);
        const className = inlineStyle.match(/\bclassName=['"]([^'"]+)['"]/)?.[1]?.split(/\s+/)[0];
        if (!hasInlineInset && className == null) {
          report(file, owner.index, text, 'ScrollView content wrapper must inset visible content from both display edges with --uit-spacing-large');
        } else if (!hasInlineInset && className != null) {
          scrollContentWrappers.push({
            file,
            offset: owner.index,
            text,
            className,
            containsPanel: /<Panel\b/.test(content),
          });
        }
        if (hasInlineInset && /<Panel\b/.test(content)) {
          report(file, owner.index + content.indexOf('<Panel'), text, 'page-level Panel is inside route horizontal padding; let the Panel backdrop reach both screen edges and inset its children internally');
        }
      }
      const firstFocusTarget = content.search(/<(?:Button|Container|Card)\b/);
      const firstSubject = content.search(/<(?:Panel|StaticContainer|TextView|h[1-6]|p)\b/);
      if (firstFocusTarget >= 0 && firstSubject >= 0 && firstFocusTarget < firstSubject && /^\s*<Button\b/.test(content.slice(firstFocusTarget))) {
        report(file, owner.index + firstFocusTarget, text, 'Button appears before the content it acts on; place contextual actions below their subject content');
      }
      const descriptionPosition = content.search(/\{\s*[A-Za-z_$][\w$]*\.description\s*\}/);
      if (descriptionPosition >= 0) {
        for (const actionButton of content.matchAll(/<Button\b[\s\S]*?\/>/g)) {
          if (actionButton.index > descriptionPosition) break;
          if (/\btitle=\{[^}]*['"](?:Save|Remove)['"]/.test(actionButton[0]) || /\btitle=['"](?:Save|Remove)['"]/.test(actionButton[0])) {
            report(file, owner.index + actionButton.index, text, 'record-level Save/Remove Button appears before the record description; place the action below the content it affects');
            break;
          }
        }
      }
      const hasGenericNextItem = /<Button\b(?=[^>]*\btitle=['"]Next (?:item|record)['"])[^>]*\/>/i.test(owner[2]);
      const hasGenericPreviousItem = /<Button\b(?=[^>]*\btitle=['"]Previous (?:item|record)['"])[^>]*\/>/i.test(owner[2]);
      if (hasGenericNextItem && hasGenericPreviousItem) {
        report(file, owner.index, text, 'ScrollView brackets static detail with generic Next/Previous item controls; do not add peer-navigation focus sentinels—use a real pager/carousel flow or rely on Back to the collection');
      }
      const ownerHandlers = new Map();
      const ownerDestinations = new Map();
      const shieldedOwner = owner[2].replace(/=>/g, '==');
      const dynamicViewDestinations = [...owner[2].matchAll(/<Button\b[^>]*\btitle=\{`View\s+\$\{[^}]+\}`\}[^>]*\bonClick=\{\(\)\s*=>\s*navigate\(`\/([^/`$]+)\/\$\{/g)];
      if (dynamicViewDestinations.length > 1) {
        report(file, owner.index + dynamicViewDestinations[1].index, text, 'ScrollView inserts repeated View-peer navigation Buttons as focus sentinels; keep only destinations that are genuinely relevant to the detail content');
      }
      for (const button of shieldedOwner.matchAll(/<Button\b[^>]*\/?>/g)) {
        const handler = button[0].match(/\bonClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
        if (handler != null) {
          if (ownerHandlers.has(handler)) {
            report(file, owner.index + button.index, text, `ScrollView duplicates the same ${handler} action as multiple focus stops; keep one control at its logical content location`);
          } else {
            ownerHandlers.set(handler, button.index);
          }
        }
        const action = getJsxExpression(button[0], 'onClick');
        const destination = action.match(/\bnavigate\s*\(\s*['"]([^'"]+)['"]\s*\)/)?.[1];
        if (destination != null) {
          if (ownerDestinations.has(destination)) {
            report(file, owner.index + button.index, text, `ScrollView repeats navigation to ${destination} as multiple focus stops; keep one contextually placed destination`);
          } else {
            ownerDestinations.set(destination, button.index);
          }
        }
      }
      const targets = [...owner[2].matchAll(/<(?:Button|Container|Card)\b/g)];
      if (
        targets.length === 0 &&
        (owner[2].match(/<TextView\b/g) ?? []).length >= 4 &&
        !/\btabIndex=\{0\}/.test(openingTag)
      ) {
        report(file, owner.index, text, 'substantial static ScrollView content needs tabIndex={0} so the scroll owner receives D-pad input; otherwise condense or split the route—never add a focus-sentinel control');
      }
    }
  }

  const pageAction = text.match(/<(?:ButtonRail|ButtonGroup)\b/);
  if (pageAction?.index != null && /<(?:ButtonRail|ButtonGroup)\b[\s\S]*(?:aria-selected|role=['"]tab['"]|set(?:Active|Current|Selected)(?:Tab|Page|Section))/i.test(text)) {
    report(file, pageAction.index, text, 'ButtonRail/ButtonGroup cannot implement peer-content navigation; use SubNavigationPager');
  }

  for (const pager of text.matchAll(/<SubNavigationPager\b(?![^>]*\bsubNavigationDisabled(?:=\{true\})?)[^>]*>([\s\S]*?)<\/SubNavigationPager>/g)) {
    const contents = pager[1];
    for (const child of contents.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g)) {
      pagerChildComponents.push({ componentName: child[1], ownerFile: file, ownerText: text, ownerOffset: pager.index + child.index });
    }
    for (const owner of contents.matchAll(/<(VerticalList|ScrollView)\b([^>]*)>/g)) {
      if (!/\binsetForHeader\b/.test(owner[2])) {
        report(
          file,
          pager.index + pager[0].indexOf(owner[0]),
          text,
          `${owner[1]} inside SubNavigationPager must set insetForHeader so content clears the overlaid tabs`,
        );
      }
    }
  }

  for (const itemArray of text.matchAll(/const\s+[A-Za-z_$][\w$]*\s*=\s*\[([\s\S]*?)\]\s*;/g)) {
    if (!/\blabel\s*:/.test(itemArray[1])) continue;
    for (const label of itemArray[1].matchAll(/\blabel\s*:\s*['"]([^'"]+)['"]/g)) {
      if (wordCount(label[1]) > 1) {
        report(file, itemArray.index + label.index, text, 'SubNavigation tab title exceeds one word; use one concise word for each tab');
      }
    }
  }

  const tagPattern = /<(\/)?(ScrollView|VerticalList|ListItem)\b[^>]*(\/?)>/g;
  const scrollStack = [];
  for (const match of text.matchAll(tagPattern)) {
    const closing = Boolean(match[1]);
    const tag = match[2];
    const selfClosing = Boolean(match[3]);
    if (closing) {
      if (tag !== 'ListItem') scrollStack.pop();
      continue;
    }
    if (tag === 'ListItem' && !scrollStack.some(item => item === 'VerticalList')) {
      report(file, match.index, text, 'ListItem has no same-file VerticalList owner');
    }
    if (tag !== 'ListItem') {
      if (scrollStack.length > 0) {
        report(file, match.index, text, `${tag} is nested inside same-axis ${scrollStack.at(-1)}`);
      }
      if (!selfClosing) scrollStack.push(tag);
    }
  }

  if (
    /<ScrollView\b/.test(text) &&
    /<ListItem\b/.test(text) &&
    !/<SubNavigationPager\b/.test(text)
  ) {
    report(file, text.indexOf('<ScrollView'), text, 'route mixes ScrollView and ListItem; choose one legal route skeleton');
  }

  for (const list of text.matchAll(/<VerticalList\b[\s\S]*?<\/VerticalList>/g)) {
    const firstItem = list[0].indexOf('<ListItem');
    if (firstItem < 0) continue;
    if (/<TextView\b/.test(list[0].slice(0, firstItem))) {
      report(file, list.index, text, 'VerticalList prepends an authored text/count/category header before its first row; use Page/SubNavigation context and keep one uninterrupted row collection');
    }
    const arbitraryHeader = list[0].match(/<(?:Header|ContainerHeader)\b/);
    if (arbitraryHeader?.index != null) {
      report(file, list.index + arbitraryHeader.index, text, 'Header is page-only and ContainerHeader belongs inside a larger Container-owned region; neither is a VerticalList section label');
    }
    const panel = list[0].match(/<Panel\b/);
    if (panel?.index != null) {
      report(file, list.index + panel.index, text, 'Panel cannot be used as a list row or section backdrop inside VerticalList');
    }
    const radioRows = (list[0].match(/<ListItem\b[\s\S]*?\bshowRadioButton\b[\s\S]*?\/>/g) ?? []).length;
    if (radioRows >= 3 && /\bnavigate\s*\(/.test(list[0])) {
      report(file, list.index, text, 'three or more persistent filter rows displace the primary record collection; use a concise popup, dedicated filter route, or peer subnavigation');
    }
    if (/\b[A-Za-z_$][\w$]*filter[\w$]*\.map\s*\(/i.test(list[0]) && /\bshowRadioButton\b/.test(list[0]) && /\bnavigate\s*\(/.test(list[0])) {
      report(file, list.index, text, 'generated persistent filter rows displace the primary record collection; use a concise popup, dedicated filter route, or peer subnavigation');
    }
    for (const item of list[0].matchAll(/<ListItem\b[\s\S]*?\/>/g)) {
      const title = item[0].match(/\btitle=['"]([^'"]+)['"]/)?.[1] ?? '';
      if (/^(?:No|Nothing|Empty)\b/i.test(title) && /\bonClick=/.test(item[0])) {
        report(file, list.index + item.index, text, 'empty-state status is used as a focusable ListItem action label; render truthful status copy and label any recovery control with its command');
      }
    }
    const lastItem = list[0].lastIndexOf('<ListItem');
    const trailingContent = lastItem >= 0 ? list[0].slice(lastItem) : '';
    for (const trailingText of trailingContent.matchAll(/<div\b[\s\S]*?<TextView\b/g)) {
      const beforeText = trailingContent.slice(Math.max(0, trailingText.index - 180), trailingText.index);
      if (!/(?:length|size)\s*===?\s*0\s*&&\s*\(?\s*$/.test(beforeText)) {
        report(file, list.index + lastItem + trailingText.index, text, 'VerticalList appends static explanatory/footer content after its rows; keep the row flow adjacent and move concise context to Page metadata');
        break;
      }
    }
  }

  // Arrow functions in JSX attributes contain `>`, which is not the end of
  // the opening tag. Preserve string length while shielding those arrows from
  // the lightweight tag scanner so self-closing controls do not become false
  // ancestors of their following siblings.
  const tagSource = text.replace(/=>/g, '==');
  const allTags = /<(\/)?([A-Za-z][\w.]*)\b[^>]*?(\/?)>/g;
  const elementStack = [];
  const nonNestableMaterialHosts = new Set([
    'Container',
    'StaticContainer',
    'Button',
    'Surface',
    'Chip',
    'Tag',
    'Header',
  ]);
  for (const match of tagSource.matchAll(allTags)) {
    const closing = Boolean(match[1]);
    const tag = match[2];
    const selfClosing = Boolean(match[3]);
    if (closing) {
      const index = elementStack.map(item => item.tag).lastIndexOf(tag);
      if (index >= 0) elementStack.splice(index);
      continue;
    }
    if (tag === 'Carousel') {
      let ownerIndex = -1;
      for (let index = elementStack.length - 1; index >= 0; index -= 1) {
        if (elementStack[index].tag === 'ScrollView' || elementStack[index].tag === 'VerticalList') {
          ownerIndex = index;
          break;
        }
      }
      const wrappers = ownerIndex >= 0 ? elementStack.slice(ownerIndex + 1) : [];
      if (wrappers.length > 0) {
        report(file, match.index, text, 'Carousel must be a direct child of the route vertical owner so its viewport remains edge-to-edge');
      }
    }
    if (tag === 'ButtonRail' || tag === 'ButtonGroup') {
      const owner = elementStack.find(item => item.tag === 'ScrollView' || item.tag === 'VerticalList');
      if (owner != null) {
        report(file, match.index, text, `${tag} must be outside the route vertical owner in the bottom action dock`);
      }
    }
    if (
      tag === 'Modal' &&
      elementStack.some(item => item.tag === 'Page') &&
      !elementStack.some(item => item.tag === 'ScrollView' || item.tag === 'VerticalList' || item.tag === 'Carousel')
    ) {
      report(file, match.index, text, 'Modal is Panel-based content, not a dialog portal; do not append it outside the Page vertical owner as a conditional popup—use a dedicated route or supported host presenter');
    }
    if (tag === 'ContainerHeader' && !elementStack.some(item => item.tag === 'Container')) {
      report(file, match.index, text, 'ContainerHeader must identify content inside a Container-owned region; do not render it in Panel or ordinary layout');
    }
    if (nonNestableMaterialHosts.has(tag)) {
      const parent = [...elementStack].reverse().find(item => nonNestableMaterialHosts.has(item.tag));
      if (parent != null) {
        report(file, match.index, text, `${tag} is nested inside ${parent.tag}; StaticContainer, Container, Button, Surface, Chip, Tag, and Header must not contain one another`);
      }
    }
    if (!selfClosing) elementStack.push({ tag, offset: match.index });
  }
}

function getNamedComponentSource(text, componentName) {
  const declaration = new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+${componentName}\\b|(?:export\\s+)?const\\s+${componentName}\\b`);
  const match = declaration.exec(text);
  if (match == null) return null;

  const nextDeclaration = /\n(?:export\s+)?(?:default\s+)?function\s+[A-Z][A-Za-z0-9]*\b|\n(?:export\s+)?const\s+[A-Z][A-Za-z0-9]*\b/g;
  nextDeclaration.lastIndex = match.index + match[0].length;
  const next = nextDeclaration.exec(text);
  return {
    offset: match.index,
    source: text.slice(match.index, next?.index ?? text.length),
  };
}

function inspectPagerChildRoots() {
  for (const child of pagerChildComponents) {
    const declaration = new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+${child.componentName}\\b|(?:export\\s+)?const\\s+${child.componentName}\\b`);
    const implementation = inspectedFiles.find(({ file, text }) =>
      /\.(?:tsx|jsx)$/.test(file) && declaration.test(text),
    );
    const component = implementation == null
      ? null
      : getNamedComponentSource(implementation.text, child.componentName);
    if (implementation && component && /<Page\b/.test(component.source)) {
      report(
        implementation.file,
        component.offset + component.source.indexOf('<Page'),
        implementation.text,
        `SubNavigationPager child ${child.componentName} renders Page; the pager replaces Page and each child must begin with its one VerticalList or ScrollView`,
      );
    }
    if (implementation && component) {
      for (const branch of component.source.matchAll(/if\s*\([^)]*\)\s*\{\s*return\s*\(\s*<(VerticalList|ScrollView)\b([^>]*)>([\s\S]*?)<\/\1>\s*\);?\s*\}/g)) {
        const focusableOwner = branch[1] === 'ScrollView' && /\btabIndex=\{0\}/.test(branch[2]);
        if (!focusableOwner && !/<(?:ListItem|Button|Container|Card)\b/.test(branch[3])) {
          report(
            implementation.file,
            component.offset + branch.index,
            implementation.text,
            `SubNavigationPager child ${child.componentName} has a conditional page state with no meaningful focus target; every enabled empty/loading/error state needs a real handoff destination or recovery action`,
          );
        }
      }
      const owner = component.source.match(/<(?:VerticalList|ScrollView)\b/);
      if (owner?.index == null) {
        report(
          implementation.file,
          component.offset,
          implementation.text,
          `SubNavigationPager child ${child.componentName} has no VerticalList or ScrollView; every enabled pager page needs one toolkit vertical owner for focus handoff and bounded content`,
        );
      } else {
        const openingTagEnd = component.source.indexOf('>', owner.index);
        const openingTag = component.source.slice(owner.index, openingTagEnd + 1);
        if (!/\binsetForHeader\b/.test(openingTag)) {
          report(
            implementation.file,
            component.offset + owner.index,
            implementation.text,
            `SubNavigationPager child ${child.componentName} must set insetForHeader on its ${owner[0].slice(1)} so content clears the overlaid tabs`,
          );
        }
        const returnIndex = component.source.lastIndexOf('return', owner.index);
        const prefix = component.source.slice(Math.max(0, returnIndex), owner.index);
        const openingTags = [...prefix.matchAll(/<(?:[a-z][\w-]*|[A-Z][A-Za-z0-9]*)\b/g)];
        if (openingTags.length > 1) {
          report(
            implementation.file,
            component.offset + returnIndex + openingTags[1].index,
            implementation.text,
            `SubNavigationPager child ${child.componentName} places authored header/summary content outside its vertical owner; put all page content inside the insetForHeader owner and reserve an outer shell only for a bottom action dock`,
          );
        }
      }
    }
  }
}

function inspectDistantFocusComponents() {
  for (const ownerFile of inspectedFiles.filter(({ file }) => /\.(?:tsx|jsx)$/.test(file))) {
    for (const owner of ownerFile.text.matchAll(/<ScrollView\b[^>]*>([\s\S]*?)<\/ScrollView>/g)) {
      const targets = [...owner[1].matchAll(/<(?:Button|Container|Card)\b/g)];
      for (let index = 1; index < targets.length; index += 1) {
        const between = owner[1].slice(targets[index - 1].index, targets[index].index);
        for (const child of between.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g)) {
          const declaration = new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+${child[1]}\\b|(?:export\\s+)?const\\s+${child[1]}\\b`);
          const implementation = inspectedFiles.find(candidate =>
            /\.(?:tsx|jsx)$/.test(candidate.file) && declaration.test(candidate.text),
          );
          if (implementation && (implementation.text.match(/<TextView\b/g) ?? []).length >= 10) {
            report(
              ownerFile.file,
              owner.index + targets[index - 1].index,
              ownerFile.text,
              `ScrollView places long static ${child[1]} content between distant focus targets; directional navigation can jump over it`,
            );
          }
        }
      }
    }
  }
}

function inspectApplicationMount() {
  const source = inspectedFiles
    .filter(({ file }) => /\.(?:tsx|jsx)$/.test(file))
    .map(({ text }) => text)
    .join('\n');
  if (!/\bcreateRoot\s*\(/.test(source) || !/\.render\s*\(/.test(source)) {
    const candidate = inspectedFiles.find(({ file }) => /(?:^|\/)main\.(?:tsx|jsx)$/.test(file)) ?? inspectedFiles[0];
    report(candidate.file, 0, candidate.text, 'application defines components but never mounts them with createRoot(...).render(...), producing a blank WebView');
  }
}

function inspectRouterIntegration() {
  const routerFile = inspectedFiles.find(({ text }) => /<BrowserRouter\b/.test(text));
  if (routerFile == null) return;
  const source = inspectedFiles
    .filter(({ file }) => /\.(?:tsx|jsx)$/.test(file))
    .map(({ text }) => text)
    .join('\n');
  if (!/<ReactRouterNavigationProvider\b/.test(source)) {
    report(routerFile.file, routerFile.text.indexOf('<BrowserRouter'), routerFile.text, 'BrowserRouter application must include ReactRouterNavigationProvider so the host Back path and focus navigation use the toolkit infrastructure');
  }
  if (!/<ReactRouterPageTransition\b/.test(source)) {
    report(routerFile.file, routerFile.text.indexOf('<BrowserRouter'), routerFile.text, 'BrowserRouter application must render Routes through ReactRouterPageTransition so route Back restores focus and scroll state');
  }
}

function inspectRoutedPagerPersistence() {
  const source = inspectedFiles
    .filter(({ file }) => /\.(?:tsx|jsx)$/.test(file))
    .map(({ text }) => text)
    .join('\n');
  if (!/<BrowserRouter\b/.test(source) || (source.match(/<Route\b/g) ?? []).length < 2) return;
  for (const candidate of inspectedFiles) {
    if (!/\.(?:tsx|jsx)$/.test(candidate.file)) continue;
    const shielded = candidate.text.replace(/=>/g, '==');
    for (const pager of shielded.matchAll(/<SubNavigationPager\b[^>]*>/g)) {
      if (!/\bcurrentPageIndex=/.test(pager[0]) || !/\bonPageChange=/.test(pager[0])) {
        report(
          candidate.file,
          pager.index,
          candidate.text,
          'routed SubNavigationPager must use currentPageIndex and onPageChange with state that survives route unmount so Back restores the originating tab',
        );
      }
      const controlledName = pager[0].match(/\bcurrentPageIndex=\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1];
      if (controlledName != null) {
        const escapedName = controlledName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`const\\s*\\[\\s*${escapedName}\\s*,[^\\]]+\\]\\s*=\\s*useState`).test(candidate.text)) {
          report(
            candidate.file,
            pager.index,
            candidate.text,
            'routed SubNavigationPager index is owned by route-local useState and resets when the pager unmounts; keep it in retained application/navigation state',
          );
        }
      }
    }
  }
}

function inspectDuplicatePageActions() {
  for (const source of inspectedFiles) {
    if (!/\.(?:tsx|jsx)$/.test(source.file)) continue;
    const owners = new Map();
    const shielded = source.text.replace(/=>/g, '==');
    for (const control of shielded.matchAll(/<(Button|Container)\b[^>]*?(?:\/?>)/g)) {
      const handler = control[0].match(/\bonClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
      if (handler == null) continue;
      if (owners.has(handler)) {
        report(source.file, control.index, source.text, `${control[1]} duplicates the ${handler} operation as another focus stop on the same route`);
      } else {
        owners.set(handler, control.index);
      }
    }

    const blankRange = (value, start, length) =>
      `${value.slice(0, start)}${' '.repeat(length)}${value.slice(start + length)}`;
    let outsideActionRegions = source.text;
    const actionRegions = [...source.text.matchAll(/<(ButtonRail|ButtonGroup)\b[\s\S]*?<\/\1>/g)];
    for (const region of actionRegions.slice().reverse()) {
      outsideActionRegions = blankRange(outsideActionRegions, region.index, region[0].length);
    }
    const contentButtons = [...outsideActionRegions.matchAll(/<Button\b[\s\S]*?\/>/g)];
    for (const region of actionRegions) {
      const dockButtons = [...region[0].matchAll(/<Button\b[\s\S]*?\/>/g)];
      for (const dockButton of dockButtons) {
        const dockTitle = (
          dockButton[0].match(/\btitle=['"]([^'"]+)['"]/)?.[1] ??
          getJsxExpression(dockButton[0], 'title')
        ).replace(/\s+/g, ' ').trim();
        const dockAction = getJsxExpression(dockButton[0], 'onClick');
        const dockMutators = new Set(
          [...dockAction.matchAll(/\b((?:set|toggle|update|save|share|track|open|close|remove|add)[A-Z][A-Za-z0-9_$]*)\s*\(/g)]
            .map((match) => match[1]),
        );
        for (const contentButton of contentButtons) {
          const contentTitle = (
            contentButton[0].match(/\btitle=['"]([^'"]+)['"]/)?.[1] ??
            getJsxExpression(contentButton[0], 'title')
          ).replace(/\s+/g, ' ').trim();
          const contentAction = getJsxExpression(contentButton[0], 'onClick');
          const contentMutators = new Set(
            [...contentAction.matchAll(/\b((?:set|toggle|update|save|share|track|open|close|remove|add)[A-Z][A-Za-z0-9_$]*)\s*\(/g)]
              .map((match) => match[1]),
          );
          const sharedMutator = [...dockMutators].find((name) => contentMutators.has(name));
          if ((dockTitle && dockTitle === contentTitle) || sharedMutator != null) {
            report(
              source.file,
              contentButton.index,
              source.text,
              `ScrollView/content Button duplicates a page command from the bottom ${region[1]}; keep the command only in its docked action region`,
            );
            break;
          }
        }
      }
    }
  }
}

function inspectTimestampDataContracts() {
  const timestampProperties = new Set();
  for (const source of inspectedFiles) {
    if (!/\.(?:tsx|jsx)$/.test(source.file)) continue;
    for (const usage of source.text.matchAll(/\btimestamp=\{\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\}/g)) {
      timestampProperties.add(usage[1]);
    }
  }

  for (const property of timestampProperties) {
    const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const valuePattern = new RegExp(`\\b${escapedProperty}\\s*:\\s*(['"])([^'"]+)\\1`, 'g');
    let reportedVerboseSchedule = false;
    for (const source of inspectedFiles) {
      if (/(?:^|\/)(?:store|state)(?:\/|$)|Context\.[jt]sx?$/.test(source.file)) {
        continue;
      }
      for (const value of source.text.matchAll(valuePattern)) {
        if (/^(?:active|available|closed|collected|completed|delayed|delivered|full|in transit|open|out for delivery|reserved|unavailable)$/i.test(value[2].trim())) {
          report(
            source.file,
            value.index,
            source.text,
            `${property} feeds a ListItem timestamp but contains status-only value “${value[2]}”; use a real point in time or omit the timestamp for that state`,
          );
          continue;
        }
        if (/\s·\s/.test(value[2]) && !reportedVerboseSchedule) {
          report(
            source.file,
            value.index,
            source.text,
            `${property} feeds a ListItem timestamp with an overlong combined schedule “${value[2]}”; use one concise date or time and move the full schedule to detail`,
          );
          reportedVerboseSchedule = true;
        }
      }
    }
  }
}

function inspectHeaderMetadataContracts() {
  const metadataProperties = new Set();
  const metadataHelpers = new Set();
  for (const source of inspectedFiles) {
    if (!/\.(?:tsx|jsx)$/.test(source.file)) continue;
    for (const usage of source.text.matchAll(/\bheaderMetadata=\{\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\}/g)) {
      metadataProperties.add(usage[1]);
    }
    for (const usage of source.text.matchAll(/\bheaderMetadata=\{\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      metadataHelpers.add(usage[1]);
    }
  }
  for (const source of inspectedFiles) {
    for (const property of metadataProperties) {
      if (/^(?:stall|duration|difficulty|servings?|count|identifier|id|track|category|room|timeMinutes)$/i.test(property)) {
        report(source.file, 0, source.text, `Page header metadata uses routine ${property} data; omit optional metadata unless it materially affects understanding or the next action`);
        metadataProperties.delete(property);
      }
    }
    for (const helper of metadataHelpers) {
      if (/^(?:format)?(?:Minutes|Duration|Count|Price|Floor)$/i.test(helper)) {
        report(source.file, 0, source.text, `Page header metadata uses routine ${helper} output; move the fact into body content unless it materially affects the next action`);
        metadataHelpers.delete(helper);
      }
    }
  }
}

function inspectUnusedContentContracts() {
  const definesDescription = inspectedFiles.some(({ text }) => /\bdescription\s*:\s*['"]|\bdescription\s*:\s*\n\s*['"]/.test(text));
  const rendersDescription = inspectedFiles.some(({ file, text }) => /\.(?:tsx|jsx)$/.test(file) && /\.[Dd]escription\b/.test(text));
  if (definesDescription && !rendersDescription) {
    const source = inspectedFiles.find(({ text }) => /\bdescription\s*:/.test(text));
    report(source?.file ?? sourceRoot, 0, source?.text ?? '', 'domain descriptions are defined but never rendered; include required descriptive content instead of substituting unrelated focus actions');
  }
}

function inspectAuthoredScrims() {
  for (const style of inspectedFiles.filter(({ file }) => file.endsWith('.css'))) {
    for (const rule of style.text.matchAll(/\.([A-Za-z_-][\w-]*scrim[\w-]*)\s*\{([^}]*)\}/gi)) {
      if (/\b(?:background|mask|filter|backdrop-filter)\s*:/.test(rule[2])) continue;
      const className = rule[1];
      const usedOverMedia = inspectedFiles.some(({ file, text }) =>
        /\.(?:tsx|jsx)$/.test(file) &&
        new RegExp(`className=['"]${className}['"][\\s\\S]*?<TextView\\b`).test(text) &&
        /<(?:img|picture|video)\b/.test(text),
      );
      if (usedOverMedia) {
        report(style.file, rule.index, style.text, `${className} is named as a scrim but paints no gradient/material beneath media-overlay text`);
      }
    }
  }
}

function inspectToastOnlyActions() {
  const toastOnlyNames = new Set();
  for (const { text } of inspectedFiles) {
    for (const callback of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useCallback\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*,\s*\[[^\]]*\]\s*,?\s*\)/g)) {
      const body = callback[2];
      if (
        /\bToast\.show\s*\(/.test(body) &&
        !/\b(?:set[A-Z][A-Za-z0-9_$]*|navigate|dispatch|update[A-Z][A-Za-z0-9_$]*|open[A-Z][A-Za-z0-9_$]*)\s*\(/.test(body)
      ) {
        toastOnlyNames.add(callback[1]);
      }
    }
  }
  if (toastOnlyNames.size === 0) return;
  for (const source of inspectedFiles) {
    if (!/\.(?:tsx|jsx)$/.test(source.file)) continue;
    const shielded = source.text.replace(/=>/g, '==');
    for (const control of shielded.matchAll(/<(Button|ListItem|Container)\b[^>]*\/?>/g)) {
      if (!/\bonClick=/.test(control[0])) continue;
      const toastOnlyName = [...toastOnlyNames].find(name => new RegExp(`\\b${name}\\s*\\(`).test(control[0]));
      if (toastOnlyName != null) {
        report(source.file, control.index, source.text, `${control[1]} invokes Toast-only helper ${toastOnlyName}; Toast may confirm a real result but cannot be the action outcome`);
      }
    }
  }
}

function inspectSurfaceContentInsets() {
  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  for (const wrapper of surfaceContentWrappers) {
    const escapedClass = wrapper.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = styles.match(new RegExp(`\\.${escapedClass}\\s*\\{([^}]*)\\}`));
    if (!rule || !/padding\s*:\s*var\(\s*--uit-spacing-large\s*\)/.test(rule[1])) {
      report(wrapper.file, wrapper.offset, wrapper.text, `${wrapper.componentName} content wrapper must inset every edge with --uit-spacing-large`);
    }
  }
}

function inspectFauxMedia() {
  const styleFiles = inspectedFiles.filter(({ file }) => file.endsWith('.css'));
  for (const styleFile of styleFiles) {
    for (const block of styleFile.text.matchAll(/\.([A-Za-z_-][\w-]*(?:cover|media)[\w-]*)\s*\{([^}]*)\}/gi)) {
      if (!/\bbackground(?:-color)?\s*:/.test(block[2]) || !/\bborder-radius\s*:/.test(block[2])) continue;
      const className = block[1];
      for (const source of inspectedFiles) {
        if (!/\.(?:tsx|jsx)$/.test(source.file)) continue;
        const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usage = source.text.match(new RegExp(`<div\\b[^>]*className=['"][^'"]*\\b${escapedClass}\\b[^'"]*['"][^>]*>([\\s\\S]*?)<\\/div>`));
        if (
          usage != null &&
          /<TextView\b/.test(usage[1]) &&
          !/<(?:img|picture|video|Image|Card|StaticContainer)\b/.test(usage[1])
        ) {
          report(source.file, usage.index, source.text, `${className} paints a rounded letter/text tile as faux media; use a relevant image or omit the media region`);
        }
      }
    }
  }
}

function inspectProjectConfig() {
  const projectRoot = path.dirname(sourceRoot);
  const htmlFile = path.join(projectRoot, 'index.html');
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    if (!/<meta\s+[^>]*name=['"]viewport['"][^>]*content=['"][^'"]*width=device-width[^'"]*initial-scale=1[^'"]*['"][^>]*>/i.test(html)) {
      report(htmlFile, 0, html, 'host HTML must declare a device-width viewport with initial-scale=1 so the WebView does not shrink a desktop layout viewport');
    }
  }
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/alias\s*:\s*\{/.test(text) && /['"]@meta\/wearables-ui-toolkit-icons['"]\s*:/.test(text) && /['"]@meta\/wearables-ui-toolkit-icons\/svg['"]\s*:/.test(text)) {
      report(file, text.indexOf('alias'), text, 'unordered object aliases can let the broad icons package capture /svg subpaths; use ordered alias entries or package exports');
    }
    if (/packages\/(?:foundation|mrbd|icons)\/src\//.test(text)) {
      report(file, 0, text, 'application aliases library source instead of consuming package exports');
    }
  }
}

function inspectBottomActionShell() {
  const pageActionFiles = inspectedFiles.filter(({ file, text }) => {
    if (!/\.(?:tsx|jsx)$/.test(file) || !/<Page\b/.test(text)) return false;
    const withoutModals = text.replace(/<Modal\b[\s\S]*?<\/Modal>/g, '');
    return /<(?:ButtonRail|ButtonGroup)\b/.test(withoutModals);
  });
  if (pageActionFiles.length === 0) return;

  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  const pageActionSource = pageActionFiles.map(({ text }) => text).join('\n');
  const hasGridDock =
    /grid-template-rows\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)\s+auto\b/.test(styles) ||
    /\bgridTemplateRows\s*:\s*['"]minmax\(\s*0\s*,\s*1fr\s*\)\s+auto['"]/.test(pageActionSource);
  const hasColumnDock = /display\s*:\s*flex\s*;[\s\S]*?flex-direction\s*:\s*column\s*;/.test(styles) &&
    /flex\s*:\s*1\s+1\s+(?:auto|0)\s*;[\s\S]*?min-block-size\s*:\s*0\s*;/.test(styles);
  if (!hasGridDock && !hasColumnDock) {
    report(pageActionFiles[0].file, 0, pageActionFiles[0].text, 'page actions require a full-height two-row shell: minmax(0, 1fr) content owner then auto bottom action dock');
  }
  const hasBottomClearance =
    /padding-(?:block-end|bottom)\s*:\s*var\(\s*--uit-spacing-xsmall\s*\)/.test(styles) ||
    /\b(?:paddingBlockEnd|paddingBottom)\s*:\s*['"]var\(\s*--uit-spacing-xsmall\s*\)['"]/.test(pageActionSource);
  if (!hasBottomClearance) {
    report(pageActionFiles[0].file, 0, pageActionFiles[0].text, 'bottom action dock must use --uit-spacing-xsmall below its ButtonRail/ButtonGroup');
  }
  const cssDockCanShrink = [...styles.matchAll(/[^{}]+\{([^{}]*)\}/g)].some(
    block =>
      /padding-(?:block-end|bottom)\s*:\s*var\(\s*--uit-spacing-xsmall\s*\)/.test(block[1]) &&
      /min-inline-size\s*:\s*0\b/.test(block[1]),
  );
  const inlineDockCanShrink = [...pageActionSource.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].some(
    style =>
      /(?:paddingBlockEnd|paddingBottom)\s*:\s*['"]var\(\s*--uit-spacing-xsmall\s*\)['"]/.test(style[1]) &&
      /minInlineSize\s*:\s*(?:0|['"]0['"])/.test(style[1]),
  );
  if (!cssDockCanShrink && !inlineDockCanShrink) {
    report(pageActionFiles[0].file, 0, pageActionFiles[0].text, 'bottom action dock must set min-inline-size: 0 so intrinsic actions cannot expand the viewport');
  }
}

function inspectWindowBackground() {
  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  const token = /var\(\s*--uit-color-background-window\s*\)/;
  const paintedRoots = new Set();
  for (const block of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1];
    const body = block[2];
    const background = body.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1] ?? '';
    if (!background) continue;
    const roots = [
      ['html', /(?:^|,)\s*html\s*(?:,|$)/],
      ['body', /(?:^|,)\s*body\s*(?:,|$)/],
      ['#root', /(?:^|,)\s*#root\s*(?:,|$)/],
      ['[data-app-root]', /\[data-app-root(?:=[^\]]+)?\]/],
    ];
    for (const [name, pattern] of roots) {
      if (!pattern.test(selector)) continue;
      if (!token.test(background)) {
        report(
          inspectedFiles.find(({ file }) => file.endsWith('.css'))?.file ?? sourceRoot,
          0,
          styles,
          `${name} background must use --uit-color-background-window`,
        );
      } else {
        paintedRoots.add(name);
      }
    }
  }
  for (const root of ['html', 'body', '#root']) {
    if (!paintedRoots.has(root)) {
      report(
        inspectedFiles.find(({ file }) => file.endsWith('.css'))?.file ?? sourceRoot,
        0,
        styles,
        `${root} must paint --uit-color-background-window`,
      );
    }
  }
}

function inspectPublicComponentStylingBoundary() {
  const uitRootClasses = new Map();

  for (const source of inspectedFiles.filter(({file}) => /\.(?:tsx|jsx)$/.test(file))) {
    const importedComponents = new Set();
    for (const declaration of source.text.matchAll(
      /import\s*\{([\s\S]*?)\}\s*from\s*['"]@meta\/wearables-ui-toolkit-mrbd['"]/g,
    )) {
      for (const entry of declaration[1].split(',')) {
        const match = entry.trim().match(/^([A-Z][\w]*)(?:\s+as\s+([A-Z][\w]*))?$/);
        if (match != null) importedComponents.add(match[2] ?? match[1]);
      }
    }

    for (const componentName of importedComponents) {
      const componentPattern = new RegExp(
        `<${componentName}\\b([^>]*)>`,
        'g',
      );
      for (const component of source.text.matchAll(componentPattern)) {
        const className = component[1].match(
          /\bclassName=['"]([A-Za-z_-][\w-]*)['"]/,
        )?.[1];
        if (className == null) continue;
        if (!uitRootClasses.has(className)) {
          uitRootClasses.set(className, {
            componentName,
            file: source.file,
            offset: component.index,
            text: source.text,
          });
        }
      }
    }

    for (const query of source.text.matchAll(
      /\bquerySelector(?:All)?\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g,
    )) {
      if (
        /\[(?:data-uit|data-scroll-view|role|aria-)[^\]]*\]|module__/.test(
          query[2],
        )
      ) {
        report(
          source.file,
          query.index,
          source.text,
          'application DOM query targets the toolkit-rendered anatomy; use documented public props or handles only',
        );
      }
    }
  }

  for (const style of inspectedFiles.filter(({file}) => file.endsWith('.css'))) {
    for (const block of style.text.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      const selectors = block[1].split(',').map(selector => selector.trim());
      for (const selector of selectors) {
        if (
          /\[(?:data-uit|data-scroll-view|role|aria-)[^\]]*\]|[A-Za-z]+-module__/.test(
            selector,
          )
        ) {
          report(
            style.file,
            block.index,
            style.text,
            'application CSS targets the toolkit-rendered classes/attributes; customize through documented public APIs only',
          );
          continue;
        }

        for (const [className, owner] of uitRootClasses) {
          const escapedClassName = className.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          );
          const classMatch = selector.match(
            new RegExp(`\\.${escapedClassName}(.*)$`),
          );
          if (classMatch == null || classMatch[1].trim() === '') continue;
          report(
            owner.file,
            owner.offset,
            owner.text,
            `${owner.componentName} root class ${className} is used to target component internals; style only the documented public root hook`,
          );
        }
      }
    }
  }
}

function inspectIntrinsicComponentSizing() {
  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  for (const source of inspectedFiles.filter(({ file }) => /\.(?:tsx|jsx)$/.test(file))) {
    for (const component of source.text.matchAll(/<(Chip|Header|Tag|Button|AppBadge)\b([^>]*)>/g)) {
      const className = component[2].match(/\bclassName=['"]([A-Za-z_-][\w-]*)['"]/)?.[1];
      if (className == null) continue;
      const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const rule of styles.matchAll(new RegExp(`[^{}]*\\.${escapedClassName}(?:[^\\w-][^{}]*)?\\{([^}]*)\\}`, 'g'))) {
        if (/\b(?:width|height|inline-size|block-size|min-width|max-width|min-height|max-height|min-inline-size|max-inline-size|min-block-size|max-block-size|flex-grow|flex-shrink|flex-basis|transform|scale)\s*:/.test(rule[1]) || /\bflex\s*:\s*(?!none\b|0\s+0\s+auto\b)/.test(rule[1])) {
          report(source.file, component.index, source.text, `${component[1]} class ${className} forces or constrains intrinsic size; remove external dimensions, flex sizing, and scale`);
        }
      }
    }
  }
}

function inspectScrollContentInsets() {
  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  for (const wrapper of scrollContentWrappers) {
    const escapedClassName = wrapper.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = styles.match(new RegExp(`\\.${escapedClassName}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
    if (!/padding-inline\s*:\s*var\(\s*--uit-spacing-large\s*\)/.test(rule) && !/padding\s*:\s*var\(\s*--uit-spacing-large\s*\)/.test(rule)) {
      report(wrapper.file, wrapper.offset, wrapper.text, 'ScrollView content wrapper must inset visible content from both display edges with --uit-spacing-large');
    } else if (wrapper.containsPanel) {
      report(wrapper.file, wrapper.offset, wrapper.text, 'page-level Panel is inside route horizontal padding; let the Panel backdrop reach both screen edges and inset its children internally');
    }
  }
}

function inspectFauxCompactSurfaces() {
  const styles = inspectedFiles
    .filter(({ file }) => file.endsWith('.css'))
    .map(({ text }) => text)
    .join('\n');
  for (const surface of fauxCompactSurfaces) {
    const escapedClassName = surface.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = styles.match(new RegExp(`\\.${escapedClassName}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
    if (/(?:width|inline-size)\s*:\s*100%/.test(rule) || /(?:align-self|justify-self)\s*:\s*stretch/.test(rule) || /flex-grow\s*:\s*(?!0\b)/.test(rule)) {
      report(surface.file, surface.offset, surface.text, `${surface.componentName} class ${surface.className} stretches one short label to imitate a compact toolkit component; use an intrinsic semantic component or ordinary text`);
    }
  }
}

if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
  console.error(`Expected an application source directory: ${sourceRoot}`);
  process.exit(2);
}

visit(sourceRoot);
inspectApplicationMount();
inspectRouterIntegration();
inspectRoutedPagerPersistence();
inspectDuplicatePageActions();
inspectTimestampDataContracts();
inspectHeaderMetadataContracts();
inspectUnusedContentContracts();
inspectToastOnlyActions();
inspectProjectConfig();
inspectBottomActionShell();
inspectWindowBackground();
inspectPublicComponentStylingBoundary();
inspectIntrinsicComponentSizing();
inspectScrollContentInsets();
inspectFauxCompactSurfaces();
inspectSurfaceContentInsets();
inspectFauxMedia();
inspectAuthoredScrims();
inspectPagerChildRoots();
inspectDistantFocusComponents();

if (findings.length > 0) {
  console.error(`UI Toolkit application structure failed (${findings.length} finding${findings.length === 1 ? '' : 's'}):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`UI Toolkit application structure passed: ${sourceRoot}`);
