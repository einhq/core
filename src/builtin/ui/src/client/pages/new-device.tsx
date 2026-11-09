import type { DeviceCreated } from '@ein/api';
import { CommandForm } from '../components/Form/CommandForm.tsx';
import type { FormField, FormValues } from '../components/Form/FormFields.tsx';
import { shq } from '../lib/shquote.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'New Device', icon: 'plug', pattern: 'device', signedIn: true };

const FIELDS: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Ruby phone', description: 'What it is called; its address is made from it.' },
  {
    key: 'driver',
    label: 'Reports by',
    type: 'select',
    options: [
      { value: 'tracker', label: 'Its position: a phone or GPS tracker' },
      { value: 'webhook', label: 'Posting its readings to a webhook' },
      { value: 'none', label: 'Nothing: values are written to it by hand' },
    ],
    half: true,
  },
  {
    key: 'class',
    label: 'What it is',
    type: 'select',
    searchable: true,
    options: ['phone', 'tracker', 'boat', 'car', 'bike', 'foot', 'sensor', 'plug', 'light', 'button'].map((value) => ({ value, label: value })),
    half: true,
  },
];

const build = (v: FormValues) => {
  let command = `device-create ${shq(v.name.trim())}`;
  if (v.driver && v.driver !== 'none') command += ` --driver ${shq(v.driver)}`;
  if (v.class) command += ` --class ${shq(v.class)}`;
  return { command, navigateTo: (answer: unknown) => `/devices/${(answer as DeviceCreated).device}` };
};

/**
 * `/devices/new`: make a device no driver announces — in the dialog from the top bar's Create
 * menu, which shows it to the devices group, or as a page of its own. It opens the new device,
 * where a tracker's key is made.
 */
export default function NewDevicePage() {
  return <CommandForm fields={FIELDS} initial={{ driver: 'tracker' }} build={build} submitLabel='Create' />;
}
