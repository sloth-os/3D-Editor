import { useEffect } from 'preact/hooks';
import { getShots } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { AssetBrowser } from '../assets/AssetBrowser';
import { Icon } from '../icons';
import { ShotList } from './ShotList';
import { ShotInspector } from './ShotInspector';
import { ActorPanel } from './ActorPanel';
import { directorTab, followedSelection, panelSelection, selectedShot, type DirectorTab } from './state';
import { actorOf, shotOfCamera } from './shots';
import './director.css';

/*
 * The right column of the Director workspace (and the "Shots" bottom tab on narrow screens): tabs
 * Shots (shot list, checks, shot inspector), Actor (the selected actor, or adding one) and Assets
 * (the Asset Browser). The panel follows the selection made elsewhere: a shot's camera selects its
 * shot, an actor shows the Actor tab (never leaving the Assets tab).
 */

const TABS: { id: DirectorTab; label: string; icon: 'film' | 'user' | 'cube' }[] = [
  { id: 'shots', label: 'Shots', icon: 'film' },
  { id: 'actor', label: 'Actor', icon: 'user' },
  { id: 'assets', label: 'Assets', icon: 'cube' },
];

/**
 * Follows a change of the selection made outside the panel: shots for shot cameras, the Actor tab
 * for actors. A selection the panel followed already (the panel built again) changes nothing.
 */
function useFollowSelection(s: ProjectSession, active: string | null): void {
  useEffect(() => {
    if (followedSelection.session === s && followedSelection.id === active) return;
    followedSelection.session = s;
    followedSelection.id = active;
    if (!active) return;
    // a selection the panel made itself (an issue's objects) keeps the panel where it is
    if (panelSelection.id === active) {
      panelSelection.id = null;
      return;
    }
    if (actorOf(s.doc, active)) {
      if (directorTab.peek() === 'shots') directorTab.value = 'actor';
      return;
    }
    const shot = shotOfCamera(s.doc, getShots(s.doc), active);
    if (!shot) return;
    selectedShot.value = shot.id;
    if (directorTab.peek() === 'actor') directorTab.value = 'shots';
  }, [s, active]);
}

export function DirectorPanel({ s }: { s: ProjectSession }) {
  void s.revision.value;
  const tab = directorTab.value;
  const active = s.state.$activeId.value;
  useFollowSelection(s, active);
  const actor = actorOf(s.doc, active);
  const shots = getShots(s.doc);
  const selected = selectedShot.value;
  const shot = shots.find((x) => x.id === selected) ?? null;
  return (
    <div class="director" data-testid="director-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div class="area-header director-tabs" role="tablist" aria-label="Director">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            class={`menu-button director-tab ${tab === t.id ? 'open' : ''}`}
            data-testid={`director-tab-${t.id}`}
            onClick={() => (directorTab.value = t.id)}
          >
            <Icon name={t.icon} size={12} />
            {t.label}
            {t.id === 'actor' && actor && (
              <span class="badge-dot" title={`${s.doc.getObject(actor)?.name ?? ''} is selected`} />
            )}
          </button>
        ))}
      </div>
      <div
        class={`director-body ${tab === 'assets' ? 'flush' : ''}`}
        role="tabpanel"
        data-testid={`director-content-${tab}`}
      >
        {tab === 'shots' && (
          <>
            <ShotList s={s} />
            {shot ? (
              // built anew for another shot: a field never writes what was typed for one shot into another
              <ShotInspector key={shot.id} s={s} shot={shot} />
            ) : (
              shots.length > 0 && (
                <div class="hint" style={{ padding: '8px' }}>
                  Select a shot to edit it.
                </div>
              )
            )}
          </>
        )}
        {tab === 'actor' && <ActorPanel key={actor ?? 'none'} s={s} actor={actor} />}
        {tab === 'assets' && <AssetBrowser session={s} compact />}
      </div>
    </div>
  );
}
