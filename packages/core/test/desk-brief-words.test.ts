import { describe, expect, it } from 'vitest';
import { isHumanoid } from '../src/desk/rideo/rules';
import { castKinds } from '../src/desk/brief/plan';
import { animalOf, interiorFromWords } from '../src/desk/brief/words';
import type { SceneBrief } from '../src/desk/brief';

/*
 * What a brief's words say (desk/brief words.ts) where the brief leaves it to them: a cast member
 * without a kind hint (rideo sends none: its descriptions open with an identity line, "Name: age
 * gender, build; marks; wearing …") is the animal its own words name only when they name it before
 * any person and not as something the member has, does or wears; an identity line that gives a
 * gender is a person's, whatever animal words follow in it, and its age and gender make the person
 * a child, an elder, a woman or a man; a set without `interior` is one only when a room is named,
 * not an outdoor place that "inside", "flat", "bar", "cafe", "factory" or "museum" qualifies, and an
 * outdoor word naming a building ("the lake house") is not the place.
 */

function kindOf(name: string, description: string, hint: string | null = null) {
  const brief = {
    id: 'scene',
    name: 'Scene',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: '', interior: false, timeOfDay: null },
    cast: [{ id: 'c', name, description, kind: hint, heightM: null }],
    elements: [],
    shots: [],
  } as SceneBrief;
  const { kinds, warnings } = castKinds(brief);
  return { ...kinds.get('c')!, warnings };
}

describe('a cast member without a kind hint', () => {
  it.each([
    ['Tom', 'Tom: A farmer with a goat.', 'adult'],
    ['Anna', 'Anna: A girl who loves birds.', 'child'],
    ['Old Joe', 'Old Joe: An old fisherman feeding the ducks.', 'adult'],
    ['Rita', 'Rita: A zookeeper who looks after the lions.', 'adult'],
    ['Kit', 'Kit: A girl in a rabbit costume.', 'child'],
    ['Mira', 'Mira: 8 girl, slim; a small bird tattoo on her wrist; wearing a yellow raincoat.', 'child'],
    ['Tom', 'Tom: 45 man, stocky; wearing a fox-fur hat.', 'man'],
    ['Ana', 'Ana: 30 woman; wearing rabbit ears for the party.', 'woman'],
    ['Sam', 'Sam: 40 man; a horse tattoo on his arm.', 'man'],
    ['Jo', 'Jo: A girl in a horse costume.', 'child'],
    ['Ned', 'A horse trainer from the valley.', 'adult'],
    ['Mr Fox', 'A fox in a waistcoat who talks and wears glasses.', 'adult'],
  ])('%s (%s) is a person', (name, description, kind) => {
    const k = kindOf(name, description);
    expect(isHumanoid(k.kind), `${name}: ${k.kind} (${k.reason})`).toBe(true);
    expect(k.kind).toBe(kind);
    expect(k.warnings).toEqual([]);
  });

  it.each([
    ['Daisy', 'A white duck.', 'cat', 'duck'],
    ['Daisy', "Daisy, the farmer's duck.", 'cat', 'duck'],
    ['Leo', 'Two old lions.', 'bear', 'lion'],
    [
      'Quackers',
      'Quackers: 2 female, small; white feathers, orange bill. A curious white duck.',
      'cat',
      'duck',
    ],
    ['Rusty', 'A red fox who steals hens.', 'dog', 'fox'],
  ])('%s (%s) is an animal the desk stands in for', (name, description, kind, word) => {
    const k = kindOf(name, description);
    expect(k.kind).toBe(kind);
    // one animal, named as one: "Leo is a lion", not "a lions"
    expect(k.warnings).toEqual([
      `${name} is a ${word}: the desk has no ${word} figure, so a ${kind} of its size stands in`,
    ]);
  });

  it.each([
    ['Pip', 'A golden retriever puppy.', 'dog'],
    ['Pip', 'Pip: 3 male, small; golden fur. A golden retriever puppy who chases everything.', 'dog'],
    ['Star', 'Star: a brown horse with a white blaze.', 'horse'],
  ])('%s (%s) is the animal it names', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
  });

  it('reads the name when the words say nothing of what the member is', () => {
    expect(animalOf('Duck', 'Lives by the pond.')).toMatchObject({ kind: 'cat', word: 'duck' });
    expect(animalOf('Wolf', 'Wolf: 40 man, tall.')).toBeNull();
    // rideo's identity line with a gender is a person's: the name does not make it a wolf
    expect(animalOf('Wolf', 'Wolf: 40 male, tall.')).toBeNull();
  });

  // rideo's identity lines (compactIdentity: "Name: <age> <gender>, <build>; <marks>; wearing …"):
  // an animal word among the marks is a feature of a person
  it.each([
    ['Tom', 'Tom: 45 male, stocky; bull neck, broken nose.', 'man'],
    ['Dee', 'Dee: 25 female; doe eyes.', 'woman'],
    ['Sol', "Sol: 70 male; crow's feet around his eyes.", 'elder'],
    ['Roy', 'Roy: 65 male; a parrot on his shoulder.', 'elder'],
    ['Max', 'Max: 30 non-binary; fox-red hair.', 'adult'],
    ['Tom', 'Tom: 45 male, stocky; bull neck, broken nose; wearing a grey suit.', 'man'],
  ])('%s (%s) is a person, its identity line says so', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, reason: 'a person', warnings: [] });
  });

  // its age and gender, by humanKindOf's thresholds (3 and under a toddler, 12 and under a child,
  // 65 and over an elder)
  it.each([
    ['Bo', 'Bo: 6 male, small; wearing shorts.', 'child'],
    ['Pia', 'Pia: 8 female, slight; wearing a school uniform. A pupil.', 'child'],
    ['Tom', 'Tom: 72 male, stooped; wearing a flat cap.', 'elder'],
    ['Ana', 'Ana: 30 female, slim; wearing a red coat.', 'woman'],
    ['Lea', 'Lea: early 30s female, tall; wearing a lab coat.', 'woman'],
    ['Ben', 'Ben: mid-40s male; wearing overalls.', 'man'],
    ['Kit', 'Kit: 3 female; wearing a sun hat.', 'toddler'],
    ['Pia', 'Pia: 8 years old female, slight; wearing a school uniform.', 'child'],
  ])('%s (%s) is staged by the age and gender of its identity line', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
    // as when the brief's kind says "person"
    expect(kindOf(name, description, 'person')).toMatchObject({ kind, warnings: [] });
  });
});

describe('a set without `interior`', () => {
  it.each([
    'A flat sandy beach at low tide.',
    'A flat open field under a grey sky.',
    'Deep inside the forest, a mossy clearing.',
    'The cafe terrace on the village square.',
    'A sand bar in the middle of the river.',
    'The factory yard at dusk, rain on the asphalt.',
  ])('%s is outdoors', (words) => {
    expect(interiorFromWords(words)).toBe(false);
  });

  it.each([
    'A small kitchen with a view of the garden.',
    "Mira's flat.",
    'A tiny flat in the city.',
    'A dimly lit bar.',
    'Inside the old barn.',
    'The factory floor, machines humming.',
    'A meadow behind the house.',
  ])('%s', (words) => {
    expect(interiorFromWords(words)).toBe(!/meadow/.test(words));
  });

  // a room is never qualified by an outdoor word after it, and an outdoor word that names a
  // building ("the lake house", "the park's cafe") is not the place
  it.each([
    'The kitchen of the lake house, morning light.',
    'The bedroom of the beach house.',
    'The kitchen of the farm, a fire in the hearth.',
    'The hall of the mountain lodge.',
    "Inside the park's cafe.",
    'The office of the harbour master.',
    'A cosy kitchen, a garden outside the window.',
    'The lobby of the forest hotel.',
    'Inside the lake house.',
  ])('%s is an interior', (words) => {
    expect(interiorFromWords(words)).toBe(true);
  });

  it('reads an outdoor word that names a building as neither indoors nor outdoors', () => {
    expect(interiorFromWords('A lake house at dusk.')).toBeNull();
    expect(interiorFromWords('The lake at dusk.')).toBe(false);
  });
});
