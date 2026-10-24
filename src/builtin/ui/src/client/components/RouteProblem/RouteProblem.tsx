import { Button, Code, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconHome, IconRefresh } from '@tabler/icons-react';
import { type CSSProperties, type ReactNode, useId } from 'react';
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import { useSurface } from '../../hooks/useSurface.ts';
import { HAT_PATCH } from '../../lib/hat.ts';
import { ModuleLoadError } from '../../lib/module-load-error.ts';
import { MARK_COLORS } from '../Layout/EinMark.tsx';

/** The fallen hat's colours when something went wrong. */
const ERROR_COLORS = ['#ffa94d', '#ff6b6b', '#e03131'];

/**
 * How each hat of the patch flies off when it bursts: straight out from the hole, further the
 * further out it lies, turning a little, and later the further out it lies, so the burst spreads
 * as a wave.
 */
function burst(points: string, index: number) {
  const xy = points.split(' ').map((pair) => pair.split(',').map(Number));
  const x = xy.reduce((sum, [px]) => sum + px, 0) / xy.length;
  const y = xy.reduce((sum, [, py]) => sum + py, 0) / xy.length;
  const distance = Math.hypot(x, y);
  const reach = 1.4 + distance * .45;
  return {
    '--mrx-burst-x': `${(x / distance * reach).toFixed(2)}px`,
    '--mrx-burst-y': `${(y / distance * reach).toFixed(2)}px`,
    '--mrx-burst-turn': `${(index * 47) % 70 - 35}deg`,
    '--mrx-burst-delay': `${Math.round(250 + distance * 110)}ms`,
    fillOpacity: .7 + (index * 37 % 30) / 100,
  } as CSSProperties;
}

/**
 * The tiling with one hat fallen out of it: the patch fading out from the hole, and the hat
 * lying below it in the mark's colours — red, for an error. The patch first shows in those colours
 * and bursts, leaving its outline.
 */
function MissingTile({ error }: { error: boolean }) {
  const id = useId();
  const [hole, ...rest] = HAT_PATCH;
  const colors = error ? ERROR_COLORS : MARK_COLORS;
  return (
    <svg className='mrx-missing-tile' viewBox='-5.4 -5.2 10.8 11.6' aria-hidden focusable='false'>
      <defs>
        <radialGradient id={`${id}-fade`} cx='0' cy='0' r='5.4' gradientUnits='userSpaceOnUse'>
          <stop offset='.2' stopColor='#fff' />
          <stop offset='1' stopColor='#fff' stopOpacity='0' />
        </radialGradient>
        <mask id={`${id}-mask`} maskUnits='userSpaceOnUse' x='-6' y='-6' width='12' height='12'>
          <rect x='-6' y='-6' width='12' height='12' fill={`url(#${id}-fade)`} />
        </mask>
        <linearGradient id={`${id}-hat`} x1='0' y1='0' x2='1' y2='1'>
          {colors.map((color, i) => <stop key={color} offset={i / (colors.length - 1)} stopColor={color} />)}
        </linearGradient>
        <linearGradient id={`${id}-patch`} gradientUnits='userSpaceOnUse' x1='-5' y1='-3' x2='5' y2='3'>
          {colors.map((color, i) => <stop key={color} offset={i / (colors.length - 1)} stopColor={color} />)}
        </linearGradient>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        {rest.map((points) => <polygon key={points} points={points} />)}
      </g>
      <g mask={`url(#${id}-mask)`}>
        {rest.map((points, i) => <polygon key={points} className='mrx-missing-tile-burst' points={points} style={{ fill: `url(#${id}-patch)`, ...burst(points, i) }} />)}
      </g>
      <polygon className='mrx-missing-tile-hole' points={hole} />
      <polygon className='mrx-missing-tile-hat' points={hole} style={{ fill: `url(#${id}-hat)` }} />
    </svg>
  );
}

type Props = {
  title: string;
  children: ReactNode;
  /** Red rather than the mark's colours. */
  error?: boolean;
  /** Reload rather than go back: what was asked for could not be loaded or drawn. */
  reload?: boolean;
  /** What went wrong, in the error's own words. */
  detail?: string;
};

/**
 * What a route draws in place of a page that is not there or did not work: the fallen hat, a title,
 * a line on what happened, and the way on — home, back, or a reload. Inside the shell, so the
 * navigation stays; in a dialog or the drawer it is smaller and closes instead, and in a panel it
 * leaves the page around it to go on from.
 */
function RouteProblem({ title, children, error = false, reload = false, detail }: Props) {
  const surface = useSurface();
  const navigate = useNavigate();
  const page = surface.kind === 'page';
  const home = (
    <Button variant={reload ? 'default' : 'filled'} leftSection={<IconHome size={16} />} onClick={() => surface.openPage('/')}>
      Go home
    </Button>
  );
  return (
    <Stack className='mrx-route-problem' data-page={page || undefined} align='center' justify='center' gap='md' ta='center'>
      <MissingTile error={error} />
      <Stack gap={6} align='center'>
        <Title order={page ? 2 : 4}>{title}</Title>
        <Text c='dimmed' size={page ? 'md' : 'sm'} maw={460}>{children}</Text>
      </Stack>
      {detail && <Code block className='mrx-route-problem-detail'>{detail}</Code>}
      <Group justify='center' gap='xs' mt='xs'>
        {reload && <Button leftSection={<IconRefresh size={16} />} onClick={() => location.reload()}>Reload</Button>}
        {page && !reload && history.length > 1 && (
          <Button variant='subtle' color='gray' leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)}>
            Go back
          </Button>
        )}
        {page ? home : surface.kind !== 'panel' && <Button variant='default' onClick={surface.close}>Close</Button>}
      </Group>
    </Stack>
  );
}

/** A path no route matches, the shell's or a module's: the root's `*` child. */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <RouteProblem title='Nothing here'>
      There is no page at <Code>{pathname}</Code>. The link may be mistyped, or what it led to has moved.
    </RouteProblem>
  );
}

/**
 * A route's `ErrorBoundary`: a module page whose code could not be loaded, or a page that threw
 * while loading or drawing.
 */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  if (error instanceof ModuleLoadError) {
    return (
      <RouteProblem title='This page did not load' error reload>
        Its code could not be fetched. EiN may have been updated while this tab was open; reloading picks up the new version.
      </RouteProblem>
    );
  }
  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);
  return (
    <RouteProblem title='Something broke on this page' error reload detail={detail}>
      The rest of EiN still works. Reloading may help; if it keeps happening, what went wrong is below.
    </RouteProblem>
  );
}
