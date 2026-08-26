import { Plus } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import type { AgentConnection } from "../lib/agent-protocol";

export function SettingsPage({
  agents,
  endpointInput,
  tokenInput,
  savedAgentsPresent,
  onEndpointInputChange,
  onTokenInputChange,
  onAddAgent,
  onConnectAgent,
  onDisconnectAgent,
  onRemoveAgent,
}: {
  agents: AgentConnection[];
  endpointInput: string;
  tokenInput: string;
  savedAgentsPresent: boolean;
  onEndpointInputChange: (value: string) => void;
  onTokenInputChange: (value: string) => void;
  onAddAgent: () => void;
  onConnectAgent: (id: string) => void;
  onDisconnectAgent: (id: string) => void;
  onRemoveAgent: (id: string) => void;
}) {
  return (
    <main className="flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add multiple MSM agents. Enter the agent's IP address and access
            token. Agents are always remembered and reconnect automatically.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <Card>
            <CardHeader>
              <CardTitle>Add agent</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="agent-ip">Agent IP address</Label>
                <Input
                  id="agent-ip"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="192.168.1.10"
                  value={endpointInput}
                  onChange={(event) => onEndpointInputChange(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-token">Access token</Label>
                <Input
                  id="agent-token"
                  type="password"
                  value={tokenInput}
                  onChange={(event) => onTokenInputChange(event.target.value)}
                />
              </div>
              <Button className="w-full" onClick={onAddAgent}>
                <Plus className="h-4 w-4" /> Add and connect
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Configured agents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {agents.length ? (
                agents.map((agent) => (
                  <div key={agent.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {agent.identity?.deviceName ?? agent.endpoint}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {agent.endpoint}
                        </p>
                      </div>
                      <Badge
                        variant={
                          agent.status === "Connected" ? "default" : "outline"
                        }
                      >
                        {agent.status}
                      </Badge>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          agent.status === "Connected" || !agent.token
                        }
                        onClick={() => onConnectAgent(agent.id)}
                      >
                        Connect
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={agent.status !== "Connected"}
                        onClick={() => onDisconnectAgent(agent.id)}
                      >
                        Disconnect
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRemoveAgent(agent.id)}
                      >
                        Forget
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No agents configured.
                </p>
              )}
              {savedAgentsPresent && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Configured agents are restored from the native credential
                  store on startup.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
