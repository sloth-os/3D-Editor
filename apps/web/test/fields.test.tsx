import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { evalExpression, NumberField, Checkbox } from '../src/ui/fields/fields';
import { SchemaForm } from '../src/ui/SchemaForm';
import { z } from 'zod';
import { safeJsonSchema } from '@3d-editor/core';

describe('fields', () => {
  it('evaluates arithmetic expressions safely', () => {
    expect(evalExpression('2*3+1')).toBe(7);
    expect(evalExpression('pi/2')).toBeCloseTo(Math.PI / 2);
    expect(evalExpression('alert(1)')).toBeNull();
    expect(evalExpression('')).toBeNull();
  });

  it('number field shows formatted values and accepts typed input', () => {
    const onChange = vi.fn();
    const { getByTestId, container } = render(<NumberField value={1.5} unit=" m" onChange={onChange} testId="nf" />);
    expect(container.textContent).toContain('1.5 m');
    const el = getByTestId('nf');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
    const input = container.querySelector('input')!;
    fireEvent.input(input, { target: { value: '2*2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(4, true);
  });

  it('checkbox toggles', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Checkbox value={false} label="X" onChange={onChange} testId="cb" />);
    fireEvent.click(getByTestId('cb'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('schema form renders numbers, enums, booleans and vectors', () => {
    const schema = safeJsonSchema(
      z.object({
        levels: z.number().int().min(0).max(6).default(1),
        mode: z.enum(['A', 'B']).default('A'),
        use_x: z.boolean().default(true),
        offset: z.tuple([z.number(), z.number(), z.number()]).default([1, 0, 0]),
      }),
    );
    const onChange = vi.fn();
    const { container } = render(<SchemaForm schema={schema} values={{ levels: 2 }} onChange={onChange} testIdPrefix="f" />);
    expect(container.querySelector('[data-testid=f-levels]')?.textContent).toContain('2');
    expect(container.querySelector('select[data-testid=f-mode]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^=f-offset-]').length).toBe(3);
    fireEvent.click(container.querySelector('label.checkbox')!);
    expect(onChange).toHaveBeenCalledWith('use_x', false, true);
  });
});
