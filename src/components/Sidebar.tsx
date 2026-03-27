import { DragEvent, useState, useRef, useCallback, useEffect } from 'react';
import type { NoteBullet } from '../types';
import Tooltip from './Tooltip';

const componentTypes = [
  { type: 'source', label: 'Power Source', desc: 'Battery, USB, Wall adapter' },
  { type: 'converter', label: 'Converter', desc: 'Buck, Boost, LDO regulator' },
  { type: 'series', label: 'Series Element', desc: 'Load switch, FET, fuse' },
  { type: 'load', label: 'Load', desc: 'MCU, Sensor, LED, Resistor' },
  { type: 'group', label: 'Box', desc: 'Outline to group blocks' },
  { type: 'text', label: 'Text', desc: 'Placeable text label' },
];

interface SidebarProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  heatmap: boolean;
  onToggleHeatmap: () => void;
  notes: NoteBullet[];
  onNotesChange: (notes: NoteBullet[]) => void;
  notesOpen: boolean;
  onNotesOpenChange: (open: boolean) => void;
  nodeList: React.RefObject<{ id: string; label: string }[]>;
  onNodeNavigate: React.RefObject<(nodeId: string) => void>;
}

function NodePicker({ nodeList, onSelect, onClose }: { nodeList: { id: string; label: string }[]; onSelect: (nodeId: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = nodeList.filter(n => n.label.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="node-picker-overlay" onClick={onClose}>
      <div className="node-picker" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="node-picker-search"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Search nodes..."
          spellCheck={false}
        />
        <div className="node-picker-list">
          {filtered.map(n => (
            <button key={n.id} className="node-picker-item" onClick={() => onSelect(n.id)}>
              {n.label}
            </button>
          ))}
          {filtered.length === 0 && <div className="node-picker-empty">No nodes found</div>}
        </div>
      </div>
    </div>
  );
}

function NoteBulletRow({ bullet, nodeList, onTextChange, onTagNode, onRemoveTag, onDelete, onNavigate, onNewAfter }: {
  bullet: NoteBullet;
  nodeList: { id: string; label: string }[];
  onTextChange: (text: string) => void;
  onTagNode: (nodeId: string) => void;
  onRemoveTag: () => void;
  onDelete: () => void;
  onNavigate: (nodeId: string) => void;
  onNewAfter: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [mentionState, setMentionState] = useState<{ query: string; startIdx: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tagLabel = bullet.nodeId ? nodeList.find(n => n.id === bullet.nodeId)?.label : null;

  const mentionFiltered = mentionState
    ? nodeList.filter(n => n.label.toLowerCase().includes(mentionState.query.toLowerCase())).slice(0, 8)
    : [];

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onTextChange(val);

    const cursorPos = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === ' ')) {
      const query = before.slice(atIdx + 1);
      if (!query.includes(' ')) {
        setMentionState({ query, startIdx: atIdx });
        return;
      }
    }
    setMentionState(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mentionState && mentionFiltered.length > 0) {
        selectMention(mentionFiltered[0].id);
      } else {
        onNewAfter();
      }
    }
    if (e.key === 'Backspace' && bullet.text === '') {
      e.preventDefault();
      onDelete();
    }
    if (e.key === 'Escape') {
      setMentionState(null);
    }
  };

  const selectMention = (nodeId: string) => {
    if (!mentionState) return;
    const before = bullet.text.slice(0, mentionState.startIdx);
    const after = bullet.text.slice(mentionState.startIdx + mentionState.query.length + 1);
    onTextChange(before + after);
    onTagNode(nodeId);
    setMentionState(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handlePickerSelect = (nodeId: string) => {
    onTagNode(nodeId);
    setShowPicker(false);
  };

  return (
    <div className="note-bullet-row">
      <span className="note-bullet-marker">{'\u2022'}</span>
      <div className="note-bullet-content">
        <div className="note-bullet-input-wrap">
          <input
            ref={inputRef}
            className="note-bullet-input"
            value={bullet.text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setMentionState(null), 150)}
            placeholder="Type a note... (@node to tag)"
            spellCheck={false}
          />
          {mentionState && mentionFiltered.length > 0 && (
            <div className="mention-dropdown">
              {mentionFiltered.map(n => (
                <button key={n.id} className="mention-item" onMouseDown={e => { e.preventDefault(); selectMention(n.id); }}>
                  {n.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="note-bullet-actions">
          {tagLabel ? (
            <span className="note-tag-chip" onClick={() => onNavigate(bullet.nodeId!)}>
              {tagLabel}
              <button className="note-tag-remove" onClick={e => { e.stopPropagation(); onRemoveTag(); }}>{'\u00D7'}</button>
            </span>
          ) : (
            <Tooltip text="Tag this note to a node">
              <button className="note-link-btn" onClick={() => setShowPicker(true)}>{'\u2197'}</button>
            </Tooltip>
          )}
        </div>
      </div>
      {showPicker && (
        <NodePicker nodeList={nodeList} onSelect={handlePickerSelect} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

export default function Sidebar({ theme, onToggleTheme, heatmap, onToggleHeatmap, notes, onNotesChange, notesOpen, onNotesOpenChange, nodeList, onNodeNavigate }: SidebarProps) {
  const [visualsOpen, setVisualsOpen] = useState(false);
  const newBulletRef = useRef<string | null>(null);

  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/powernode', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const addBullet = useCallback(() => {
    const id = crypto.randomUUID();
    onNotesChange([...notes, { id, text: '' }]);
    newBulletRef.current = id;
  }, [notes, onNotesChange]);

  const updateBullet = useCallback((bulletId: string, updates: Partial<NoteBullet>) => {
    onNotesChange(notes.map(b => b.id === bulletId ? { ...b, ...updates } : b));
  }, [notes, onNotesChange]);

  const deleteBullet = useCallback((bulletId: string) => {
    onNotesChange(notes.filter(b => b.id !== bulletId));
  }, [notes, onNotesChange]);

  const insertAfter = useCallback((bulletId: string) => {
    const idx = notes.findIndex(b => b.id === bulletId);
    const id = crypto.randomUUID();
    const updated = [...notes];
    updated.splice(idx + 1, 0, { id, text: '' });
    onNotesChange(updated);
    newBulletRef.current = id;
  }, [notes, onNotesChange]);

  useEffect(() => {
    if (newBulletRef.current) {
      const id = newBulletRef.current;
      newBulletRef.current = null;
      setTimeout(() => {
        const el = document.querySelector(`[data-bullet-id="${id}"] input`) as HTMLInputElement | null;
        el?.focus();
      }, 0);
    }
  });

  const currentNodeList = nodeList.current ?? [];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img className="logo-img" src="/bloom-logo.png" alt="bloom logo" />
        <span className="logo-text">bloom</span>
      </div>
      <h2>Components</h2>
      <p className="sidebar-hint">Drag onto canvas to add</p>
      {componentTypes.map(n => (
        <Tooltip key={n.type} text={`Drag and drop onto the canvas to add a ${n.label.toLowerCase()}`}>
          <div
            className={`sidebar-item ${n.type}`}
            draggable
            onDragStart={e => onDragStart(e, n.type)}
          >
            <div className="sidebar-item-label">{n.label}</div>
            <div className="sidebar-item-desc">{n.desc}</div>
          </div>
        </Tooltip>
      ))}
      <div className="sidebar-spacer" />
      <Tooltip text="Free-form notes saved with the project. Type @ to tag a node.">
        <div className="sidebar-section">
          <button className="sidebar-section-toggle" onClick={() => onNotesOpenChange(!notesOpen)}>
            <span>{notesOpen ? '\u25BE' : '\u25B8'}</span> Notes
            {notes.length > 0 && <span className="notes-count">{notes.length}</span>}
          </button>
        </div>
      </Tooltip>
      {notesOpen && (
        <div className="sidebar-notes">
          {notes.map(b => (
            <div key={b.id} data-bullet-id={b.id}>
              <NoteBulletRow
                bullet={b}
                nodeList={currentNodeList}
                onTextChange={text => updateBullet(b.id, { text })}
                onTagNode={nodeId => updateBullet(b.id, { nodeId })}
                onRemoveTag={() => updateBullet(b.id, { nodeId: undefined })}
                onDelete={() => deleteBullet(b.id)}
                onNavigate={nodeId => onNodeNavigate.current?.(nodeId)}
                onNewAfter={() => insertAfter(b.id)}
              />
            </div>
          ))}
          <button className="note-add-btn" onClick={addBullet}>+ Add note</button>
        </div>
      )}
      <div className="sidebar-visuals">
        <button className="sidebar-visuals-toggle" onClick={() => setVisualsOpen(!visualsOpen)}>
          <span>{visualsOpen ? '\u25BE' : '\u25B8'}</span> Visuals
        </button>
        {visualsOpen && (
          <div className="sidebar-visuals-menu">
            <Tooltip text="Switch between light and dark color themes">
              <label className="sidebar-toggle-row">
                <span>Dark mode</span>
                <input type="checkbox" checked={theme === 'dark'} onChange={onToggleTheme} />
              </label>
            </Tooltip>
            <Tooltip text="Color-code nodes by power dissipation — red indicates higher loss">
              <label className="sidebar-toggle-row">
                <span>Heatmap</span>
                <input type="checkbox" checked={heatmap} onChange={onToggleHeatmap} />
              </label>
            </Tooltip>
          </div>
        )}
      </div>
    </aside>
  );
}
