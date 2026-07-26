import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { QueueList } from "@/views/QueueList";
import { ItemDetail } from "@/views/ItemDetail";
import { Button } from "@/components/ui/button";
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
  return { id: match ? decodeURIComponent(match[1]) : null, navigate };
}

function ThemeToggle(): React.JSX.Element {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const next = document.documentElement.classList.toggle("dark");
        try {
          localStorage.setItem("lb-theme", next ? "dark" : "light");
        } catch {
          /* private mode */
        }
        setDark(next);
      }}
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export default function App(): React.JSX.Element {
  const { id, navigate } = useRoute();
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      {id ? (
        <ItemDetail id={id} navigate={navigate} themeToggle={<ThemeToggle />} />
      ) : (
        <QueueList navigate={navigate} themeToggle={<ThemeToggle />} />
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}
