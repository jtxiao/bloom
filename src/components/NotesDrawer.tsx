import { useState, useRef, useCallback, useEffect } from 'react';
import type { NoteBullet } from '../types';

interface NotesDrawerProps {
  open: boolean;
  onToggle: () => void;
  notes: NoteBullet[];
  onNotesChange: (notes: NoteBullet[]) => void;
  nodeList: React.RefObject<{ id: string; label: string }[]>;
  onNodeNavigate: React.RefObject<(nodeId: string) => void>;
}

function notesToText(notes: NoteBullet[]): string {
  return notes.map(b => b.text).join('\n');
}

function textToNotes(text: string, oldNotes: NoteBullet[]): NoteBullet[] {
  const lines = text.split('\n');
  const used = new Set<number>();
  return lines.map((line, i) => {
    if (i < oldNotes.length && !used.has(i) && oldNotes[i].text === line) {
      used.add(i);
      return oldNotes[i];
    }
    for (let j = 0; j < oldNotes.length; j++) {
      if (!used.has(j) && oldNotes[j].text === line) {
        used.add(j);
        return oldNotes[j];
      }
    }
    if (i < oldNotes.length && !used.has(i)) {
      used.add(i);
      return { ...oldNotes[i], text: line };
    }
    return { id: crypto.randomUUID(), text: line };
  });
}

function getLineAtCursor(val: string, pos: number) {
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = val.indexOf('\n', pos);
  if (lineEnd < 0) lineEnd = val.length;
  const lines = val.split('\n');
  let lineIdx = 0;
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    if (acc + lines[i].length >= lineStart) { lineIdx = i; break; }
    acc += lines[i].length + 1;
  }
  return { lineStart, lineEnd, lineIdx };
}

export default function NotesDrawer({ open, onToggle, notes, onNotesChange, nodeList, onNodeNavigate }: NotesDrawerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ query: string; atIdx: number } | null>(null);
  const mentionRef = useRef<HTMLDivElement>(null);

  const currentNodeList = nodeList.current ?? [];

  const autoResize = useCallback((ta: HTMLTextAreaElement) => {
    ta.style.height = 'auto';
    ta.style.height = Math.max(80, ta.scrollHeight) + 'px';
  }, []);

  useEffect(() => {
    if (textareaRef.current) autoResize(textareaRef.current);
  }, [notes, open, autoResize]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let val = e.target.value;
    let pos = e.target.selectionStart ?? val.length;
    const ta = e.target;

    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const lineText = val.slice(lineStart);
    if (lineText.startsWith('- ') || lineText === '-') {
      const replacement = lineText === '-' ? '\u2022' : '\u2022 ';
      val = val.slice(0, lineStart) + replacement + lineText.slice(lineText === '-' ? 1 : 2);
      pos = lineStart + replacement.length;
      onNotesChange(textToNotes(val, notes));
      setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos; }, 0);
      setMention(null);
      return;
    }

    onNotesChange(textToNotes(val, notes));

    const before = val.slice(0, pos);
    const mentionLineStart = before.lastIndexOf('\n') + 1;
    const lineBefore = before.slice(mentionLineStart);
    const atIdx = lineBefore.lastIndexOf('@');
    if (atIdx >= 0) {
      const absAtIdx = mentionLineStart + atIdx;
      const charBefore = absAtIdx === 0 ? '\n' : val[absAtIdx - 1];
      if (charBefore === ' ' || charBefore === '\n' || charBefore === '\u2022') {
        const query = lineBefore.slice(atIdx + 1);
        setMention({ query, atIdx: absAtIdx });
        return;
      }
    }
    setMention(null);
  }, [notes, onNotesChange]);

  const mentionFiltered = mention
    ? currentNodeList.filter(n => n.label.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8)
    : [];

  const selectMention = useCallback((nodeId: string) => {
    if (!mention) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const val = notesToText(notes);
    const node = currentNodeList.find(n => n.id === nodeId);
    if (!node) return;

    const before = val.slice(0, mention.atIdx);
    const afterCursor = val.slice(mention.atIdx + mention.query.length + 1);
    const newVal = before + '@' + node.label + ' ' + afterCursor;
    const updated = textToNotes(newVal, notes);

    const { lineIdx } = getLineAtCursor(val, mention.atIdx);
    if (updated[lineIdx]) {
      const existing = updated[lineIdx].nodeIds ?? (updated[lineIdx].nodeId ? [updated[lineIdx].nodeId!] : []);
      if (!existing.includes(nodeId)) {
        updated[lineIdx] = { ...updated[lineIdx], nodeIds: [...existing, nodeId] };
      }
    }

    onNotesChange(updated);
    setMention(null);
    const cursorPos = mention.atIdx + node.label.length + 2;
    setTimeout(() => {
      ta.selectionStart = ta.selectionEnd = cursorPos;
      ta.focus();
    }, 0);
  }, [mention, notes, currentNodeList, onNotesChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionFiltered.length > 0 && e.key === 'Enter') {
      e.preventDefault();
      selectMention(mentionFiltered[0].id);
    }
    if (e.key === 'Escape') {
      setMention(null);
    }
  }, [mention, mentionFiltered, selectMention]);

  useEffect(() => {
    if (!mention) return;
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setMention(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mention]);

  const taggedByNode = new Map<string, NoteBullet[]>();
  for (const b of notes) {
    if (!b.text.trim()) continue;
    const mentionedNodes = new Set<string>();
    let searchPos = 0;
    while (searchPos < b.text.length) {
      const atIdx = b.text.indexOf('@', searchPos);
      if (atIdx < 0) break;
      const after = b.text.slice(atIdx + 1);
      const matched = [...currentNodeList].sort((a, bb) => bb.label.length - a.label.length).find(n => after.startsWith(n.label));
      if (matched) {
        mentionedNodes.add(matched.id);
        searchPos = atIdx + 1 + matched.label.length;
      } else {
        searchPos = atIdx + 1;
      }
    }
    for (const nId of mentionedNodes) {
      const arr = taggedByNode.get(nId);
      if (arr) arr.push(b);
      else taggedByNode.set(nId, [b]);
    }
  }

  const noteCount = notes.filter(b => b.text.trim()).length;

  return (
    <>
    <div className={`notes-drawer-overlay ${open ? 'open' : ''}`} onClick={onToggle} />
    <div className={`notes-drawer-container ${open ? 'open' : ''}`}>
      <div className="notes-drawer">
        <div className="notes-drawer-header">
          <span className="notes-drawer-title">Notes</span>
        </div>
      <div className="notes-drawer-body">
        <div className="notes-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="notes-textarea"
            value={notesToText(notes)}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setMention(null), 150)}
            placeholder="Type notes here... (@ to tag a node)"
            spellCheck={false}
          />
          {mention && mentionFiltered.length > 0 && (
            <div className="mention-dropdown" ref={mentionRef}>
              {mentionFiltered.map(n => (
                <button key={n.id} className="mention-item" onMouseDown={e => { e.preventDefault(); selectMention(n.id); }}>
                  {n.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {taggedByNode.size > 0 && (
          <div className="notes-organized">
            {[...taggedByNode.entries()].map(([nodeId, bullets]) => {
              const label = currentNodeList.find(n => n.id === nodeId)?.label ?? nodeId;
              return (
                <div key={nodeId} className="notes-node-group">
                  <div className="notes-node-header" onClick={() => onNodeNavigate.current?.(nodeId)}>
                    {label}
                  </div>
                  {bullets.map(b => (
                    <div key={b.id} className="notes-node-bullet">{b.text}</div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
      <button className="notes-drawer-tab" onClick={onToggle} title="Toggle notes panel">
        {open ? '\u25C0' : '\u270E'}
        {!open && noteCount > 0 && <span className="notes-drawer-tab-count">{noteCount}</span>}
      </button>
    </div>
    </>
  );
}
