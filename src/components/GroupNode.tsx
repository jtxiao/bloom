import { memo } from 'react';
import { NodeResizer } from '@xyflow/react';

function GroupNode({ selected }: { data: Record<string, unknown>; selected?: boolean }) {
  return (
    <div className="group-node" style={{ width: '100%', height: '100%' }}>
      <NodeResizer
        isVisible={selected}
        minWidth={60}
        minHeight={40}
        lineStyle={{ borderColor: 'var(--text-dim)', pointerEvents: 'all' }}
        handleStyle={{ backgroundColor: 'var(--text-dim)', width: 8, height: 8, pointerEvents: 'all' }}
      />
      {/* Invisible border hit area for dragging — only the edges, not the interior */}
      <div className="group-node-border-hit" />
    </div>
  );
}

export default memo(GroupNode);
