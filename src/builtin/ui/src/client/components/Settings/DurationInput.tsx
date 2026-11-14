import { Group, NumberInput, Select } from '@mantine/core';
import { useState } from 'react';

const UNITS = [
  { seconds: 86400, one: 'day', many: 'days' },
  { seconds: 3600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
];

/** The largest unit a number of seconds is a whole count of. */
const unitFor = (seconds: number): number => UNITS.find((unit) => seconds > 0 && seconds % unit.seconds === 0)?.seconds ?? 1;

type DurationInputProps = { id?: string; value: string; onChange: (next: string) => void; disabled: boolean };

/**
 * A number of seconds, the value a setting holds, as a count of days, hours, minutes or seconds. It
 * starts in the largest unit the value is a whole count of; choosing another unit keeps the count,
 * so typing 2 and choosing days makes two days. A value the chosen unit does not divide is shown in
 * the unit that does.
 */
export function DurationInput({ id, value, onChange, disabled }: DurationInputProps) {
  const seconds = value === '' ? Number.NaN : Number(value);
  const [chosen, setChosen] = useState(() => unitFor(seconds));
  const valid = Number.isFinite(seconds);
  const unit = valid && seconds % chosen !== 0 ? unitFor(seconds) : chosen;
  const count = valid ? seconds / unit : '';

  return (
    <Group gap='xs' wrap='nowrap'>
      <NumberInput
        id={id}
        value={count}
        disabled={disabled}
        min={1}
        allowNegative={false}
        allowDecimal={false}
        style={{ flex: 1, minWidth: 0 }}
        onChange={(next) => onChange(next === '' ? '' : String(Number(next) * unit))}
      />
      <Select
        aria-label='Unit'
        w={112}
        data={UNITS.map((option) => ({ value: String(option.seconds), label: count === 1 ? option.one : option.many }))}
        value={String(unit)}
        disabled={disabled}
        allowDeselect={false}
        onChange={(next) => {
          if (!next) return;
          setChosen(Number(next));
          if (typeof count === 'number') onChange(String(count * Number(next)));
        }}
      />
    </Group>
  );
}
