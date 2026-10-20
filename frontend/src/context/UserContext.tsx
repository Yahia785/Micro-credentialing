import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser } from 'aws-amplify/auth';
import { createUserProfile, getUserProfile } from '../api/users';
import type { UserProfile } from '../types/user';

interface UserContextValue {
  cognitoUser: AuthUser | undefined;
  userProfile: UserProfile | null;
  isAdmin: boolean;
  /** True only during the initial profile load. Silent refreshes never set it. */
  loading: boolean;
  error: string | null;
  /** Re-fetches the profile in the background. Keeps the current profile if it fails. */
  refreshProfile: () => Promise<void>;
  /** Replace the profile locally, e.g. after editing it. */
  setUserProfile: (profile: UserProfile) => void;
  signOut: () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

interface UserProviderProps {
  cognitoUser: AuthUser | undefined;
  /** Amplify's Authenticator `signOut`, which may be undefined. */
  signOut: (() => void) | undefined;
  children: ReactNode;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function UserProvider({ cognitoUser, signOut, children }: UserProviderProps) {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Depend on the user's identity, not the object, so a new object for the same user can't re-trigger loading.
  const cognitoUserId = cognitoUser?.userId;
  const hasUser = Boolean(cognitoUserId);

  useEffect(() => {
    let cancelled = false;

    async function initializeUser() {
      if (!hasUser) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        console.log('Checking for existing user profile...');

        const profile = await getUserProfile();
        if (cancelled) return;

        if (profile.user) {
          console.log('User profile found:', profile.user);
          setUserProfile(profile.user);
        } else {
          console.log('No user profile found, creating...');
          const newProfile = await createUserProfile();
          if (cancelled) return;
          setUserProfile(newProfile.user);
        }

        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        console.error('Error initializing user:', err);

        if (errorMessage(err).includes('404')) {
          try {
            console.log('User not found in DB, creating profile...');
            const newProfile = await createUserProfile();
            if (cancelled) return;
            console.log('Profile created:', newProfile);
            setUserProfile(newProfile.user);
            setLoading(false);
          } catch (createErr) {
            if (cancelled) return;
            console.error('Error creating profile:', createErr);
            setError('Failed to create user profile');
            setLoading(false);
          }
        } else {
          setError('Failed to load user profile');
          setLoading(false);
        }
      }
    }

    initializeUser();

    return () => {
      cancelled = true;
    };
  }, [hasUser, cognitoUserId]);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await getUserProfile();
      if (profile.user) {
        setUserProfile(profile.user);
      }
    } catch (err) {
      // Silent refresh: keep the profile we already have.
      console.error('Failed to refresh user profile:', err);
    }
  }, []);

  const handleSignOut = useCallback(() => {
    signOut?.();
  }, [signOut]);

  const value = useMemo<UserContextValue>(
    () => ({
      cognitoUser,
      userProfile,
      isAdmin: userProfile?.role === 'admin',
      loading,
      error,
      refreshProfile,
      setUserProfile,
      signOut: handleSignOut,
    }),
    [cognitoUser, userProfile, loading, error, refreshProfile, handleSignOut],
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUser(): UserContextValue {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
