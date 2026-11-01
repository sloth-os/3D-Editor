import { SCHEMA_VERSION, type ObjectType, type ProjectInfo, type SceneDoc } from '@3d-editor/core';

export interface SceneStats {
  objects: number;
  vertices: number;
  faces: number;
  /** Objects per type (only types present), e.g. `{ MESH: 3, CURVE: 1, CAMERA: 1 }`. */
  by_type: Partial<Record<ObjectType, number>>;
}

/**
 * Scene statistics (Blender-style: mesh data counted once per object using it; vertices and
 * faces of mesh objects only, curves and text are counted by type).
 */
export function sceneStats(scene: SceneDoc): SceneStats {
  let objects = 0;
  let vertices = 0;
  let faces = 0;
  const byType: Partial<Record<ObjectType, number>> = {};
  for (const id of scene.objectIds()) {
    const o = scene.getObject(id);
    if (!o) continue;
    objects++;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
    if (o.type === 'MESH' && o.data) {
      const c = scene.meshCounts(o.data);
      if (c) {
        vertices += c.vertices;
        faces += c.faces;
      }
    }
  }
  return { objects, vertices, faces, by_type: byType };
}

/** True when the document holds no project data at all (e.g. a room nobody has written to). */
export function isSceneEmpty(scene: SceneDoc): boolean {
  return scene.map('meta').size === 0 && scene.objectIds().length === 0;
}

/** Builds the `project.json` record for a document, keeping fields such as the thumbnail. */
export function projectInfoFromScene(
  id: string,
  scene: SceneDoc,
  prev: ProjectInfo | null,
  now = new Date(),
): ProjectInfo {
  const meta = scene.getMeta();
  return {
    ...(prev ?? {}),
    id,
    name: meta.name || prev?.name || 'Untitled',
    created_at: prev?.created_at || meta.created_at || now.toISOString(),
    updated_at: now.toISOString(),
    schema_version: meta.schema_version || SCHEMA_VERSION,
    stats: sceneStats(scene),
  };
}
