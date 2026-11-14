import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { z } from 'zod';
import { createOperatorRegistry, safeJsonSchema } from '@3d-editor/core';
import { SchemaForm } from '../src/ui/SchemaForm';

/*
 * Optional enum parameters without a default (Adjust Last Operation of Add Shot: framing, angle,
 * height, move) are the operator's to leave out: when they were not given the dropdown says so
 * ('— not set —') instead of showing the first value as if it had been chosen, and choosing that
 * entry leaves the parameter out again. A nullable one also offers null ('— none —').
 */

afterEach(cleanup);

const registry = createOperatorRegistry();
const schemaOf = (id: string) => safeJsonSchema(registry.get(id)!.schema);
const select = (root: ParentNode, key: string) =>
  root.querySelector<HTMLSelectElement>(`[data-testid="f-${key}"]`)!;
const shown = (root: ParentNode, key: string) => {
  const el = select(root, key);
  return el.options[el.selectedIndex]?.textContent;
};
const labels = (root: ParentNode, key: string) => [...select(root, key).options].map((o) => o.textContent);

describe('SchemaForm: optional enums left out (Add Shot redo panel)', () => {
  it('shows the enums Add Shot was run without as not set, not as their first value', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SchemaForm schema={schemaOf('desk.shot_add')} values={{}} testIdPrefix="f" onChange={onChange} />,
    );
    for (const key of ['framing', 'angle', 'height', 'move']) {
      expect(select(container, key).value, key).toBe('');
      expect(shown(container, key), key).toBe('— not set —');
    }
    expect(labels(container, 'framing').slice(0, 3)).toEqual(['— not set —', 'Extreme wide', 'Wide']);
    // a parameter with a default shows it, and offers no empty choice
    expect(shown(container, 'continuity')).toBe('Cut');
    expect(labels(container, 'continuity')).not.toContain('— not set —');

    // choosing a value passes it; choosing "not set" leaves the parameter out again
    fireEvent.change(select(container, 'framing'), { target: { value: 'wide' } });
    expect(onChange).toHaveBeenLastCalledWith('framing', 'wide', true);
    fireEvent.change(select(container, 'framing'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('framing', undefined, true);
  });

  it('shows the value an enum was given', () => {
    const { container } = render(
      <SchemaForm
        schema={schemaOf('desk.shot_add')}
        values={{ framing: 'close_up', angle: 'profile_left' }}
        testIdPrefix="f"
        onChange={() => undefined}
      />,
    );
    expect(select(container, 'framing').value).toBe('close_up');
    expect(shown(container, 'framing')).toBe('Close up');
    expect(shown(container, 'angle')).toBe('Profile left');
    expect(shown(container, 'height')).toBe('— not set —');
  });

  it('a nullable enum tells left out (unchanged) from null (cleared)', () => {
    const onChange = vi.fn();
    const schema = schemaOf('desk.shot_update');
    const { container, rerender } = render(
      <SchemaForm schema={schema} values={{}} testIdPrefix="f" onChange={onChange} />,
    );
    expect(shown(container, 'framing')).toBe('— not set —');
    expect(labels(container, 'framing').slice(0, 3)).toEqual(['— not set —', '— none —', 'Extreme wide']);
    fireEvent.change(select(container, 'framing'), {
      target: { value: select(container, 'framing').options[1].value },
    });
    expect(onChange).toHaveBeenLastCalledWith('framing', null, true);
    fireEvent.change(select(container, 'framing'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('framing', undefined, true);
    rerender(<SchemaForm schema={schema} values={{ framing: null }} testIdPrefix="f" onChange={onChange} />);
    expect(shown(container, 'framing')).toBe('— none —');
  });

  it('keeps required enums and enums with a default as they were', () => {
    const schema = safeJsonSchema(
      z.object({
        mode: z.enum(['FAST', 'SLOW']),
        axis: z.enum(['X', 'Y', 'Z']).default('Z'),
        side: z.enum(['LEFT', 'RIGHT']).optional(),
      }),
    );
    const { container } = render(
      <SchemaForm
        schema={schema}
        values={{}}
        testIdPrefix="f"
        expandEnums={['side']}
        onChange={() => undefined}
      />,
    );
    expect(labels(container, 'mode')).toEqual(['Fast', 'Slow']);
    expect(select(container, 'mode').value).toBe('FAST');
    expect(labels(container, 'axis')).toEqual(['X', 'Y', 'Z']);
    expect(select(container, 'axis').value).toBe('Z');
    // as buttons, a left-out enum has no button pressed (none of its values was chosen)
    const pressed = [...container.querySelectorAll('[data-testid^="f-side-"]')].map((b) =>
      b.getAttribute('aria-pressed'),
    );
    expect(pressed).toEqual(['false', 'false']);
  });
});
