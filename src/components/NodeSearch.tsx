import { useState, useEffect, useRef, useCallback } from 'react';
import type { Node } from '@xyflow/react';

interface NodeSearchProps {
  nodes: Node[];
  onSelect: (nodeId: string) => void;
  onHover: (nodeId: string) => void;
  onClose: () => void;
}

export default function NodeSearch({ nodes, onSelect, onHover, onClose }: NodeSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchable = nodes.filter(n => n.type !== 'groupNode' && n.type !== 'textNode');

  const matches = query.trim()
    ? searchable.filter(n => {
        const data = n.data as Record<string, unknown>;
        const label = (data.label as string) || '';
        const type = (data.type as string) || '';
        const q = query.toLowerCase();
        return label.toLowerCase().includes(q) || type.toLowerCase().includes(q);
      })
    : searchable;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (matches[activeIdx]) {
      onHover(matches[activeIdx].id);
    }
  }, [activeIdx, matches, onHover]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[activeIdx]) {
        onSelect(matches[activeIdx].id);
        onClose();
      }
    }
  }, [matches, activeIdx, onSelect, onClose]);

  const typeLabel = (t: string) => {
    switch (t) {
      case 'source': return 'SRC';
      case 'converter': return 'CONV';
      case 'series': return 'SER';
      case 'load': return 'LOAD';
      default: return t.toUpperCase();
    }
  };

  return (
    <div className="node-search-overlay" onClick={onClose}>
      <div className="node-search-box" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="node-search-input"
          type="text"
          placeholder="Search nodes..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKey}
        />
        <div className="node-search-results">
          {matches.length === 0 && (
            <div className="node-search-empty">No matching nodes</div>
          )}
          {matches.map((n, i) => {
            const data = n.data as Record<string, unknown>;
            const label = (data.label as string) || 'Untitled';
            const type = (data.type as string) || '';
            return (
              <div
                key={n.id}
                className={`node-search-item ${i === activeIdx ? 'active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => { onSelect(n.id); onClose(); }}
              >
                <span className={`node-search-type type-${type}`}>{typeLabel(type)}</span>
                <span className="node-search-label">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
