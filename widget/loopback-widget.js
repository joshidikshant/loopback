/*!
 * Loopback capture widget v0.9.0 (MIT)
 *
 * Interaction lineage (all adapted, with thanks):
 * - Vercel Toolbar — floating-toolbar workflow + resolve lifecycle (pattern).
 * - Claude Design (Anthropic Labs) — element-anchored comments (pattern).
 * - paraschopra/make-pages-interactive (MIT) — the "loop closes visibly"
 *   walkthrough: status changes announce themselves on the page.
 * - AAnkacHH/DOM-Review (MIT) — the window.__domReviewAPI idea, here as
 *   window.__loopback (pins + refresh) for tests and agents.
 *
 * One script tag turns any web app into an interactive feedback surface:
 *
 *   <script src="http://127.0.0.1:7077/widget.js"
 *           data-project="my-app"
 *           data-endpoint="http://127.0.0.1:7077"></script>
 *
 * - Floating toolbar (Vercel-toolbar-style); "pin" mode makes every element
 *   clickable (Claude-Design-style anchored comments).
 * - A pin is an ANCHOR, not a scope: the payload carries recent console lines
 *   and network calls (with response bodies for failures), so "frontend looks
 *   fine but the backend is broken" is diagnosable from a single pin.
 * - AI/automation context: the widget picks up the nearest ancestor's
 *   data-loopback-context='{"run_id":"...","model":"..."}' into extra.context,
 *   so feedback on an LLM feature arrives with its run metadata.
 * - Pins hydrate from GET /feedback and poll status: they turn blue when an
 *   agent claims the item, green when fixed/verified — the loop closes visibly.
 */
(function () {
  "use strict";
  if (window.__loopbackWidgetLoaded) return;
  window.__loopbackWidgetLoaded = true;

  // ---------- config ----------
  var script = document.currentScript;
  /**
   * Endpoint resolution, in priority order.
   *
   * The widget is SERVED BY the hub, so the origin of its own <script src> is
   * the hub — no configuration needed and correct under any bind address. The
   * hardcoded fallback only applies when the origin cannot be read at all.
   *
   * This matters beyond tidiness: the dashboard embeds the widget with no
   * data-endpoint, under a comment asserting the endpoint is relative. It was
   * not — it fell through to the absolute default, so in the documented
   * `--host 0.0.0.0` phone mode the one page that demonstrates the loop pointed
   * at the phone's own localhost and could neither file nor hydrate a pin.
   */
  var scriptOrigin = null;
  try {
    if (script && script.src) scriptOrigin = new URL(script.src, location.href).origin;
  } catch (e) {
    /* malformed src — fall through */
  }
  var ENDPOINT =
    (script && script.dataset.endpoint) || scriptOrigin || "http://127.0.0.1:7077";
  var PROJECT = (script && script.dataset.project) || "unknown-project";
  var POLL_MS = 10000;
  var MAX_BODY = 2048;

  // ---------- ring buffers: console + network ----------
  var consoleBuf = [];
  var networkBuf = [];

  // Shallow, bounded summary — NOT JSON.stringify.
  //
  // This runs inside a patched console.* on someone else's page, so it is on the
  // hot path of every log the host app makes. A full stringify walks the entire
  // object graph (and can hit a huge redux store or a DOM-heavy payload) only
  // for the result to be truncated to 500 chars a moment later. This costs
  // O(top-level keys) instead of O(whole tree).
  function brief(a) {
    if (typeof a === "string") return a;
    if (a === null || a === undefined) return String(a);
    if (typeof a !== "object") return String(a);
    if (a instanceof Error) return a.name + ": " + a.message;
    if (Array.isArray(a)) return "[Array(" + a.length + ")]";
    if (a.nodeType === 1) return "<" + a.tagName.toLowerCase() + ">";
    try {
      var keys = Object.keys(a);
      var parts = [];
      for (var i = 0; i < keys.length && i < 6; i++) {
        var v = a[keys[i]];
        var t = typeof v;
        parts.push(keys[i] + ":" + (t === "object" && v !== null ? (Array.isArray(v) ? "[…]" : "{…}") : String(v).slice(0, 40)));
      }
      return "{" + parts.join(",") + (keys.length > 6 ? ",…" : "") + "}";
    } catch (e) {
      return String(a);
    }
  }

  function pushConsole(level, args) {
    try {
      var text = Array.prototype.map.call(args, brief).join(" ");
      consoleBuf.push("[" + level + "] " + text.slice(0, 500));
      if (consoleBuf.length > 30) consoleBuf.shift();
    } catch (e) {
      /* never break the host app */
    }
  }
  ["log", "warn", "error"].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      pushConsole(level, arguments);
      original.apply(null, arguments);
    };
  });
  window.addEventListener("error", function (ev) {
    pushConsole("error", [ev.message + " @ " + (ev.filename || "?") + ":" + (ev.lineno || "?")]);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    pushConsole("error", ["UnhandledRejection: " + String(ev.reason).slice(0, 300)]);
  });

  function pushNetwork(entry) {
    networkBuf.push(entry);
    if (networkBuf.length > 30) networkBuf.shift();
  }

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf(ENDPOINT) === 0) return origFetch(input, init); // don't record ourselves
      var method = (init && init.method) || (input && input.method) || "GET";
      var start = Date.now();
      return origFetch(input, init).then(
        function (res) {
          var entry = {
            url: String(url).slice(0, 2000),
            method: method,
            status: res.status,
            ms: Date.now() - start,
          };
          if (res.status >= 400) {
            // capture response body for failures — this is what lets an agent
            // chase a broken backend from a frontend pin
            res
              .clone()
              .text()
              .then(function (body) {
                entry.response_snippet = body.slice(0, MAX_BODY);
              })
              .catch(function () {});
          }
          pushNetwork(entry);
          return res;
        },
        function (err) {
          pushNetwork({
            url: String(url).slice(0, 2000),
            method: method,
            status: 0,
            ms: Date.now() - start,
            response_snippet: "NETWORK ERROR: " + String(err).slice(0, 300),
          });
          throw err;
        }
      );
    };
  }

  var OrigXHROpen = XMLHttpRequest.prototype.open;
  var OrigXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lb = { method: method, url: String(url) };
    return OrigXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var meta = xhr.__lb || {};
    var start = Date.now();
    if (meta.url && meta.url.indexOf(ENDPOINT) !== 0) {
      xhr.addEventListener("loadend", function () {
        var entry = {
          url: (meta.url || "").slice(0, 2000),
          method: meta.method || "GET",
          status: xhr.status,
          ms: Date.now() - start,
        };
        if (xhr.status >= 400 || xhr.status === 0) {
          try {
            entry.response_snippet = String(xhr.responseText || "").slice(0, MAX_BODY);
          } catch (e) {}
        }
        pushNetwork(entry);
      });
    }
    return OrigXHRSend.apply(this, arguments);
  };

  // ---------- css path generator ----------
  // Classes that describe state, not identity — never stable anchors.
  var STATE_CLASSES = /^(active|selected|current|open|closed|visible|hidden|disabled|checked|focus|hover|loading|expanded|collapsed)$/;
  function semanticClasses(el) {
    var raw = typeof el.className === "string" ? el.className : "";
    var tokens = raw.split(/\s+/).filter(function (t) {
      if (!t || t.length < 3 || t.length > 24) return false;
      if (STATE_CLASSES.test(t)) return false;
      if (/^(is-|has-|js-)/.test(t)) return false; // state/behavior hooks
      if (/[\d:[\]\/!%#.]/.test(t)) return false; // utility scales & arbitrary-value syntax
      return /^[a-zA-Z][a-zA-Z_-]*$/.test(t);
    });
    return tokens
      .slice(0, 2)
      .map(function (t) {
        return "." + CSS.escape(t);
      })
      .join("");
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    var path = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 8) {
      var seg = node.tagName.toLowerCase();
      var testId = node.getAttribute("data-testid");
      if (testId) {
        path.unshift(seg + '[data-testid="' + testId + '"]');
        break;
      }
      seg += semanticClasses(node);
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) {
          seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
      }
      path.unshift(seg);
      node = parent;
      depth++;
    }
    return path.join(" > ");
  }

  function nearestContext(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.dataset && node.dataset.loopbackContext) {
        try {
          return JSON.parse(node.dataset.loopbackContext);
        } catch (e) {
          return { raw: node.dataset.loopbackContext };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---------- shadow-DOM ui ----------
  var host = document.createElement("div");
  host.id = "loopback-widget-host";
  var root = host.attachShadow({ mode: "open" });
  // ---------- design tokens (Loopback Design System v0) ----------
  // The shadcn token VALUES, declared on an INTERNAL wrapper (.lb-root) under
  // an --lb- prefix. Three facts, each verified in a real browser, force this
  // exact shape:
  //
  // 1. Custom properties pierce shadow boundaries, and `all: initial` does NOT
  //    reset them (the `all` shorthand excludes custom properties by spec). So
  //    an undeclared token silently inherits the host page's value.
  // 2. `:host` is NOT sufficient to stop that. Per CSS Cascade's encapsulation
  //    ordering, a NORMAL declaration from the outer document wins over the
  //    inner context regardless of specificity — so a host-page rule that
  //    targets the host element (`#loopback-widget-host{--lb-primary:…}`, or
  //    even `div{color-scheme:dark}`) overrides anything we put on :host.
  //    Measured: it does, and it is how the old white-on-white bug got in.
  // 3. An element the outer page cannot select is immune. Nothing outside can
  //    match `.lb-root` inside our shadow tree, and an own-element declaration
  //    always beats an inherited one. `display:contents` keeps the wrapper out
  //    of layout so the fixed-position children are unaffected.
  //
  // The widget also owns its theme deliberately: it follows the VIEWER's
  // prefers-color-scheme, never the host page's palette, so a feedback tool
  // stays recognisable and legible on every site instead of camouflaging.
  // These literals are a transcription of design/tokens.css — the widget cannot
  // @import it (it ships as one file, injected into arbitrary pages), so the
  // copy is deliberate. It is NOT allowed to drift: scripts/widget-token-gate.mjs
  // parses both files and fails the build on any mismatch. It caught two real
  // divergences the first time it ran (--lb-border and --lb-input had crept to
  // 15%/20% against tokens.css's 10%/15%).
  //
  // Mapping note: --lb-bg is the widget's floating surface, so it tracks
  // --popover, not --background. The gate encodes that pairing explicitly.
  var TOKENS =
    ":host{all:initial}" +
    ".lb-root{display:contents;color-scheme:light;" +
    "--lb-bg:oklch(1 0 0);--lb-fg:oklch(0.145 0 0);" +
    "--lb-muted:oklch(0.97 0 0);--lb-muted-fg:oklch(0.556 0 0);" +
    "--lb-border:oklch(0.922 0 0);--lb-input:oklch(0.922 0 0);" +
    "--lb-primary:oklch(0.205 0 0);--lb-primary-fg:oklch(0.985 0 0);" +
    "--lb-ring:oklch(0.45 0 0);--lb-radius:0.625rem;"+
    "--lb-pin-size:24px;--lb-pin-radius:999px 999px 999px 4px;" +
    "--lb-open:oklch(0.555 0.163 48.998);--lb-open-fg:oklch(0.985 0 0);" +
    "--lb-triaged:oklch(0.476 0.113 61.907);--lb-triaged-fg:oklch(0.985 0 0);" +
    "--lb-in-progress:oklch(0.488 0.243 264.376);--lb-in-progress-fg:oklch(0.985 0 0);" +
    "--lb-fixed:oklch(0.8 0.09 168);--lb-fixed-fg:oklch(0.205 0 0);" +
    "--lb-verified:oklch(0.508 0.118 165.612);--lb-verified-fg:oklch(0.985 0 0);" +
    "--lb-wontfix:oklch(0.551 0.027 264.364);--lb-wontfix-fg:oklch(0.985 0 0);" +
    "--lb-highlight:oklch(0.488 0.243 264.376);" +
    "--lb-shadow-sm:0 2px 8px rgb(0 0 0/0.18);--lb-shadow-md:0 4px 14px rgb(0 0 0/0.22);" +
    "--lb-shadow-lg:0 10px 32px rgb(0 0 0/0.2);" +
    "--lb-font:system-ui,-apple-system,'Segoe UI',sans-serif}";
  // The dark token body, emitted under TWO conditions.
  //
  // The widget follows the VIEWER's prefers-color-scheme so it stays legible on
  // any host page rather than camouflaging into it. That is right for a foreign
  // site and wrong when the host has an explicit theme of its own: the hub's own
  // dashboard toggles a `.dark` class, and the widget sat light on a dark page —
  // measured, the FAB at 1.1:1 and the panel a pure-white slab. `.lb-dark` is
  // set from JS when the host declares a theme; the media query still covers
  // every host that does not.
  var DARK_BODY =
"color-scheme:dark;" +
    "--lb-bg:oklch(0.205 0 0);--lb-fg:oklch(0.985 0 0);" +
    "--lb-muted:oklch(0.269 0 0);--lb-muted-fg:oklch(0.708 0 0);" +
    "--lb-border:oklch(1 0 0/10%);--lb-input:oklch(1 0 0/15%);" +
    "--lb-primary:oklch(0.922 0 0);--lb-primary-fg:oklch(0.205 0 0);" +
    "--lb-ring:oklch(0.85 0 0);" +
    "--lb-open:oklch(0.828 0.189 84.429);--lb-open-fg:oklch(0.205 0 0);" +
    "--lb-triaged:oklch(0.646 0.132 68);--lb-triaged-fg:oklch(0.205 0 0);" +
    "--lb-in-progress:oklch(0.707 0.165 254.624);--lb-in-progress-fg:oklch(0.205 0 0);" +
    "--lb-fixed:oklch(0.52 0.09 168);--lb-fixed-fg:oklch(0.985 0 0);" +
    "--lb-verified:oklch(0.765 0.177 163.223);--lb-verified-fg:oklch(0.205 0 0);" +
    "--lb-wontfix:oklch(0.707 0.022 261.325);--lb-wontfix-fg:oklch(0.205 0 0);" +
    "--lb-highlight:oklch(0.707 0.165 254.624);" +
    "--lb-shadow-sm:0 2px 8px rgb(0 0 0/0.5);--lb-shadow-md:0 4px 14px rgb(0 0 0/0.55);" +
    "--lb-shadow-lg:0 10px 32px rgb(0 0 0/0.6);";
  var TOKENS_DARK =
    "@media (prefers-color-scheme:dark){.lb-root:not(.lb-light){" + DARK_BODY + "}}" +
    ".lb-root.lb-dark{" + DARK_BODY + "}";


  TOKENS += TOKENS_DARK;

  var RADIUS_MD = "calc(var(--lb-radius) * 0.8)";
  var RADIUS_SM = "calc(var(--lb-radius) * 0.6)";

  // Style is set as textContent on a <style> element, and the shell is built
  // with DOM calls — no innerHTML anywhere the host page can reach.
  var styleEl = document.createElement("style");
  styleEl.textContent =
    TOKENS +
    "*{box-sizing:border-box;font-family:var(--lb-font)}" +
    // Visually hidden but present for assistive tech — the live regions.
    ".sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
    ".fab{position:fixed;bottom:18px;right:18px;z-index:2147483000;background:var(--lb-primary);color:var(--lb-primary-fg);border:none;border-radius:999px;min-height:44px;padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer;box-shadow:var(--lb-shadow-md)}" +
    ".fab:focus-visible{outline:2px solid var(--lb-ring);outline-offset:2px}" +
    ".fab.pinmode{background:var(--lb-in-progress);color:var(--lb-in-progress-fg)}" +
    // Own tooltip rather than title="": a native tooltip waits ~1s, is styled by
    // the OS, and can't be shown on keyboard focus.
    ".tip{position:fixed;bottom:62px;right:18px;z-index:2147483000;max-width:250px;" +
    "background:var(--lb-primary);color:var(--lb-primary-fg);padding:7px 10px;" +
    "border-radius:" + RADIUS_MD + ";font-size:12px;line-height:1.45;" +
    "box-shadow:var(--lb-shadow-md);opacity:0;transform:translateY(4px);" +
    "transition:opacity .12s ease,transform .12s ease;pointer-events:none}" +
    // Hoverable (SC 1.4.13): once shown, the pointer can move onto it without
    // it vanishing. Kept pointer-events:none while hidden so it never blocks
    // the host page underneath.
    ".tip:hover,.fab:hover~.tip,.tip.shown{opacity:1;transform:none;pointer-events:auto}" +
    ".fab:focus-visible~.tip{opacity:1;transform:none;pointer-events:auto}" +
    // Suppress it when the panel is open or we're mid-pin: the label no longer
    // says "Loopback", so explaining Loopback would be noise.
    ".panel.open~.tip,.fab.pinmode~.tip,.tip.dismissed{opacity:0!important;transform:translateY(4px)!important;pointer-events:none!important}" +
    ".panel{position:fixed;bottom:64px;right:18px;z-index:2147483000;width:290px;background:var(--lb-bg);border:1px solid var(--lb-border);border-radius:var(--lb-radius);box-shadow:var(--lb-shadow-lg);padding:12px;display:none;color:var(--lb-fg)}" +
    ".panel.open{display:block}" +
    ".panel h3{margin:0 0 8px;font-size:13px;font-weight:600}" +
    ".panel button{width:100%;margin:4px 0;padding:8px;border-radius:" + RADIUS_MD + ";border:1px solid var(--lb-border);background:var(--lb-bg);color:var(--lb-fg);cursor:pointer;font-size:13px;font-weight:500}" +
    ".panel button:hover{background:var(--lb-muted)}" +
    ".pinlist{margin:8px 0 0;max-height:180px;overflow:auto;font-size:12px}" +
    ".pinrow{display:block;width:100%;min-height:44px;text-align:left;padding:8px;border-radius:" + RADIUS_SM + ";border:1px solid var(--lb-border);margin:4px 0;color:var(--lb-fg);background:var(--lb-bg);font:inherit;cursor:pointer}" +
    ".pinrow:hover{background:var(--lb-muted)}" +
    ".pinrow:focus-visible{outline:2px solid var(--lb-ring);outline-offset:2px}" +
    ".pinrow small{color:var(--lb-muted-fg)}" +
    ".badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;margin-right:6px}" +
    // Each status carries its own paired foreground. A single --lb-on-status
    // could not stay legible once `fixed` became a pale green in light mode.
    ".b-open{background:var(--lb-open);color:var(--lb-open-fg)}" +
    ".b-triaged{background:var(--lb-triaged);color:var(--lb-triaged-fg)}" +
    ".b-in_progress{background:var(--lb-in-progress);color:var(--lb-in-progress-fg)}" +
    ".b-fixed{background:var(--lb-fixed);color:var(--lb-fixed-fg)}" +
    ".b-verified{background:var(--lb-verified);color:var(--lb-verified-fg)}" +
    ".b-wontfix{background:var(--lb-wontfix);color:var(--lb-wontfix-fg)}" +
    ".hl{position:fixed;left:0;top:0;will-change:transform;z-index:2147482998;pointer-events:none;border:2px solid var(--lb-highlight);border-radius:" + RADIUS_SM + ";background:color-mix(in oklch,var(--lb-highlight) 10%,transparent)}" +
    ".form{position:fixed;z-index:2147483001;width:min(300px,calc(100vw - 16px));max-height:min(72vh,460px);overflow:auto;background:var(--lb-bg);border:1px solid var(--lb-border);border-radius:var(--lb-radius);box-shadow:var(--lb-shadow-lg);padding:12px;color:var(--lb-fg)}" +
    // 16px, not 13px: iOS Safari zooms the viewport on focus for anything under
    // 16px, and this panel is position:fixed — the zoom leaves it half off-screen
    // with no way back. Font size here is a layout constraint, not taste.
    ".form input,.form textarea,.form select{width:100%;margin:3px 0 8px;padding:9px;border:1px solid var(--lb-input);border-radius:" + RADIUS_MD + ";font-size:16px;background:var(--lb-bg);color:var(--lb-fg);font-family:inherit;min-height:44px}" +
    ".form input:focus-visible,.form textarea:focus-visible,.form select:focus-visible{outline:2px solid var(--lb-ring);outline-offset:-1px}" +
    ".form textarea{height:60px;resize:vertical}" +
    // Chrome's default placeholder grey measured 3.89:1 on the dark panel.
    ".form ::placeholder{color:var(--lb-muted-fg);opacity:1}" +
    ".form label{display:block;font-size:11px;font-weight:500;color:var(--lb-muted-fg)}" +
    // Status notes are prose, not labels — they get their own class so no
    // <label> has to exist purely to inherit type styling.
    ".form .note{display:block;font-size:11px;font-weight:500;margin-bottom:6px}" +
    // Informational capture notes, NOT status. Using --lb-verified and
    // --lb-open here spent the product's status vocabulary on decoration.
    ".form .note-ctx,.form .note-net{color:var(--lb-fg)}" +
    ".form [aria-invalid=true]{border-color:var(--lb-open);outline-color:var(--lb-open)}" +
    ".row{display:flex;gap:6px}.row>*{flex:1}" +
    ".actions{display:flex;gap:8px;margin-top:4px}" +
    ".actions button{flex:1;padding:8px;border-radius:" + RADIUS_MD + ";border:1px solid var(--lb-border);background:var(--lb-bg);color:var(--lb-fg);cursor:pointer;font-size:13px;font-weight:500}" +
    ".actions button:hover{background:var(--lb-muted)}" +
    ".actions .primary{background:var(--lb-primary);color:var(--lb-primary-fg);border-color:transparent}" +
    // 24px clears the 24x24 minimum of WCAG 2.5.8. The pin is an anchor drawn at
    // a precise point on someone else's page, so it cannot grow to 44 without
    // lying about what it marks; the panel's pin list is the large-target route
    // to the same actions.
    ".pin{position:fixed;left:0;top:0;z-index:2147482999;width:var(--lb-pin-size);height:var(--lb-pin-size);padding:0;border:none;border-radius:var(--lb-pin-radius);background:var(--lb-primary);color:var(--lb-primary-fg);font-size:11px;font-weight:600;line-height:var(--lb-pin-size);text-align:center;cursor:pointer;box-shadow:var(--lb-shadow-sm);font-family:var(--lb-font)}" +
    ".pin:focus-visible{outline:2px solid var(--lb-ring);outline-offset:2px}" +
    ".pin.b-open{background:var(--lb-open);color:var(--lb-open-fg)}" +
    ".pin.b-triaged{background:var(--lb-triaged);color:var(--lb-triaged-fg)}" +
    ".pin.b-in_progress{background:var(--lb-in-progress);color:var(--lb-in-progress-fg)}" +
    ".pin.b-fixed{background:var(--lb-fixed);color:var(--lb-fixed-fg)}" +
    ".pin.b-verified{background:var(--lb-verified);color:var(--lb-verified-fg)}" +
    ".pin.b-wontfix{background:var(--lb-wontfix);color:var(--lb-wontfix-fg)}" +
    ".toast{position:fixed;bottom:70px;right:18px;z-index:2147483002;background:var(--lb-primary);color:var(--lb-primary-fg);padding:9px 14px;border-radius:" + RADIUS_MD + ";font-size:12.5px;box-shadow:var(--lb-shadow-md);max-width:320px}" +
    ".pin.pulse{animation:lbpulse 1.1s ease-out 3}" +
    "@keyframes lbpulse{from{box-shadow:0 0 0 0 var(--lb-ring)}to{box-shadow:0 0 0 13px transparent}}" +
    // Reduced motion resolves to the DESIGNED STILL STATE, it does not just
    // delete feedback: the pin keeps a steady ring so "this one is new" still
    // reads, it simply stops pulsing. A blanket animation:none would remove the
    // signal along with the movement.
    "@media (prefers-reduced-motion:reduce){" +
    ".pin.pulse{animation:none;box-shadow:0 0 0 3px var(--lb-ring)}" +
    ".tip{transition:none}}";
  root.appendChild(styleEl);

  function mk(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Every widget node lives inside `ui` (.lb-root), never directly on the
  // shadow root: the wrapper is what carries the tokens, and it is the only
  // element the host page has no way to select.
  var ui = mk("div", "lb-root");
  root.appendChild(ui);

  /**
   * Follow the host's theme when the host declares one.
   *
   * Most host pages declare nothing, and the media query above keeps the widget
   * legible on them. But a page that themes itself with a class — the hub's own
   * dashboard does — leaves the widget stranded in the opposite theme. Watched
   * rather than read once, because the dashboard's toggle flips it at runtime.
   */
  function syncHostTheme() {
    var de = document.documentElement;
    var explicit = de.classList.contains("dark")
      ? "dark"
      : de.classList.contains("light") || de.dataset.theme === "light"
        ? "light"
        : de.dataset.theme === "dark"
          ? "dark"
          : null;
    ui.classList.toggle("lb-dark", explicit === "dark");
    ui.classList.toggle("lb-light", explicit === "light");
  }
  syncHostTheme();
  new MutationObserver(syncHostTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  var FAB_LABEL = "✦ Loopback";
  var TAGLINE = "Pin feedback on this page — an agent picks it up and the pin turns green.";

  var fab = mk("button", "fab", FAB_LABEL);
  fab.setAttribute("part", "fab");
  fab.setAttribute("aria-label", "Loopback — " + TAGLINE);
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "lb-panel");
  fab.setAttribute("aria-describedby", "lb-tip");
  var tip = mk("div", "tip", TAGLINE);
  tip.setAttribute("role", "tooltip");
  tip.id = "lb-tip";
  // Dismissable (SC 1.4.13): Escape hides it and focus stays exactly where it
  // was. Re-arms as soon as the pointer or focus leaves the FAB.
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") tip.classList.add("dismissed");
  });
  fab.addEventListener("mouseleave", function () {
    tip.classList.remove("dismissed");
  });
  fab.addEventListener("blur", function () {
    tip.classList.remove("dismissed");
  });
  var panel = mk("div", "panel");
  panel.id = "lb-panel";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Loopback — " + PROJECT);
  // textContent, not string concatenation: the project slug comes from the
  // host page's script tag and never gets parsed as markup.
  panel.appendChild(mk("h3", null, "Loopback — " + PROJECT));
  var pinBtn = mk("button", "pinbtn", "📍 Pin feedback on an element");
  var pinList = mk("div", "pinlist");
  panel.appendChild(pinBtn);
  panel.appendChild(pinList);
  // Order matters: the tooltip's CSS keys off ~ (general sibling), so it has to
  // come after both the fab that reveals it and the panel that suppresses it.
  ui.appendChild(fab);
  ui.appendChild(panel);
  ui.appendChild(tip);

  function mount() {
    document.body.appendChild(host);
    refreshPins();
    setInterval(refreshPins, POLL_MS);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  fab.addEventListener("click", function () {
    if (pinMode) {
      exitPinMode();
      return;
    }
    var open = panel.classList.toggle("open");
    fab.setAttribute("aria-expanded", open ? "true" : "false");
  });
  pinBtn.addEventListener("click", function () {
    panel.classList.remove("open");
    fab.setAttribute("aria-expanded", "false");
    enterPinMode();
  });

  // One persistent live region, created up front. A toast that is merely
  // appended to the DOM announces nothing — every message the widget produces
  // (validation, send failures, "Filed <id>", agent status changes) was
  // invisible to assistive tech. Two regions because polite messages must not
  // preempt each other while an error has to interrupt.
  var livePolite = mk("div", "sr");
  livePolite.setAttribute("role", "status");
  livePolite.setAttribute("aria-live", "polite");
  var liveAssertive = mk("div", "sr");
  liveAssertive.setAttribute("role", "alert");
  liveAssertive.setAttribute("aria-live", "assertive");
  ui.appendChild(livePolite);
  ui.appendChild(liveAssertive);

  function announce(msg, urgent) {
    var region = urgent ? liveAssertive : livePolite;
    // Clear first: repeating identical text is not re-announced otherwise.
    region.textContent = "";
    setTimeout(function () {
      region.textContent = msg;
    }, 50);
  }

  var toastCount = 0;
  function toast(msg, urgent) {
    var el = document.createElement("div");
    el.className = "toast";
    el.style.bottom = 70 + toastCount * 44 + "px";
    toastCount++;
    el.textContent = msg;
    ui.appendChild(el);
    announce(msg, urgent);
    setTimeout(function () {
      el.remove();
      toastCount = Math.max(0, toastCount - 1);
    }, 3800);
  }

  // ---------- pin mode ----------
  var pinMode = false;
  var highlight = null;

  // Keyboard pin mode. Pointer picking alone made the product's core gesture —
  // choosing what to pin — unavailable without a mouse, and most page content
  // worth pinning (a heading, a broken paragraph, an image) is not focusable,
  // so native Tab could never reach it either. This walks the page's own
  // elements with the arrow keys instead.
  var kbIndex = -1;
  var kbTargets = [];

  function collectTargets() {
    var out = [];
    var all = document.body.querySelectorAll(
      "p,h1,h2,h3,h4,li,td,th,img,button,a,input,textarea,select,label,figure,section,article,blockquote,pre,code,span",
    );
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (host.contains(el)) continue;
      var r = el.getBoundingClientRect();
      // On-screen and big enough to be a meaningful anchor.
      if (r.width < 12 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      out.push(el);
    }
    return out;
  }

  // rAF-throttled, like renderPins. This measured and then wrote four style
  // properties on every mousemove event — read-after-write at pointer rate,
  // the same class of thrash renderPins was rebuilt to eliminate.
  var paintQueued = null;
  function paint(el) {
    if (!highlight || !el) return;
    paintQueued = el;
    if (paint.frame) return;
    paint.frame = requestAnimationFrame(function () {
      paint.frame = 0;
      var target = paintQueued;
      if (!highlight || !target) return;
      var r = target.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.transform =
        "translate3d(" + Math.round(r.left - 2) + "px," + Math.round(r.top - 2) + "px,0)";
      highlight.style.width = r.width + "px";
      highlight.style.height = r.height + "px";
    });
  }

  function describe(el) {
    var text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60);
    return el.tagName.toLowerCase() + (text ? ": " + text : "");
  }

  function onKey(ev) {
    if (!pinMode) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      exitPinMode();
      announce("Pin mode cancelled");
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight" || ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      // Recollect each press. Collecting once froze the candidate set to
      // whatever was on screen at the first keypress, so scrolling never
      // revealed anything new and only the first viewport was ever pinnable.
      var previous = kbTargets[kbIndex];
      kbTargets = collectTargets();
      if (!kbTargets.length) return;
      // Keep the cursor on the same element across recollection where we can.
      if (previous) {
        var at = kbTargets.indexOf(previous);
        if (at !== -1) kbIndex = at;
      }
      var step = ev.key === "ArrowDown" || ev.key === "ArrowRight" ? 1 : -1;
      kbIndex = (kbIndex + step + kbTargets.length) % kbTargets.length;
      var el = kbTargets[kbIndex];
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      paint(el);
      announce(describe(el) + ". Press Enter to pin.");
      return;
    }
    if (ev.key === "Enter" && kbIndex >= 0 && kbTargets[kbIndex]) {
      ev.preventDefault();
      var target = kbTargets[kbIndex];
      var rect = target.getBoundingClientRect();
      exitPinMode();
      openForm(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
  }

  function enterPinMode() {
    pinMode = true;
    fab.classList.add("pinmode");
    fab.textContent = "✕ Cancel pin";
    // The accessible name has to track the visible one, or a screen reader
    // announces "Loopback — pin feedback…" on a button that now says Cancel.
    fab.setAttribute("aria-label", "Cancel pin mode");
    kbIndex = -1;
    kbTargets = [];
    highlight = document.createElement("div");
    highlight.className = "hl";
    ui.appendChild(highlight);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
    fab.focus();
    announce(
      "Pin mode on. Use the arrow keys to move through the page, Enter to pin the highlighted element, Escape to cancel.",
    );
  }
  function exitPinMode() {
    pinMode = false;
    fab.classList.remove("pinmode");
    fab.textContent = FAB_LABEL;
    fab.setAttribute("aria-label", "Loopback — " + TAGLINE);
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "lb-panel");
  fab.setAttribute("aria-describedby", "lb-tip");
    if (highlight) highlight.remove();
    highlight = null;
    kbTargets = [];
    kbIndex = -1;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onMove(ev) {
    if (ev.composedPath().indexOf(host) !== -1) {
      highlight.style.display = "none";
      return;
    }
    paint(ev.target);
  }
  function onPick(ev) {
    if (ev.composedPath().indexOf(host) !== -1) return;
    ev.preventDefault();
    ev.stopPropagation();
    var el = ev.target;
    exitPinMode();
    openForm(el, ev.clientX, ev.clientY);
  }

  // ---------- capture form ----------
  function openForm(el, x, y) {
    var selector = cssPath(el);
    var ctx = nearestContext(el);
    var failedNet = networkBuf.filter(function (n) {
      return n.status >= 400 || n.status === 0;
    });
    var guessType = ctx ? "usage" : failedNet.length ? "backend" : "ui";

    var form = document.createElement("div");
    form.className = "form";
    // A modal-ish surface needs a role and a name, or it is an anonymous div to
    // assistive tech and Escape does nothing.
    form.setAttribute("role", "dialog");
    // Deliberately NOT aria-modal="true". This panel floats over a host page we
    // do not own; we cannot mark that page inert and will not trap focus inside
    // someone else's document. Claiming modality without enforcing it tells a
    // screen reader the rest of the page is unavailable when it is still fully
    // reachable — worse than not claiming it.
    form.setAttribute("aria-label", "File Loopback feedback");
    function placeForm() {
      var w = form.offsetWidth || 300;
      var h = form.offsetHeight || Math.min(window.innerHeight * 0.72, 460);
      // Clamp to the CURRENT viewport, and never below 8px from either edge.
      // Math.max(8, …) has to come last or a viewport narrower than the form
      // produces a negative left and pushes it off the screen entirely.
      form.style.left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8)) + "px";
      form.style.top = Math.max(8, Math.min(y + 10, window.innerHeight - h - 8)) + "px";
    }
    placeForm();
    // Reposition on resize and rotation. Without this the panel kept the
    // coordinates it was born with.
    window.addEventListener("resize", placeForm);

    // Remember who opened it so focus can go back there on close.
    // root.activeElement, NOT document.activeElement: when focus is inside a
    // shadow root the document only reports the HOST, and calling focus() on a
    // host with no tabindex silently drops focus to <body> — which is exactly
    // the bug this restore exists to prevent.
    var opener = root.activeElement || document.activeElement;

    // Built with DOM calls rather than innerHTML: the context keys and request
    // URLs below come from the host page, and must never be parsed as markup.
    //
    // ids are generated per-form. A shadow root is its own id scope, so these
    // cannot collide with the host page no matter what it contains — which is
    // what makes htmlFor safe to use in an injected widget.
    var uid = 0;
    function field(labelText, node) {
      var id = "lb-f" + ++uid;
      node.id = id;
      var label = mk("label", null, labelText);
      label.htmlFor = id;
      form.appendChild(label);
      form.appendChild(node);
      return node;
    }
    function select(className, options, selected) {
      var sel = mk("select", className);
      options.forEach(function (value) {
        var opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        if (value === selected) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    }
    var titleInput = field("Title", mk("input", "f-title"));
    titleInput.placeholder = "What is wrong here?";
    field("What happened", mk("textarea", "f-got"));
    field("What you expected", mk("textarea", "f-want"));

    // Same id/htmlFor pairing inside the two-up row.
    function cell(labelText, node) {
      var wrap = mk("div");
      var id = "lb-f" + ++uid;
      node.id = id;
      var label = mk("label", null, labelText);
      label.htmlFor = id;
      wrap.appendChild(label);
      wrap.appendChild(node);
      return wrap;
    }
    var row = mk("div", "row");
    row.appendChild(cell("Type", select("f-type", ["ui", "backend", "usage", "ux"], guessType)));
    row.appendChild(cell("Severity", select("f-sev", ["p0", "p1", "p2", "p3"], "p2")));
    form.appendChild(row);

    // These are status notes, not labels — they label no control. They were
    // <label> elements only to inherit the 11px type rule, which now lives on
    // .note instead.
    if (ctx) {
      form.appendChild(
        mk(
          "div",
          "note note-ctx",
          "✓ AI/automation context attached (" + Object.keys(ctx).slice(0, 3).join(", ") + ")",
        ),
      );
    }
    if (failedNet.length) {
      var last = failedNet[failedNet.length - 1];
      form.appendChild(
        mk(
          "div",
          "note note-net",
          "✓ " + failedNet.length + " failed request(s) attached (latest: " +
            (last.status || "ERR") + " " + last.url.split("?")[0].slice(-40) + ")",
        ),
      );
    }

    var actions = mk("div", "actions");
    actions.appendChild(mk("button", "cancel", "Cancel"));
    actions.appendChild(mk("button", "primary send", "Send"));
    form.appendChild(actions);
    ui.appendChild(form);
    form.querySelector(".f-title").focus();

    function closeForm() {
      form.remove();
      document.removeEventListener("keydown", onFormKey, true);
      window.removeEventListener("resize", placeForm);
      // Send focus back where it came from; otherwise it falls to <body> and a
      // keyboard user restarts from the top of the page. Only trust the opener
      // if it is still in the shadow tree — otherwise fall back to the FAB,
      // which is always present.
      var back = opener && root.contains(opener) ? opener : fab;
      if (back && typeof back.focus === "function") back.focus();
    }
    function onFormKey(ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      closeForm();
      announce("Feedback form closed");
    }
    document.addEventListener("keydown", onFormKey, true);

    form.querySelector(".cancel").addEventListener("click", closeForm);
    form.querySelector(".send").addEventListener("click", function () {
      var titleEl = form.querySelector(".f-title");
      var title = titleEl.value.trim();
      if (title.length < 3) {
        // Was a bare toast: silent to assistive tech, no invalid state, no focus
        // move. A screen-reader user got no feedback and no way to find the field.
        titleEl.setAttribute("aria-invalid", "true");
        titleEl.focus();
        toast("Add a short title first", true);
        return;
      }
      titleEl.removeAttribute("aria-invalid");
      var got = form.querySelector(".f-got").value.trim();
      var want = form.querySelector(".f-want").value.trim();
      var body =
        (got ? "What happened: " + got : "") +
        (want ? (got ? "\n" : "") + "Expected: " + want : "");
      var extra = {
        viewport: window.innerWidth + "x" + window.innerHeight,
        user_agent: navigator.userAgent.slice(0, 120),
        element_html: (el.outerHTML || "").slice(0, 800),
      };
      if (ctx) extra.context = ctx;
      var payload = {
        project: PROJECT,
        type: form.querySelector(".f-type").value,
        severity: form.querySelector(".f-sev").value,
        title: title,
        body: body,
        route: location.pathname,
        url: location.href,
        dom_selector: selector,
        source: "widget",
        reporter: "human",
        console: consoleBuf.slice(-15),
        network: networkBuf.slice(-15).map(function (n) {
          var out = { url: n.url, method: n.method, status: n.status, ms: n.ms };
          return out;
        }),
        repro_steps: [],
        extra: extra,
      };
      // response bodies of failures ride along in extra (schema keeps network entries lean)
      if (failedNet.length) {
        extra.failed_responses = failedNet.slice(-3).map(function (n) {
          return {
            url: n.url,
            status: n.status,
            body: n.response_snippet || "",
          };
        });
      }
      // The form stays mounted until the report is SAFELY on the bus. Losing
      // what someone just typed is the one unforgivable failure for a feedback
      // tool, and the hub being down is a normal, expected state.
      var sendBtn = form.querySelector(".send");
      var keepDraft = function (message) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        toast(message, true);
      };
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";

      origFetch(ENDPOINT + "/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json().catch(function () {
            return { ok: false, error: "HTTP " + r.status };
          });
        })
        .then(function (j) {
          if (j && j.ok) {
            closeForm();
            toast("Filed " + j.id + " — an agent will pick it up");
            refreshPins();
            return;
          }
          // Show WHICH field the bus rejected, so the text can be salvaged.
          var issue = j && j.issues && j.issues[0];
          keepDraft(
            issue
              ? "Rejected: " + issue.path + " — " + issue.message + " (your text is kept)"
              : "Loopback rejected this report" +
                  (j && j.error ? " (" + j.error + ")" : "") +
                  " — your text is kept",
          );
        })
        .catch(function () {
          keepDraft(
            "Can't reach Loopback at " + ENDPOINT + " — is the hub running? Your text is kept.",
          );
        });
    });
  }

  // ---------- pin hydration + live status ----------
  var pinEls = [];
  var lastStatuses = {};
  var changedIds = {};
  var baseTitle = null;

  // Page API for tests and agents (window.__domReviewAPI pattern, DOM-Review).
  window.__loopback = {
    version: "0.9.0",
    project: PROJECT,
    endpoint: ENDPOINT,
    pins: [],
    refresh: function () {
      refreshPins();
    },
    // internal, exposed for tests and browser-driving agents
    _cssPath: cssPath,
  };

  // The closing act of every loop (spirit of make-pages-interactive's reload
  // walkthrough): when an agent moves a pin's status, say so on the page —
  // a toast, a pulse on the pin, and a 🔔 in the tab title if you're elsewhere.
  function announceChanges(items) {
    changedIds = {};
    items.forEach(function (item) {
      var prev = lastStatuses[item.id];
      if (prev && prev !== item.status) {
        changedIds[item.id] = true;
        toast(
          "✦ “" + item.title.slice(0, 42) + "” " + prev + " → " + item.status +
            (item.assignee_agent ? " by " + item.assignee_agent : "") +
            (item.links && item.links.pr_url ? " · PR linked" : "")
        );
        if (document.hidden && !baseTitle) {
          baseTitle = document.title;
          document.title = "🔔 " + baseTitle;
        }
      }
      lastStatuses[item.id] = item.status;
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && baseTitle) {
      document.title = baseTitle;
      baseTitle = null;
    }
  });

  function refreshPins() {
    origFetch(
      ENDPOINT +
        "/feedback?project=" +
        encodeURIComponent(PROJECT) +
        "&route=" +
        encodeURIComponent(location.pathname) +
        "&limit=50",
      { method: "GET" }
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var items = data.items || [];
        renderTick++;
        window.__loopback.pins = items;
        announceChanges(items);
        renderPins(items);
        renderPinList(items);
      })
      .catch(function () {});
  }

  // Pin elements are pooled by feedback id and reused across renders.
  var pinPool = {};
  // Bumped once per hydration poll. Negative cache entries live for one tick,
  // so a re-added element is picked up within 10s rather than never.
  var renderTick = 0;
  // Resolved targets are cached too. Pooling the ELEMENT alone still left up to
  // 50 full-document `querySelector` matches per scroll frame against the host
  // page — once layout thrash was gone, selector matching became the dominant
  // per-frame cost. Cache the node and re-resolve only when it leaves the DOM.
  var targetCache = {};

  // Misses are cached too, briefly. /feedback is fetched with no status filter,
  // so long-resolved items whose anchor a fix deleted stay in the payload
  // forever — and an uncached miss re-ran a full-document querySelector on every
  // host scroll frame, exactly the cost this cache exists to remove, growing
  // with project age. Re-checked each poll in case the element comes back.
  var missUntil = {};
  function resolveTarget(item) {
    var cached = targetCache[item.id];
    if (cached && cached.isConnected) return cached;
    // Equality, not >. A miss recorded during tick N is skipped for the rest
    // of tick N and re-checked once the next hydration poll bumps the tick.
    if (missUntil[item.id] === renderTick) return null;
    var found = null;
    try {
      found = document.querySelector(item.dom_selector);
    } catch (e) {}
    if (found) {
      targetCache[item.id] = found;
      delete missUntil[item.id];
    } else {
      delete targetCache[item.id];
      // Skip this selector until the next hydration pass.
      missUntil[item.id] = renderTick;
    }
    return found;
  }

  function pinSummary(item) {
    return (
      "#" + item.id + " · " + item.status +
      (item.assignee_agent ? " · " + item.assignee_agent : "") +
      (item.links && item.links.pr_url ? " · PR linked" : "")
    );
  }

  /**
   * Runs on every scroll frame of the HOST page, so both of its costs are
   * bounded: layout is touched exactly twice (one read pass, then one write
   * pass), and selector matching is cached per item rather than re-run per
   * frame.
   *
   * The previous version interleaved `querySelector` + `getBoundingClientRect`
   * with `appendChild` inside a single loop. Each append invalidates layout, so
   * the next rect read forced a synchronous reflow — up to 50 per frame — and
   * every pin element was destroyed and rebuilt each time. A guest widget has
   * no business degrading its host's scroll performance.
   */
  function renderPins(items) {
    // ---- READ PASS: resolve targets and measure. No DOM mutation here. ----
    var measured = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.dom_selector) continue;
      var target = resolveTarget(item);
      if (!target) continue;
      var r = target.getBoundingClientRect();
      measured.push({ item: item, left: r.right - 10, top: r.top - 10, index: measured.length + 1 });
      seen[item.id] = true;
    }

    // ---- WRITE PASS: create, update, position. No layout reads below. ----
    for (var id in pinPool) {
      if (!seen[id]) {
        pinPool[id].remove();
        delete pinPool[id];
        delete targetCache[id];
        delete missUntil[id];
      }
    }
    pinEls = [];
    for (var m = 0; m < measured.length; m++) {
      var rec = measured[m];
      var it = rec.item;
      var pin = pinPool[it.id];
      if (!pin) {
        // A real <button>: pins were unfocusable divs, so the only way to read
        // a pin's status was to hover it with a mouse.
        pin = document.createElement("button");
        pin.type = "button";
        pin.className = "pin";
        pin.addEventListener("click", makePinHandler(it.id));
        pinPool[it.id] = pin;
        ui.appendChild(pin);
      }
      // Guarded like every write below. textContent and dataset both invalidate
      // layout, and re-assigning an identical value still counts.
      if (pin.dataset.id !== it.id) pin.dataset.id = it.id;
      var label = String(rec.index);
      if (pin.textContent !== label) pin.textContent = label;
      var cls = "pin b-" + it.status;
      // Pulse once per announcement — scroll/resize re-renders must not replay it.
      if (changedIds[it.id]) cls += " pulse";
      if (pin.className !== cls) pin.className = cls;
      var name = "Feedback " + rec.index + ": " + it.status + " — " + it.title;
      if (pin.getAttribute("aria-label") !== name) pin.setAttribute("aria-label", name);
      // Viewport coordinates with position:fixed, NOT document coordinates.
      // An absolutely-positioned pin resolves against the nearest positioned
      // ancestor, so on a centred layout (body{position:relative;margin:0 auto})
      // every pin landed offset by the auto margin — measured 300px off on a
      // 680px centred page. Fixed + viewport coords is immune to the host's
      // layout; scroll/resize already re-render (rAF-throttled).
      // transform, not left/top: position writes force layout + paint on every
      // host scroll frame, while a transform stays on the compositor. The pin
      // is anchored at 0,0 and translated into place.
      var t = "translate3d(" + Math.round(rec.left) + "px," + Math.round(rec.top) + "px,0)";
      if (pin.style.transform !== t) pin.style.transform = t;
      // Off-screen pins leave the tab order entirely. They used to stay
      // focusable at negative coordinates: focus would vanish to a control the
      // user could neither see nor scroll to.
      var visible =
        rec.top > -24 && rec.top < window.innerHeight && rec.left > -24 && rec.left < window.innerWidth;
      var vis = visible ? "" : "none";
      if (pin.style.display !== vis) pin.style.display = vis;
      pinEls.push(pin);
    }
    changedIds = {};
  }

  // Bound once per pin element, so the handler survives reuse across renders
  // and always reports the item currently under that pin.
  function makePinHandler(id) {
    return function () {
      var current = null;
      var list = window.__loopback.pins || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) current = list[i];
      if (current) toast(pinSummary(current));
    };
  }

  function renderPinList(items) {
    pinList.textContent = "";
    if (!items.length) {
      var empty = mk("div", "pinrow", "No feedback on this page yet.");
      empty.style.border = "0";
      pinList.appendChild(empty);
      return;
    }
    items.forEach(function (i) {
      // Real buttons. These were inert <div>s while a comment three hundred
      // lines up justified the 24px pin by calling this list the large-target
      // route to the same actions. It was not a route at all.
      var rowEl = mk("button", "pinrow");
      rowEl.type = "button";
      rowEl.setAttribute("aria-label", i.status + ": " + i.title);
      rowEl.addEventListener("click", function () {
        toast(pinSummary(i));
      });
      rowEl.appendChild(mk("span", "badge b-" + i.status, i.status));
      // Titles are reporter-authored text — appended as text, never markup.
      rowEl.appendChild(document.createTextNode(i.title));
      if (i.assignee_agent) {
        rowEl.appendChild(mk("small", null, " · " + i.assignee_agent));
      }
      pinList.appendChild(rowEl);
    });
  }

  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderPins(window.__loopback.pins);
    });
  }
  window.addEventListener("scroll", scheduleRender);
  window.addEventListener("resize", scheduleRender);

  // SPA route changes (Next/React routers): refresh immediately instead of
  // leaving the previous route's pins up until the next poll tick.
  // Debounced, and only when the PATH actually changed.
  //
  // This fired one full /feedback fetch per call with neither guard: measured
  // 200 calls producing 200 fetches, every one with an identical pathname. Any
  // host that syncs state into the URL — the hub's own dashboard writes filters
  // and the search term on a keystroke debounce — turned this into a fetch
  // storm against the hub. Pins are keyed on the route, so a same-path call
  // cannot change what they render.
  var lastPath = location.pathname;
  var routeTimer = null;
  function onRouteChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    clearTimeout(routeTimer);
    routeTimer = setTimeout(refreshPins, 120);
  }
  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    if (!orig) return;
    history[fn] = function () {
      var out = orig.apply(this, arguments);
      setTimeout(onRouteChange, 0);
      return out;
    };
  });
  window.addEventListener("popstate", function () {
    setTimeout(refreshPins, 50);
  });
})();
