import { signal } from '@preact/signals';
import type { ObjectData } from '@3d-editor/core';
import { session as sessionSig } from '../../app/store';
import type { ProjectSession } from '../../project/session';
import { Icon, type IconName } from '../icons';
import { RenderTab, OutputTab, SceneTab, WorldTab } from './SceneTabs';
import { ObjectTab } from './ObjectTab';
import { ModifiersTab } from './ModifiersTab';
import { ParticlesTab, canHaveParticles } from './ParticlesTab';
import { PhysicsTab } from './PhysicsTab';
import { ConstraintsTab } from './ConstraintsTab';
import { DataTab } from './DataTab';
import { MaterialTab } from './MaterialTab';

/** Tabs of the Properties editor, in Blender's order. */
export type PropertiesTabId =
  | 'render'
  | 'output'
  | 'scene'
  | 'world'
  | 'object'
  | 'modifiers'
  | 'particles'
  | 'physics'
  | 'constraints'
  | 'data'
  | 'material';

interface TabDef {
  id: PropertiesTabId;
  icon: IconName;
  title: string;
  /** Whether the tab applies to the active object (scene tabs are always shown). */
  available?: (o: ObjectData | null) => boolean;
}

const hasObject = (o: ObjectData | null) => !!o;
const isMesh = (o: ObjectData | null) => o?.type === 'MESH';
/** Object types with material slots (core: meshes, and curves/text through their splines). */
const MATERIAL_TYPES = new Set(['MESH', 'CURVE', 'FONT']);
const hasMaterialSlots = (o: ObjectData | null) => !!o && MATERIAL_TYPES.has(o.type);

const TABS: TabDef[] = [
  { id: 'render', icon: 'render', title: 'Render' },
  { id: 'output', icon: 'output', title: 'Output' },
  { id: 'scene', icon: 'scene', title: 'Scene' },
  { id: 'world', icon: 'world', title: 'World' },
  { id: 'object', icon: 'object', title: 'Object', available: hasObject },
  { id: 'modifiers', icon: 'wrench', title: 'Modifiers', available: isMesh },
  { id: 'particles', icon: 'particles', title: 'Particles', available: (o) => !!o && canHaveParticles(o) },
  { id: 'physics', icon: 'physics', title: 'Physics', available: (o) => isMesh(o) || !!o?.rigid_body },
  { id: 'constraints', icon: 'constraint', title: 'Object Constraints', available: hasObject },
  { id: 'data', icon: 'data', title: 'Object Data', available: hasObject },
  { id: 'material', icon: 'material', title: 'Material', available: hasMaterialSlots },
];

/**
 * The selected Properties tab. A signal so other editors can switch it (e.g. clicking a modifier
 * or constraint in the Outliner opens its tab, like Blender).
 */
export const activePropertiesTab = signal<PropertiesTabId>('object');

/** @deprecated use {@link activePropertiesTab}; kept for existing callers. */
export const propertiesTab = {
  get current(): PropertiesTabId {
    return activePropertiesTab.value;
  },
  set current(v: PropertiesTabId) {
    activePropertiesTab.value = v;
  },
};

/** Tabs shown for the given active object. */
export function availableTabs(active: ObjectData | null): PropertiesTabId[] {
  return TABS.filter((t) => !t.available || t.available(active)).map((t) => t.id);
}

export function Properties({ session }: { session: ProjectSession }) {
  void session.revision.value;
  const activeId = session.state.$activeId.value;
  const active = activeId ? session.doc.getObject(activeId) : null;
  const tab = activePropertiesTab.value;
  const available = TABS.filter((t) => !t.available || t.available(active));
  // an unavailable tab falls back to Scene without forgetting the choice (it returns when the
  // active object supports it again, as in Blender)
  const current = available.some((t) => t.id === tab) ? tab : 'scene';
  return (
    <div class="properties" onPointerDown={(e) => e.stopPropagation()}>
      <div class="prop-tabs" role="tablist" aria-orientation="vertical">
        {available.map((t) => (
          <button
            key={t.id}
            class={current === t.id ? 'active' : ''}
            title={t.title}
            role="tab"
            aria-selected={current === t.id}
            aria-label={t.title}
            data-testid={`prop-tab-${t.id}`}
            onClick={() => (activePropertiesTab.value = t.id)}
          >
            <Icon name={t.icon} />
          </button>
        ))}
      </div>
      <div class="prop-content" role="tabpanel" data-testid={`prop-content-${current}`}>
        {current === 'render' && <RenderTab s={session} />}
        {current === 'output' && <OutputTab s={session} />}
        {current === 'scene' && <SceneTab s={session} />}
        {current === 'world' && <WorldTab s={session} />}
        {current === 'object' && active && <ObjectTab s={session} o={active} />}
        {current === 'modifiers' && active && <ModifiersTab s={session} o={active} />}
        {current === 'particles' && active && <ParticlesTab s={session} o={active} />}
        {current === 'physics' && active && <PhysicsTab s={session} o={active} />}
        {current === 'constraints' && active && <ConstraintsTab s={session} o={active} />}
        {current === 'data' && active && <DataTab s={session} o={active} />}
        {current === 'material' && active && <MaterialTab s={session} o={active} />}
      </div>
    </div>
  );
}

export function PropertiesArea() {
  const s = sessionSig.value;
  return s ? <Properties session={s} /> : null;
}
