import { STORE_CATEGORIES, type StoreCategory } from '@3d-editor/core';
import { words, wordForms } from './relevance';

/*
 * The store's categories for models whose provider has none of its own (Khronos samples, JSON
 * catalogs without a category): guessed from words of the name, tags and summary. The first
 * category with a matching word wins, in the order below (people before props: "toy car" is a
 * vehicle, "chess set" props).
 */

const CATEGORY_WORDS: [StoreCategory, readonly string[]][] = [
  [
    'vehicles',
    [
      'car',
      'truck',
      'bus',
      'van',
      'bicycle',
      'bike',
      'motorcycle',
      'boat',
      'ship',
      'plane',
      'airplane',
      'aircraft',
      'helicopter',
      'train',
      'tractor',
      'vehicle',
      'wheel',
      'kart',
      'scooter',
      'rover',
    ],
  ],
  [
    'people',
    [
      'person',
      'people',
      'man',
      'woman',
      'child',
      'kid',
      'character',
      'human',
      'body',
      'figure',
      'boy',
      'girl',
    ],
  ],
  [
    'animals',
    [
      'animal',
      'dog',
      'cat',
      'horse',
      'pony',
      'cow',
      'fox',
      'duck',
      'bird',
      'fish',
      'dragon',
      'mosquito',
      'insect',
      'bear',
      'deer',
      'sheep',
      'pig',
      'rabbit',
      'creature',
      'dinosaur',
    ],
  ],
  [
    'furniture',
    [
      'chair',
      'sofa',
      'couch',
      'table',
      'desk',
      'bed',
      'shelf',
      'bookcase',
      'cabinet',
      'wardrobe',
      'pouf',
      'stool',
      'bench',
      'armchair',
      'refrigerator',
      'fridge',
      'lamp',
      'furniture',
      'dresser',
      'ottoman',
    ],
  ],
  [
    'food',
    [
      'food',
      'fruit',
      'orange',
      'apple',
      'banana',
      'avocado',
      'olive',
      'bread',
      'cake',
      'pizza',
      'cheese',
      'watermelon',
      'vegetable',
      'drink',
      'meal',
    ],
  ],
  [
    'nature',
    [
      'tree',
      'plant',
      'flower',
      'rock',
      'stone',
      'bush',
      'grass',
      'leaf',
      'leaves',
      'log',
      'mushroom',
      'shell',
      'coral',
    ],
  ],
  [
    'architecture',
    [
      'house',
      'building',
      'wall',
      'door',
      'window',
      'roof',
      'tower',
      'bridge',
      'room',
      'cabin',
      'barn',
      'church',
      'castle',
    ],
  ],
  [
    'street',
    ['cone', 'traffic', 'street', 'road', 'sign', 'hydrant', 'mailbox', 'streetlight', 'lamppost', 'barrier'],
  ],
  [
    'sports',
    [
      'ball',
      'football',
      'soccer',
      'basketball',
      'tennis',
      'golf',
      'racket',
      'skateboard',
      'surfboard',
      'kite',
    ],
  ],
  [
    'props',
    [
      'helmet',
      'watch',
      'sunglasses',
      'glasses',
      'shoe',
      'bottle',
      'cup',
      'teacup',
      'mug',
      'vase',
      'candle',
      'lantern',
      'box',
      'crate',
      'barrel',
      'camera',
      'book',
      'phone',
      'chess',
      'game',
      'toy',
      'jar',
      'dish',
      'plate',
      'bowl',
      'pot',
      'tool',
      'clock',
    ],
  ],
];

const LOOKUP = new Map<string, StoreCategory>();
for (const [category, list] of CATEGORY_WORDS)
  for (const w of list) if (!LOOKUP.has(w)) LOOKUP.set(w, category);

/** The category the words of `texts` suggest (earlier texts count first), else null. */
export function guessCategory(...texts: (string | null | undefined)[]): StoreCategory | null {
  // CamelCase names (Khronos 'SheenWoodLeatherSofa') split into words
  const found = new Set<StoreCategory>();
  for (const text of texts) {
    if (!text) continue;
    for (const w of words(text.replace(/([a-z])([A-Z])/g, '$1 $2')))
      for (const form of wordForms(w)) {
        const c = LOOKUP.get(form);
        if (c) found.add(c);
      }
    if (found.size) break;
  }
  if (!found.size) return null;
  for (const [category] of CATEGORY_WORDS) if (found.has(category)) return category;
  return null;
}

/** `value` when it is one of the store's categories, else null. */
export function asCategory(value: unknown): StoreCategory | null {
  return typeof value === 'string' && (STORE_CATEGORIES as readonly string[]).includes(value)
    ? (value as StoreCategory)
    : null;
}
