import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { run, registry, canRun, popupMenu, paletteOpen } from '../editor/editor';
import { availableItems, menuByName, type MenuItem } from '../editor/menus';
import { session } from '../app/store';

function resolve(items: MenuItem['submenu']): MenuItem[] {
  if (!items) return [];
  return typeof items === 'function' ? items() : items;
}

export function MenuList(p: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  level?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: p.x, y: p.y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = p.x;
    let y = p.y;
    if (x + r.width > innerWidth - 4)
      x = Math.max(4, p.level ? p.x - r.width - 190 : innerWidth - r.width - 4);
    if (y + r.height > innerHeight - 4) y = Math.max(4, innerHeight - r.height - 4);
    setPos({ x, y });
  }, [p.x, p.y]);
  const items = availableItems(p.items);
  return (
    <>
      <div
        class="menu"
        ref={ref}
        style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => {
          if (it.sep) return <div key={i} class="menu-sep" />;
          if (it.title)
            return (
              <div key={i} class="menu-title">
                {it.title}
              </div>
            );
          const enabled = it.enabled
            ? it.enabled()
            : it.op
              ? canRun(it.op) || !!registry.get(it.op)?.uiOnly
              : true;
          const hasSub = !!it.submenu;
          // greyed out like a disabled item, but a click still runs it (Blender's layout.active)
          const inactive = enabled && !hasSub ? (it.inactive?.() ?? null) : null;
          return (
            <div
              key={i}
              class={`menu-item ${enabled || hasSub ? '' : 'disabled'} ${sub?.index === i ? 'hover' : ''}`}
              title={
                inactive ? `${it.label}: ${inactive}` : it.op ? registry.get(it.op)?.description : undefined
              }
              style={inactive ? { color: 'var(--text-faint)' } : undefined}
              data-inactive={inactive ? 'true' : undefined}
              data-testid={`menu-${(it.label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              onPointerEnter={(e) => {
                if (hasSub) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ index: i, x: r.right - 2, y: r.top - 4 });
                } else setSub(null);
              }}
              onClick={() => {
                if (hasSub || !enabled) return;
                p.onClose();
                if (it.action) it.action();
                else if (it.op) run(it.op, it.params, 'menu');
              }}
            >
              <span class="check">{it.checked ? (it.checked() ? '✓' : '') : ''}</span>
              <span class="label">{it.label}</span>
              {it.shortcut && <span class="shortcut">{it.shortcut}</span>}
              {hasSub && <span class="arrow">▸</span>}
            </div>
          );
        })}
      </div>
      {sub && items[sub.index]?.submenu && (
        <MenuList
          items={resolve(items[sub.index].submenu)}
          x={sub.x}
          y={sub.y}
          onClose={p.onClose}
          level={(p.level ?? 0) + 1}
        />
      )}
    </>
  );
}

/** Dropdown menu button used in headers. */
export function MenuButton(p: { label: string; items: () => MenuItem[]; testId?: string }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);
  return (
    <>
      <button
        class={`menu-button ${open ? 'open' : ''}`}
        data-testid={p.testId ?? `menu-button-${p.label.toLowerCase()}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (open) return setOpen(null);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setOpen({ x: r.left, y: r.bottom + 2 });
        }}
      >
        {p.label}
      </button>
      {open && <MenuList items={p.items()} x={open.x} y={open.y} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Host for popup menus requested via `wm.call_menu` (Shift+A, X, Shift+S, Z, RMB…). */
export function PopupMenuHost() {
  const m = popupMenu.value;
  useEffect(() => {
    if (!m) return;
    const close = () => (popupMenu.value = null);
    const t = setTimeout(() => window.addEventListener('pointerdown', close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
    };
  }, [m]);
  if (!m || !session.value) return null;
  const items = menuByName(m.name);
  if (!items.length) return null;
  return <MenuList items={items} x={m.x - 20} y={m.y - 10} onClose={() => (popupMenu.value = null)} />;
}

/** F3 operator search. */
export function CommandPalette() {
  const [q, setQ] = useState('');
  const [hover, setHover] = useState(0);
  if (!paletteOpen.value) return null;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = registry
    .list()
    .filter((d) => {
      const hay = `${d.label} ${d.id} ${d.category} ${d.description}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, 60);
  const close = () => {
    paletteOpen.value = false;
    setQ('');
    setHover(0);
  };
  const exec = (id: string) => {
    close();
    run(id, undefined, 'palette');
  };
  return (
    <div
      class="modal-backdrop"
      style={{ background: 'transparent', alignItems: 'flex-start' }}
      onPointerDown={close}
    >
      <div class="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Search operators… (e.g. 'bevel', 'add cube', 'subdivision')"
          value={q}
          data-testid="palette-input"
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setHover(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setHover((h) => Math.min(results.length - 1, h + 1));
            if (e.key === 'ArrowUp') setHover((h) => Math.max(0, h - 1));
            if (e.key === 'Enter' && results[hover]) exec(results[hover].id);
          }}
        />
        <div class="results">
          {results.map((d, i) => (
            <div
              key={d.id}
              class={`result ${i === hover ? 'hover' : ''}`}
              onPointerEnter={() => setHover(i)}
              onClick={() => exec(d.id)}
              title={d.description}
            >
              <span>{d.label}</span>
              <span class="cat">
                {d.category} · {d.id}
              </span>
            </div>
          ))}
          {results.length === 0 && <div class="empty-note">No matching operators</div>}
        </div>
      </div>
    </div>
  );
}
