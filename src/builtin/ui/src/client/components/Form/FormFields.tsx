import { Box, Checkbox, Group, Input, NumberInput, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapMarkers, MapView, type PositionPoint } from '../Map/mod.ts';
import { MarkdownEditor } from '../Markdown/MarkdownEditor.tsx';

/**
 * A form as data: the fields a command needs, drawn the same way wherever they are asked for —
 * the shell's own forms and module routes alike (`CommandForm`).
 *
 * `coordinates` is a map plus a latitude/longitude pair, stored under `lat` and `lng`.
 */
export type FormFieldType = 'text' | 'textarea' | 'markdown' | 'number' | 'select' | 'timezone' | 'checkbox' | 'coordinates';

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: { value: string; label: string }[];
  /** Shares a row with the `half` field beside it, where the form is wide enough for two. */
  half?: boolean;
  /** A `select` that can be typed into to narrow its options, and cleared. */
  searchable?: boolean;
};

/** The field values by key; a checkbox is `'true'` or `''`. */
export type FormValues = Record<string, string>;

/**
 * Every IANA zone the browser knows, which is the same list the server
 * validates against — both sides ask ICU. Computed once: it is ~400 entries and
 * a Select rebuilds its data on every render otherwise.
 */
const TIMEZONE_OPTIONS = (() => {
  try {
    return Intl.supportedValuesOf('timeZone').map((zone) => ({ value: zone, label: zone }));
  } catch {
    return [];
  }
})();

/** Six decimals is ~10 cm, well below what a click on the map can mean. */
const round6 = (n: number) => String(Math.round(n * 1e6) / 1e6);

function toPoint(lat: string, lng: string): PositionPoint | null {
  if (lat.trim() === '' || lng.trim() === '') return null;
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? point : null;
}

type CoordinatesFieldProps = {
  label: string;
  description?: string;
  lat: string;
  lng: string;
  onChange: (lat: string, lng: string) => void;
};

/**
 * A map to click plus the two numbers it fills in. Typing still works; the map
 * follows coordinates that are typed or set from outside (a known place picked
 * beside it) but not clicked ones — `MapView` re-centres on every `center`
 * change, and recentring under the pointer on each click would make the map
 * slide away from what was just picked.
 */
function CoordinatesField({ label, description, lat, lng, onChange }: CoordinatesFieldProps) {
  const point = useMemo(() => toPoint(lat, lng), [lat, lng]);
  // Seeded from a prefill, so a location opened with coordinates starts on them.
  const [center, setCenter] = useState<PositionPoint | undefined>(() => point ?? undefined);
  const clicked = useRef<string | null>(null);

  useEffect(() => {
    if (point && `${point.lat},${point.lng}` !== clicked.current) setCenter(point);
  }, [point?.lat, point?.lng]);

  const markers = useMemo(() => point ? [{ id: 'picked', ...point }] : [], [point]);

  const pick = useCallback((p: PositionPoint) => {
    const [nextLat, nextLng] = [round6(p.lat), round6(p.lng)];
    clicked.current = `${Number(nextLat)},${Number(nextLng)}`;
    onChange(nextLat, nextLng);
  }, [onChange]);

  return (
    <Input.Wrapper label={label} description={description} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <Stack gap='sm' mt={4} style={{ flex: 1 }}>
        {/* As tall as the fields beside it, when it stands beside them, and never lower than this. */}
        <Box mih={320} style={{ flex: 1, borderRadius: 'var(--mantine-radius-sm)', overflow: 'hidden' }}>
          <MapView center={center} onClick={pick} style={{ height: '100%', cursor: 'crosshair' }}>
            <MapMarkers markers={markers} />
          </MapView>
        </Box>
        <Group grow>
          <NumberInput
            label='Latitude'
            placeholder='Optional'
            value={lat}
            onChange={(val) => onChange(val === '' ? '' : String(val), lng)}
            decimalScale={6}
            min={-90}
            max={90}
          />
          <NumberInput
            label='Longitude'
            placeholder='Optional'
            value={lng}
            onChange={(val) => onChange(lat, val === '' ? '' : String(val))}
            decimalScale={6}
            min={-180}
            max={180}
          />
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}

/**
 * The fields, each as its kind of input: one to a row, a `half` one beside the next where the form
 * is wide enough for two, and a map, with other fields, to their right (`.mrx-form-fields`).
 */
export function FormFields({ fields, values, onChange }: { fields: FormField[]; values: FormValues; onChange: (values: FormValues) => void }) {
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  const setValues = (update: (prev: FormValues) => FormValues) => onChange(update(values));
  const beside = fields.length > 1 && fields.some((field) => field.type === 'coordinates');

  const input = (field: FormField) => {
    const options = field.options;
    if (field.type === 'coordinates') {
      return (
        <CoordinatesField
          label={field.label}
          description={field.description}
          lat={values.lat ?? ''}
          lng={values.lng ?? ''}
          onChange={(lat, lng) => setValues((prev) => ({ ...prev, lat, lng }))}
        />
      );
    }
    if (field.type === 'timezone') {
      return (
        <Select
          label={field.label}
          placeholder={field.placeholder ?? 'Select…'}
          data={TIMEZONE_OPTIONS}
          value={values[field.key] || null}
          onChange={(val) => set(field.key, val ?? '')}
          description={field.description}
          searchable
          clearable
          // 400-odd zones: typing is the only usable way in, and the list
          // has to stay virtual-ish or the dropdown janks on open.
          limit={50}
          nothingFoundMessage='No such timezone'
        />
      );
    }
    if (field.type === 'select') {
      return (
        <Select
          label={field.label}
          placeholder={field.placeholder ?? 'Select…'}
          data={options ?? []}
          value={values[field.key] || null}
          onChange={(val) => set(field.key, val ?? '')}
          required={field.required}
          description={field.description}
          searchable={field.searchable}
          clearable={field.searchable}
        />
      );
    }
    if (field.type === 'textarea') {
      return (
        <Textarea
          label={field.label}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          onChange={(e) => set(field.key, e.currentTarget.value)}
          required={field.required}
          description={field.description}
          autosize
          minRows={2}
        />
      );
    }
    if (field.type === 'markdown') {
      return (
        <MarkdownEditor
          label={field.label}
          description={field.description}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          onChange={(value) => set(field.key, value)}
          required={field.required}
          minRows={3}
        />
      );
    }
    if (field.type === 'checkbox') {
      return (
        <Checkbox
          label={field.label}
          description={field.description}
          checked={values[field.key] === 'true'}
          onChange={(event) => set(field.key, event.currentTarget.checked ? 'true' : '')}
        />
      );
    }
    if (field.type === 'number') {
      return (
        <NumberInput
          label={field.label}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          onChange={(val) => set(field.key, val === '' ? '' : String(val))}
          required={field.required}
          description={field.description}
          decimalScale={6}
        />
      );
    }
    return (
      <TextInput
        key={field.key}
        label={field.label}
        placeholder={field.placeholder}
        value={values[field.key] ?? ''}
        onChange={(e) => set(field.key, e.currentTarget.value)}
        required={field.required}
        description={field.description}
      />
    );
  };

  return (
    <Box className='mrx-form'>
      <Box
        className='mrx-form-fields'
        data-map={beside || undefined}
        style={beside ? { '--mrx-form-map-rows': fields.length - 1 } as CSSProperties : undefined}
      >
        {fields.map((field) => (
          <Box key={field.key} className='mrx-form-field' data-half={field.half || undefined} data-map={field.type === 'coordinates' || undefined}>
            {input(field)}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
