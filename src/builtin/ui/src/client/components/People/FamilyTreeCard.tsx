import { ActionIcon, Box, Group, Loader, Menu, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconDots, IconHeartPlus, IconUser, IconUserMinus, IconUserPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { CARD_HEIGHT, CARD_WIDTH, type FamilyNode } from '../../lib/family-layout.ts';
import { openRoute } from '../../signals/module-ui.ts';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';

/** How far an expand bulge stands out from the card's edge, and how wide it is. */
const BULGE_HEIGHT = 15;
const BULGE_WIDTH = 34;

/** Which way a card's family is expanded: towards its parents or its children. */
export type FamilyDirection = 'up' | 'down';

/** `1948 – 2011`, `b. 1948`, `d. 2011`, or nothing. */
export function lifeSpan(node: Pick<FamilyNode, 'born' | 'died'>): string | undefined {
  const born = node.born?.slice(0, 4);
  const died = node.died?.slice(0, 4);
  if (born && died) return `${born} – ${died}`;
  if (born) return `b. ${born}`;
  if (died) return `d. ${died}`;
  return undefined;
}

export type FamilyTreeCardProps = {
  node: FamilyNode;
  x: number;
  y: number;
  /** The person the tree is drawn for, highlighted so they can be found again. */
  isRoot: boolean;
  /** Parents exist that are not on screen. */
  moreParents: number;
  moreChildren: number;
  /** Waiting on this card's own expand, that way. */
  expanding: FamilyDirection | null;
  /** Relation controls are hidden for readers. */
  editable: boolean;
  onExpand: (direction: FamilyDirection) => void;
  onAddRelation: (kind: 'parent' | 'partner' | 'child') => void;
  onRemoveRelation: () => void;
};

/**
 * One person in the tree.
 *
 * A fixed box, because the layout measured it before it was drawn — a card that
 * sizes itself to its content would make every number in `family-layout.ts` a
 * guess. Names are clamped rather than allowed to grow for the same reason.
 *
 * The expand buttons sit on the edges they point at: parents above, children
 * below. A card with nothing more in a direction shows nothing there, so the
 * buttons are also the answer to "is this branch finished".
 */
export function FamilyTreeCard(
  { node, x, y, isRoot, moreParents, moreChildren, expanding, editable, onExpand, onAddRelation, onRemoveRelation }: FamilyTreeCardProps,
) {
  const span = lifeSpan(node);

  return (
    <Box
      className='mrx-family-card'
      data-person={node.path}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: 'var(--mantine-radius-md)',
        border: `1px solid ${isRoot ? 'var(--mantine-color-marine-5)' : 'var(--mantine-color-default-border)'}`,
        // A second pixel of ring rather than a thicker border, so the root's
        // portrait and text sit exactly where every other card's do.
        boxShadow: isRoot ? '0 0 0 1px var(--mantine-color-marine-5), var(--mantine-shadow-xs)' : 'var(--mantine-shadow-xs)',
        background: 'var(--mrx-surface-chrome)',
        boxSizing: 'border-box',
      }}
    >
      {moreParents > 0 && <ExpandBulge side='top' isRoot={isRoot} busy={expanding === 'up'} onClick={() => onExpand('up')} label={`Show ${node.name}'s parents`} />}
      {moreChildren > 0 && <ExpandBulge side='bottom' isRoot={isRoot} busy={expanding === 'down'} onClick={() => onExpand('down')} label={`Show ${node.name}'s children`} />}

      <Group wrap='nowrap' gap='xs' pr={6} align='center' h='100%'>
        {
          /* The portrait is the card's full height, flush to its left edge — the
            face is what finds a person in a tree, and at this height a round
            avatar inside padding would be a thumbnail. Its own clip, because the
            card cannot clip: the expand bulges stand out of its edges. */
        }
        <Box
          style={{
            flex: 'none',
            alignSelf: 'stretch',
            overflow: 'hidden',
            borderRadius: 'calc(var(--mantine-radius-md) - 1px) 0 0 calc(var(--mantine-radius-md) - 1px)',
          }}
        >
          <CoverAvatar path={node.path} alt={node.name} size={CARD_HEIGHT - 2} radius={0} fallback={<IconUser size={24} />} />
        </Box>

        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text
            component={Link}
            to={openRoute('person', node.path) ?? '#'}
            fz={13}
            lh={1.25}
            fw={isRoot ? 700 : 500}
            lineClamp={2}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            {node.name}
          </Text>
          {span && <Text fz={11} c='dimmed' mt={2}>{span}</Text>}
        </Stack>

        {editable && (
          <Menu position='bottom-end' withinPortal>
            <Menu.Target>
              <ActionIcon size='sm' variant='subtle' color='gray' aria-label={`Edit ${node.name}'s relations`}>
                <IconDots size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconUserPlus size={14} />} onClick={() => onAddRelation('parent')}>Add parent</Menu.Item>
              <Menu.Item leftSection={<IconHeartPlus size={14} />} onClick={() => onAddRelation('partner')}>Add partner</Menu.Item>
              <Menu.Item leftSection={<IconUserPlus size={14} />} onClick={() => onAddRelation('child')}>Add child</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconUserMinus size={14} />} color='red' onClick={onRemoveRelation}>Remove a relation…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Box>
  );
}

type ExpandBulgeProps = { side: 'top' | 'bottom'; isRoot: boolean; busy: boolean; onClick: () => void; label: string };

/**
 * An expand button shaped as a bulge of the card's own edge, so it stands out of
 * the card instead of lying over its name.
 *
 * It overlaps the card's border by the border's width and has no border of its
 * own on that side, so its background hides the card's edge where the two meet
 * and the outline runs on round it. The root card's outline is two pixels — its
 * border and the ring outside it — and so is the root's bulge.
 */
function ExpandBulge({ side, isRoot, busy, onClick, label }: ExpandBulgeProps) {
  const edge = isRoot ? 2 : 1;
  const line = `${edge}px solid ${isRoot ? 'var(--mantine-color-marine-5)' : 'var(--mantine-color-default-border)'}`;
  const round = `${BULGE_WIDTH / 2}px`;
  return (
    <UnstyledButton
      className='mrx-family-bulge'
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        [side]: -(BULGE_HEIGHT + 1),
        width: BULGE_WIDTH,
        height: BULGE_HEIGHT + 1,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        background: 'var(--mrx-surface-chrome)',
        borderLeft: line,
        borderRight: line,
        ...(side === 'top'
          ? { borderTop: line, borderRadius: `${round} ${round} 0 0`, paddingTop: 1 }
          : { borderBottom: line, borderRadius: `0 0 ${round} ${round}`, paddingBottom: 1 }),
      }}
    >
      {busy ? <Loader size={10} /> : side === 'top' ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
    </UnstyledButton>
  );
}
