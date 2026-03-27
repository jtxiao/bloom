import { DragEvent, useState } from 'react';
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
}

export default function Sidebar({ theme, onToggleTheme, heatmap, onToggleHeatmap }: SidebarProps) {
  const [visualsOpen, setVisualsOpen] = useState(false);

  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/powernode', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

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
