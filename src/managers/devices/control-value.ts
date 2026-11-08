/**
 * What a control takes, read from what was written to it: `on` for a switch, `21.5` for a setpoint,
 * a word from a mode's options. A value its schema does not take is refused with why, so the writer
 * hears it from its write.
 */

import type { ControlSchema, DeviceValue } from '../../lib/api/devices.ts';

/** A value a control's schema does not take. */
export class ControlValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlValueError';
  }
}

const TRUE_WORDS = new Set(['on', 'true', '1', 'yes']);
const FALSE_WORDS = new Set(['off', 'false', '0', 'no']);

/**
 * `text` as `schema` takes it. `toggle` turns a switch to the other of `current`, the state the
 * device last reported, and is refused when there is none.
 */
export const parseControlValue = (schema: ControlSchema, text: string, current?: DeviceValue): DeviceValue => {
  const word = text.trim();
  switch (schema.type) {
    case 'bool': {
      const lower = word.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      if (lower === 'toggle') {
        if (typeof current !== 'boolean') throw new ControlValueError('toggle needs the state the device last reported, and it has reported none');
        return !current;
      }
      throw new ControlValueError(`takes on, off or toggle, not '${word}'`);
    }
    case 'number': {
      const value = Number(word);
      if (word === '' || !Number.isFinite(value)) throw new ControlValueError(`takes a number, not '${word}'`);
      if (schema.min !== undefined && value < schema.min) throw new ControlValueError(`takes ${schema.min} or more, not ${value}`);
      if (schema.max !== undefined && value > schema.max) throw new ControlValueError(`takes ${schema.max} or less, not ${value}`);
      if (schema.step !== undefined && schema.step > 0) {
        const steps = (value - (schema.min ?? 0)) / schema.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) throw new ControlValueError(`takes steps of ${schema.step}, not ${value}`);
      }
      return value;
    }
    case 'enum':
      if (!schema.options.includes(word)) throw new ControlValueError(`takes one of ${schema.options.join(', ')}, not '${word}'`);
      return word;
    case 'text':
      if (word === '') throw new ControlValueError('takes a line of text, not nothing');
      return word;
    case 'momentary':
      if (word !== '' && word !== 'press') throw new ControlValueError(`is pressed, with press, not '${word}'`);
      return 'press';
  }
};
