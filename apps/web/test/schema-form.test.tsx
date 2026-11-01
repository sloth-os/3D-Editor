import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { z } from 'zod';
import { SceneDoc, safeJsonSchema } from '@3d-editor/core';
import { SchemaForm } from '../src/ui/SchemaForm';
import { ToggleGroup } from '../src/ui/fields/fields';

afterEach(cleanup);

const q = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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
