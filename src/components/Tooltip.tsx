import { useState, useRef, useCallback, type ReactNode, type ReactElement, cloneElement, isValidElement } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string;
  children: ReactNode;
  delay?: number;
}

export default function Tooltip({ text, children, delay = 600 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const maxW = 260;
    const pad = 8;

    if (cx - maxW / 2 < pad) {
      setStyle({ left: rect.right + 6, top: rect.top + rect.height / 2, transform: 'translateY(-50%)' });
    } else if (cx + maxW / 2 > window.innerWidth - pad) {
      setStyle({ right: window.innerWidth - rect.left + 6, top: rect.top + rect.height / 2, transform: 'translateY(-50%)' });
    } else {
      setStyle({ left: cx, top: rect.bottom + 6, transform: 'translateX(-50%)' });
    }
    timer.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);

  const bubble = visible && createPortal(
    <span className="tooltip-bubble" style={style}>{text}</span>,
    document.body,
  );

  if (isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>;
    const merged = {
      onMouseEnter: (e: React.MouseEvent) => {
        show(e);
        if (typeof child.props.onMouseEnter === 'function') (child.props.onMouseEnter as (e: React.MouseEvent) => void)(e);
      },
      onMouseLeave: (e: React.MouseEvent) => {
        hide();
        if (typeof child.props.onMouseLeave === 'function') (child.props.onMouseLeave as (e: React.MouseEvent) => void)(e);
      },
      onMouseDown: (e: React.MouseEvent) => {
        hide();
        if (typeof child.props.onMouseDown === 'function') (child.props.onMouseDown as (e: React.MouseEvent) => void)(e);
      },
    };
    return (
      <>
        {cloneElement(child, merged)}
        {bubble}
      </>
    );
  }

  return (
    <span onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide} style={{ display: 'contents' }}>
      {children}
      {bubble}
    </span>
  );
}
