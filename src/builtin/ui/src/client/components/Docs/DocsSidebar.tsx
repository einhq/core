import { Loader, NavLink, Text } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';
import { type DocNode, useModuleReference } from '@ein/ui/hooks';
import { docRoute, moduleRoute, REFERENCE_PAGES } from './reference.tsx';

export function prettify(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSsh\b/, 'SSH')
    .replace(/\bSftp\b/, 'SFTP');
}

/** Label a guide node; the index of a directory is its overview. */
function label(node: DocNode): string {
  if (node.type === 'file' && node.name.toLowerCase() === 'index.md') return 'Overview';
  return prettify(node.name);
}

function GuideLink({ node, activePath, onNavigate }: { node: DocNode; activePath: string; onNavigate?: () => void }) {
  if (node.type === 'directory') {
    // A directory containing the currently-open doc starts expanded.
    const containsActive = activePath.startsWith(node.path + '/');
    return (
      <NavLink label={prettify(node.name)} defaultOpened={containsActive} childrenOffset={16}>
        {node.children?.map((child) => <GuideLink key={child.path} node={child} activePath={activePath} onNavigate={onNavigate} />)}
      </NavLink>
    );
  }
  return (
    <NavLink
      component={Link}
      to={docRoute(node.path)}
      label={label(node)}
      active={activePath === node.path}
      onClick={onNavigate}
      style={{ borderRadius: 6 }}
    />
  );
}

const Heading = ({ children }: { children: string }) => <Text size='xs' c='dimmed' fw={500} mt='md' mb={4} px='sm' tt='uppercase'>{children}</Text>;

export type DocsSidebarProps = {
  /** The guide's pages. */
  tree: DocNode[];
  loading?: boolean;
  /** The guide's overview, which `/docs` itself shows. */
  indexPath: string;
  /** Called after a link is followed, so a phone can fold the contents away. */
  onNavigate?: () => void;
};

/** The docs section's contents: the written guide, then the pages drawn from this installation. */
export function DocsSidebar({ tree, loading, indexPath, onNavigate }: DocsSidebarProps) {
  const { pathname } = useLocation();
  const { data: modules } = useModuleReference();
  // A guide page's VFS path is encoded into the route's last segment (/docs/<encoded>); /docs itself is the overview.
  const activePath = pathname === '/docs' ? indexPath : pathname.startsWith('/docs/') ? decodeURIComponent(pathname.slice('/docs/'.length)) : '';

  return (
    <>
      <Heading>Guide</Heading>
      {loading ? <Loader size='xs' mx='sm' /> : tree.map((node) => <GuideLink key={node.path} node={node} activePath={activePath} onNavigate={onNavigate} />)}

      <Heading>Reference</Heading>
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
