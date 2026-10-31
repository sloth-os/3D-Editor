import type { Vec3 } from '../math/types';
import type { WorldSettings } from '../doc/types';

/** Unit direction towards the sun (Z up) from sun_elevation / sun_rotation. */
export function sunDirection(world: Pick<WorldSettings, 'sun_elevation' | 'sun_rotation'>): Vec3 {
  const ce = Math.cos(world.sun_elevation);
  return [
    ce * Math.sin(world.sun_rotation),
    -ce * Math.cos(world.sun_rotation),
    Math.sin(world.sun_elevation),
  ];
}

/**
 * Background radiance (linear RGB, before `strength`) seen along a world-space direction, for the
 * procedural sky (environment 'SKY'): zenith/horizon/ground gradient plus a sun disc. Used by the
 * software renderers and the viewport so every renderer shows the same sky.
 *
 * Phase-0 stub: the flat world colour. The materials/world workstream implements the sky model.
 */
export function sampleSky(world: WorldSettings, dir: Readonly<Vec3>): Vec3 {
  void dir;
  return [world.color[0], world.color[1], world.color[2]];
}
