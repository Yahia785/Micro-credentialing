import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useMatches } from 'react-router';
import { Badge, BlockingOverlay, Button } from '../components/ui';
import { AssessmentSessionContext } from '../context/AssessmentSessionContext';
import type { ActiveAssessmentSession } from '../context/AssessmentSessionContext';
import { useUser } from '../context/UserContext';
import { SUBMIT_AND_LEAVE_MESSAGE } from '../hooks/useAssessmentNavigationGuard';
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
    items: [{ to: '/assessments', label: 'Assessments' }],
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
  const [activeSession, setActiveSession] = useState<ActiveAssessmentSession | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const assessmentSession = useMemo(() => ({ register: setActiveSession }), []);
  useDocumentTitle();

  const handleSignOut = async () => {
    if (activeSession) {
      // TODO(later phase): replace window.confirm with a proper dialog.
      if (!window.confirm(SUBMIT_AND_LEAVE_MESSAGE)) return;
      setSigningOut(true);
      await activeSession.submitAndLeave();
    }
    signOut();
    setSigningOut(false);
  };

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
      {signingOut && <BlockingOverlay message="Submitting your work…" detail="Please keep this tab open." />}
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
          <Button variant="secondary" size="sm" onClick={handleSignOut}>
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
            <AssessmentSessionContext.Provider value={assessmentSession}>
              <Outlet />
            </AssessmentSessionContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
