import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import { Link } from 'react-router-dom';

/** One step of a `HeaderTrail`: its label and the route it opens. */
export type TrailStep = { label: string; to: string };

/**
 * Where a page stands under the pages that lead to it, each a link, for a header's `eyebrow`: above
 * the title, which is the trail's last step.
 */
export function HeaderTrail({ steps }: { steps: TrailStep[] }) {
  return (
    <Breadcrumbs separator={<Text span size='sm' c='gray.4'>›</Text>} separatorMargin={6} className='mrx-header-trail'>
      {steps.map((step) => (
        <Anchor key={step.to} component={Link} to={step.to} size='sm' c='gray.2'>
          {step.label}
        </Anchor>
      ))}
    </Breadcrumbs>
  );
}
