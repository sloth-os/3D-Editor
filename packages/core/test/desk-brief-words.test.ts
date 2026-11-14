import { describe, expect, it } from 'vitest';
import { isHumanoid } from '../src/desk/rideo/rules';
import { castKinds } from '../src/desk/brief/plan';
import { animalOf, interiorFromWords } from '../src/desk/brief/words';
import type { SceneBrief } from '../src/desk/brief';

/*
 * What a brief's words say (desk/brief words.ts) where the brief leaves it to them: a cast member
 * without a kind hint (rideo sends none: its descriptions open with an identity line, "Name: age
 * gender, build; marks; wearing …") is the animal its own words name only when they name it before
 * any person and not as something the member has, does or wears; a set without `interior` is one
 * only when a room is named, not an outdoor place that a room word qualifies.
 */

function kindOf(name: string, description: string) {
  const brief = {
    id: 'scene',
    name: 'Scene',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: '', interior: false, timeOfDay: null },
    cast: [{ id: 'c', name, description, kind: null, heightM: null }],
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
});
