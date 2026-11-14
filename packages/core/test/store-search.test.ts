import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import {
  BUILTIN_CATALOG,
  builtinResult,
  rankCatalog,
  searchCatalog,
  searchCatalogPage,
  searchWords,
  wordForms,
} from '../src/store';

/*
 * Keyword search of the built-in catalog: synonyms, plurals, phrases, the head noun, categories,
 * paging, ties, and the read-only store.search operator.
 */

const top = (query: string, n = 1) =>
  rankCatalog(query)
    .slice(0, n)
    .map((r) => r.entry.id);
const byName = (ids: { name: string; id: string }[]) =>
  [...ids].sort((a, b) =>
    a.name.toLowerCase() !== b.name.toLowerCase()
      ? a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : 1,
  );

describe('searchWords / wordForms', () => {
  it('splits text into lower-case words with accents folded', () => {
    expect(searchWords('Café-Table, 2 seats!')).toEqual(['cafe', 'table', '2', 'seats']);
    expect(searchWords('  ')).toEqual([]);
  });

  it('keeps the letters and digits of every script', () => {
    expect(searchWords('椅子, Stuhl! собака 🚗 ???')).toEqual(['椅子', 'stuhl', 'собака']);
    expect(searchWords('Žluťoučký kůň')).toEqual(['zlutoucky', 'kun']);
    expect(searchWords('🚗 ??? —')).toEqual([]);
  });

  it('gives the singular candidates of plural words', () => {
    expect(wordForms('chairs')).toContain('chair');
    expect(wordForms('boxes')).toContain('box');
    expect(wordForms('berries')).toContain('berry');
    expect(wordForms('shelves')).toContain('shelf');
    expect(wordForms('knives')).toContain('knife');
    expect(wordForms("dog's")).toContain('dog');
    // 'glass' is no plural; short words have no other forms
    expect(wordForms('glass')).toEqual(['glass']);
    expect(wordForms('bus')).toEqual(['bus']);
  });

  it('knows the irregular plurals', () => {
    expect(wordForms('men')).toContain('man');
    expect(wordForms('women')).toContain('woman');
    expect(wordForms('children')).toContain('child');
    expect(wordForms('people')).toContain('person');
    expect(wordForms('feet')).toContain('foot');
    expect(wordForms('mice')).toContain('mouse');
    expect(wordForms('geese')).toContain('goose');
  });
});

describe('rankCatalog', () => {
  it('finds models by their synonyms', () => {
    expect(top('couch')).toEqual(['sofa']);
    expect(top('telly')).toEqual(['tv']);
    expect(top('refrigerator')).toEqual(['fridge']);
    expect(top('carpet')).toEqual(['rug']);
    expect(top('rucksack')).toEqual(['backpack']);
    expect(top('bin')).toEqual(['trash_can']);
    expect(top('kid')).toEqual(['child']);
  });

  it('puts the model whose name or id is the query first', () => {
    expect(top('sofa')).toEqual(['sofa']);
    expect(top('table')).toEqual(['table']);
    expect(top('chair')).toEqual(['chair']);
    expect(top('bed')).toEqual(['bed']);
    expect(top('umbrella')).toEqual(['umbrella']);
    expect(top('coffee table')).toEqual(['coffee_table']);
    expect(top('Coffee-Table')).toEqual(['coffee_table']);
    expect(top('the coffee table')).toEqual(['coffee_table']);
    expect(top('wine glass')).toEqual(['wine_glass']);
    expect(top('watermelon')).toEqual(['watermelon']);
  });

  it('matches plurals and accents', () => {
    expect(top('chairs')).toEqual(['chair']);
    expect(top('bookshelves')).toEqual(['bookshelf']);
    expect(top('boxes')).toEqual(['cardboard_box']);
    expect(top('apples')).toEqual(['apple']);
    expect(top('wine glasses')).toEqual(['wine_glass']);
    expect(top('café table')).toEqual(['round_table']);
  });

  it('weighs the last word (the noun) above the words describing it', () => {
    expect(top('red couch')).toEqual(['sofa']);
    // the plain wooden chair is the kitchen chair (its synonym), the upholstered one the dining chair
    expect(top('kitchen chair')).toEqual(['chair']);
    expect(top('beach umbrella')).toEqual(['beach_umbrella']);
    expect(top('table lamp')).toEqual(['table_lamp']);
    expect(top('lamp table')[0]).not.toBe('floor_lamp');
  });

  it('ranks models matching every word above those matching some, ties by name', () => {
    const r = rankCatalog('picnic blanket');
    expect(r[0].entry.id).toBe('picnic_blanket');
    expect(r.findIndex((x) => x.entry.id === 'folded_blanket')).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    // the floor and table lamps both have 'lamp' as name word and synonym: by name
    const lamps = rankCatalog('lamp').filter((x) => x.score === rankCatalog('lamp')[0].score);
    expect(lamps.map((x) => x.entry.id)).toEqual(['floor_lamp', 'table_lamp']);
  });

  it('matches the start of a word of three letters or more', () => {
    const ids = rankCatalog('umbrel').map((r) => r.entry.id);
    expect(ids).toContain('umbrella');
    expect(ids).toContain('closed_umbrella');
    expect(rankCatalog('umbrel')[0].score).toBeLessThan(rankCatalog('umbrella')[0].score);
    expect(rankCatalog('zq')).toEqual([]);
  });

  it('finds nothing for unknown words', () => {
    expect(rankCatalog('xyzzy plugh')).toEqual([]);
    expect(searchCatalog('xyzzy')).toEqual([]);
  });

  it('keeps to the category asked for', () => {
    const r = rankCatalog('table', { category: 'food' });
    expect(r.every((x) => x.entry.category === 'food')).toBe(true);
    const furniture = rankCatalog('chair', { category: 'furniture' });
    expect(furniture[0].entry.id).toBe('chair');
    expect(furniture.every((x) => x.entry.category === 'furniture')).toBe(true);
    expect(rankCatalog('chair', { category: 'animals' })).toEqual([]);
  });

  it('weighs a word of a synonym or tag of several words as little as a description word', () => {
    // 'people carrier' (the van) and 'light truck' (the pickup) do not make them people or lights
    expect(top('people', 2)).toEqual(['person', 'elderly_person']);
    const light = rankCatalog('light').map((r) => r.entry.id);
    expect(light[0]).toBe('floor_lamp');
    expect(light.indexOf('pickup_truck')).toBeGreaterThan(light.indexOf('streetlight'));
    // the whole phrase weighs what the synonym does
    expect(top('people carrier')).toEqual(['van']);
    expect(top('light truck')).toEqual(['pickup_truck']);
    const truck = rankCatalog('light truck')[0].score;
    expect(truck).toBeGreaterThan(rankCatalog('truck').find((r) => r.entry.id === 'pickup_truck')!.score);
  });

  it('finds people by irregular plurals', () => {
    expect(top('men')).toEqual(['man']);
    expect(top('women')).toEqual(['woman']);
    expect(top('children')).toEqual(['child']);
  });

  it('puts the usual model of a generic noun first among equals', () => {
    expect(top('car')).toEqual(['sedan']);
    expect(top('cars')).toEqual(['sedan']);
    expect(top('ball')).toEqual(['soccer_ball']);
    expect(top('blanket')).toEqual(['picnic_blanket']);
    expect(top('settee')).toEqual(['sofa']);
    expect(top('hut')).toEqual(['beach_hut']);
    expect(top('steps')).toEqual(['stairs']);
    expect(top('canoe')).toEqual(['rowboat']);
    expect(top('kayak')).toEqual(['rowboat']);
    expect(top('puppy')).toEqual(['dog']);
  });

  it('finds nothing for a query without a word to search', () => {
    for (const q of ['椅子', 'собака', '🚗', '???', 'the', 'the a of']) {
      expect(rankCatalog(q), q).toEqual([]);
      expect(searchCatalogPage(q).total, q).toBe(0);
    }
  });

  it('lists every model by name for an empty query', () => {
    const all = rankCatalog('');
    expect(all.map((r) => r.entry.id)).toEqual(byName(BUILTIN_CATALOG).map((e) => e.id));
    expect(all.every((r) => r.score === 0)).toBe(true);
    expect(rankCatalog('   ').map((r) => r.entry.id)).toEqual(all.map((r) => r.entry.id));
    const food = rankCatalog('', { category: 'food' }).map((r) => r.entry.id);
    expect(food).toEqual(byName(BUILTIN_CATALOG.filter((e) => e.category === 'food')).map((e) => e.id));
    expect(food).toContain('watermelon_slice');
  });
});

describe('searchCatalog / searchCatalogPage', () => {
  it('returns store results of the built-in provider', () => {
    const [sofa] = searchCatalog('couch', { limit: 1 });
    expect(sofa).toEqual(builtinResult(BUILTIN_CATALOG.find((e) => e.id === 'sofa')!));
    expect(sofa).toMatchObject({
      id: 'builtin:sofa',
      provider: 'builtin',
      name: 'Sofa',
      category: 'furniture',
      thumbnail_url: null,
      license: { spdx: 'CC0-1.0', attribution: '3D Editor built-in' },
      author: '3D Editor built-in',
      formats: ['builtin'],
      downloadable: true,
    });
  });

  it('pages through the results and counts them all', () => {
    const all = searchCatalogPage('', { limit: 1000 });
    expect(all.total).toBe(BUILTIN_CATALOG.length);
    expect(all.results).toHaveLength(BUILTIN_CATALOG.length);
    const first = searchCatalogPage('', { limit: 10 });
    const second = searchCatalogPage('', { limit: 10, offset: 10 });
    expect(first.total).toBe(all.total);
    expect([...first.results, ...second.results].map((r) => r.id)).toEqual(
      all.results.slice(0, 20).map((r) => r.id),
    );
    expect(searchCatalog('')).toHaveLength(Math.min(20, BUILTIN_CATALOG.length));
    expect(searchCatalogPage('', { limit: 0 })).toMatchObject({ results: [], total: all.total });
    expect(searchCatalogPage('', { limit: 5, offset: -3 }).results).toEqual(first.results.slice(0, 5));
    expect(searchCatalogPage('', { offset: 1e6 }).results).toEqual([]);
  });
});

describe('store.search', () => {
  function setup() {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    const run = (p: unknown) => reg.run(ctx, 'store.search', p) as RunResult<any> & { result: any };
    return { doc, reg, run };
  }

  it('describes each model with its description, synonyms and parameters', () => {
    const t = setup();
    const r = t.run({ query: 'couch', limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ total: 2, offset: 0, limit: 2 });
    const [sofa, loveseat] = r.result.results;
    expect(sofa).toMatchObject({ id: 'builtin:sofa', rig: null, description: expect.stringMatching(/sofa/) });
    expect(sofa.synonyms).toContain('couch');
    expect(sofa.params.seats).toMatchObject({ type: 'integer', minimum: 1, maximum: 5, default: 3 });
    expect(loveseat.id).toBe('builtin:loveseat');
    // a model without parameters has none listed
    expect(t.run({ query: 'rug' }).result.results[0]).not.toHaveProperty('params');
  });

  it('names the actor kind of people and animals', () => {
    const t = setup();
    const r = t.run({ query: 'horse', category: 'animals' }).result;
    expect(r.results[0]).toMatchObject({ id: 'builtin:horse', rig: 'actor', actor_kind: 'horse' });
    expect(r.results.every((x: { category: string }) => x.category === 'animals')).toBe(true);
  });

  it('lists every model by name without a query and pages', () => {
    const t = setup();
    const r = t.run({}).result;
    expect(r.total).toBe(BUILTIN_CATALOG.length);
    expect(r.results).toHaveLength(20);
    const next = t.run({ offset: 20, limit: 5 }).result;
    expect(next.results.map((x: { id: string }) => x.id)).toEqual(
      searchCatalog('', { offset: 20, limit: 5 }).map((x) => x.id),
    );
  });

  it('changes nothing and is no undo step', () => {
    const t = setup();
    const before = t.doc.listObjects().length;
    t.run({ query: 'sofa' });
    expect(t.doc.listObjects()).toHaveLength(before);
    expect(t.reg.get('store.search')!.undo).toBe(false);
  });

  it('refuses parameters out of range', () => {
    const t = setup();
    expect(t.run({ limit: 0 })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(t.run({ category: 'spaceships' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(t.run({ query: 'x'.repeat(201) })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });
});
