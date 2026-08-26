import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function AboutPage({
  agentCount,
  connectedAgentCount,
  remoteViewerCount,
}: {
  agentCount: number;
  connectedAgentCount: number;
  remoteViewerCount: number;
}) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>MSM Viewer</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex justify-between border-b pb-3">
            <span className="text-muted-foreground">Agents</span>
            <span>{agentCount}</span>
          </div>
          <div className="flex justify-between border-b pb-3">
            <span className="text-muted-foreground">Connected</span>
            <span>{connectedAgentCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Remote viewers</span>
            <span>{remoteViewerCount}</span>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
