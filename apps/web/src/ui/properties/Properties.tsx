import { useState } from 'preact/hooks';
import { session as sessionSig } from '../../app/store';
import type { ProjectSession } from '../../project/session';
import { Icon, type IconName } from '../icons';
import { RenderTab, OutputTab, SceneTab, WorldTab } from './SceneTabs';
import { ObjectTab } from './ObjectTab';
import { ModifiersTab } from './ModifiersTab';
import { DataTab } from './DataTab';
import { MaterialTab } from './MaterialTab';

type Tab = 'render' | 'output' | 'scene' | 'world' | 'object' | 'modifiers' | 'data' | 'material';

const TABS: { id: Tab; icon: IconName; title: string; needs?: 'object' | 'mesh' }[] = [
  { id: 'render', icon: 'render', title: 'Render' },
  { id: 'output', icon: 'output', title: 'Output' },
  { id: 'scene', icon: 'scene', title: 'Scene' },
  { id: 'world', icon: 'world', title: 'World' },
  { id: 'object', icon: 'object', title: 'Object', needs: 'object' },
  { id: 'modifiers', icon: 'wrench', title: 'Modifiers', needs: 'mesh' },
  { id: 'data', icon: 'data', title: 'Object Data', needs: 'object' },
  { id: 'material', icon: 'material', title: 'Material', needs: 'mesh' },
];

export const propertiesTab = { current: 'object' as Tab };

export function Properties({ session }: { session: ProjectSession }) {
  void session.revision.value;
  const activeId = session.state.$activeId.value;
  const active = activeId ? session.doc.getObject(activeId) : null;
  const [tab, setTab] = useState<Tab>(propertiesTab.current);
  const available = TABS.filter((t) => !t.needs || (t.needs === 'object' ? !!active : active?.type === 'MESH'));
  const current = available.find((t) => t.id === tab) ? tab : available.find((t) => t.id === 'scene')!.id;
  return (
    <div class="properties" onPointerDown={(e) => e.stopPropagation()}>
      <div class="prop-tabs">
        {available.map((t) => (
          <button
            key={t.id}
            class={current === t.id ? 'active' : ''}
            title={t.title}
            data-testid={`prop-tab-${t.id}`}
            onClick={() => {
              propertiesTab.current = t.id;
              setTab(t.id);
            }}
          >
            <Icon name={t.icon} />
          </button>
        ))}
      </div>
      <div class="prop-content" data-testid={`prop-content-${current}`}>
        {current === 'render' && <RenderTab s={session} />}
        {current === 'output' && <OutputTab s={session} />}
        {current === 'scene' && <SceneTab s={session} />}
        {current === 'world' && <WorldTab s={session} />}
        {current === 'object' && active && <ObjectTab s={session} o={active} />}
        {current === 'modifiers' && active && <ModifiersTab s={session} o={active} />}
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
