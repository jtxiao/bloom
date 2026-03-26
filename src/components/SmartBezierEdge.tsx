import { useRef } from 'react';
import { BaseEdge, BezierEdge, getBezierPath, useNodes } from '@xyflow/react';
import type { EdgeProps, Node } from '@xyflow/react';

interface Rect { x: number; y: number; w: number; h: number }

const PAD = 8;

function nodeRect(n: Node): Rect {
  const w = n.measured?.width ?? n.width ?? 180;
  const h = n.measured?.height ?? n.height ?? 80;
  return { x: n.position.x - PAD, y: n.position.y - PAD, w: w + PAD * 2, h: h + PAD * 2 };
}

function segHitsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const l = r.x, ri = r.x + r.w, t = r.y, b = r.y + r.h;
  if (x1 >= l && x1 <= ri && y1 >= t && y1 <= b) return true;
  if (x2 >= l && x2 <= ri && y2 >= t && y2 <= b) return true;
  const d1 = xp(l,t,ri,t,x1,y1), d2 = xp(l,t,ri,t,x2,y2);
  const d3 = xp(x1,y1,x2,y2,l,t), d4 = xp(x1,y1,x2,y2,ri,t);
  if (((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0))) return true;
  const e1 = xp(ri,t,ri,b,x1,y1), e2 = xp(ri,t,ri,b,x2,y2);
  const e3 = xp(x1,y1,x2,y2,ri,t), e4 = xp(x1,y1,x2,y2,ri,b);
  if (((e1>0&&e2<0)||(e1<0&&e2>0))&&((e3>0&&e4<0)||(e3<0&&e4>0))) return true;
  const f1 = xp(l,b,ri,b,x1,y1), f2 = xp(l,b,ri,b,x2,y2);
  const f3 = xp(x1,y1,x2,y2,l,b), f4 = xp(x1,y1,x2,y2,ri,b);
  if (((f1>0&&f2<0)||(f1<0&&f2>0))&&((f3>0&&f4<0)||(f3<0&&f4>0))) return true;
  const g1 = xp(l,t,l,b,x1,y1), g2 = xp(l,t,l,b,x2,y2);
  const g3 = xp(x1,y1,x2,y2,l,t), g4 = xp(x1,y1,x2,y2,l,b);
  if (((g1>0&&g2<0)||(g1<0&&g2>0))&&((g3>0&&g4<0)||(g3<0&&g4>0))) return true;
  return false;
}

function xp(ox:number,oy:number,ax:number,ay:number,bx:number,by:number) {
  return (ax-ox)*(by-oy)-(ay-oy)*(bx-ox);
}

function cb(t:number,a:number,b:number,c:number,d:number) {
  const u=1-t; return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;
}

function curveHitsRect(sx:number,sy:number,c1x:number,c1y:number,
  c2x:number,c2y:number,ex:number,ey:number,r:Rect): boolean {
  let px=sx,py=sy;
  for (let i=1;i<=32;i++) {
    const t=i/32, nx=cb(t,sx,c1x,c2x,ex), ny=cb(t,sy,c1y,c2y,ey);
    if (segHitsRect(px,py,nx,ny,r)) return true;
    px=nx; py=ny;
  }
  return false;
}

const pathRe = /M\s*([-\d.e+]+)[,\s]+([-\d.e+]+)\s*C\s*([-\d.e+]+)[,\s]+([-\d.e+]+)\s+([-\d.e+]+)[,\s]+([-\d.e+]+)\s+([-\d.e+]+)[,\s]+([-\d.e+]+)/;

function useObstacleNodes(srcId: string, tgtId: string): Rect[] {
  const allNodes = useNodes();
  const ref = useRef<Rect[]>([]);
  const prevFp = useRef('');
  const filtered = allNodes.filter(
    n => n.type !== 'groupNode' && n.type !== 'textNode' && n.id !== srcId && n.id !== tgtId
  );
  const fp = filtered
    .map(n => `${n.id}:${Math.round(n.position.x)}:${Math.round(n.position.y)}:${n.measured?.width??0}:${n.measured?.height??0}`)
    .join('|');
  if (fp !== prevFp.current) {
    prevFp.current = fp;
    ref.current = filtered.map(nodeRect);
  }
  return ref.current;
}

export default function SmartBezierEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, source, target } = props;
  const obstacles = useObstacleNodes(source, target);

  const [defaultPath] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  if (obstacles.length === 0) return <BezierEdge {...props} />;

  // Parse actual control points from the path React Flow generates
  const m = pathRe.exec(defaultPath);
  if (!m) return <BezierEdge {...props} />;
  const c1x = +m[3], c1y = +m[4], c2x = +m[5], c2y = +m[6];

  // Find obstacles the default curve actually hits
  const hits = obstacles.filter(r => curveHitsRect(sourceX,sourceY,c1x,c1y,c2x,c2y,targetX,targetY,r));
  if (hits.length === 0) return <BezierEdge {...props} />;

  // Bounding box of ONLY the hit obstacles
  let hTop = Infinity, hBot = -Infinity;
  for (const r of hits) {
    hTop = Math.min(hTop, r.y);
    hBot = Math.max(hBot, r.y + r.h);
  }

  // Go above or below — whichever is closer to the endpoints average
  const avgY = (sourceY + targetY) / 2;
  const goAbove = Math.abs(avgY - hTop) <= Math.abs(avgY - hBot);

  // Push control points. A cubic bezier's peak is at ~0.75 of the control
  // point offset, so we need to overshoot by ~1.33x to actually clear.
  let bestCy = goAbove ? hTop : hBot;
  for (let step = 1; step <= 30; step++) {
    const candidateCy = goAbove ? hTop - step * 20 : hBot + step * 20;

    // Check if this candidate clears all CURRENTLY known obstacles
    const newHits = obstacles.filter(r =>
      curveHitsRect(sourceX,sourceY,c1x,candidateCy,c2x,candidateCy,targetX,targetY,r)
    );

    if (newHits.length === 0) {
      bestCy = candidateCy;
      break;
    }

    // Expand the obstacle bounds with newly-hit rects
    for (const r of newHits) {
      if (goAbove) hTop = Math.min(hTop, r.y);
      else hBot = Math.max(hBot, r.y + r.h);
    }
    bestCy = candidateCy;
  }

  const path = `M${sourceX},${sourceY} C${c1x},${bestCy} ${c2x},${bestCy} ${targetX},${targetY}`;
  const mx = cb(0.5, sourceX, c1x, c2x, targetX);
  const my = cb(0.5, sourceY, bestCy, bestCy, targetY);

  return <BaseEdge id={props.id} path={path} labelX={mx} labelY={my}
    label={props.label} labelStyle={props.labelStyle} labelShowBg={props.labelShowBg}
    labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding}
    labelBgBorderRadius={props.labelBgBorderRadius} style={props.style}
    markerStart={props.markerStart} markerEnd={props.markerEnd}
    interactionWidth={props.interactionWidth} />;
}
