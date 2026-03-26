import { memo, useState, useCallback, useEffect } from 'react';

interface TextNodeData {
  text: string;
  fontSize: number;
  color: string;
  _onTextChange?: (text: string) => void;
}

function TextNode({ data, selected }: { data: Record<string, unknown>; selected?: boolean }) {
  const d = data as unknown as TextNodeData;
  const text = d.text || 'Text';
  const fontSize = d.fontSize || 14;
  const color = d.color || 'var(--text)';
  const onTextChange = d._onTextChange;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(text);

  useEffect(() => {
    setEditValue(text);
  }, [text]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== text) {
      onTextChange?.(trimmed);
    } else if (!trimmed) {
      setEditValue(text);
    }
  }, [editValue, text, onTextChange]);

  return (
    <div
      className={`text-node ${selected ? 'text-node-selected' : ''}`}
      style={{ fontSize, color }}
    >
      {editing ? (
        <textarea
          className="text-node-input"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } }}
          style={{ fontSize, color }}
          autoFocus
        />
      ) : (
        <div
          className="text-node-display"
          onDoubleClick={() => { setEditValue(text); setEditing(true); }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

export default memo(TextNode);
