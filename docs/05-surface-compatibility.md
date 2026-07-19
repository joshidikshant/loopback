# 05 · Surface compatibility — where Loopback works, today and next

*Added 2026-07-20, after the first real-world dogfood run. Answers: which
surfaces can feed the queue, what each gets, and what it takes.*

## The invariant that makes this possible

Loopback's core is **not the widget** — it is a project-tagged queue with two
transport-agnostic doors:

1. **`POST /ingest`** — plain JSON over HTTP. Anything that can make an HTTP
   request is a producer: a browser, a Swift app, a shell script, a CI job.
2. **MCP tools** (`loopback_*`) — how agents read and write the loop.

The widget is just the richest producer (auto-context + on-page green pins).
Every other surface plugs into the same queue by choosing a door. Compatibility
is therefore tiered by *how feedback gets captured*, never by whether the queue
works — it always does.

## The three tiers

**Tier 1 — widget-native (full experience: pins, auto-context, visible green).**
Anything with a DOM.

**Tier 2 — ingest-native (full queue + agent loop; hand-built context; status
via `/queue`, not pins).** Anything that can POST JSON.

**Tier 3 — borrowed rails (auto-captured production signal).** Sentry/PostHog
SDKs capture; their MCPs or a bridge feed the queue. This was the
build-vs-borrow decision (doc 02) — Loopback deliberately does not rebuild
crash/replay capture.

## Surface matrix

| Surface | Tier | Works today? | How |
|---|---|---|---|
| **Web app** (any framework, dev or deployed) | 1 | ✅ | One script tag (or runtime injection/bookmarklet for zero-touch trials) |
| **Browser extension** (MV3) | 1 | ✅ | **Bundle `widget/loopback-widget.js` into the extension** — MV3 CSP + store policy forbid remote scripts, so copy the file, don't hotlink. Works in popup/options pages; a content-script build can pin on any page (DOM-Review's model) |
| **Electron / Tauri desktop** (Mac·Win·Linux) | 1 | ✅ | Renderer is a browser — bundle the widget file, endpoint `127.0.0.1:7077` |
| **WebView inside a native app** (WKWebView / Android WebView) | 1 | ✅ | Widget inside the webview; native shell unaffected |
| **Native macOS / Windows** (SwiftUI·AppKit / WinUI·WPF) | 2 | ✅ | No DOM → no pins. A ~10-line debug-menu/hotkey handler POSTs `/ingest` with `route`=screen name, `console`=log tail, `extra`=build info (snippets below) |
| **iOS / Android — simulator & emulator** | 2 | ✅ | iOS simulator shares the host's loopback; Android: `adb reverse tcp:7077 tcp:7077`. Then POST `/ingest` from a shake gesture or debug menu |
| **iOS / Android — physical device on LAN** | 2 | ✅ v0.4.0 | Run the hub with `--host 0.0.0.0` (opt-in; **no auth — trusted networks only**, the server warns loudly) and point the app at `http://<mac-ip>:7077` |
| **iOS / Android — production** | 3 | ✅ via rails | Sentry SDK (crashes/errors) + PostHog SDK (replays/analytics) in the app; agents reach them via their MCPs today; a scheduled bridge into `/ingest` (`source: "sentry"|"posthog"`) is the roadmap ingestor |
| **CLI / TUI / scripts / CI / cron** | 2 | ✅ | `curl -X POST :7077/ingest` with `reporter:"system"` — this repo's own CI-adjacent path; how the dogfood run filed most items |
| **Coding agents / LLM automations** | 2 | ✅ | MCP tools directly (`reporter:"agent"`), or `/ingest` with `extra.context` run metadata — the `data-loopback-context` pattern, hand-rolled |
| **Figma / design files / docs** | — | ✖ not a goal | Comment systems there are closed or have their own ecosystems; revisit only if a real workflow demands it |

## Native snippets (Tier 2 — copy, adjust, ship a debug menu item)

**Swift (macOS/iOS)**

```swift
func fileLoopback(title: String, body: String) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:7077/ingest")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
        "project": "my-mac-app", "type": "ui", "title": title, "body": body,
        "route": String(describing: type(of: currentScreen)),
        "console": recentLogTail(), // your ring buffer
        "extra": ["build": Bundle.main.infoDictionary?["CFBundleVersion"] ?? "?",
                  "os": ProcessInfo.processInfo.operatingSystemVersionString]
    ])
    URLSession.shared.dataTask(with: req).resume()
}
```

**Kotlin (Android — emulator: `10.0.2.2`, device via `adb reverse`: `127.0.0.1`)**

```kotlin
fun fileLoopback(title: String, body: String) = thread {
    val json = JSONObject(mapOf(
        "project" to "my-android-app", "type" to "ui",
        "title" to title, "body" to body,
        "route" to currentActivityName(),
        "extra" to mapOf("build" to BuildConfig.VERSION_NAME)
    ))
    (URL("http://10.0.2.2:7077/ingest").openConnection() as HttpURLConnection).run {
        requestMethod = "POST"; doOutput = true
        setRequestProperty("Content-Type", "application/json")
        outputStream.write(json.toString().toByteArray()); responseCode
    }
}
```

**C# (Windows — WinUI/WPF)**

```csharp
async Task FileLoopback(string title, string body) {
    using var http = new HttpClient();
    await http.PostAsJsonAsync("http://127.0.0.1:7077/ingest", new {
        project = "my-win-app", type = "ui", title, body,
        route = CurrentViewName(),
        extra = new { build = Assembly.GetExecutingAssembly().GetName().Version?.ToString() }
    });
}
```

**Anything with a shell**

```bash
curl -s -X POST http://127.0.0.1:7077/ingest -H 'Content-Type: application/json' \
  -d '{"project":"my-cli","type":"backend","title":"nightly job failed",
       "body":"exit 3 on step 4","reporter":"system","source":"other"}'
```

## What each tier gets back

| | Capture context | Status write-back |
|---|---|---|
| Tier 1 | Automatic (selector, console, failed bodies, run metadata) | **Pins turn green on the page**, live toasts |
| Tier 2 | Whatever the snippet sends (make it good: logs tail, screen, build) | `/queue`, agent comments; push notifications are a roadmap item |
| Tier 3 | The rails' own capture (stack traces, replays) | Resolution lives in Loopback; the rails keep their own state |

## Honest edges

- `--host 0.0.0.0` has **no authentication** — the server prints a warning;
  use it for device testing on networks you trust, and front it with a
  token-gated reverse proxy for anything else. A built-in bearer token is the
  next security milestone before any non-LAN exposure.
- Native surfaces get no pins by design — pins are a DOM concept. The visible
  loop for Tier 2 is the `/queue` page (and, later, notifications).
- Per the project's own rules (three manual reps before automating): native
  shake-to-report SDK packages get built only after real native apps have
  actually used these snippets three times.
