import { listModifierDefs, getModifierDef, safeJsonSchema, type ModifierData, type ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { MenuButton } from '../Menu';
import { Panel } from '../fields/fields';
import { SchemaForm } from '../SchemaForm';
import { Icon } from '../icons';
import { run } from '../../editor/editor';
import { PREVIEW_ORIGIN } from './prop-edit';
import type { MenuItem } from '../../editor/menus';

let dragOriginal: { key: string; modifiers: ModifierData[] } | null = null;

function setParam(s: ProjectSession, o: ObjectData, mod: ModifierData, key: string, value: unknown, final: boolean): void {
  const k = `${o.id}:${mod.id}:${key}`;
  if (!final) {
    if (!dragOriginal || dragOriginal.key !== k) dragOriginal = { key: k, modifiers: o.modifiers };
    const modifiers = o.modifiers.map((m) => (m.id === mod.id ? { ...m, params: { ...m.params, [key]: value } } : m));
    s.doc.transact(() => s.doc.updateObject(o.id, { modifiers }), PREVIEW_ORIGIN);
    return;
  }
  if (dragOriginal?.key === k) {
    s.doc.transact(() => s.doc.updateObject(o.id, { modifiers: dragOriginal!.modifiers }), PREVIEW_ORIGIN);
    dragOriginal = null;
  }
  run('object.modifier_set', { object: o.id, modifier: mod.id, params: { [key]: value } }, 'ui');
}

function addMenu(o: ObjectData): MenuItem[] {
  const defs = listModifierDefs();
  const cats = ['EDIT', 'GENERATE', 'DEFORM', 'NORMALS'] as const;
  const names: Record<string, string> = { EDIT: 'Edit', GENERATE: 'Generate', DEFORM: 'Deform', NORMALS: 'Normals' };
  return cats
    .map((c) => ({
      label: names[c],
      submenu: defs
        .filter((d) => d.category === c)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((d) => ({ label: d.label, op: 'object.modifier_add', params: { type: d.type, object: o.id } })),
    }))
    .filter((c) => c.submenu.length > 0);
}

export function ModifiersTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = s.evaluator.evaluate(s.state.frame).byId.get(o.id);
  return (
    <>
      <div class="prop-context">
        <Icon name="wrench" size={14} /> {o.name}
      </div>
      <div style={{ padding: '4px 8px' }} data-testid="add-modifier">
        <MenuButton label="Add Modifier ▾" items={() => addMenu(o)} testId="add-modifier-button" />
      </div>
      {o.modifiers.length === 0 && <div class="empty-note">No modifiers. Add one to change geometry non-destructively.</div>}
      {o.modifiers.map((m, i) => {
        const def = getModifierDef(m.type);
        const err = ev?.modifierErrors.find((e) => e.modifierId === m.id);
        return (
          <Panel
            key={m.id}
            id={`mod-${m.id}`}
            title={`${m.name}`}
            actions={
              <>
                <button
                  class={`btn flat icon ${m.show_in_editmode ? 'active' : ''}`}
                  title="Show in Edit Mode"
                  onClick={() => run('object.modifier_set', { object: o.id, modifier: m.id, show_in_editmode: !m.show_in_editmode }, 'ui')}
                >
                  <Icon name="vert" size={12} />
                </button>
                <button
                  class={`btn flat icon ${m.show_viewport ? 'active' : ''}`}
                  title="Show in Viewport"
                  data-testid={`modifier-toggle-${m.name}`}
                  onClick={() => run('object.modifier_set', { object: o.id, modifier: m.id, show_viewport: !m.show_viewport }, 'ui')}
                >
                  <Icon name="eye" size={12} />
                </button>
                <button
                  class={`btn flat icon ${m.show_render ? 'active' : ''}`}
                  title="Show in Render"
                  onClick={() => run('object.modifier_set', { object: o.id, modifier: m.id, show_render: !m.show_render }, 'ui')}
                >
                  <Icon name="render" size={12} />
                </button>
                <button class="btn flat icon" title="Move up" disabled={i === 0} onClick={() => run('object.modifier_move_up', { object: o.id, modifier: m.id }, 'ui')}>
                  <Icon name="up" size={12} />
                </button>
                <button
                  class="btn flat icon"
                  title="Move down"
                  disabled={i === o.modifiers.length - 1}
                  onClick={() => run('object.modifier_move_down', { object: o.id, modifier: m.id }, 'ui')}
                >
                  <Icon name="down" size={12} />
                </button>
                <button class="btn flat" title="Apply (bake into mesh)" data-testid={`modifier-apply-${m.name}`} onClick={() => run('object.modifier_apply', { object: o.id, modifier: m.id }, 'ui')}>
                  Apply
                </button>
                <button class="btn flat icon" title="Remove" data-testid={`modifier-remove-${m.name}`} onClick={() => run('object.modifier_remove', { object: o.id, modifier: m.id }, 'ui')}>
                  <Icon name="close" size={12} />
                </button>
              </>
            }
          >
            {err && <div class="error-text">{err.message}</div>}
            {def ? (
              <SchemaForm
                schema={safeJsonSchema(def.schema)}
                values={m.params}
                doc={s.doc}
                testIdPrefix={`mod-${m.type.toLowerCase()}`}
                onChange={(k, v, final) => setParam(s, o, m, k, v, final)}
              />
            ) : (
              <div class="hint">Unknown modifier type {m.type}</div>
            )}
          </Panel>
        );
      })}
    </>
  );
}
