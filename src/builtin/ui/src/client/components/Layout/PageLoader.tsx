import { Center, Loader, Stack, Text } from '@mantine/core';
import { HAT_KITES, HAT_POINTS } from '../../lib/hat.ts';
import { kiteShade, MarkGradient } from './EinMark.tsx';

/** One turn of the lit kites round the hat, in seconds. */
const TURN = 1.6;

/**
 * The mark with its outline faint and its kites lit one after another round the hat, each fading
 * as the next lights, so about a third of it shines at a time.
 */
function HatLoader() {
  return (
    <svg className='mrx-hat-loader' viewBox='-1.75 -1.98 6.5 4.83' role='presentation' focusable='false'>
      <defs>
        <MarkGradient id='mrx-hat-loader-fill' />
      </defs>
      <polygon points={HAT_POINTS} />
      {HAT_KITES.map((points, i) => (
        // A negative delay starts each kite part-way through its fade, so the turn is under way at once.
        <g key={points} data-kite style={{ animationDelay: `${(i / HAT_KITES.length - 1) * TURN}s`, animationDuration: `${TURN}s` }}>
          <polygon points={points} fill='url(#mrx-hat-loader-fill)' />
          <polygon points={points} {...kiteShade(i)} />
        </g>
      ))}
    </svg>
  );
}

/**
 * The one loading state a page shows while its content has not arrived: the hat
 * being drawn and a line saying what is coming, centered where the content will
 * be and tall enough that the page does not jump when it lands.
 */
export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <Center mih={240} role='status'>
      <Stack align='center' gap='xs'>
        <HatLoader />
        <Text size='sm' c='dimmed' ta='center' maw={420}>{label}</Text>
      </Stack>
    </Center>
  );
}

/** The small loader below a list that is fetching its next page. */
export function MoreLoader() {
  return (
    <Center py='lg'>
      <Loader size='sm' />
    </Center>
  );
}
