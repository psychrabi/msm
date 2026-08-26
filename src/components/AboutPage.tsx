import { Monitor, ShieldCheck, Users, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function AboutPage() {
  return (
    <main className="flex flex-1 items-start justify-center overflow-auto p-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>About MSM Viewer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            MSM Viewer is a desktop application for managing and observing
            remote workstations. It connects to lightweight MSM agents running
            on machines in your network and shows you, at a glance, every
            active user session across all of them — with live, view-only
            screen streaming for any session you choose.
          </p>
          <p className="text-muted-foreground">
            Add an agent by entering its IP address and access token once. The
            agent is remembered, its credentials are stored securely in the
            operating system's credential store, and the viewer reconnects
            automatically whenever an agent or session becomes available
            again.
          </p>
          <ul className="space-y-3">
            <li className="flex gap-3">
              <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Live remote viewers.</span>{" "}
                <span className="text-muted-foreground">
                  Each active login session appears as a 16:9 card streaming
                  the remote screen. Open any viewer fullscreen and switch
                  between view-only observation and interactive control.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Users className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Multi-agent monitoring.</span>{" "}
                <span className="text-muted-foreground">
                  Manage any number of agents side by side. Sessions are
                  listed per machine, and viewers open automatically for
                  sessions as they become active.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Secure by design.</span>{" "}
                <span className="text-muted-foreground">
                  Every connection is authenticated with a per-agent bearer
                  token, screen data flows directly between you and the agent,
                  and access tokens never persist in plain configuration
                  files.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Built for uptime.</span>{" "}
                <span className="text-muted-foreground">
                  Dropped connections retry on their own, session lists refresh
                  continuously in the background, and clipboard content syncs
                  between your desktop and remote sessions during interactive
                  use.
                </span>
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
