import { Activity, CircleHelp, Monitor, Moon, Settings2, Sun, Wifi, WifiOff } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useTheme } from "./theme-provider";
import {
  loadAboutPage,
  loadMonitoringPage,
  loadSettingsPage,
} from "../lib/page-loaders";

export type Page = "monitoring" | "settings" | "about";

/** Prefetch a split page chunk on hover/focus so navigation feels instant. */
function prefetch(loader: () => Promise<unknown>) {
  void loader().catch(() => undefined);
}

const PAGE_PRELOADS: Record<Page, () => void> = {
  monitoring: () => prefetch(loadMonitoringPage),
  settings: () => prefetch(loadSettingsPage),
  about: () => prefetch(loadAboutPage),
};

export function AppHeader({
  activePage,
  onNavigate,
  connectedAgentCount,
}: {
  activePage: Page;
  onNavigate: (page: Page) => void;
  connectedAgentCount: number;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <header className="relative flex h-14 shrink-0 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Monitor className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">MSM Viewer</p>
          <p className="text-[11px] text-muted-foreground">
            Remote workstation management
          </p>
        </div>
      </div>
      <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        {(
          [
            { page: "monitoring", icon: Activity, label: "Monitoring" },
            { page: "settings", icon: Settings2, label: "Settings" },
            { page: "about", icon: CircleHelp, label: "About" },
          ] as const
        ).map(({ page, icon: Icon, label }) => (
          <Button
            key={page}
            variant={activePage === page ? "secondary" : "ghost"}
            size="sm"
            onMouseEnter={() => PAGE_PRELOADS[page]()}
            onFocus={() => PAGE_PRELOADS[page]()}
            onClick={() => onNavigate(page)}
          >
            <Icon className="h-4 w-4" /> {label}
          </Button>
        ))}
      </nav>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
        <Badge
          variant={connectedAgentCount ? "default" : "outline"}
          className="gap-1.5"
        >
          {connectedAgentCount ? (
            <Wifi className="h-3 w-3" />
          ) : (
            <WifiOff className="h-3 w-3" />
          )}
          {connectedAgentCount} agent{connectedAgentCount === 1 ? "" : "s"}{" "}
          connected
        </Badge>
      </div>
    </header>
  );
}
