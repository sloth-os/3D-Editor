import type { JSX } from 'preact';

/** Small original line icons (16px grid). */
const P = (d: string) => (props: JSX.SVGAttributes<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" {...props}>
    <path d={d} />
  </svg>
);

export const Icons = {
  cube: P('M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8zM2 4.8 8 8l6-3.2M8 8v6.5'),
  mesh: P('M2 3h12v10H2zM2 8h12M8 3v10M5 3v10M11 3v10'),
  empty: P('M8 2v12M2 8h12M4 4l8 8M12 4l-8 8'),
  camera: P('M2 5h8v6H2zM10 7l4-2v6l-4-2'),
  light: P('M8 2a4 4 0 0 1 2.4 7.2c-.5.4-.9 1-.9 1.8H6.5c0-.8-.4-1.4-.9-1.8A4 4 0 0 1 8 2zM6.5 13h3M7 14.5h2'),
  collection: P('M2 4h5l1 1.5h6V13H2z'),
  eye: P('M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'),
  eyeOff: P('M2 2l12 12M6.4 4A6.8 6.8 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a12 12 0 0 1-2 2.6M9.6 12.1c-.5.2-1 .4-1.6.4C4 12.5 1.5 8 1.5 8A12 12 0 0 1 4 5'),
  select: P('M3 2l9 5-4 1 3 5-2 1-3-5-3 3z'),
  cursor: P('M8 1v4M8 11v4M1 8h4M11 8h4M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'),
  move: P('M8 1v14M1 8h14M8 1 6 3M8 1l2 2M8 15l-2-2M8 15l2-2M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2'),
  rotate: P('M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3'),
  scale: P('M2 14 14 2M9 2h5v5M2 9v5h5'),
  brush: P('M10 2l4 4-6 6-4-4zM4 8l-2 6 6-2'),
  render: P('M2 3h12v9H2zM5 15h6M8 12v3M6 6l4 1.5L6 9z'),
  scene: P('M2 13l4-6 3 4 2-3 3 5zM11 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z'),
  world: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM1.5 8h13M8 1.5c2 2 2.5 4.3 2.5 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.5 5.8 5.5 8S6 12.5 8 14.5'),
  object: P('M3 3h10v10H3zM6 6h4v4H6z'),
  wrench: P('M10.5 2a3 3 0 0 0-2.8 4L2.5 11.2a1.4 1.4 0 0 0 2 2L9.8 8a3 3 0 0 0 4-2.8l-1.8 1.8-2-.5-.5-2z'),
  data: P('M3 3l5-1.5L13 3v10l-5 1.5L3 13zM3 3l5 1.5L13 3M8 4.5v10'),
  material: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM4.5 6a4 4 0 0 1 3-2.5'),
  output: P('M2 4h12v8H2zM5 2v2M11 2v2M2 7h12'),
  play: P('M5 3l8 5-8 5z'),
  pause: P('M5 3v10M11 3v10'),
  first: P('M3 3v10M13 3 6 8l7 5z'),
  last: P('M13 3v10M3 3l7 5-7 5z'),
  prev: P('M11 3 5 8l6 5z'),
  next: P('M5 3l6 5-6 5z'),
  key: P('M8 2l5 6-5 6-5-6z'),
  plus: P('M8 3v10M3 8h10'),
  minus: P('M3 8h10'),
  close: P('M3 3l10 10M13 3 3 13'),
  up: P('M4 10l4-4 4 4'),
  down: P('M4 6l4 4 4-4'),
  chevronRight: P('M6 3l5 5-5 5'),
  chevronDown: P('M3 6l5 5 5-5'),
  trash: P('M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6l.5-9.5'),
  copy: P('M5 5h8v8H5zM3 11V3h8'),
  check: P('M3 8.5l3 3 7-7'),
  link: P('M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1'),
  cloud: P('M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.8 1 2.5 2.5 0 0 0 .4 5z'),
  offline: P('M2 2l12 12M4.5 12.5h7M11.9 6.5a4 4 0 0 0-6-2.6M4.1 7.5a2.5 2.5 0 0 0 .4 5'),
  user: P('M8 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM2.5 14.5c.8-2.6 3-4 5.5-4s4.7 1.4 5.5 4'),
  bot: P('M3 6h10v7H3zM8 3v3M6 9v1M10 9v1M1.5 9v2M14.5 9v2'),
  wire: P('M2 2h12v12H2zM2 2l12 12M14 2 2 14'),
  solid: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z'),
  matPreview: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM4 8a4 4 0 0 0 4 4'),
  rendered: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 1.5v13M8 4.5l3.5 1.5M8 8l5.5.5M8 11.5l4 1'),
  xray: P('M2 4h8v8H2zM6 2h8v8'),
  overlay: P('M2 6l6-3 6 3-6 3zM2 10l6 3 6-3'),
  vert: P('M3 13l10-10M3 13a1 1 0 1 1 0 .01M13 3a1 1 0 1 1 0 .01'),
  edge: P('M3 13 13 3'),
  face: P('M3 3h10v10H3z'),
  search: P('M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.5 10.5 14 14'),
  menu: P('M2 4h12M2 8h12M2 12h12'),
  share: P('M11 2.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM5 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM11 9.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6.8 7l2.4-1.3M6.8 9l2.4 1.3'),
  grid: P('M2 2h12v12H2zM6 2v12M10 2v12M2 6h12M2 10h12'),
  home: P('M2 8l6-5.5L14 8M4 6.5V14h8V6.5'),
  zoom: P('M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.5 10.5 14 14M5 7h4M7 5v4'),
  hand: P('M5 8V3.5a1 1 0 0 1 2 0V7M7 6.5V2.5a1 1 0 0 1 2 0V7M9 6.5V3.5a1 1 0 0 1 2 0V8M11 7a1 1 0 0 1 2 0v3a4.5 4.5 0 0 1-4.5 4.5H8A4 4 0 0 1 4.6 12.6L2.8 9.6a1 1 0 0 1 1.7-1L5 9.5'),
  info: P('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 7v4.5M8 4.5v.5'),
};

export type IconName = keyof typeof Icons;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & JSX.SVGAttributes<SVGSVGElement>) {
  const C = Icons[name];
  return <C width={size} height={size} {...rest} />;
}
