/*!
 * Loopback capture widget v0.3.1 (MIT)
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
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}" +
    ".fab{position:fixed;bottom:18px;right:18px;z-index:2147483000;background:#111;color:#fff;border:none;border-radius:999px;padding:10px 16px;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}" +
    ".fab.pinmode{background:#1d4ed8}" +
    ".panel{position:fixed;bottom:64px;right:18px;z-index:2147483000;width:290px;background:#fff;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.18);padding:12px;display:none;color:#111}" +
    ".panel.open{display:block}" +
    ".panel h3{margin:0 0 8px;font-size:13px}" +
    ".panel button{width:100%;margin:4px 0;padding:8px;border-radius:8px;border:1px solid #d4d4d8;background:#fafafa;cursor:pointer;font-size:13px}" +
    ".panel button:hover{background:#f0f0f1}" +
    ".pinlist{margin:8px 0 0;max-height:180px;overflow:auto;font-size:12px}" +
    ".pinrow{padding:6px;border-radius:6px;border:1px solid #eee;margin:4px 0}" +
    ".badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;color:#fff;margin-right:6px}" +
    ".b-open{background:#b45309}.b-in_progress{background:#1d4ed8}.b-fixed{background:#047857}.b-verified{background:#047857}.b-wontfix{background:#6b7280}" +
    ".hl{position:fixed;z-index:2147482998;pointer-events:none;border:2px solid #1d4ed8;border-radius:4px;background:rgba(29,78,216,.08)}" +
    ".form{position:fixed;z-index:2147483001;width:300px;max-height:min(72vh,460px);overflow:auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.2);padding:12px;color:#111}" +
    ".form input,.form textarea,.form select{width:100%;margin:3px 0 8px;padding:7px;border:1px solid #d4d4d8;border-radius:7px;font-size:13px}" +
    ".form textarea{height:52px;resize:vertical}" +
    ".form label{font-size:11px;color:#555}" +
    ".row{display:flex;gap:6px}.row>*{flex:1}" +
    ".actions{display:flex;gap:8px;margin-top:4px}" +
    ".actions .primary{background:#111;color:#fff;border:none}" +
    ".actions button{flex:1;padding:8px;border-radius:8px;border:1px solid #d4d4d8;background:#fafafa;cursor:pointer;font-size:13px}" +
    ".pin{position:absolute;z-index:2147482999;width:22px;height:22px;border-radius:999px 999px 999px 4px;color:#fff;font-size:11px;line-height:22px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);transform:rotate(0deg)}" +
    ".toast{position:fixed;bottom:70px;right:18px;z-index:2147483002;background:#111;color:#fff;padding:9px 14px;border-radius:8px;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:320px}" +
    ".pin.pulse{animation:lbpulse 1.1s ease-out 3}" +
    "@keyframes lbpulse{from{box-shadow:0 0 0 0 var(--lb-ring,rgba(17,17,17,.45))}to{box-shadow:0 0 0 13px rgba(0,0,0,0)}}" +
    // The widget owns its scheme: host pages setting color-scheme:dark must not
    // flip UA control colors inside the shadow root (white-on-white buttons).
    ".panel,.form,.toast{color-scheme:light}" +
    ".panel button,.actions button,.form input,.form textarea,.form select{color:#111}" +
    ".form input,.form textarea,.form select{background:#fff}" +
    "</style>" +
    '<button class="fab" part="fab">✦ Feedback</button>' +
    '<div class="panel"><h3>Loopback — ' +
    PROJECT.replace(/</g, "&lt;") +
    "</h3>" +
    '<button class="pinbtn">📍 Pin feedback on an element</button>' +
    '<div class="pinlist"></div></div>';
  var fab = root.querySelector(".fab");
  var panel = root.querySelector(".panel");
  var pinBtn = root.querySelector(".pinbtn");
  var pinList = root.querySelector(".pinlist");

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
    root.appendChild(el);
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
    root.appendChild(highlight);
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
    form.innerHTML =
      "<label>Title</label><input class='f-title' placeholder='What is wrong here?'>" +
      "<label>What happened</label><textarea class='f-got'></textarea>" +
      "<label>What you expected</label><textarea class='f-want'></textarea>" +
      "<div class='row'><div><label>Type</label><select class='f-type'>" +
      ["ui", "backend", "usage", "ux"]
        .map(function (t) {
          return (
            "<option value='" + t + "'" + (t === guessType ? " selected" : "") + ">" + t + "</option>"
          );
        })
        .join("") +
      "</select></div><div><label>Severity</label><select class='f-sev'>" +
      ["p0", "p1", "p2", "p3"]
        .map(function (s) {
          return "<option" + (s === "p2" ? " selected" : "") + ">" + s + "</option>";
        })
        .join("") +
      "</select></div></div>" +
      (ctx
        ? "<label style='color:#047857'>✓ AI/automation context attached (" +
          Object.keys(ctx).slice(0, 3).join(", ") +
          ")</label>"
        : "") +
      (failedNet.length
        ? "<label style='color:#b45309'>✓ " +
          failedNet.length +
          " failed request(s) attached (latest: " +
          (failedNet[failedNet.length - 1].status || "ERR") +
          " " +
          failedNet[failedNet.length - 1].url.split("?")[0].slice(-40) +
          ")</label>"
        : "") +
      "<div class='actions'><button class='cancel'>Cancel</button><button class='primary send'>Send</button></div>";
    root.appendChild(form);
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
    version: "0.3.1",
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
      var colors = {
        open: "#b45309",
        triaged: "#b45309",
        in_progress: "#1d4ed8",
        fixed: "#047857",
        verified: "#047857",
        wontfix: "#6b7280",
      };
      pin.style.background = colors[item.status] || "#111";
      if (changedIds[item.id]) {
        pin.style.setProperty("--lb-ring", (colors[item.status] || "#111111") + "88");
        pin.classList.add("pulse");
      }
      pin.addEventListener("click", function () {
        toast(
          "#" + item.id + " · " + item.status +
            (item.assignee_agent ? " · " + item.assignee_agent : "") +
            (item.links && item.links.pr_url ? " · PR linked" : "")
        );
      });
      root.appendChild(pin);
      pinEls.push(pin);
    });
    // Pulse once per announcement — scroll/resize re-renders must not replay it.
    changedIds = {};
  }

  function renderPinList(items) {
    pinList.innerHTML = items.length
      ? items
          .map(function (i) {
            return (
              "<div class='pinrow'><span class='badge b-" + i.status + "'>" + i.status + "</span>" +
              i.title.replace(/</g, "&lt;") +
              (i.assignee_agent ? " <small>· " + i.assignee_agent + "</small>" : "") +
              "</div>"
            );
          })
          .join("")
      : "<div style='color:#777;padding:6px'>No feedback on this page yet.</div>";
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
