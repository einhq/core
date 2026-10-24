import { ActionIcon, Box, Group, Loader, Menu, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconDots, IconHeartPlus, IconUser, IconUserMinus, IconUserPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { CARD_HEIGHT, CARD_WIDTH, type FamilyNode } from '../../lib/family-layout.ts';
import { openRoute } from '../../signals/module-ui.ts';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';

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
  /** Waiting on this card's own expand. */
  busy: boolean;
  /** Relation controls are hidden for readers. */
  editable: boolean;
  onExpand: () => void;
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
 * below, each showing how many are still hidden. A card with nothing more in a
 * direction shows nothing there, so the buttons are also the answer to "is this
 * branch finished".
 */
export function FamilyTreeCard(
  { node, x, y, isRoot, moreParents, moreChildren, busy, editable, onExpand, onAddRelation, onRemoveRelation }: FamilyTreeCardProps,
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
      {(moreParents > 0 || moreChildren > 0) && (
        <ActionIcon
          size='sm'
          radius='xl'
          variant='filled'
          color='gray'
          loading={busy}
          onClick={onExpand}
          aria-label={`Show more family for ${node.name}`}
          style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: moreParents > 0 ? -11 : undefined, bottom: moreParents > 0 ? undefined : -11 }}
        >
          {moreParents > 0 ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </ActionIcon>
      )}

      {
        /* Only when there is more in *both* directions does the second button
          earn its location; otherwise the one above says everything. */
      }
      {moreParents > 0 && moreChildren > 0 && (
        <ActionIcon
          size='sm'
          radius='xl'
          variant='filled'
          color='gray'
          loading={busy}
          onClick={onExpand}
          aria-label={`Show more descendants of ${node.name}`}
          style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: -11 }}
        >
          <IconChevronDown size={14} />
        </ActionIcon>
      )}

      <Group wrap='nowrap' gap='xs' pr={6} align='center' h='100%'>
        {
          /* The portrait is the card's full height, flush to its left edge — the
            face is what finds a person in a tree, and at this height a round
            avatar inside padding would be a thumbnail. Its own clip, because the
            card cannot clip: the expand buttons hang over its edges. */
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

        {busy ? <Loader size='xs' /> : editable && (
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
