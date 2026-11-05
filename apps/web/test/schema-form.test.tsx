import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { z } from 'zod';
import {
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  safeJsonSchema,
  type OperatorContext,
} from '@3d-editor/core';
import { SchemaForm } from '../src/ui/SchemaForm';
import { ToggleGroup } from '../src/ui/fields/fields';
import { session as sessionSignal } from '../src/app/store';
import { EditorStateSignals } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';

afterEach(() => {
  cleanup();
  sessionSignal.value = null;
});

const q = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Types into a Blender-style number field (click, type, Enter). */
function typeNumber(el: HTMLElement, value: string): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** A document with a mesh, a camera and a curve (created through the core operators). */
function sceneWithObjects(): { doc: SceneDoc; id: (name: string) => string } {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  for (const [op, name] of [
    ['mesh.primitive_cube_add', 'Cube'],
    ['object.camera_add', 'Cam'],
    ['curve.primitive_bezier_curve_add', 'Wire'],
  ])
    expect(reg.run(ctx, op, { name }).ok).toBe(true);
  return { doc, id: (name) => doc.findObjectByName(name)!.id };
}

describe('SchemaForm extensions', () => {
  it('renders fixed choices, mapping the empty choice to null for nullable parameters', () => {
    const schema = safeJsonSchema(
      z.object({
        instance_collection: z.string().nullable().default(null),
        vertex_group: z.string().default(''),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm
        schema={schema}
        values={{ instance_collection: 'c1', vertex_group: 'Gone' }}
        testIdPrefix="f"
        choices={{
          instance_collection: [
            { value: '', label: '— none —' },
            { value: 'c1', label: 'Trees' },
          ],
          vertex_group: [{ value: '', label: '— none —' }],
        }}
        onChange={onChange}
      />,
    );
    const coll = q(container, 'f-instance_collection') as HTMLSelectElement;
    expect(coll.value).toBe('c1');
    fireEvent.change(coll, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('instance_collection', null, true);
    // a stored value that is no longer offered stays visible as missing
    const vg = q(container, 'f-vertex_group') as HTMLSelectElement;
    expect([...vg.options].map((o) => o.textContent)).toEqual(['— none —', 'Gone (missing)']);
    fireEvent.change(vg, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('vertex_group', '', true);
  });

  it('orders and labels a subset, adds units and detects angles from descriptions', () => {
    const schema = safeJsonSchema(
      z.object({
        strength: z
          .number()
          .default(1)
          .describe('Amplitude in the units of the property (metres, radians, …)'),
        max_z: z
          .number()
          .default(Math.PI / 2)
          .describe('Highest Z angle (radians)'),
        rotation_factor_random: z.number().min(0).max(1).default(0.5),
        mass: z.number().default(2),
        hidden: z.number().default(0),
      }),
    );
    const { container } = render(
      <SchemaForm
        schema={schema}
        values={{}}
        only={['mass', 'max_z', 'strength', 'rotation_factor_random']}
        labels={{ mass: 'Mass' }}
        units={{ mass: ' kg' }}
        testIdPrefix="f"
        onChange={() => undefined}
      />,
    );
    const labels = [...container.querySelectorAll('.prop-row > label')].map((l) => l.textContent);
    expect(labels).toEqual(['Mass', 'Max z', 'Strength', 'Rotation factor random']);
    expect(q(container, 'f-mass')?.textContent).toBe('2 kg');
    expect(q(container, 'f-max_z')?.textContent).toBe('90°');
    expect(q(container, 'f-strength')?.textContent).toBe('1');
    expect(q(container, 'f-rotation_factor_random')?.textContent).toBe('0.5');
    expect(q(container, 'f-hidden')).toBeNull();
    // descriptions become tooltips
    expect(container.querySelector('.prop-row > label[title="Highest Z angle (radians)"]')).not.toBeNull();
  });

  it('renders enum sets as toggles, expanded enums as buttons and fixed-length number arrays as vectors', () => {
    const schema = safeJsonSchema(
      z.object({
        axis: z.array(z.enum(['X', 'Y', 'Z'])).default(['X']),
        track_axis: z.enum(['TRACK_X', 'TRACK_NEGATIVE_Z']).default('TRACK_X'),
        offset: z.array(z.number()).length(3).default([1, 2, 3]),
        surface: z.array(z.string()).optional(),
      }),
    );
    const onChange = vi.fn();
    const doc = SceneDoc.create({ empty: true });
    const { container } = render(
      <SchemaForm
        schema={schema}
        values={{}}
        doc={doc}
        testIdPrefix="f"
        expandEnums={['track_axis']}
        enumLabel={(_k, v) => (v === 'TRACK_NEGATIVE_Z' ? '-Z' : undefined)}
        onChange={onChange}
      />,
    );
    fireEvent.click(q(container, 'f-axis-2')!);
    expect(onChange).toHaveBeenLastCalledWith('axis', ['X', 'Z'], true);
    // the set has no minimum here, so its last value can be switched off
    fireEvent.click(q(container, 'f-axis-0')!);
    expect(onChange).toHaveBeenLastCalledWith('axis', [], true);
    expect(q(container, 'f-track_axis-TRACK_NEGATIVE_Z')?.textContent).toBe('-Z');
    fireEvent.click(q(container, 'f-track_axis-TRACK_NEGATIVE_Z')!);
    expect(onChange).toHaveBeenLastCalledWith('track_axis', 'TRACK_NEGATIVE_Z', true);
    expect(container.querySelectorAll('[data-testid^="f-offset-"]').length).toBe(3);
    // an array of object references is not mistaken for a single object picker
    expect(q(container, 'f-surface')).toBeNull();
  });

  it('shows unset optional numbers as Auto and accepts a typed value', () => {
    const schema = safeJsonSchema(
      z.object({
        radius: z.number().positive().optional().describe('Orbit radius (default: fit the scene)'),
        frame_start: z.number().int().optional(),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm schema={schema} values={{ frame_start: 12 }} testIdPrefix="f" onChange={onChange} />,
    );
    const radius = q(container, 'f-radius')!;
    expect(radius.textContent).toBe('Auto');
    expect(q(container, 'f-frame_start')?.textContent).toBe('12');
    fireEvent.pointerDown(radius, { button: 0, clientX: 5, pointerId: 1 });
    fireEvent.pointerUp(radius, { button: 0, clientX: 5, pointerId: 1 });
    const input = radius.querySelector('input')!;
    expect(input.value).toBe('');
    fireEvent.input(input, { target: { value: '7.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('radius', 7.5, true);
  });

  it('toggle group reports the toggled index and its new state', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ToggleGroup
        testId="t"
        options={[
          { label: 'X', value: true },
          { label: 'Y', value: false },
        ]}
        onChange={onChange}
      />,
    );
    expect(q(container, 't-0')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(q(container, 't-1')!);
    expect(onChange).toHaveBeenCalledWith(1, true);
  });
});

describe('SchemaForm only produces values the operator accepts (Adjust Last Operation)', () => {
  it('keeps enums as dropdowns even when the parameter is named like an object reference', () => {
    // object.convert `target` is an enum: it must not become an object picker
    const { doc } = sceneWithObjects();
    const schema = safeJsonSchema(z.object({ target: z.enum(['MESH', 'CURVE']).default('MESH') }));
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm schema={schema} values={{}} doc={doc} testIdPrefix="f" onChange={onChange} />,
    );
    const select = q(container, 'f-target') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['MESH', 'CURVE']);
    expect(select.value).toBe('MESH');
    fireEvent.change(select, { target: { value: 'CURVE' } });
    expect(onChange).toHaveBeenLastCalledWith('target', 'CURVE', true);
  });

  it('object pickers clear to undefined or null as the schema allows and only list fitting types', () => {
    const { doc, id } = sceneWithObjects();
    const schema = safeJsonSchema(
      z.object({
        camera: z.string().optional().describe('Existing camera object (default: create a new camera)'),
        mirror_object: z.string().nullable().default(null),
        surface: z.string().optional(),
        target: z.string().describe('Object to follow'),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm
        schema={schema}
        values={{ camera: id('Cam'), mirror_object: id('Cube'), target: 'Wire' }}
        doc={doc}
        testIdPrefix="f"
        onChange={onChange}
      />,
    );
    const options = (key: string) =>
      [...(q(container, `f-${key}`) as HTMLSelectElement).options].map((o) => o.textContent);
    // a camera parameter only offers cameras; surfaces only geometry objects
    expect(options('camera')).toEqual(['— none —', 'Cam']);
    expect(options('surface')).toEqual(['— none —', 'Cube', 'Wire']);
    expect(options('mirror_object')).toEqual(['— none —', 'Cam', 'Cube', 'Wire']);
    // a required reference has no "none" entry; a value given by name is shown as that object
    expect(options('target')).toEqual(['Cam', 'Cube', 'Wire']);
    expect((q(container, 'f-target') as HTMLSelectElement).value).toBe(id('Wire'));
    // optional non-nullable: none leaves the parameter out (its default); nullable: null
    fireEvent.change(q(container, 'f-camera')!, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('camera', undefined, true);
    fireEvent.change(q(container, 'f-mirror_object')!, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('mirror_object', null, true);
  });

  it('enum sets keep their minimum number of values', () => {
    const schema = safeJsonSchema(
      z.object({
        axis: z
          .array(z.enum(['X', 'Y', 'Z']))
          .min(1)
          .default(['X']),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm schema={schema} values={{}} testIdPrefix="f" onChange={onChange} />,
    );
    // X is the only value: switching it off would make the operator fail
    fireEvent.click(q(container, 'f-axis-0')!);
    expect(onChange).not.toHaveBeenCalled();
    expect(q(container, 'f-axis-0')?.getAttribute('title')).toMatch(/at least/i);
    fireEvent.click(q(container, 'f-axis-1')!);
    expect(onChange).toHaveBeenLastCalledWith('axis', ['X', 'Y'], true);
  });

  it('shows the effective values of unset optional vectors and keeps them when one component is edited', () => {
    const state = new EditorStateSignals();
    state.cursorLocation = [1, 2, 3];
    sessionSignal.value = { state } as unknown as ProjectSession;
    const vec3 = z.tuple([z.number(), z.number(), z.number()]);
    const schema = safeJsonSchema(
      z.object({
        location: vec3.optional().describe('World location of the new object (default: the 3D cursor)'),
        rotation: vec3.optional().describe('Euler XYZ rotation in radians'),
        scale: vec3.optional(),
        size: vec3.optional().describe('Box size (default [2, 2, 2])'),
        center: vec3.optional().describe('Orbit centre (overrides the centre of `target`)'),
        rotation_euler: vec3.optional().describe('Euler XYZ rotation in radians about the bone axes'),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm schema={schema} values={{}} testIdPrefix="f" onChange={onChange} />,
    );
    const shown = (key: string) =>
      [0, 1, 2].map((i) => q(container, `f-${key}-${i}`)?.querySelector('.nf-value')?.textContent);
    expect(shown('location')).toEqual(['1', '2', '3']);
    expect(shown('rotation')).toEqual(['0°', '0°', '0°']);
    expect(shown('scale')).toEqual(['1', '1', '1']);
    expect(shown('size')).toEqual(['2', '2', '2']);
    // no documented default: the operator computes it (or keeps the current value)
    expect(shown('center')).toEqual(['Auto', 'Auto', 'Auto']);
    expect(shown('rotation_euler')).toEqual(['Auto', 'Auto', 'Auto']);

    typeNumber(q(container, 'f-scale-0')!, '2');
    expect(onChange).toHaveBeenLastCalledWith('scale', [2, 1, 1], true);
    typeNumber(q(container, 'f-location-0')!, '5');
    expect(onChange).toHaveBeenLastCalledWith('location', [5, 2, 3], true);
    typeNumber(q(container, 'f-center-2')!, '4');
    expect(onChange).toHaveBeenLastCalledWith('center', [0, 0, 4], true);
  });
});
