import { memo,useEffect,useMemo,useRef,useState,type CSSProperties } from "react";
import { Eye,EyeOff,Maximize2,Minimize2,Monitor,X } from "lucide-react";
import { Button } from "./ui/button";
import { Card,CardContent,CardHeader,CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { RemoteViewer } from "./RemoteViewer";
import { cn } from "../lib/utils";
import { connectionKey,sessionMonitors,type AgentConnection,type MonitorInfo,type RemoteConnection } from "../lib/agent-protocol";

const EDGE_BAR_PX=2,EDGE_BAR_LINGER_MS=1500;

type MonitorTopology={width:number;height:number;positions:Map<number,CSSProperties>};

export type MonitoringActions={
  openFullscreen:(key:string)=>void;
  closeFullscreen:()=>void;
  setViewOnly:(viewOnly:boolean)=>void;
  disconnectRemote:(agentId:string,sessionId:string,monitorIndex:number)=>void;
  startSession:(agentId:string,sessionId:string,monitorIndex:number)=>void;
  viewerError:(message:string)=>void;
};

function sessionViewerKey(agentId:string,sessionId:string){return `${agentId}::${sessionId}::session`;}

function monitorWeight(monitor:MonitorInfo){
  if(monitor.width>0&&monitor.height>0)return monitor.width/monitor.height;
  return 16/9;
}

function buildMonitorTopology(monitors:MonitorInfo[]):MonitorTopology|null{
  if(monitors.length===0||!monitors.every(m=>m.width>0&&m.height>0&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&Number.isFinite(m.width)&&Number.isFinite(m.height)))return null;
  const minX=Math.min(...monitors.map(m=>m.x));
  const minY=Math.min(...monitors.map(m=>m.y));
  const maxX=Math.max(...monitors.map(m=>m.x+m.width));
  const maxY=Math.max(...monitors.map(m=>m.y+m.height));
  const width=maxX-minX,height=maxY-minY;
  if(width<=0||height<=0)return null;
  const positions=new Map<number,CSSProperties>();
  for(const monitor of monitors){
    positions.set(monitor.index,{
      left:`${((monitor.x-minX)/width)*100}%`,
      top:`${((monitor.y-minY)/height)*100}%`,
      width:`${(monitor.width/width)*100}%`,
      height:`${(monitor.height/height)*100}%`,
    });
  }
  return{width,height,positions};
}

const SessionMonitorPane=memo(function SessionMonitorPane({agent,session,monitor,remote,connecting,isFullscreen,fullscreenViewOnly,paneStyle,actions}:{agent:AgentConnection;session:AgentConnection["sessions"][number];monitor:MonitorInfo;remote:RemoteConnection|undefined;connecting:boolean;isFullscreen:boolean;fullscreenViewOnly:boolean;paneStyle:CSSProperties|undefined;actions:MonitoringActions}){
  return <div className={cn("group/monitor min-h-0 min-w-0 overflow-hidden bg-black",paneStyle?"absolute border border-white/10":"relative")} style={paneStyle??{flexGrow:monitorWeight(monitor),flexBasis:0}}>
    {remote?<RemoteViewer remote={remote} endpoint={agent.endpoint} token={agent.token} viewOnly={isFullscreen?fullscreenViewOnly:true} onDisconnect={()=>actions.disconnectRemote(agent.id,session.sessionId,monitor.index)} onError={actions.viewerError}/>:<div className="flex h-full min-h-0 w-full items-center justify-center bg-black"><Button size="sm" disabled={agent.status!=="Connected"||connecting} onClick={()=>actions.startSession(agent.id,session.sessionId,monitor.index)}>{connecting?"Connecting…":`Connect ${monitor.name}`}</Button></div>}
    <div className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-black/65 px-2 py-1 text-[10px] text-white/80 backdrop-blur-sm">{monitor.name}{monitor.isPrimary?" · Primary":""}</div>
    {remote&&<Button variant="ghost" size="icon" className="absolute right-1.5 top-1.5 z-20 h-7 w-7 bg-black/45 text-white opacity-0 hover:bg-black/70 hover:text-white group-hover/monitor:opacity-100" onClick={()=>actions.disconnectRemote(agent.id,session.sessionId,monitor.index)} aria-label={`Disconnect ${monitor.name}`}><X className="h-3.5 w-3.5"/></Button>}
  </div>;
});

const SessionViewerCard=memo(function SessionViewerCard({agent,session,monitors,remotes,connectingSessions,isFullscreen,fullscreenViewOnly,actions}:{agent:AgentConnection;session:AgentConnection["sessions"][number];monitors:MonitorInfo[];remotes:Map<number,RemoteConnection>;connectingSessions:Set<string>;isFullscreen:boolean;fullscreenViewOnly:boolean;actions:MonitoringActions}){
  const key=sessionViewerKey(agent.id,session.sessionId);
  const[edgeBarVisible,setEdgeBarVisible]=useState(false);
  const hideTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null),overChromeRef=useRef(false);
  const clear=()=>{if(hideTimerRef.current){clearTimeout(hideTimerRef.current);hideTimerRef.current=null}};
  const hide=()=>{if(overChromeRef.current||hideTimerRef.current)return;hideTimerRef.current=setTimeout(()=>{hideTimerRef.current=null;setEdgeBarVisible(false)},EDGE_BAR_LINGER_MS)};
  useEffect(()=>{if(!isFullscreen)return;const options={capture:true,passive:true} as const;const move=(e:MouseEvent)=>{if(e.clientY<=EDGE_BAR_PX){clear();setEdgeBarVisible(true)}else hide()};window.addEventListener("mousemove",move,options);return()=>{clear();overChromeRef.current=false;setEdgeBarVisible(false);window.removeEventListener("mousemove",move,options)}},[isFullscreen]);
  const chrome={onMouseEnter:()=>{overChromeRef.current=true;clear()},onMouseLeave:()=>{overChromeRef.current=false;hide()}};
  const connectedCount=remotes.size;
  const topology=useMemo(()=>buildMonitorTopology(monitors),[monitors]);
  const totalWeight=useMemo(()=>monitors.reduce((sum,m)=>sum+monitorWeight(m),0),[monitors]);
  const viewportRatio=topology?topology.width/topology.height:Math.max(totalWeight,16/9);
  const viewportStyle=isFullscreen?undefined:{aspectRatio:`${viewportRatio} / 1`};
  const canvasStyle:CSSProperties|undefined=topology?(isFullscreen?{
    aspectRatio:`${topology.width} / ${topology.height}`,
    width:`min(100%, ${(topology.width/topology.height)*100}vh)`,
    height:`min(100%, ${(topology.height/topology.width)*100}vw)`,
  }:{width:"100%",height:"100%"}):undefined;
  const disconnectAll=()=>{for(const monitor of monitors)if(remotes.has(monitor.index))actions.disconnectRemote(agent.id,session.sessionId,monitor.index);if(isFullscreen)actions.closeFullscreen()};

  return <Card className={cn("group relative flex min-h-0 flex-col overflow-hidden",isFullscreen&&"fixed inset-0 z-50 m-0 rounded-none border-0")}>
    <CardHeader {...chrome} className={cn("absolute inset-x-0 top-0 z-30 flex-row items-center justify-between space-y-0 border-b border-white/10 bg-black/60 px-3 py-2 text-primary-foreground backdrop-blur-sm transition-opacity duration-200",isFullscreen?(edgeBarVisible?"pointer-events-auto opacity-100":"pointer-events-none opacity-0"):"pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100")}>
      <div className="min-w-0"><CardTitle className="truncate text-sm text-white">{session.username}</CardTitle><p className="truncate text-[11px] text-white/60">{agent.identity?.deviceName??agent.endpoint} · Session {session.sessionId} · {monitors.length} monitor{monitors.length===1?"":"s"}{topology?" · Windows layout":""}</p></div>
      <div className="flex items-center gap-2">{isFullscreen&&connectedCount>0&&<Label className="flex items-center gap-2 text-xs text-white"><Switch checked={fullscreenViewOnly} onCheckedChange={actions.setViewOnly}/>{fullscreenViewOnly?<Eye className="h-4 w-4"/>:<EyeOff className="h-4 w-4"/>}View only</Label>}{connectedCount>0&&!isFullscreen&&<Button variant="ghost" size="icon" className="hover:bg-white/15 hover:text-white" onClick={()=>actions.openFullscreen(key)}><Maximize2 className="h-4 w-4"/></Button>}{connectedCount>0&&<Button variant="ghost" size="icon" className="hover:bg-white/15 hover:text-white" onClick={disconnectAll} aria-label="Disconnect all monitors"><X className="h-4 w-4"/></Button>}{isFullscreen&&connectedCount>0&&<Button variant="outline" size="sm" className="border-white/20 bg-transparent text-white hover:bg-white/15 hover:text-white" onClick={actions.closeFullscreen}><Minimize2 className="h-4 w-4"/> Exit</Button>}</div>
    </CardHeader>
    <CardContent className={cn("relative flex min-h-0 items-center justify-center overflow-hidden bg-black p-0",isFullscreen&&"h-full rounded-none")} style={viewportStyle}>
      <div className={cn(topology?"relative shrink-0":"flex h-full min-h-0 w-full divide-x divide-white/10")} style={canvasStyle}>{monitors.map(monitor=>{const monitorKey=connectionKey(agent.id,session.sessionId,monitor.index);return <SessionMonitorPane key={monitor.index} agent={agent} session={session} monitor={monitor} remote={remotes.get(monitor.index)} connecting={connectingSessions.has(monitorKey)} isFullscreen={isFullscreen} fullscreenViewOnly={fullscreenViewOnly} paneStyle={topology?.positions.get(monitor.index)} actions={actions}/>})}</div>
    </CardContent>
  </Card>;
});

export function MonitoringPage({agents,connectingSessions,connectedByKey,totalSessions,totalMonitors,fullscreenKey,fullscreenViewOnly,globalError,actions}:{agents:AgentConnection[];connectingSessions:Set<string>;connectedByKey:Map<string,RemoteConnection>;totalSessions:number;totalMonitors:number;fullscreenKey:string|null;fullscreenViewOnly:boolean;globalError:string;actions:MonitoringActions}){
  const sessionRows=agents.flatMap(agent=>agent.sessions.map(session=>({agent,session,monitors:sessionMonitors(session)})));
  return <main className="min-w-0 flex-1 overflow-auto"><div className="flex min-h-full flex-col"><div className="border-b px-5 py-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monitoring</p><h1 className="mt-1 text-xl font-semibold">Remote viewers</h1><p className="mt-1 text-sm text-muted-foreground">{agents.length} agent{agents.length===1?"":"s"} · {totalSessions} sessions · {totalMonitors} monitors. Each session preserves the Windows monitor layout and position.</p></div>{globalError&&<div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">{globalError}</div>}<section className="flex-1 p-5">{totalSessions===0?<div className="flex min-h-90 items-center justify-center rounded-xl border bg-muted/10 text-center"><div><Monitor className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50"/><p className="text-sm font-medium">No remote sessions available</p></div></div>:<div className="viewer-grid">{sessionRows.map(({agent,session,monitors})=>{const key=sessionViewerKey(agent.id,session.sessionId);const remotes=new Map<number,RemoteConnection>();for(const monitor of monitors){const remote=connectedByKey.get(connectionKey(agent.id,session.sessionId,monitor.index));if(remote)remotes.set(monitor.index,remote)}return <SessionViewerCard key={key} agent={agent} session={session} monitors={monitors} remotes={remotes} connectingSessions={connectingSessions} isFullscreen={fullscreenKey===key} fullscreenViewOnly={fullscreenViewOnly} actions={actions}/>})}</div>}</section></div></main>;
}
