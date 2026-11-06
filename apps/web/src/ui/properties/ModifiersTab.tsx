import {
  listModifierDefs,
  getModifierDef,
  modifierObjectParams,
  safeJsonSchema,
  type ModifierData,
  type ObjectData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { MenuButton } from '../Menu';
import { Panel } from '../fields/fields';
import { SchemaForm } from '../SchemaForm';
import { Icon } from '../icons';
import { run } from '../../editor/editor';
import { captureField, dragEdit, isRecord, withField } from './ObjectTab';
import type { MenuItem } from '../../editor/menus';

/** The stored modifier of an object (null when it is gone). */
function storedModifier(s: ProjectSession, objectId: string, modifierId: string): ModifierData | null {
  const list = s.doc.getObject(objectId)?.modifiers;
  return (Array.isArray(list) ? list : []).find((m) => isRecord(m) && m.id === modifierId) ?? null;
}

/**
 * Sets one parameter of a modifier in the current document state (live drag previews and their
 * restore; undefined removes it): the other modifiers and the other values of this one, including
 * changes other devices or MCP agents make meanwhile, are kept as stored.
 */
function writeParam(
  s: ProjectSession,
  objectId: string,
  modifierId: string,
  key: string,
  value: unknown,
): void {
  const list = s.doc.getObject(objectId)?.modifiers;
  if (!Array.isArray(list) || !storedModifier(s, objectId, modifierId)) return;
  s.doc.updateObject(objectId, {
    modifiers: list.map((m) =>
      isRecord(m) && m.id === modifierId ? { ...m, params: withField(m.params, key, value) } : m,
    ),
  });
}

/**
 * Changes a modifier parameter from the panel: drags preview live and commit once through
 * object.modifier_set (one undo step); the release restores only the dragged parameter.
 */
function setParam(
  s: ProjectSession,
  o: ObjectData,
  mod: ModifierData,
  key: string,
  value: unknown,
  final: boolean,
): void {
  dragEdit(
    s,
    `modifier:${o.id}:${mod.id}:${key}`,
    final,
    () => writeParam(s, o.id, mod.id, key, value),
    captureField(
      () => storedModifier(s, o.id, mod.id)?.params?.[key],
      (before) => writeParam(s, o.id, mod.id, key, before),
    ),
    () => run('object.modifier_set', { object: o.id, modifier: mod.id, params: { [key]: value } }, 'ui'),
  );
}

function addMenu(o: ObjectData): MenuItem[] {
  const defs = listModifierDefs();
  const cats = ['EDIT', 'GENERATE', 'DEFORM', 'NORMALS'] as const;
  const names: Record<string, string> = {
    EDIT: 'Edit',
    GENERATE: 'Generate',
    DEFORM: 'Deform',
    NORMALS: 'Normals',
  };
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

/**
 * Why a modifier of `o` cannot be applied on its own (null when it can): the stack of a curve or
 * text object only bakes as a whole, by converting the object to a mesh (core object.modifier_apply).
 */
export function modifierApplyBlocked(o: ObjectData): string | null {
  if (o.type === 'MESH') return null;
  const kind = o.type === 'FONT' ? 'text' : 'curve';
  return (
    `Modifiers of a ${kind} object cannot be applied one by one: Object > Convert > Mesh bakes the ` +
    'whole modifier stack into a mesh'
  );
}

export function ModifiersTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = s.evaluator.evaluate(s.state.frame).byId.get(o.id);
  const applyBlocked = modifierApplyBlocked(o);
  return (
    <>
      <div class="prop-context">
        <Icon name="wrench" size={14} /> {o.name}
      </div>
      <div style={{ padding: '4px 8px' }} data-testid="add-modifier">
        <MenuButton label="Add Modifier ▾" items={() => addMenu(o)} testId="add-modifier-button" />
      </div>
      {o.type !== 'MESH' && (
        <div class="hint" style={{ padding: '0 8px 4px' }} data-testid="modifier-curve-hint">
          {o.type === 'FONT'
            ? 'The modifiers act on the surface of the text.'
            : 'The modifiers act on the surface of the curve, or on its wire when it has none (Screw revolves a profile).'}
        </div>
      )}
      {o.modifiers.length === 0 && (
        <div class="empty-note">No modifiers. Add one to change geometry non-destructively.</div>
      )}
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
                  onClick={() =>
                    run(
                      'object.modifier_set',
                      { object: o.id, modifier: m.id, show_in_editmode: !m.show_in_editmode },
                      'ui',
                    )
                  }
                >
                  <Icon name="vert" size={12} />
                </button>
                <button
                  class={`btn flat icon ${m.show_viewport ? 'active' : ''}`}
                  title="Show in Viewport"
                  data-testid={`modifier-toggle-${m.name}`}
                  onClick={() =>
                    run(
                      'object.modifier_set',
                      { object: o.id, modifier: m.id, show_viewport: !m.show_viewport },
                      'ui',
                    )
                  }
                >
                  <Icon name="eye" size={12} />
                </button>
                <button
                  class={`btn flat icon ${m.show_render ? 'active' : ''}`}
                  title="Show in Render"
                  onClick={() =>
                    run(
                      'object.modifier_set',
                      { object: o.id, modifier: m.id, show_render: !m.show_render },
                      'ui',
                    )
                  }
                >
                  <Icon name="render" size={12} />
                </button>
                <button
                  class="btn flat icon"
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => run('object.modifier_move_up', { object: o.id, modifier: m.id }, 'ui')}
                >
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
                <button
                  class="btn flat"
                  title={applyBlocked ?? 'Apply (bake into mesh)'}
                  disabled={!!applyBlocked}
                  data-testid={`modifier-apply-${m.name}`}
                  onClick={() => run('object.modifier_apply', { object: o.id, modifier: m.id }, 'ui')}
                >
                  Apply
                </button>
                <button
                  class="btn flat icon"
                  title="Remove"
                  data-testid={`modifier-remove-${m.name}`}
                  onClick={() => run('object.modifier_remove', { object: o.id, modifier: m.id }, 'ui')}
                >
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
                objectKeys={modifierObjectParams(m.type)}
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
