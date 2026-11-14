import type { JSX } from 'preact';
import type { StoreCategory } from '@3d-editor/core';

/*
 * Line icons of the store categories (16 px grid, drawn for this editor): the Asset Browser shows
 * them on the chips and in place of a thumbnail when a model has none (no editor server, or a
 * thumbnail that failed to load).
 */

const PATHS: Record<StoreCategory, string> = {
  // head and shoulders
  people: 'M8 2.5a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM3.5 13.5c0-2.6 2-4.6 4.5-4.6s4.5 2 4.5 4.6',
  // a paw: four toes and the pad
  animals:
    'M4.2 5.2a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM6.8 2.8a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM9.2 2.8a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM11.8 5.2a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM5.4 12c0-2.1 1.2-3.8 2.6-3.8s2.6 1.7 2.6 3.8c0 1.1-1.1 1.6-2.6 1.6S5.4 13.1 5.4 12z',
  // a chair from the side
  furniture: 'M5 2v12M5 8.5h6.5M11.5 8.5V14M5 5.5h1.5',
  // a crate
  props: 'M2.5 4.5h11v9h-11zM2.5 4.5l11 9M13.5 4.5l-11 9',
  // an apple
  food: 'M8 5.2C6.6 4.3 3 4.2 3 8.1 3 11.3 5.3 14 8 13.4c2.7.6 5-2.1 5-5.3 0-3.9-3.6-3.8-5-2.9zM8 5.2c0-1.4.6-2.4 2-3',
  // a car from the side
  vehicles:
    'M1.8 10.8V8.6l1.6-3.1h6.8l2.2 3.1h1.8v2.2M3.6 10.8a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zM9.8 10.8a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zM6.2 10.8h3.6',
  // a pine tree
  nature: 'M8 1.8 4 7.5h2.3L3.3 12h9.4L9.7 7.5H12zM8 12v2.4',
  // a house
  architecture: 'M2.3 7.6 8 3l5.7 4.6M3.8 6.4V13h8.4V6.4M6.8 13V9.8h2.4V13',
  // a traffic cone
  street: 'M8 2 4.6 12.8h6.8zM2.8 13.4h10.4M5.9 8.6h4.2',
  // a ball
  sports:
    'M8 2.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2zM2.2 8h11.6M8 2.2c1.9 2.1 1.9 9.5 0 11.6M8 2.2c-1.9 2.1-1.9 9.5 0 11.6',
};

/** A model or category without a picture: a box. */
const GENERIC = 'M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8zM2 4.8 8 8l6-3.2M8 8v6.5';

/** The line icon of a store category (a box for none). */
export function CategoryIcon({
  category,
  size = 16,
  ...rest
}: { category: StoreCategory | null | undefined; size?: number } & JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={category ? PATHS[category] : GENERIC} />
    </svg>
  );
}
