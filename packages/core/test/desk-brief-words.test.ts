import { describe, expect, it } from 'vitest';
import { isHumanoid } from '../src/desk/rideo/rules';
import { castKinds, planBrief } from '../src/desk/brief/plan';
import { animalOf, interiorFromWords } from '../src/desk/brief/words';
import type { SceneBrief } from '../src/desk/brief';

/*
 * What a brief's words say (desk/brief words.ts) where the brief leaves it to them: a cast member
 * without a kind hint (rideo sends none: its descriptions open with an identity line, "Name: age
 * gender, build; marks; wearing …") is the animal its own words name only when they name it before
 * any person and not as something the member has, does or wears; an identity line that gives a
 * gender is a person's unless an item before its first ";" names an animal as what the member is
 * ("golden retriever", "sturdy pony build", "brown, hulking bear build"; not "bull neck" or "White,
 * bear build"), whatever animal words follow in its marks, and its age and gender make the person a
 * child, an elder, a woman or a man; a set without `interior` is one only when a room is named, not
 * an outdoor place that "inside", "flat", "bar", "cafe", "factory" or "museum" qualifies, and an
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

  // the identity line runs to its first real sentence end: a period after a title, inside a number
  // or after an abbreviation does not end it, so what follows is not read as rideo's summary; a gender
  // word in its first item is a person's whatever the age says, and a worded age is read as an age
  it.each([
    ['Dr. Okafor', 'Dr. Okafor: 52 female; doe eyes.', 'woman'],
    ['Mr. Lee', 'Mr. Lee: 70 male, stooped; bull neck. A retired boxer.', 'elder'],
    ['Tom', 'Tom: 45 male, 1.85 m tall; bull neck, broken nose.', 'man'],
    ['Ann', 'Ann: 30 female, approx. 160 cm; doe eyes.', 'woman'],
    ['Okafor', 'Okafor: 52 female; doe eyes.', 'woman'],
    ['Dr. Okafor', 'Dr. Okafor: 52 female, tall; owl eyes; wearing a white coat. A surgeon.', 'woman'],
    ['Mrs. Hay', 'Mrs. Hay: 40 female; e.g. a fox-red scarf, a crow tattoo. A vet.', 'woman'],
    ['Dee2', 'Dee2: early twenties female; doe eyes.', 'woman'],
    ['Ivy', 'Ivy: 30-ish female; cat-eye glasses.', 'woman'],
    ['Jo', 'Jo: tall, thin; crow’s feet.', 'adult'],
    ['Gwen', 'Gwen: 70 female. A crow-like old woman.', 'elder'],
  ])('%s (%s) is a person: its identity line ends where its sentence does', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, reason: 'a person', warnings: [] });
  });

  // worded ages by humanKindOf's thresholds (late sixties: 68, an elder)
  it.each([
    ['Gus', 'Gus: late sixties male; walrus moustache.', 'elder'],
    ['Ida', 'Ida: seventy-two female; bird-like hands.', 'elder'],
    ['Lea', 'Lea: thirty-something female; doe eyes.', 'woman'],
    ['Bo', 'Bo: six male, small; wearing shorts.', 'child'],
    ['Kit', 'Kit: eighteen months female; wearing a bonnet.', 'toddler'],
    ['Al', 'Al: late 60s male; bull neck.', 'elder'],
  ])('%s (%s) is staged by its worded age', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
  });

  it('still reads the animal its summary names after a period inside the identity line or the summary', () => {
    expect(kindOf('Bella', 'Bella: 4 female, 1.6 m; chestnut coat. Dr. Hay’s gentle mare.')).toMatchObject({
      kind: 'horse',
      warnings: [],
    });
    expect(kindOf('Quackers', 'Quackers: 2 female, approx. 30 cm; white feathers. A duck.').kind).toBe('cat');
  });

  // an animal the identity line names before its marks (as its age, ethnicity or build: rideo's pets
  // and mounts) is what the member is, whatever gender word follows the age
  it.each([
    ['Pip2', 'Pip2: puppy male, small; golden fur. Loves to chase balls.', 'small_dog'],
    ['Pip3', 'Pip3: puppy male, small; golden fur.', 'small_dog'],
    ['Rex', 'Rex: young male, golden retriever; floppy ears.', 'dog'],
    ['Kit2', 'Kit2: kitten female; white paws.', 'cat'],
    ['Pip', 'Pip: 3 male, golden retriever, small; golden fur; wearing a red collar.', 'dog'],
    ['Bella2', 'Bella2: adult female, chestnut mare; white blaze.', 'horse'],
    ['Clover', 'Clover: 7 female, Shetland pony, small; white mane.', 'pony'],
  ])('%s (%s) is the animal its identity line names', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
  });

  // ... but not one it names as a feature or a figure of speech, nor one among its marks
  it.each([
    ['Tom', 'Tom: 45 male, bull-necked; broken nose.', 'man'],
    ['Dee', 'Dee: 25 female, doe-eyed; freckles.', 'woman'],
    ['Bob', 'Bob: 60 male, owl-eyed, stocky; grey beard.', 'man'],
    ['Sam', 'Sam: 40 male, bear of a man; beard.', 'man'],
    ['Leo', 'Leo: 8 boy, slim; lion tattoo.', 'child'],
    ['Ned', 'A bull-necked farmer.', 'adult'],
  ])('%s (%s) is a person: its animal word is a feature', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, reason: 'a person', warnings: [] });
  });

  // an animal word in an item before the ";" is a feature of a person, whichever item it is in: before
  // a body part or a look ("bull neck", "pony tail"), as a build ("bear build", "gorilla build"), or
  // likened ("strong as an ox", "as strong as a big old bull", "built like a bear")
  it.each([
    ['Tom', 'Tom: 45 male, stocky, bull neck; broken nose.', 'man'],
    ['Dee', 'Dee: 25 female, Latina, petite, doe eyes. A shy librarian.', 'woman'],
    ['Ken', 'Ken: 40 male, Asian, horse face; scar.', 'man'],
    ['Rob', 'Rob: 35 male, White, bear build; beard.', 'man'],
    ['Tim', 'Tim: 30 male, slim, chicken legs; freckles.', 'man'],
    ['Ned', 'Ned: 50 male, bull-neck; scar.', 'man'],
    ['Al', 'Al: 40 male, strong as an ox; scar.', 'man'],
    ['Gus', 'Gus: 70 male, as strong as a young bull; scar.', 'elder'],
    ['Gil', 'Gil: 40 male, White, gorilla build; beard.', 'man'],
    ['Abe', 'Abe: 45 male, Black, ox build; shaved head.', 'man'],
    ['Kai', 'Kai: 35 male, Pacific Islander, as strong as a big old bull; tattoos.', 'man'],
    ['Bo', 'Bo: 40 male, White, built like a bear; beard.', 'man'],
    ['Mia', 'Mia: 7 female, slim, pony tail; freckles.', 'child'],
    // an ethnicity written for people, in any case (Kai and Lu are guards: written with a capital,
    // they were people before the list of ethnicities was closed too)
    ['Kai', 'Kai: 35 male, Pacific Islander, ox build; tattoos.', 'man'],
    ['Lu', 'Lu: 30 female, East Asian, bull build; short hair.', 'woman'],
    ['Lu2', 'Lu2: 30 female, east asian, bull build; short hair.', 'woman'],
    // a likeness of an animal word ending in -er or -or, whose article blankModifiers blanks
    ['X', 'X: 30 female, White, fierce as a tiger; freckles. A teacher.', 'woman'],
    ['Lea', 'Lea: 28 female, White, lithe as a panther; freckles.', 'woman'],
    ['Ben', 'Ben: 40 male, White, busy as a beaver; freckles.', 'man'],
    ['Ray', 'Ray: 50 male, White, proud as a rooster; moustache.', 'man'],
    ['Oda', 'Oda: 25 female, White, sleek as an otter; freckles.', 'woman'],
    ['Ted', 'Ted: 60 male, White, tenacious as a terrier; scar.', 'man'],
  ])('%s (%s) is a person: its animal word is a feature or a likeness', (name, description, kind) => {
    expect(animalOf(name, description)).toBeNull();
    expect(kindOf(name, description)).toMatchObject({ kind, reason: 'a person', warnings: [] });
  });

  // ... but an animal word before another word names what the member is: a species in the build item
  // ("sturdy pony build", "lean collie build", "heavy cow build") or before its type, its sex, its
  // age or a size ("golden retriever type", "tabby tom", "pony yearling", "mare sixteen hands")
  it.each([
    [
      'Clover',
      'Clover: 7 female, chestnut, sturdy pony build; white mane; wearing a red saddle. Loves apples.',
      'pony',
      'pony',
    ],
    ['Moss', 'Moss: 4 male, black and white, lean collie build; one blue eye.', 'dog', 'dog'],
    ['Bruiser', 'Bruiser: 4 male, brindle, muscular terrier build; scarred ear.', 'small dog', 'small_dog'],
    ['Pip', 'Pip: 3 male, golden, retriever build; floppy ears.', 'dog', 'dog'],
    ['Pip11', 'Pip11: 3 male, golden retriever type, medium; floppy ears.', 'dog', 'dog'],
    ['Tibbs', 'Tibbs: 5 male, ginger tabby tom, lean; torn ear.', 'cat', 'cat'],
    ['Hoot3', 'Hoot3: 4 female, barn owl species, small; white face.', 'owl', 'cat'],
    ['Star2', 'Star2: 1 female, pony yearling, leggy; white star.', 'pony', 'pony'],
    ['Jack', 'Jack: 5 male, donkey jack, grey; long ears.', 'donkey', 'donkey'],
    ['Bella4', 'Bella4: 10 female, chestnut mare sixteen hands; white blaze.', 'horse', 'horse'],
    [
      'Bella',
      'Bella: 8 female, chestnut, sleek horse build; white blaze; wearing a leather saddle.',
      'horse',
      'horse',
    ],
    ['Pip16', 'Pip16: 3 male, golden, medium-sized dog build; floppy ears.', 'dog', 'dog'],
    ['Tibbs2', 'Tibbs2: 5 male, ginger, lean cat build; torn ear.', 'cat', 'cat'],
    ['Billy', 'Billy: 3 male, white, scruffy goat build; horns.', 'goat', 'sheep'],
    ['Daisy', 'Daisy: 4 female, brown, heavy cow build; bell around her neck.', 'cow', 'cow'],
    ['Clover3', 'Clover3: 7 female, chestnut, sturdy pony body; white mane.', 'pony', 'pony'],
    ['Pepper', 'Pepper: 6 female, dapple grey, stocky pony shape; braided mane.', 'pony', 'pony'],
    ['Clover6', 'Clover6: 7 female, chestnut, small pony size; white mane.', 'pony', 'pony'],
    ['Moss3', 'Moss3: 4 male, black and white, lean sheepdog body; one blue eye.', 'dog', 'dog'],
  ])(
    '%s (%s) is an animal (%s): an animal word before another word names it',
    (name, description, word, kind) => {
      expect(animalOf(name, description)).toMatchObject({ word, kind });
      expect(kindOf(name, description).kind).toBe(kind);
    },
  );

  // ... and so does "bear", "bull", "ox" or "gorilla" before a build word after an animal's coat, breed
  // or region, or "N/A": it is a person's build only in the line of a people, its ethnicity one written
  // for people ("Rob: 35 male, White, bear build" above), whatever capital it has
  it.each([
    [
      'Bruno',
      'Bruno: 6 male, brown, hulking bear build; scar over one eye. Raids the campsite every night.',
      'bear',
      'bear',
    ],
    [
      'Ferdinand',
      'Ferdinand: 5 male, black, massive bull build; ring through his nose. Would rather smell the flowers than fight.',
      'cow',
      'cow',
    ],
    [
      'Babe',
      'Babe: 4 male, blue, giant ox frame; long curved horns. Pulls the logging sledge.',
      'cow',
      'cow',
    ],
    ['Koko', 'Koko: 12 female, black, gorilla build; grey hair on her back.', 'gorilla', 'bear'],
    [
      'Bruno7',
      'Bruno7: 6 male, N/A, hulking bear build; scar over one eye. Steals honey from the campsite.',
      'bear',
      'bear',
    ],
    [
      'Kodiak2',
      'Kodiak2: 8 male, Brown, massive bear build; torn left ear. Fishes for salmon in the river.',
      'bear',
      'bear',
    ],
    [
      'Ferdinand4',
      'Ferdinand4: 5 male, Black Angus, massive bull build; ring through his nose.',
      'cow',
      'cow',
    ],
    ['Kong3', 'Kong3: 20 male, Silverback, massive gorilla build; scarred chest.', 'gorilla', 'bear'],
    ['Oxford', 'Oxford: 10 male, Bovine, giant ox frame; long horns.', 'cow', 'cow'],
    ['Duke', 'Duke: 6 male, Hereford, massive bull build; ring through his nose.', 'cow', 'cow'],
    ['Babe', 'Babe: 4 male, Blue, giant ox frame; long curved horns.', 'cow', 'cow'],
    ['Bubba2', 'Bubba2: 4 male, Angus, stocky bull frame; short horns.', 'cow', 'cow'],
    ['Hercules2', 'Hercules2: 6 male, Highland, powerful ox build; shaggy coat.', 'cow', 'cow'],
    ['Kodiak2b', 'Kodiak2b: 15 male, Alaskan, enormous bear frame; grey muzzle.', 'bear', 'bear'],
    ['Ursa', 'Ursa: 9 female, Ursine, hulking bear build; grey muzzle.', 'bear', 'bear'],
    ['Ebon', 'Ebon: 9 male, American Black, hulking bear build; torn ear.', 'bear', 'bear'],
    ['Bram', 'Bram: 9 male, Dark brown, hulking bear build; torn ear.', 'bear', 'bear'],
    ['Jet', 'Jet: 9 male, Jet black, massive bull build; ring through his nose.', 'cow', 'cow'],
    ['Cinna', 'Cinna: 9 female, Cinnamon, hulking bear build; torn ear.', 'bear', 'bear'],
    ['Charlie', 'Charlie: 9 male, Charolais, massive bull build; ring through his nose.', 'cow', 'cow'],
  ])(
    '%s (%s) is an animal (%s): its build word after a coat, a breed or a region names it',
    (name, description, word, kind) => {
      expect(animalOf(name, description)).toMatchObject({ word, kind });
      expect(kindOf(name, description).kind).toBe(kind);
    },
  );

  it.each([
    'Tornado: 7 male, black, massive bull build; ring through his nose. Has never been ridden for eight seconds.',
    'Tornado: 7 male, Brahman, massive bull build; ring through his nose.',
  ])('keeps a bull whose build names it the mount the shot says it is: %s', (tornado) => {
    const brief = {
      id: 'scene',
      name: 'Scene',
      fps: 24,
      width: 640,
      height: 360,
      set: { description: 'A dusty rodeo arena.', interior: false, timeOfDay: null },
      cast: [
        {
          id: 'colt',
          name: 'Colt',
          description: 'Colt: 25 male, White, lanky; stubble; wearing a denim jacket. A young rodeo rider.',
          kind: null,
          heightM: null,
        },
        { id: 'tornado', name: 'Tornado', description: tornado, kind: null, heightM: null },
      ],
      elements: [],
      shots: [
        {
          id: 's1',
          index: 0,
          durationSec: 3,
          description: 'Wide: the arena.',
          action: 'Colt rides Tornado out of the chute.',
          castIds: ['colt', 'tornado'],
          elementIds: [],
          framing: 'wide',
          movement: 'static',
          move: null,
          lensMm: null,
          continuity: 'cut',
          layout: [],
        },
      ],
    } as SceneBrief;
    const { kinds } = castKinds(brief);
    expect(kinds.get('tornado')).toEqual({ kind: 'cow', reason: 'a cow another character rides' });
    expect(kinds.get('colt')).toEqual({ kind: 'man', reason: 'a person' });
  });

  // ... and one before another animal word is that one's: the later is the animal ("a cattle dog" is a
  // dog, not a cow), unless it is the young, the sex or a breed word ("Shetland pony mare", "bear
  // cub"); "and", "or" and the words that say what it has or is with do not change it
  it.each([
    ['Blue', 'Blue: 3 male, Australian cattle dog; merle coat.', 'dog'],
    ['Scout', 'Scout: 2 female, bird dog, lean; liver spots.', 'dog'],
    ['Spike', 'Spike: 4 male, bull terrier, stocky; scarred ear.', 'small_dog'],
    ['Cub', 'Cub: 2 male, bear cub, small; brown fur.', 'bear'],
    ['Mutt', 'Mutt: 4 male, terrier mix, scruffy; one ear up.', 'small_dog'],
    ['Lab', 'Lab: 6 female, Labrador cross; grey muzzle.', 'dog'],
    ['Mix', 'Mix: 6 female, Labrador and poodle mix; curly coat.', 'dog'],
    ['Clover2', 'Clover2: 9 female, Shetland pony mare; white mane.', 'pony'],
    ['Pip4', 'Pip4: 3 male, golden retriever with a white chest; floppy ears.', 'dog'],
    ['Bella3', 'Bella3: adult female, chestnut mare (Arabian); white blaze.', 'horse'],
  ])('%s (%s) is the animal its identity line names', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
  });

  // ... but a breed of dog before it names the dog, as in a sentence: a cross of a retriever, a husky
  // or a Labrador with a poodle is no small dog ("puppy" before "dog" is still its young, a feature
  // in "puppy-dog eyes")
  it('reads a cross of two breeds of dog as its first breed', () => {
    for (const [name, description] of [
      ['Barney', 'Barney: 4 male, golden retriever-poodle mix, fluffy; apricot coat.'],
      ['Juno', 'Juno: 3 female, husky-poodle mix, fluffy; one blue eye.'],
      ['Biscuit3', 'Biscuit3: 2 male, Labrador poodle mix, curly; cream coat.'],
      ['Rover', 'Rover: 5 male, Labrador-poodle cross, curly; cream coat.'],
    ])
      expect(kindOf(name, description), name).toMatchObject({ kind: 'dog', warnings: [] });
    expect(animalOf('Joel', 'Joel: 27 male, White, lanky, puppy-dog eyes; mop of curls.')).toBeNull();
  });

  // a summary that names a person does not undo it: dogs are "good boys", and a companion who follows
  // the boy is not the boy
  it.each([
    ['Max', 'Max: 5 male, Labrador. A good boy.', 'dog'],
    [
      'Pip5',
      'Pip5: 3 male, golden retriever, small. A loyal companion who follows the boy everywhere.',
      'dog',
    ],
  ])('%s (%s) stays the animal its identity line names', (name, description, kind) => {
    expect(kindOf(name, description)).toMatchObject({ kind, warnings: [] });
  });
});

describe("a shot's sentences", () => {
  // Mira and Pip (rideo sends no kind hints) and a kite: who holds it is read sentence by sentence
  function kiteShot(description: string, action: string) {
    const brief = {
      id: 'scene',
      name: 'Scene',
      fps: 24,
      width: 640,
      height: 360,
      set: { description: 'A meadow.', interior: false, timeOfDay: null },
      cast: [
        {
          id: 'mira',
          name: 'Mira',
          description: 'A girl of 8 in a yellow raincoat.',
          kind: null,
          heightM: null,
        },
        { id: 'pip', name: 'Pip', description: 'A golden retriever puppy.', kind: null, heightM: null },
      ],
      elements: [{ id: 'kite', name: 'Red kite', description: 'A red diamond kite.', kind: 'prop' }],
      shots: [
        {
          id: 's1',
          index: 0,
          durationSec: 2,
          description,
          action,
          castIds: ['mira', 'pip'],
          elementIds: ['kite'],
          framing: 'wide',
          movement: 'static',
          move: null,
          lensMm: null,
          continuity: 'cut',
          layout: [],
        },
      ],
    } as SceneBrief;
    const plan = planBrief(brief);
    return { holder: plan.holders.get('kite') ?? null, pip: plan.cast.get('pip')!.kind };
  }

  it('give a prop to the subject of the sentence that says so, not to one named in the sentence before', () => {
    // "in." ends the description: "She" names nobody, so nobody holds the kite and Pip stays a dog
    expect(kiteShot('Wide: Pip bounds in.', 'She grabs the kite and runs.')).toEqual({
      holder: null,
      pip: 'dog',
    });
    expect(kiteShot('Wide: Pip bounds in', 'Mira grabs the kite and runs.')).toEqual({
      holder: 'mira',
      pip: 'dog',
    });
    // a dog that holds a prop in its own sentence is a person
    expect(kiteShot('Wide: Pip bounds in and grabs the kite.', '')).toEqual({ holder: 'pip', pip: 'adult' });
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

  // boats, ships, sheds, tents, caravans and other shelters are buildings: "inside the river boat" is
  // inside the boat, not deep inside the river
  it.each([
    'Inside the river boat.',
    'Inside the garden shed.',
    'Inside the mountain tent.',
    'Inside the beach caravan.',
    'Inside the harbour ship, below deck.',
    'Inside the lake yacht.',
    'Inside the sea ferry.',
  ])('%s is an interior', (words) => {
    expect(interiorFromWords(words)).toBe(true);
  });

  it.each(['On the deck of the river boat.', 'The river by the boat shed.', 'A tent pitched in the meadow.'])(
    '%s is outdoors',
    (words) => {
      expect(interiorFromWords(words)).toBe(false);
    },
  );

  // a deck is a boat's or a house's (outdoors), not a deck of (old playing, his) cards, a tape, DJ
  // or skateboard deck or a deck chair; the deck of a ship where cards are dealt is still the ship's,
  // and so is the deck of a ship, a riverboat, a yacht or a river boat before "cards"
  it.each([
    ['A deck of cards lies on the kitchen table.', true],
    ['A deck of old playing cards lies on the kitchen table.', true],
    ['A deck of worn old playing cards in the bedroom.', true],
    ['The deck of his cards lies on the kitchen table.', true],
    ['Grandpa shuffles the deck of his cards in the kitchen.', true],
    ['She deals from a deck of the cards in the living room.', true],
    ['On the deck of the ship as cards are dealt.', false],
    ['On the deck of the ship his cards lie scattered.', false],
    ['A tape deck plays in the bedroom.', true],
    ['A cassette deck hums in the living room.', true],
    ['DJ decks spin in the bedroom.', true],
    ["The DJ's decks glow in the living room.", true],
    ['A skateboard deck leans on the bedroom wall.', true],
    ['A skate deck leans on the bedroom wall.', true],
    ['A deck chair in the living room.', true],
    ["The ship's deck at dawn, a cabin below.", false],
    ['On deck, the crew hauls the sail.', false],
    ['The deck of the ferry, a deck of cards on the bench.', false],
    ['On the deck of the ship where cards are dealt.', false],
    ['Sailors on the deck of the ship play cards while the cook works in the kitchen below.', false],
    ['On the deck of the riverboat gamblers play cards beside the dining room door.', false],
    ['On the deck of the ship men play cards near the dining room.', false],
    ['A poker game on the deck of the yacht cards dealt beside the galley kitchen.', false],
    ['On the deck of the ship cards are dealt to the sailors.', false],
    ['The deck of the river boat cards scattered everywhere.', false],
  ])('%s', (words, interior) => {
    expect(interiorFromWords(words)).toBe(interior);
  });

  // "inside" or "indoors" opening a clause says where the scene is, of itself or of a room or a
  // building, whatever outdoor words came before
  it.each([
    ['A cabin in the woods, inside by the fire.', true],
    ['The farmyard, inside the barn.', true],
    ['The campsite; indoors, a storm rages.', true],
    ['The garden, inside the gate.', false],
    ['Deep inside the forest, a mossy clearing.', false],
  ])('%s', (words, interior) => {
    expect(interiorFromWords(words)).toBe(interior);
  });
});
