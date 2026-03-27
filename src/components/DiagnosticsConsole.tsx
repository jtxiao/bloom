import { useState, useEffect, useRef } from 'react';
import type { Diagnostic } from '../types';
import Tooltip from './Tooltip';

interface DiagnosticsConsoleProps {
  diagnostics: Diagnostic[];
  onNodeClick?: (nodeId: string) => void;
}

const SEVERITY_ICON: Record<string, string> = {
  error: '\u2716',
  warning: '\u26A0',
  info: '\u2139',
};

export default function DiagnosticsConsole({ diagnostics, onNodeClick }: DiagnosticsConsoleProps) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warnCount = diagnostics.filter(d => d.severity === 'warning').length;
  const infoCount = diagnostics.filter(d => d.severity === 'info').length;

  useEffect(() => {
    if (expanded && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [diagnostics, expanded]);

  const hasAny = diagnostics.length > 0;

  return (
    <div className={`diag-console ${expanded ? 'diag-expanded' : ''}`}>
      <Tooltip text="Warnings and errors about your power tree — click to expand">
        <button className="diag-header" onClick={() => hasAny && setExpanded(!expanded)} style={{ cursor: hasAny ? 'pointer' : 'default' }}>
          <span className="diag-title">Diagnostics</span>
          <span className="diag-counts">
            {hasAny ? (
              <>
                {errorCount > 0 && <span className="diag-count error">{SEVERITY_ICON.error} {errorCount}</span>}
                {warnCount > 0 && <span className="diag-count warning">{SEVERITY_ICON.warning} {warnCount}</span>}
                {infoCount > 0 && <span className="diag-count info">{SEVERITY_ICON.info} {infoCount}</span>}
              </>
            ) : (
              <span className="diag-count clear">No issues</span>
            )}
          </span>
          {hasAny && <span className="diag-chevron">{expanded ? '\u25BE' : '\u25B4'}</span>}
        </button>
      </Tooltip>
      {expanded && hasAny && (
        <div className="diag-list" ref={listRef}>
          {diagnostics.map((d, i) => (
            <div
              key={i}
              className={`diag-row diag-${d.severity}`}
              onClick={() => d.nodeId && onNodeClick?.(d.nodeId)}
              style={{ cursor: d.nodeId ? 'pointer' : 'default' }}
            >
              <span className="diag-icon">{SEVERITY_ICON[d.severity]}</span>
              <span className="diag-msg">{d.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
