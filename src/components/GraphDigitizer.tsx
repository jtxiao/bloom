import { useState, useRef, useCallback, useEffect, ChangeEvent } from 'react';
import type { XYPoint } from '../types';

interface GraphDigitizerProps {
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  defaultXMin?: string;
  defaultXMax?: string;
  defaultYMin?: string;
  defaultYMax?: string;
  defaultXLog?: boolean;
  onExtract: (points: XYPoint[]) => void;
  onClose: () => void;
}

interface PixelPoint {
  x: number;
  y: number;
}

type CalibrationStep = 'image' | 'corner1' | 'corner2' | 'trace';

export default function GraphDigitizer({
  title = 'Extract Data from Graph',
  xAxisLabel = 'X-Axis',
  yAxisLabel = 'Y-Axis',
  defaultXMin = '0',
  defaultXMax = '1',
  defaultYMin = '0',
  defaultYMax = '100',
  defaultXLog = false,
  onExtract,
  onClose,
}: GraphDigitizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);

  const [step, setStep] = useState<CalibrationStep>('image');

  const [corner1, setCorner1] = useState<PixelPoint | null>(null);
  const [corner2, setCorner2] = useState<PixelPoint | null>(null);

  const [c1x, setC1x] = useState(defaultXMin);
  const [c1y, setC1y] = useState(defaultYMin);
  const [c2x, setC2x] = useState(defaultXMax);
  const [c2y, setC2y] = useState(defaultYMax);
  const [xLog, setXLog] = useState(defaultXLog);

  const [tracePoints, setTracePoints] = useState<PixelPoint[]>([]);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageSrc(reader.result as string);
      setStep('corner1');
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (!imageSrc) return;
    const img = new Image();
    img.onload = () => setImageEl(img);
    img.src = imageSrc;
  }, [imageSrc]);

  const getPixelCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>): PixelPoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageEl) return;
    const ctx = canvas.getContext('2d')!;

    canvas.width = imageEl.width;
    canvas.height = imageEl.height;
    ctx.drawImage(imageEl, 0, 0);

    const drawMarker = (p: PixelPoint, color: string, label: string) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = 'bold 14px Inter, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(label, p.x + 12, p.y + 5);
      ctx.fillText(label, p.x + 12, p.y + 5);
    };

    if (corner1) drawMarker(corner1, '#3FA7D6', 'P1');
    if (corner2) drawMarker(corner2, '#FAC05E', 'P2');

    if (corner1 && corner2) {
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(corner1.x, corner2.y, corner2.x - corner1.x, corner1.y - corner2.y);
      ctx.setLineDash([]);
    }

    for (const p of tracePoints) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#EE6352';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (tracePoints.length > 1) {
      ctx.beginPath();
      ctx.moveTo(tracePoints[0].x, tracePoints[0].y);
      for (let i = 1; i < tracePoints.length; i++) {
        ctx.lineTo(tracePoints[i].x, tracePoints[i].y);
      }
      ctx.strokeStyle = 'rgba(231, 76, 60, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [imageEl, corner1, corner2, tracePoints]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = getPixelCoords(e);
    if (step === 'corner1') {
      setCorner1(p);
      setStep('corner2');
    } else if (step === 'corner2') {
      setCorner2(p);
      setStep('trace');
    } else if (step === 'trace') {
      setTracePoints(prev => [...prev, p]);
    }
  };

  const undoPoint = () => {
    if (step === 'trace' && tracePoints.length > 0) {
      setTracePoints(prev => prev.slice(0, -1));
    } else if (step === 'trace' && tracePoints.length === 0) {
      setCorner2(null);
      setStep('corner2');
    } else if (step === 'corner2') {
      setCorner1(null);
      setStep('corner1');
    }
  };

  const resetAll = () => {
    setCorner1(null);
    setCorner2(null);
    setTracePoints([]);
    setStep('corner1');
  };

  const extractPoints = () => {
    if (!corner1 || !corner2 || tracePoints.length === 0) return;

    const c1xVal = parseFloat(c1x);
    const c2xVal = parseFloat(c2x);
    const c1yVal = parseFloat(c1y);
    const c2yVal = parseFloat(c2y);

    const pxLeft = corner1.x;
    const pxRight = corner2.x;
    const pxBottom = corner1.y;
    const pxTop = corner2.y;

    const pxWidth = pxRight - pxLeft;
    const pxHeight = pxBottom - pxTop;

    const result: XYPoint[] = tracePoints.map(p => {
      const normX = (p.x - pxLeft) / pxWidth;
      const normY = (pxBottom - p.y) / pxHeight;

      let x: number;
      if (xLog) {
        const logMin = Math.log10(c1xVal);
        const logMax = Math.log10(c2xVal);
        x = Math.pow(10, logMin + normX * (logMax - logMin));
      } else {
        x = c1xVal + normX * (c2xVal - c1xVal);
      }

      const y = c1yVal + normY * (c2yVal - c1yVal);
      return { x, y };
    });

    result.sort((a, b) => a.x - b.x);

    // Merge nearby x-values
    const merged: (XYPoint & { _count?: number })[] = [];
    for (const pt of result) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(pt.x - last.x) / Math.max(Math.abs(last.x), 1e-9) < 0.05) {
        const count = last._count ?? 1;
        last.y = (last.y * count + pt.y) / (count + 1);
        last._count = count + 1;
      } else {
        merged.push({ ...pt });
      }
    }

    onExtract(merged.map(({ x, y }) => ({ x, y })));
  };

  const stepLabel = () => {
    switch (step) {
      case 'image': return 'Upload a screenshot of the graph.';
      case 'corner1': return 'Step 1/3: Click the BOTTOM-LEFT corner of the plot area.';
      case 'corner2': return 'Step 2/3: Click the TOP-RIGHT corner of the plot area.';
      case 'trace': return 'Step 3/3: Click along the curve to trace it.';
    }
  };

  return (
    <div className="digitizer-overlay">
      <div className="digitizer-modal">
        <div className="config-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onClose}>X</button>
        </div>

        <div className="digitizer-instruction">{stepLabel()}</div>

        {step === 'image' && (
          <div className="digitizer-upload">
            <label className="file-label">
              Choose Screenshot
              <input type="file" accept="image/*" onChange={handleFile} />
            </label>
          </div>
        )}

        {imageSrc && step !== 'image' && (
          <>
            <div className="digitizer-axes">
              <div className="axis-group">
                <span className="axis-title">{xAxisLabel}</span>
                <div className="axis-inputs">
                  <label>P1 (min) <input type="text" inputMode="decimal" value={c1x} onChange={e => setC1x(e.target.value)} /></label>
                  <label>P2 (max) <input type="text" inputMode="decimal" value={c2x} onChange={e => setC2x(e.target.value)} /></label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={xLog} onChange={e => setXLog(e.target.checked)} />
                    Log scale
                  </label>
                </div>
              </div>
              <div className="axis-group">
                <span className="axis-title">{yAxisLabel}</span>
                <div className="axis-inputs">
                  <label>P1 (min) <input type="text" inputMode="decimal" value={c1y} onChange={e => setC1y(e.target.value)} /></label>
                  <label>P2 (max) <input type="text" inputMode="decimal" value={c2y} onChange={e => setC2y(e.target.value)} /></label>
                </div>
              </div>
            </div>

            <div className="digitizer-canvas-wrap">
              <canvas ref={canvasRef} onClick={handleCanvasClick} className="digitizer-canvas" />
            </div>

            <div className="digitizer-actions">
              <span className="point-count">
                {step === 'corner1' && 'Waiting for P1...'}
                {step === 'corner2' && 'P1 set. Waiting for P2...'}
                {step === 'trace' && `${tracePoints.length} curve points`}
              </span>
              <button onClick={undoPoint} className="btn-secondary">Undo</button>
              <button onClick={resetAll} className="btn-secondary">Reset</button>
              <button onClick={extractPoints} disabled={step !== 'trace' || tracePoints.length < 2} className="btn-primary">
                Apply Points
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
