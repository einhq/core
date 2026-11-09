/**
 * Devices: what is under `/dev/<device>`, as the device commands answer, the device pages draw and
 * drivers write it.
 *
 * A device is a node of type `device` whose children are its endpoints: a `log` of values or
 * events, a `track` of positions, or a `control` that is written to change the device. A driver
 * (a module's, or core's `tracker`) turns the device's raw input and output into those endpoints.
 */

/** The group whose members see, switch, share, make, name and forget every device under `/dev`. */
export const DEVICES_GROUPNAME = 'devices';

/** A value as an endpoint keeps it and the bus carries it. */
export type DeviceValue = number | string | boolean | null;

/** The node types an endpoint can be. */
export type EndpointType = 'log' | 'track' | 'control';
export const ENDPOINT_TYPES: readonly EndpointType[] = ['log', 'track', 'control'];

/**
 * What a control takes:
 *
 * - `bool` — on or off (`on`, `off`, `toggle`, `true`, `false`, `1`, `0`)
 * - `number` — a number, within `min` and `max`, a multiple of `step` from `min`
 * - `enum` — one of `options`
 * - `text` — any line
 * - `momentary` — a press with no state: a restart, a doorbell's chime (`press`)
 */
export type ControlSchema =
  | { type: 'bool' }
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'enum'; options: string[] }
  | { type: 'text' }
  | { type: 'momentary' };

/** What an endpoint is about when it is not what the device is for: its own temperature, a setting. */
export type EndpointCategory = 'diagnostic' | 'config';

/** Attrs of a `device` node. */
export type DeviceAttrs = {
  /** What it is called, as the device or a person named it. */
  label: string;
  /** What it is: `phone`, `tracker`, `plug`, `sensor`, `light`, `button`, `car`, `boat`, `gpu`, … */
  class?: string;
  /** The driver that reads and writes it; none for a device whose endpoints are written by hand. */
  driver?: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  serial?: string;
  mac?: string;
  /** Its own web page, an http(s) URL, when its driver knows one: a Shelly's, an ESPHome node's, a printer's. */
  url?: string;
  /** Whether it answers, when its driver can tell. */
  online?: boolean;
  /** What a person gave its driver (`device-create --config`); secrets are in `.secret`, never here. */
  config?: Record<string, string>;
};

/** Attrs a driver gives an endpoint: a `log`, `track` or `control` under a device. */
export type EndpointAttrs = {
  label?: string;
  unit?: string;
  /** What is measured: `temperature`, `power`, `door`, `motion`. */
  deviceClass?: string;
  category?: EndpointCategory;
  /** A log whose entries are events (a button's presses), not a state. */
  events?: boolean;
  /** Shortest time between two published readings, in seconds. */
  minInterval?: number;
  /** How long a log's or control's entries are kept: `30 day`, `forever` (the log registry's retention). */
  retention?: string;
  /** A control's: what it takes. */
  schema?: ControlSchema;
  /** A control's: the last value someone wrote, which the device has yet to report. */
  requested?: ControlRequest;
  /** False when the driver cannot read its values. */
  supported?: boolean;
  /** Set when the device stopped announcing it; its history stays. */
  retired?: boolean;
};

/** A control's last write: what, when, by whom. */
export type ControlRequest = { value: DeviceValue; at: string; by: string };

/** One fix as a track endpoint keeps it. */
export type DeviceFix = { lat: number; lng: number; alt?: number; speed?: number; course?: number; accuracy?: number };

/**
 * What a driver's reading is published as, on `dev.<device>.<endpoint>`: who it is from, since a
 * queue hands out a message without the key it came on. A device coming or going is published on
 * `dev.<device>`, with `online` and no endpoint.
 */
export type DeviceMessage = {
  device: string;
  endpoint?: string;
  value?: DeviceValue;
  fix?: DeviceFix;
  unit?: string;
  online?: boolean;
  /** Set for an event endpoint's value: a press, not a state. */
  event?: true;
  /** When it was read (ISO 8601). */
  at: string;
  /** Set when the device replayed its last value, as a broker does after a reconnect. */
  retained?: true;
};

/**
 * A device's or endpoint's name from what a person or a device calls it: lower-case letters,
 * digits and single hyphens, safe as a node's name and as one segment of a routing key.
 */
export const deviceName = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The routing key a device's endpoint publishes on, or the device itself without one. */
export const deviceRoutingKey = (device: string, endpoint?: string): string => endpoint ? `dev.${device}.${endpoint}` : `dev.${device}`;

/** An endpoint with its latest value, as `device-show` answers. */
export type EndpointSummary = {
  name: string;
  path: string;
  type: EndpointType;
  label: string;
  unit?: string;
  deviceClass?: string;
  category?: EndpointCategory;
  events?: boolean;
  schema?: ControlSchema;
  requested?: ControlRequest;
  supported: boolean;
  retired: boolean;
  /** Whether the caller may write it: a control's value, or a value appended to a log or track. */
  writable: boolean;
  /** The latest value of a log or control. */
  last?: { value: DeviceValue; at: string };
  /** A track's: how many fixes, and when the latest was. */
  track?: { points: number; firstAt?: string; lastAt?: string };
};

/** A device, as `devices` answers. */
export type DeviceSummary = {
  name: string;
  path: string;
  label: string;
  class?: string;
  driver?: string;
  manufacturer?: string;
  model?: string;
  /**
   * Whether it answers, as its driver tells; a device whose driver cannot tell (a tracker, a
   * webhook) is online while heard from in the last 15 minutes, and neither once it is not.
   */
  online?: boolean;
  endpoints: number;
  /** When the latest of its values arrived. */
  lastAt?: string;
  /**
   * The value a card shows: a temperature, then power, humidity, light or energy, else any reading,
   * else a control; never one about the device itself.
   */
  main?: { endpoint: string; label: string; value: DeviceValue; unit?: string };
  /** Whether it has a track, which a page shows as a map. */
  tracks: boolean;
};

/** `device-show`: a device and each of its endpoints. */
export type DeviceInfo = DeviceSummary & {
  firmware?: string;
  serial?: string;
  mac?: string;
  /** Its own web page. */
  url?: string;
  config?: Record<string, string>;
  /** Whether its driver runs now; unset for a device without one. */
  driverRunning?: boolean;
  /** Whether its driver takes raw input, so the device has a key to write with. */
  input: boolean;
  endpointList: EndpointSummary[];
};

/** `device-create`: the device made. */
export type DeviceCreated = { device: string; path: string };

/**
 * `device-key`: whether the device may write to `/file/dev/<device>` without signing in, and the
 * URL it is given.
 */
export type DeviceKeyAnswer = {
  device: string;
  enabled: boolean;
  /** `<origin>/file/dev/<device>?key=<key>`, or its path without `--origin`; absent while turned off. */
  url?: string;
  /**
   * What a QR code says: Traccar Client's configuration link, `org.traccar.client://config?url=<url>&id=<device>`,
   * the URL as its server and the device's name as its device identifier.
   */
  qrText?: string;
  /** The QR code as an SVG document; only with `--origin`. */
  qrSvg?: string;
  /** When the key was made, ISO 8601. */
  createdAt?: string;
};

/** How `device-history --bucket` sums each interval up. */
export type HistoryAggregate = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'first' | 'last';

/**
 * `device-history`: a log's or control's values, oldest first; with `--bucket`, one per interval,
 * where `at` is the interval's start, `value` its values summed up and `count` how many there were.
 * A track's are its fixes.
 */
export type DeviceHistory = {
  device: string;
  endpoint: string;
  type: EndpointType;
  unit?: string;
  bucket?: { seconds: number; aggregate: HistoryAggregate };
  readings: { at: string; value: DeviceValue; count?: number }[];
  fixes?: ({ at: string } & DeviceFix)[];
};

/** A config field a driver asks for when a person makes a device with it. */
export type DriverConfigField = {
  name: string;
  label: string;
  type: 'string' | 'number' | 'url';
  /** Kept in the device's `.secret`, not its attrs. */
  secret?: boolean;
  required?: boolean;
};

/** A driver, as `devices --drivers` answers. */
export type DriverSummary = {
  name: string;
  /** The module that declares it, or `core`. */
  module: string;
  description: string;
  /** Whether it takes raw input written to its devices. */
  input: boolean;
  /** Whether its service has registered it now. */
  running: boolean;
  config: DriverConfigField[];
  devices: number;
};
