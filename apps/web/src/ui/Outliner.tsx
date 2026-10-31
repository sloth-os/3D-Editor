import { useState } from 'preact/hooks';
import { ROOT_COLLECTION_ID, type CollectionData, type ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { run } from '../editor/editor';
import { Icon, type IconName } from './icons';

const TYPE_ICON: Record<string, IconName> = {
  MESH: 'mesh',
  EMPTY: 'empty',
  CAMERA: 'camera',
  LIGHT: 'light',
};

/** Scene hierarchy: collections → objects → children, with visibility toggles, rename and drag-to-parent. */
export function Outliner({ session }: { session: ProjectSession }) {
  void session.revision.value;
  const st = session.state;
  const selected = new Set(st.$selectedIds.value);
  const active = st.$activeId.value;
  const peers = session.peers.value;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const doc = session.doc;
  const objects = doc.listObjects();
  const collections = doc.listCollections();
  const byParent = new Map<string | null, ObjectData[]>();
  for (const o of objects) {
    const key = o.parent && objects.some((x) => x.id === o.parent) ? o.parent : null;
    const list = byParent.get(key) ?? [];
    list.push(o);
    byParent.set(key, list);
  }
  const peerColorFor = (id: string) => peers.find((p) => p.state.selection?.includes(id))?.state.user.color;

  const toggleCollapse = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  const select = (o: ObjectData, e: MouseEvent) => {
    if (st.mode !== 'OBJECT' && o.id !== st.activeId) run('object.mode_set', { mode: 'OBJECT' }, 'ui');
    if (e.ctrlKey || e.shiftKey) {
      st.selectedIds =
        selected.has(o.id) && !e.shiftKey
          ? st.selectedIds.filter((x) => x !== o.id)
          : [...new Set([...st.selectedIds, o.id])];
      st.activeId = o.id;
    } else {
      st.selectedIds = [o.id];
      st.activeId = o.id;
    }
  };

  const rows: preact.JSX.Element[] = [];
  const q = filter.trim().toLowerCase();
  const renderObject = (o: ObjectData, depth: number) => {
    if (q && !o.name.toLowerCase().includes(q)) {
      for (const c of byParent.get(o.id) ?? []) renderObject(c, depth);
      return;
    }
    const children = byParent.get(o.id) ?? [];
    const isCollapsed = collapsed.has(o.id);
    const peerColor = peerColorFor(o.id);
    rows.push(
      <div
        key={o.id}
        class={`outliner-row ${selected.has(o.id) ? 'selected' : ''} ${active === o.id ? 'active' : ''} ${dropTarget === o.id ? 'drop-target' : ''}`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        data-testid={`outliner-${o.name}`}
        draggable
        onDragStart={(e) => e.dataTransfer?.setData('text/x-object', o.id)}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(o.id);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          const id = e.dataTransfer?.getData('text/x-object');
          if (id && id !== o.id) run('object.parent_to', { objects: [id], parent: o.id }, 'ui');
        }}
        onClick={(e) => select(o, e)}
        onDblClick={() => setRenaming(o.id)}
      >
        <span class="twisty" onClick={(e) => (e.stopPropagation(), toggleCollapse(o.id))}>
          {children.length ? (isCollapsed ? '▸' : '▾') : ''}
        </span>
        <Icon name={TYPE_ICON[o.type] ?? 'object'} size={14} />
        {renaming === o.id ? (
          <input
            class="textfield"
            autoFocus
            value={o.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                run('object.rename', { object: o.id, name: (e.target as HTMLInputElement).value }, 'ui');
                setRenaming(null);
              }
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={(e) => {
              const v = (e.target as HTMLInputElement).value;
              if (v && v !== o.name) run('object.rename', { object: o.id, name: v }, 'ui');
              setRenaming(null);
            }}
            ref={(el) => el?.select()}
          />
        ) : (
          <span class={`name ${o.hide_viewport ? 'hidden' : ''}`}>{o.name}</span>
        )}
        {o.modifiers.length > 0 && <Icon name="wrench" size={12} style={{ opacity: 0.6 }} />}
        {peerColor && (
          <span class="peer-dot" style={{ background: peerColor }} title="Selected by another user" />
        )}
        <span
          class="vis"
          title={o.hide_viewport ? 'Show in viewport' : 'Hide in viewport'}
          data-testid={`outliner-vis-${o.name}`}
          onClick={(e) => {
            e.stopPropagation();
            run(
              'data.set_property',
              { kind: 'objects', target: o.id, values: { hide_viewport: !o.hide_viewport } },
              'ui',
            );
          }}
        >
          <Icon name={o.hide_viewport ? 'eyeOff' : 'eye'} size={13} />
        </span>
      </div>,
    );
    if (!isCollapsed) for (const c of children) renderObject(c, depth + 1);
  };

  const renderCollection = (c: CollectionData, depth: number) => {
    const isCollapsed = collapsed.has(c.id);
    rows.push(
      <div
        key={`c-${c.id}`}
        class={`outliner-row ${dropTarget === c.id ? 'drop-target' : ''}`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        onClick={() => toggleCollapse(c.id)}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(c.id);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          const id = e.dataTransfer?.getData('text/x-object');
          if (!id) return;
          run('object.parent_to', { objects: [id], parent: null }, 'ui');
          st.selectedIds = [id];
          run('object.move_to_collection', { collection: c.id }, 'ui');
        }}
      >
        <span class="twisty">{isCollapsed ? '▸' : '▾'}</span>
        <Icon name="collection" size={14} />
        <span class={`name ${c.hide_viewport ? 'hidden' : ''}`}>{c.name}</span>
        {c.id !== ROOT_COLLECTION_ID && (
          <span
            class="vis"
            onClick={(e) => {
              e.stopPropagation();
              run(
                'data.set_property',
                { kind: 'collections', target: c.id, values: { hide_viewport: !c.hide_viewport } },
                'ui',
              );
            }}
          >
            <Icon name={c.hide_viewport ? 'eyeOff' : 'eye'} size={13} />
          </span>
        )}
      </div>,
    );
    if (isCollapsed) return;
    for (const child of collections.filter((x) => x.parent === c.id && x.id !== c.id))
      renderCollection(child, depth + 1);
    for (const o of byParent.get(null) ?? [])
      if (
        o.collection === c.id ||
        (c.id === ROOT_COLLECTION_ID && !collections.some((x) => x.id === o.collection))
      )
        renderObject(o, depth + 1);
  };
  renderCollection(collections[0], 0);

  return (
    <div class="area-body" onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ padding: '4px 6px' }}>
        <input
          class="textfield"
          placeholder="Filter…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div data-testid="outliner">{rows}</div>
      {objects.length === 0 && <div class="empty-note">Empty scene — press Shift+A to add objects</div>}
    </div>
  );
}
