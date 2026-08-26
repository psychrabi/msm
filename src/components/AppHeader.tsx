import { Activity, CircleHelp, Monitor, Settings2, Wifi, WifiOff } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export type Page = "monitoring" | "settings" | "about";

export function AppHeader({
  activePage,
  onNavigate,
  connectedAgentCount,
}: {
  activePage: Page;
  onNavigate: (page: Page) => void;
  connectedAgentCount: number;
}) {
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
        <Button
          variant={activePage === "monitoring" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onNavigate("monitoring")}
        >
          <Activity className="h-4 w-4" /> Monitoring
        </Button>
        <Button
          variant={activePage === "settings" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onNavigate("settings")}
        >
          <Settings2 className="h-4 w-4" /> Settings
        </Button>
        <Button
          variant={activePage === "about" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onNavigate("about")}
        >
          <CircleHelp className="h-4 w-4" /> About
        </Button>
      </nav>
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
    </header>
  );
}
