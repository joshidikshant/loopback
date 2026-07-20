/*!
 * Loopback capture widget v0.5.0 (MIT)
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
  var ENDPOINT =
    (script && script.dataset.endpoint) || "http://127.0.0.1:7077";
  var PROJECT = (script && script.dataset.project) || "unknown-project";
  var POLL_MS = 10000;
  var MAX_BODY = 2048;

  // ---------- ring buffers: console + network ----------
  var consoleBuf = [];
  var networkBuf = [];

  function pushConsole(level, args) {
    try {
      var text = Array.prototype.map
        .call(args, function (a) {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch (e) {
            return String(a);
          }
        })
        .join(" ");
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
  var TOKENS =
    ":host{all:initial}" +
    ".lb-root{display:contents;color-scheme:light;" +
    "--lb-bg:oklch(1 0 0);--lb-fg:oklch(0.145 0 0);" +
    "--lb-muted:oklch(0.97 0 0);--lb-muted-fg:oklch(0.556 0 0);" +
    "--lb-border:oklch(0.922 0 0);--lb-input:oklch(0.922 0 0);" +
    "--lb-primary:oklch(0.205 0 0);--lb-primary-fg:oklch(0.985 0 0);" +
    "--lb-ring:oklch(0.708 0 0);--lb-radius:0.625rem;" +
    "--lb-open:oklch(0.555 0.163 48.998);--lb-triaged:oklch(0.555 0.163 48.998);" +
    "--lb-in-progress:oklch(0.488 0.243 264.376);" +
    "--lb-fixed:oklch(0.508 0.118 165.612);--lb-verified:oklch(0.508 0.118 165.612);" +
    "--lb-wontfix:oklch(0.551 0.027 264.364);--lb-on-status:oklch(0.985 0 0);" +
    "--lb-highlight:oklch(0.488 0.243 264.376);" +
    "--lb-shadow-sm:0 2px 8px rgb(0 0 0/0.18);--lb-shadow-md:0 4px 14px rgb(0 0 0/0.22);" +
    "--lb-shadow-lg:0 10px 32px rgb(0 0 0/0.2);" +
    "--lb-font:system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "@media (prefers-color-scheme:dark){.lb-root{color-scheme:dark;" +
    "--lb-bg:oklch(0.205 0 0);--lb-fg:oklch(0.985 0 0);" +
    "--lb-muted:oklch(0.269 0 0);--lb-muted-fg:oklch(0.708 0 0);" +
    "--lb-border:oklch(1 0 0/15%);--lb-input:oklch(1 0 0/20%);" +
    "--lb-primary:oklch(0.922 0 0);--lb-primary-fg:oklch(0.205 0 0);" +
    "--lb-ring:oklch(0.556 0 0);" +
    "--lb-open:oklch(0.828 0.189 84.429);--lb-triaged:oklch(0.828 0.189 84.429);" +
    "--lb-in-progress:oklch(0.707 0.165 254.624);" +
    "--lb-fixed:oklch(0.765 0.177 163.223);--lb-verified:oklch(0.765 0.177 163.223);" +
    "--lb-wontfix:oklch(0.707 0.022 261.325);--lb-on-status:oklch(0.205 0 0);" +
    "--lb-highlight:oklch(0.707 0.165 254.624);" +
    "--lb-shadow-sm:0 2px 8px rgb(0 0 0/0.5);--lb-shadow-md:0 4px 14px rgb(0 0 0/0.55);" +
    "--lb-shadow-lg:0 10px 32px rgb(0 0 0/0.6)}}";

  var RADIUS_MD = "calc(var(--lb-radius) * 0.8)";
  var RADIUS_SM = "calc(var(--lb-radius) * 0.6)";

  // Style is set as textContent on a <style> element, and the shell is built
  // with DOM calls — no innerHTML anywhere the host page can reach.
  var styleEl = document.createElement("style");
  styleEl.textContent =
    TOKENS +
    "*{box-sizing:border-box;font-family:var(--lb-font)}" +
    ".fab{position:fixed;bottom:18px;right:18px;z-index:2147483000;background:var(--lb-primary);color:var(--lb-primary-fg);border:none;border-radius:999px;padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;box-shadow:var(--lb-shadow-md)}" +
    ".fab:focus-visible{outline:2px solid var(--lb-ring);outline-offset:2px}" +
    ".fab.pinmode{background:var(--lb-in-progress);color:var(--lb-on-status)}" +
    ".panel{position:fixed;bottom:64px;right:18px;z-index:2147483000;width:290px;background:var(--lb-bg);border:1px solid var(--lb-border);border-radius:var(--lb-radius);box-shadow:var(--lb-shadow-lg);padding:12px;display:none;color:var(--lb-fg)}" +
    ".panel.open{display:block}" +
    ".panel h3{margin:0 0 8px;font-size:13px;font-weight:600}" +
    ".panel button{width:100%;margin:4px 0;padding:8px;border-radius:" + RADIUS_MD + ";border:1px solid var(--lb-border);background:var(--lb-bg);color:var(--lb-fg);cursor:pointer;font-size:13px;font-weight:500}" +
    ".panel button:hover{background:var(--lb-muted)}" +
    ".pinlist{margin:8px 0 0;max-height:180px;overflow:auto;font-size:12px}" +
    ".pinrow{padding:6px;border-radius:" + RADIUS_SM + ";border:1px solid var(--lb-border);margin:4px 0;color:var(--lb-fg)}" +
    ".pinrow small{color:var(--lb-muted-fg)}" +
    ".badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;color:var(--lb-on-status);margin-right:6px}" +
    ".b-open{background:var(--lb-open)}.b-triaged{background:var(--lb-triaged)}" +
    ".b-in_progress{background:var(--lb-in-progress)}.b-fixed{background:var(--lb-fixed)}" +
    ".b-verified{background:var(--lb-verified)}.b-wontfix{background:var(--lb-wontfix)}" +
    ".hl{position:fixed;z-index:2147482998;pointer-events:none;border:2px solid var(--lb-highlight);border-radius:" + RADIUS_SM + ";background:color-mix(in oklch,var(--lb-highlight) 10%,transparent)}" +
    ".form{position:fixed;z-index:2147483001;width:300px;max-height:min(72vh,460px);overflow:auto;background:var(--lb-bg);border:1px solid var(--lb-border);border-radius:var(--lb-radius);box-shadow:var(--lb-shadow-lg);padding:12px;color:var(--lb-fg)}" +
    ".form input,.form textarea,.form select{width:100%;margin:3px 0 8px;padding:7px;border:1px solid var(--lb-input);border-radius:" + RADIUS_MD + ";font-size:13px;background:var(--lb-bg);color:var(--lb-fg);font-family:inherit}" +
    ".form input:focus-visible,.form textarea:focus-visible,.form select:focus-visible{outline:2px solid var(--lb-ring);outline-offset:-1px}" +
    ".form textarea{height:52px;resize:vertical}" +
    ".form label{font-size:11px;font-weight:500;color:var(--lb-muted-fg)}" +
    ".form .note-ctx{color:var(--lb-fixed)}.form .note-net{color:var(--lb-open)}" +
    ".row{display:flex;gap:6px}.row>*{flex:1}" +
    ".actions{display:flex;gap:8px;margin-top:4px}" +
    ".actions button{flex:1;padding:8px;border-radius:" + RADIUS_MD + ";border:1px solid var(--lb-border);background:var(--lb-bg);color:var(--lb-fg);cursor:pointer;font-size:13px;font-weight:500}" +
    ".actions button:hover{background:var(--lb-muted)}" +
    ".actions .primary{background:var(--lb-primary);color:var(--lb-primary-fg);border-color:transparent}" +
    ".pin{position:absolute;z-index:2147482999;width:22px;height:22px;border-radius:999px 999px 999px 4px;background:var(--lb-primary);color:var(--lb-on-status);font-size:11px;font-weight:600;line-height:22px;text-align:center;cursor:pointer;box-shadow:var(--lb-shadow-sm)}" +
    ".pin.b-open{background:var(--lb-open)}.pin.b-triaged{background:var(--lb-triaged)}" +
    ".pin.b-in_progress{background:var(--lb-in-progress)}.pin.b-fixed{background:var(--lb-fixed)}" +
    ".pin.b-verified{background:var(--lb-verified)}.pin.b-wontfix{background:var(--lb-wontfix)}" +
    ".toast{position:fixed;bottom:70px;right:18px;z-index:2147483002;background:var(--lb-primary);color:var(--lb-primary-fg);padding:9px 14px;border-radius:" + RADIUS_MD + ";font-size:12.5px;box-shadow:var(--lb-shadow-md);max-width:320px}" +
    ".pin.pulse{animation:lbpulse 1.1s ease-out 3}" +
    "@keyframes lbpulse{from{box-shadow:0 0 0 0 var(--lb-ring)}to{box-shadow:0 0 0 13px rgb(0 0 0/0)}}";
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

  var fab = mk("button", "fab", "✦ Feedback");
  fab.setAttribute("part", "fab");
  var panel = mk("div", "panel");
  // textContent, not string concatenation: the project slug comes from the
  // host page's script tag and never gets parsed as markup.
  panel.appendChild(mk("h3", null, "Loopback — " + PROJECT));
  var pinBtn = mk("button", "pinbtn", "📍 Pin feedback on an element");
  var pinList = mk("div", "pinlist");
  panel.appendChild(pinBtn);
  panel.appendChild(pinList);
  ui.appendChild(fab);
  ui.appendChild(panel);

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
    panel.classList.toggle("open");
  });
  pinBtn.addEventListener("click", function () {
    panel.classList.remove("open");
    enterPinMode();
  });

  var toastCount = 0;
  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.style.bottom = 70 + toastCount * 44 + "px";
    toastCount++;
    el.textContent = msg;
    ui.appendChild(el);
    setTimeout(function () {
      el.remove();
      toastCount = Math.max(0, toastCount - 1);
    }, 3800);
  }

  // ---------- pin mode ----------
  var pinMode = false;
  var highlight = null;

  function enterPinMode() {
    pinMode = true;
    fab.classList.add("pinmode");
    fab.textContent = "✕ Cancel pin";
    highlight = document.createElement("div");
    highlight.className = "hl";
    ui.appendChild(highlight);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onPick, true);
  }
  function exitPinMode() {
    pinMode = false;
    fab.classList.remove("pinmode");
    fab.textContent = "✦ Feedback";
    if (highlight) highlight.remove();
    highlight = null;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onPick, true);
  }
  function onMove(ev) {
    if (ev.composedPath().indexOf(host) !== -1) {
      highlight.style.display = "none";
      return;
    }
    var el = ev.target;
    var r = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = r.left - 2 + "px";
    highlight.style.top = r.top - 2 + "px";
    highlight.style.width = r.width + "px";
    highlight.style.height = r.height + "px";
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
    form.style.left = Math.max(8, Math.min(x, window.innerWidth - 320)) + "px";
    form.style.top =
      Math.max(8, Math.min(y + 10, window.innerHeight - Math.min(window.innerHeight * 0.72, 460) - 20)) + "px";
    // Built with DOM calls rather than innerHTML: the context keys and request
    // URLs below come from the host page, and must never be parsed as markup.
    function field(labelText, node) {
      form.appendChild(mk("label", null, labelText));
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

    var row = mk("div", "row");
    var typeCell = mk("div");
    typeCell.appendChild(mk("label", null, "Type"));
    typeCell.appendChild(select("f-type", ["ui", "backend", "usage", "ux"], guessType));
    var sevCell = mk("div");
    sevCell.appendChild(mk("label", null, "Severity"));
    sevCell.appendChild(select("f-sev", ["p0", "p1", "p2", "p3"], "p2"));
    row.appendChild(typeCell);
    row.appendChild(sevCell);
    form.appendChild(row);

    if (ctx) {
      form.appendChild(
        mk(
          "label",
          "note-ctx",
          "✓ AI/automation context attached (" + Object.keys(ctx).slice(0, 3).join(", ") + ")",
        ),
      );
    }
    if (failedNet.length) {
      var last = failedNet[failedNet.length - 1];
      form.appendChild(
        mk(
          "label",
          "note-net",
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
    form.querySelector(".cancel").addEventListener("click", function () {
      form.remove();
    });
    form.querySelector(".send").addEventListener("click", function () {
      var title = form.querySelector(".f-title").value.trim();
      if (title.length < 3) {
        toast("Add a short title first");
        return;
      }
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
      origFetch(ENDPOINT + "/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          form.remove();
          if (j.ok) {
            toast("Filed " + j.id + " — an agent will pick it up");
            refreshPins();
          } else {
            toast("Loopback rejected the payload");
          }
        })
        .catch(function () {
          form.remove();
          toast("Could not reach Loopback at " + ENDPOINT);
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
    version: "0.5.0",
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
        window.__loopback.pins = items;
        announceChanges(items);
        renderPins(items);
        renderPinList(items);
      })
      .catch(function () {});
  }

  function renderPins(items) {
    pinEls.forEach(function (p) {
      p.remove();
    });
    pinEls = [];
    items.forEach(function (item, idx) {
      if (!item.dom_selector) return;
      var target = null;
      try {
        target = document.querySelector(item.dom_selector);
      } catch (e) {}
      if (!target) return;
      var r = target.getBoundingClientRect();
      var pin = document.createElement("div");
      pin.className = "pin b-" + item.status;
      pin.textContent = String(idx + 1);
      pin.title = "[" + item.status + "] " + item.title;
      pin.style.left = window.scrollX + r.right - 10 + "px";
      pin.style.top = window.scrollY + r.top - 10 + "px";
      // Colour comes from the .b-<status> class, not an inline style, so the
      // status palette lives in one place and follows light/dark with it.
      if (changedIds[item.id]) pin.classList.add("pulse");
      pin.addEventListener("click", function () {
        toast(
          "#" + item.id + " · " + item.status +
            (item.assignee_agent ? " · " + item.assignee_agent : "") +
            (item.links && item.links.pr_url ? " · PR linked" : "")
        );
      });
      ui.appendChild(pin);
      pinEls.push(pin);
    });
    // Pulse once per announcement — scroll/resize re-renders must not replay it.
    changedIds = {};
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
      var rowEl = mk("div", "pinrow");
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
  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    if (!orig) return;
    history[fn] = function () {
      var out = orig.apply(this, arguments);
      setTimeout(refreshPins, 50);
      return out;
    };
  });
  window.addEventListener("popstate", function () {
    setTimeout(refreshPins, 50);
  });
})();
