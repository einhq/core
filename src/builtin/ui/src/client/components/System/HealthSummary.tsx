import { Badge, Box, Card, Stack, Text, Tooltip } from '@mantine/core';
import type { HealthAnswer } from '@ein/api';

type Props = {
  health?: HealthAnswer | null;
};

const VERDICT: Record<HealthAnswer['verdict'], { label: string; color: string }> = {
  healthy: { label: 'Healthy', color: 'green' },
  'catching-up': { label: 'Catching up', color: 'blue' },
  stuck: { label: 'Stuck', color: 'orange' },
  'needs-person': { label: 'Needs a person', color: 'red' },
};

/**
 * `health`'s verdict as a badge, for a page header: is the system well and keeping up. The
 * sentence behind it (`3 jobs waiting, done in about 2 min`) is its tooltip. Nothing until the
 * first answer is in.
 */
export function HealthBadge({ health }: Props) {
  if (!health) return null;
  const verdict = VERDICT[health.verdict];
  // The summary opens with the verdict the badge already says: the tooltip is what follows it.
  const detail = health.summary.includes(': ') ? health.summary.slice(health.summary.indexOf(': ') + 2) : '';
  const badge = <Badge color={verdict.color} variant='filled'>{verdict.label}</Badge>;
  return detail ? <Tooltip label={detail} withArrow>{badge}</Tooltip> : badge;
}

/**
 * Every `health` check that is not fine, with its reason: what decided a verdict other than
 * healthy. Nothing at all while every check is fine or the answer is not in, so the card takes
 * room only when it has something to say; `health` in a shell lists every check.
 */
export function HealthSummary({ health }: Props) {
  const problems = (health?.checks ?? []).filter((check) => check.state !== 'ok')
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'fail' ? -1 : 1));
  if (problems.length === 0) return null;

  return (
    <Card>
      <Stack gap='xs'>
        {
          /* One block per check, the name over its reason, across the card's whole width: beside
          the name, a long reason would be a sliver of text on a phone. */
        }
        {problems.map((check, index) => (
          <Box
            key={`${check.name}-${index}`}
            pl='sm'
            style={{ borderLeft: `3px solid var(--mantine-color-${check.state === 'fail' ? 'red' : 'yellow'}-6)` }}
          >
            <Text size='sm' fw={500} title={check.service ? `reported by the ${check.service} service` : undefined}>{check.name}</Text>
            <Text size='sm' c='dimmed' style={{ overflowWrap: 'anywhere' }}>{check.reason}</Text>
          </Box>
        ))}
      </Stack>
    </Card>
  );
}
