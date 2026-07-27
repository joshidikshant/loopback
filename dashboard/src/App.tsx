import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { QueueList } from "@/views/QueueList";
import { ItemDetail } from "@/views/ItemDetail";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Moon, Sun } from "lucide-react";

/**
 * Routing without a router dependency: the hub serves this SPA for /queue and
 * /queue/:id, so the only thing to decide is "list or detail".
 */
function useRoute(): { id: string | null; navigate: (to: string) => void } {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    setPath(new URL(to, window.location.origin).pathname);
  }, []);
  const match = /^\/queue\/(.+)$/.exec(path);
  const id = match ? decodeURIComponent(match[1]) : null;

  // A client-side route change is invisible to assistive tech: the URL moves,
  // the title does not, and focus stays wherever the click left it. Updating
  // the title gives the change a name; moving focus to the new <main> gives a
  // screen-reader user somewhere to continue reading from.
  useEffect(() => {
    document.title = id ? `${id} — Loopback` : "Loopback queue";
    const main = document.getElementById("lb-main");
    if (main) main.focus({ preventScroll: true });
  }, [id]);

  return { id, navigate };
}

function ThemeToggle(): React.JSX.Element {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      className="size-11"
      onClick={() => {
        const next = document.documentElement.classList.toggle("dark");
        try {
          localStorage.setItem("lb-theme", next ? "dark" : "light");
        } catch {
          /* private mode */
        }
        setDark(next);
      }}
      // aria-pressed states WHICH theme is on. "Toggle theme" alone never told
      // you what you were currently in, only that a toggle existed.
      aria-pressed={dark}
      aria-label={dark ? "Dark theme on. Switch to light." : "Light theme on. Switch to dark."}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export default function App(): React.JSX.Element {
  const { id, navigate } = useRoute();
  // Tooltip in this shadcn version is a bare Radix Root with no built-in
  // provider, so the whole tree needs one or every <Tooltip> throws.
  return (
    <TooltipProvider delayDuration={200}>
      {/* A real landmark. There was none, so "skip to content" and landmark
          navigation had nothing to target. tabIndex={-1} is what lets the route
          change move focus here without putting it in the tab order. */}
      <main
        id="lb-main"
        tabIndex={-1}
        className="mx-auto max-w-[1180px] px-4 py-8 outline-none sm:px-6"
      >
        {id ? (
          <ItemDetail id={id} navigate={navigate} themeToggle={<ThemeToggle />} />
        ) : (
          <QueueList navigate={navigate} themeToggle={<ThemeToggle />} />
        )}
      </main>
      {/* OUTSIDE <main>, and out of the forward tab flow.
          Sonner makes each toast a tabindex=0 list item and restores focus on
          blur; inside the landmark that meant Tab cycled between the last
          control and the toast forever, with the dismiss timer paused the whole
          time. Sonner's own hotkey still reaches them deliberately. */}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
