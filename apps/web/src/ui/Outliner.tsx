import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ROOT_COLLECTION_ID, type CollectionData, type ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { run } from '../editor/editor';
import { Icon, type IconName } from './icons';
import { composing, useEditedText } from './fields/fields';
import { activePropertiesTab, type PropertiesTabId } from './properties/Properties';
import { validItems } from './properties/ConstraintsTab';

const TYPE_ICON: Record<string, IconName> = {
  MESH: 'mesh',
  EMPTY: 'empty',
  CAMERA: 'camera',
  LIGHT: 'light',
  CURVE: 'curve',
  FONT: 'font',
  ARMATURE: 'armature',
};

/** Outliner icon of an object (empties instancing a collection get the collection instance icon). */
export function objectIcon(o: ObjectData): IconName {
  if (o.type === 'EMPTY' && o.instance_type === 'COLLECTION' && o.instance_collection)
    return 'collectionInstance';
  return TYPE_ICON[o.type] ?? 'object';
}

/** A sub-item row below an object (modifier, constraint, particle system, rigid body, instancing). */
interface SubItem {
  key: string;
  icon: IconName;
  label: string;
  /** Properties tab that shows the item. */
  tab: PropertiesTabId;
  dim?: boolean;
  /** Visibility-style toggle (modifier show_viewport, constraint mute, particles show_viewport). */
  toggle?: { on: boolean; title: string; run: () => void };
  testId: string;
}

interface SubGroup {
  key: string;
  icon: IconName;
  label: string;
  tab: PropertiesTabId;
  items: SubItem[];
}

/** Blender-style outliner children of an object: modifiers, constraints, particles, physics, instancing. */
export function objectSubGroups(session: ProjectSession, o: ObjectData): SubGroup[] {
  const groups: SubGroup[] = [];
  const tid = (kind: string, name: string) => `outl-${kind}-${o.name}-${name}`;
  if (o.modifiers.length)
    groups.push({
      key: 'modifiers',
      icon: 'wrench',
      label: 'Modifiers',
      tab: 'modifiers',
      items: o.modifiers.map((m) => ({
        key: m.id,
        icon: 'wrench',
        label: m.name,
        tab: 'modifiers',
        dim: !m.show_viewport,
        testId: tid('modifier', m.name),
        toggle: {
          on: m.show_viewport,
          title: m.show_viewport ? 'Disable in viewport' : 'Enable in viewport',
          run: () =>
            run(
              'object.modifier_set',
              { object: o.id, modifier: m.id, show_viewport: !m.show_viewport },
              'ui',
            ),
        },
      })),
    });
  const constraints = validItems(o.constraints);
  if (constraints.length)
    groups.push({
      key: 'constraints',
      icon: 'constraint',
      label: 'Constraints',
      tab: 'constraints',
      items: constraints.map((c) => ({
        key: c.id,
        icon: 'constraint',
        label: c.name,
        tab: 'constraints',
        dim: c.mute,
        testId: tid('constraint', c.name),
        toggle: {
          on: !c.mute,
          title: c.mute ? 'Enable constraint' : 'Disable constraint',
          run: () => run('constraint.update', { object: o.id, constraint: c.id, mute: !c.mute }, 'ui'),
        },
      })),
    });
  const systems = validItems(o.particle_systems);
  if (systems.length)
    groups.push({
      key: 'particles',
      icon: 'particles',
      label: 'Particle Systems',
      tab: 'particles',
      items: systems.map((ps) => ({
        key: ps.id,
        icon: 'particles',
        label: ps.name,
        tab: 'particles',
        dim: !ps.show_viewport,
        testId: tid('particles', ps.name),
        toggle: {
          on: ps.show_viewport,
          title: ps.show_viewport ? 'Hide in viewport' : 'Show in viewport',
          run: () =>
            run(
              'object.particle_system_update',
              { object: o.id, particle_system: ps.id, show_viewport: !ps.show_viewport },
              'ui',
            ),
        },
      })),
    });
  const extra: SubItem[] = [];
  if (o.rigid_body)
    extra.push({
      key: 'rigid_body',
      icon: 'physics',
      label: `Rigid Body (${o.rigid_body.type === 'PASSIVE' ? 'Passive' : 'Active'})`,
      tab: 'physics',
      dim: o.rigid_body.enabled === false && o.rigid_body.type === 'ACTIVE',
      testId: tid('physics', 'rigid_body'),
    });
  if (o.type === 'EMPTY' && o.instance_type === 'COLLECTION' && o.instance_collection) {
    const c = session.doc.getCollection(o.instance_collection);
    extra.push({
      key: 'instance',
      icon: 'collection',
      label: c ? c.name : `${o.instance_collection} (missing)`,
      tab: 'object',
      testId: tid('instance', c?.name ?? 'missing'),
    });
  }
  if (extra.length) groups.push({ key: 'extra', icon: 'object', label: '', tab: 'object', items: extra });
  return groups;
}

/** Inline icons of a collapsed object row: one per group (and one per extra item). */
function badges(groups: SubGroup[]): { key: string; icon: IconName; tab: PropertiesTabId; title: string }[] {
  return groups.flatMap((g) =>
    g.key === 'extra'
      ? g.items.map((i) => ({ key: i.key, icon: i.icon, tab: i.tab, title: i.label }))
      : [
          {
            key: g.key,
            icon: g.icon,
            tab: g.tab,
            title: `${g.label}: ${g.items.map((i) => i.label).join(', ')}`,
          },
        ],
  );
}

/**
 * The box that renames an object (double-click). What is typed is kept in the box's own state: the
 * box showed the stored name, so every redraw of the outliner (any change to the project, by an agent
 * or another person) put the stored name back over the typing, and selected it all again. A rename of
 * this object while typing replaces the text, as in the other text fields. Enter renames (the operator
 * refuses an empty name), Escape cancels, and leaving the box renames to a changed name that is not
 * empty. The blur that browsers fire when they remove the focused box after Enter or Escape does
 * nothing more.
 */
function RenameBox(p: {
  name: string;
  onRename: (name: string, enter: boolean) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useEditedText(p.name);
  const box = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => box.current?.select(), []);
  return (
    <input
      ref={box}
      class="textfield"
      autoFocus
      value={text}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e) || done.current) return;
        if (e.key === 'Enter') {
          done.current = true;
          p.onRename((e.target as HTMLInputElement).value, true);
        }
        if (e.key === 'Escape') {
          done.current = true;
          p.onCancel();
        }
      }}
      onBlur={(e) => {
        if (done.current) return;
        done.current = true;
        p.onRename((e.target as HTMLInputElement).value, false);
      }}
    />
  );
}

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

  /**
   * `collapsed` holds the ids whose expansion differs from the default: collections and objects
   * with child objects start expanded, objects that only have sub-items start collapsed.
   */
  const toggleCollapse = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const isOpen = (id: string, byDefault: boolean) => byDefault !== collapsed.has(id);

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

  /** Clicking a sub-item selects its object and shows the item's Properties tab (like Blender). */
  const openItem = (o: ObjectData, tab: PropertiesTabId, e: MouseEvent) => {
    if ((e.ctrlKey || e.shiftKey) && selected.has(o.id)) {
      // keep the multi-selection, only make the object active
      if (st.mode !== 'OBJECT' && o.id !== st.activeId) run('object.mode_set', { mode: 'OBJECT' }, 'ui');
      st.activeId = o.id;
    } else select(o, e);
    activePropertiesTab.value = tab;
  };

  const rows: JSX.Element[] = [];
  const q = filter.trim().toLowerCase();

  const subRow = (o: ObjectData, item: SubItem, depth: number) => (
    <div
      key={`${o.id}:${item.key}`}
      class="outliner-row"
      style={{ paddingLeft: `${4 + depth * 14}px`, opacity: item.dim ? 0.55 : 1 }}
      data-testid={item.testId}
      title={`${item.label} — open in the Properties editor`}
      onClick={(e) => openItem(o, item.tab, e)}
    >
      <span class="twisty" />
      <Icon name={item.icon} size={13} />
      <span class="name">{item.label}</span>
      {item.toggle && (
        <span
          class="vis"
          title={item.toggle.title}
          onClick={(e) => {
            e.stopPropagation();
            item.toggle!.run();
          }}
        >
          <Icon name={item.toggle.on ? 'eye' : 'eyeOff'} size={13} />
        </span>
      )}
    </div>
  );

  const renderObject = (o: ObjectData, depth: number) => {
    if (q && !o.name.toLowerCase().includes(q)) {
      for (const c of byParent.get(o.id) ?? []) renderObject(c, depth);
      return;
    }
    const children = byParent.get(o.id) ?? [];
    const groups = objectSubGroups(session, o);
    const expandable = children.length > 0 || groups.length > 0;
    const open = isOpen(o.id, children.length > 0);
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
        <span
          class="twisty"
          data-testid={expandable ? `outl-twisty-${o.name}` : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={(e) => (e.stopPropagation(), expandable && toggleCollapse(o.id))}
        >
          {expandable ? (open ? '▾' : '▸') : ''}
        </span>
        <Icon name={objectIcon(o)} size={14} />
        {renaming === o.id ? (
          <RenameBox
            name={o.name}
            onRename={(name, enter) => {
              if (enter || (name && name !== o.name)) run('object.rename', { object: o.id, name }, 'ui');
              setRenaming(null);
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <span class={`name ${o.hide_viewport ? 'hidden' : ''}`}>{o.name}</span>
        )}
        {!open &&
          badges(groups).map((b) => (
            <span
              key={b.key}
              title={b.title}
              style={{ display: 'flex', opacity: 0.6, marginLeft: '2px' }}
              data-testid={`outl-badge-${o.name}-${b.key}`}
              onClick={(e) => {
                e.stopPropagation();
                openItem(o, b.tab, e);
              }}
            >
              <Icon name={b.icon} size={12} />
            </span>
          ))}
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
    if (!open) return;
    for (const g of groups) {
      if (g.key === 'extra') {
        for (const item of g.items) rows.push(subRow(o, item, depth + 1));
        continue;
      }
      const gid = `${o.id}:${g.key}`;
      const groupOpen = isOpen(gid, true);
      rows.push(
        <div
          key={gid}
          class="outliner-row"
          style={{ paddingLeft: `${4 + (depth + 1) * 14}px` }}
          data-testid={`outl-group-${o.name}-${g.key}`}
          onClick={(e) => openItem(o, g.tab, e)}
        >
          <span
            class="twisty"
            aria-expanded={groupOpen}
            onClick={(e) => (e.stopPropagation(), toggleCollapse(gid))}
          >
            {groupOpen ? '▾' : '▸'}
          </span>
          <Icon name={g.icon} size={13} />
          <span class="name" style={{ color: 'var(--text-dim)' }}>
            {g.label}
            {!groupOpen && ` (${g.items.length})`}
          </span>
        </div>,
      );
      if (groupOpen) for (const item of g.items) rows.push(subRow(o, item, depth + 2));
    }
    for (const c of children) renderObject(c, depth + 1);
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
          aria-label="Filter objects by name"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div data-testid="outliner">{rows}</div>
      {objects.length === 0 && <div class="empty-note">Empty scene — press Shift+A to add objects</div>}
    </div>
  );
}
