# Loopback Design System v0

Two surfaces — the embeddable widget and the `/queue` dashboard — built from
one set of tokens, in **vanilla CSS with zero dependencies**, speaking
**shadcn/ui's token contract** so it interoperates with the React ecosystem
without joining it.

```
design/tokens.css      shadcn's 18 semantic vars (oklch, .dark) + Loopback's --lb-* domain tokens
design/components.css  vanilla recipes: lb-btn, lb-badge, lb-card, lb-table, lb-input, lb-pin
registry.json          shadcn registry — installable by the CLI and the shadcn MCP
public/r/*.json        built registry output (committed; this is what consumers fetch)
```

## Why shadcn's contract, in a project with no UI dependencies

shadcn/ui is not a library you install — it is a convention you own. That is
the same bet Loopback makes everywhere else (own the bus, borrow the capture),
so adopting its *variable names* costs nothing and buys interoperability:
drop `tokens.css` into any shadcn / Tailwind / v0.dev project and the
components theme themselves from that project's palette.

What was deliberately **not** done: React, Tailwind, and Radix are not
dependencies and never will be. The widget is injected into arbitrary host
pages and must stay a single ~29KB dependency-free file; the server must stay
`npx`-installable with `tsc` as its only build.

## The tokens

`tokens.css` implements shadcn's contract verbatim — `--background`,
`--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`,
`--accent`, `--destructive`, `--border`, `--input`, `--ring`, and `--radius`
with its multiplicative scale (`--radius-sm: calc(var(--radius) * 0.6)` …).
Values are `oklch`, dark mode is the `.dark` class, both matching current
shadcn output.

On top sit Loopback's domain tokens, `--lb-` prefixed so they can never
collide with a host project's variables in either direction:

| Token | Meaning |
|---|---|
| `--lb-open` · `--lb-triaged` | amber — waiting on an agent |
| `--lb-in-progress` | blue — an agent holds the claim |
| `--lb-fixed` · `--lb-verified` | green — the loop closed |
| `--lb-wontfix` | gray — closed deliberately |
| `--lb-p0` … `--lb-p3` | severity ranking (`--lb-p0` reuses `--destructive`) |

These are the product's semantic vocabulary: a pin on a live page, a badge in
the widget panel, and a row in `/queue` must all agree on what "verified"
looks like.

## Shadow-DOM isolation (the part that is easy to get wrong)

The widget does **not** consume these variables by name. It carries its own
copy of the values on an internal `.lb-root` wrapper. Three measured facts
force that shape:

1. **Custom properties pierce shadow boundaries**, and `all: initial` does not
   reset them — the `all` shorthand excludes custom properties by spec. An
   undeclared token silently inherits the host page's value.
2. **`:host` is not sufficient.** Per CSS Cascade's encapsulation ordering, a
   *normal* declaration from the outer document beats the inner context
   regardless of specificity. So `#loopback-widget-host { --lb-primary: … }`
   or even `div { color-scheme: dark }` on the host page overrides anything
   declared on `:host`. This is how the original white-on-white bug got in.
3. **An element the outer page cannot select is immune.** Nothing outside can
   match `.lb-root` inside our shadow tree, and an own-element declaration
   always beats an inherited one. `display: contents` keeps the wrapper out of
   layout so the fixed-position children are unaffected.

Both cases are covered by a regression test in `scripts/e2e.mjs`, which
injects a host stylesheet targeting the host element and asserts the widget's
controls keep ≥4.5:1 contrast and never take the host's colors.

The widget also follows the **viewer's** `prefers-color-scheme` rather than
the host page's palette — a feedback tool should stay recognisable and legible
on every site, not camouflage itself in each one.

## Using it in a React / shadcn / v0 project

The registry ships two items, both installable from a static URL with no auth:

```bash
# feedback status + severity tokens, added to your existing theme
npx shadcn@latest add https://raw.githubusercontent.com/joshidikshant/loopback/main/public/r/loopback-theme.json

# the capture widget itself, dropped into public/
npx shadcn@latest add https://raw.githubusercontent.com/joshidikshant/loopback/main/public/r/loopback-widget.json
```

The theme item only *adds* `--lb-*` variables — your palette is untouched. The
shadcn CLI also generates `@theme inline` mappings for them, so Tailwind
utilities like `bg-lb-verified` and `text-lb-p0` work immediately.

To make the items discoverable by name (and to the **shadcn MCP**, which
browses whatever registries a project declares), add the namespace to your
`components.json`:

```json
{
  "registries": {
    "@loopback": "https://raw.githubusercontent.com/joshidikshant/loopback/main/public/r/{name}.json"
  }
}
```

then `npx shadcn@latest add @loopback/loopback-theme`, or just ask an agent
with the shadcn MCP connected to "search the loopback registry".

## Changing a token

`design/tokens.css` is the source of truth. After editing:

```bash
npm run registry:build     # regenerate public/r/*.json
npm run registry-gate      # asserts published output is valid and in sync
```

The gate fails if the committed registry drifts from the source — a stale
registry ships code the repo no longer has, which is worse than no registry.
The widget keeps its own inlined copy of the values (it cannot import CSS);
`registry-gate` checks the theme item against `tokens.css` so drift surfaces.
