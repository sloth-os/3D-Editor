/*
 * Custom properties (ObjectData.custom_props) the director's desk reads and writes, by name, so that
 * every workstream spells them the same way (spec §2):
 *
 * - actor armatures: desk_role 'actor', desk_kind, desk_height_m, desk_color, desk_character_id
 *   (rideo character id when imported);
 * - actor parts: desk_actor (the armature object's id);
 * - props, landmarks, set pieces and strings: desk_role 'prop' | 'landmark' | 'set' | 'string',
 *   desk_label, desk_element_id (rideo element id), and for store models store_id, store_source,
 *   license, author, source_url;
 * - shot cameras: desk_role 'camera', desk_shot (the shot's id).
 */

export const DESK_PROPS = {
  role: 'desk_role',
  kind: 'desk_kind',
  heightM: 'desk_height_m',
  color: 'desk_color',
  characterId: 'desk_character_id',
  actor: 'desk_actor',
  label: 'desk_label',
  elementId: 'desk_element_id',
  shot: 'desk_shot',
  storeId: 'store_id',
  storeSource: 'store_source',
  license: 'license',
  author: 'author',
  sourceUrl: 'source_url',
} as const;

/** Values of the desk_role custom property. */
export const DESK_ROLES = ['actor', 'prop', 'landmark', 'set', 'string', 'camera'] as const;
export type DeskRole = (typeof DESK_ROLES)[number];
