import { useEffect, useState } from 'react';
import { NavLink, Outlet, useMatches } from 'react-router';
import { Badge, Button } from '../components/ui';
import { useUser } from '../context/UserContext';
import { classNames } from '../utils/classNames';
import { APP_NAME } from './constants';
import type { RouteHandle } from './routes';
import styles from './AppLayout.module.css';

interface NavItem {
  to: string;
  label: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Assessments',
    items: [
      { to: '/assessments/coding', label: 'Coding Problems' },
      { to: '/assessments/embedded', label: 'Embedded Systems' },
    ],
  },
  {
    label: 'My Account',
    items: [
      { to: '/credentials', label: 'Credentials' },
      { to: '/profile', label: 'Profile' },
    ],
  },
];

const ADMIN_GROUP: NavGroup = {
  label: 'Admin',
  items: [{ to: '/admin/reviews', label: 'Reviews' }],
};

function isRouteHandle(value: unknown): value is RouteHandle {
  return typeof value === 'object' && value !== null && typeof (value as RouteHandle).title === 'string';
}

function useDocumentTitle() {
  const matches = useMatches();
  const handle = [...matches].reverse().find((match) => isRouteHandle(match.handle))?.handle;
  const title = isRouteHandle(handle) ? handle.title : undefined;

  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}

export function AppLayout() {
  const { userProfile, cognitoUser, isAdmin, signOut } = useUser();
  const [menuOpen, setMenuOpen] = useState(false);
  useDocumentTitle();

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  const groups = isAdmin ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS;
  const displayName = userProfile?.name || cognitoUser?.username;

  return (
    <div className={styles.layout}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to main content
      </a>

      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? 'Close menu' : 'Menu'}
        </Button>
        <span className={styles.appName}>{APP_NAME}</span>

        <div className={styles.userArea}>
          <div className={styles.userInfo}>
            {displayName && <span className={styles.userName}>{displayName}</span>}
            {userProfile?.email && <span className={styles.userEmail}>{userProfile.email}</span>}
          </div>
          {isAdmin && <Badge variant="info">Admin</Badge>}
          <Button variant="secondary" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        <nav
          id="main-nav"
          aria-label="Main"
          className={classNames(styles.sidebar, menuOpen && styles.sidebarOpen)}
        >
          {groups.map((group) => {
            const headingId = `nav-group-${group.label.replace(/\s+/g, '-').toLowerCase()}`;
            return (
              <div key={group.label} className={styles.navGroup}>
                <p id={headingId} className={styles.navGroupLabel}>
                  {group.label}
                </p>
                <ul className={styles.navList} aria-labelledby={headingId}>
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        className={({ isActive }) => classNames(styles.navLink, isActive && styles.navLinkActive)}
                        onClick={() => setMenuOpen(false)}
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        {menuOpen && <div className={styles.backdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />}

        <main id="main-content" tabIndex={-1} className={styles.main}>
          <div className={styles.content}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
