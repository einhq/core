import { IconAdjustments, IconAlbum, IconDeviceCameraPhone, IconMapPin, IconRoute, IconUser } from '@tabler/icons-react';

/** The icon for an `ENTITY_KIND_FILTERS` entry, as its collapsed control shows it on a phone. */
export function entityKindIcon(value: string, size = 18) {
  switch (value) {
    case 'album':
      return <IconAlbum size={size} />;
    case 'person':
      return <IconUser size={size} />;
    case 'location':
      return <IconMapPin size={size} />;
    case 'device':
      return <IconDeviceCameraPhone size={size} />;
    case 'track':
      return <IconRoute size={size} />;
    default:
      return <IconAdjustments size={size} />;
  }
}
