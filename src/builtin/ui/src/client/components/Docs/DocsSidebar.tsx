import { Anchor, Loader, NavLink, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { Link, useLocation } from 'react-router-dom';
import { useModuleReference } from '@ein/ui/hooks';
import { type Guide, GUIDE_SITE, guideRoute } from '../../lib/guide.ts';
import { moduleRoute, REFERENCE_PAGES } from './reference.tsx';

const Heading = ({ children }: { children: string }) => <Text size='xs' c='dimmed' fw={500} mt='md' mb={4} px='sm' tt='uppercase'>{children}</Text>;

/** The guide's contents as the site's sidebar has them: its parts, each section folded but the one open, a page under the one above indented. */
function GuideContents({ guide, pathname, onNavigate }: { guide: Guide; pathname: string; onNavigate?: () => void }) {
  return guide.sections.map((section, i) => {
    const links = section.pages.map((page) => {
      const to = guideRoute(page.path);
      return (
        <NavLink
          key={page.path}
          component={Link}
          to={to}
          label={page.title}
          active={pathname === to}
          onClick={onNavigate}
          pl={page.depth ? 12 + 16 * page.depth : undefined}
          style={{ borderRadius: 6 }}
        />
      );
    });
    const part = section.part && section.part !== guide.sections[i - 1]?.part ? <Heading key={`part-${section.part}`}>{section.part}</Heading> : null;
    if (!section.title) return [part, ...links];
    const here = section.pages.some((page) => pathname === guideRoute(page.path));
    return [
      part,
      <NavLink key={`${section.part}/${section.title}`} label={section.title} defaultOpened={here} childrenOffset={16} style={{ borderRadius: 6 }}>
        {links}
      </NavLink>,
    ];
  });
}

export type DocsSidebarProps = {
  /** The guide's contents; null when none is bundled here. */
  guide: Guide | null;
  loading?: boolean;
  /** Called after a link is followed, so a phone can fold the contents away. */
  onNavigate?: () => void;
};

/** The docs section's contents: the guide, then the pages drawn from this installation. */
export function DocsSidebar({ guide, loading, onNavigate }: DocsSidebarProps) {
  const { pathname } = useLocation();
  const { data: modules } = useModuleReference();

  return (
    <>
      {loading ? <Loader size='xs' mx='sm' mt='md' /> : guide ? <GuideContents guide={guide} pathname={pathname} onNavigate={onNavigate} /> : (
        <>
          <Heading>Guide</Heading>
          <Anchor href={GUIDE_SITE} target='_blank' rel='noreferrer' size='sm' px='sm'>
            einhq.eu/docs <IconExternalLink size={12} />
          </Anchor>
        </>
      )}

      <Heading>This installation</Heading>
      {REFERENCE_PAGES.map((page) => {
        const route = `/docs/${page.slug}`;
        const icon = <page.icon size={16} stroke={1.6} />;
        if (page.slug !== 'modules') {
          return (
            <NavLink
              key={page.slug}
              component={Link}
              to={route}
              label={page.label}
              leftSection={icon}
              active={pathname === route}
              onClick={onNavigate}
              style={{ borderRadius: 6 }}
            />
          );
        }
        return (
          <NavLink key={page.slug} label={page.label} leftSection={icon} defaultOpened={pathname.startsWith(route)} childrenOffset={28} style={{ borderRadius: 6 }}>
            <NavLink component={Link} to={route} label='All modules' active={pathname === route} onClick={onNavigate} style={{ borderRadius: 6 }} />
            {(modules ?? []).map((module) => {
              const to = moduleRoute(module.name);
              return <NavLink key={module.name} component={Link} to={to} label={module.name} active={pathname === to} onClick={onNavigate} style={{ borderRadius: 6 }} />;
            })}
          </NavLink>
        );
      })}
    </>
  );
}
