import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { RouterProvider } from 'react-router';
import { APP_NAME } from './app/constants';
import { router } from './app/routes';
import { Alert, Button, Spinner } from './components/ui';
import { UserProvider, useUser } from './context/UserContext';
import styles from './App.module.css';

/** Full-screen states for the initial profile load. Routes render only once the profile is ready. */
function AppGate() {
  const { cognitoUser, loading, error, signOut } = useUser();

  if (loading) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>{APP_NAME}</h1>
        <Spinner decorative />
        <p className={styles.message} role="status">
          Loading your profile…
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>{APP_NAME}</h1>
        <Alert variant="danger" title="We couldn't load your profile" className={styles.alert}>
          {error}. Try signing out and signing back in. If the problem continues, contact your instructor.
        </Alert>
        <Button variant="secondary" onClick={signOut}>
          Sign out
        </Button>
      </main>
    );
  }

  if (!cognitoUser) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>{APP_NAME}</h1>
        <p className={styles.message}>No user data available.</p>
      </main>
    );
  }

  return <RouterProvider router={router} />;
}

/** The app name above the sign-in form. Only the sign-in view uses it. */
const AUTH_COMPONENTS = {
  Header() {
    return <h1 className={styles.signInTitle}>{APP_NAME}</h1>;
  },
};

function App() {
  return (
    <Authenticator
      components={AUTH_COMPONENTS}
      formFields={{
        signIn: {
          username: {
            label: 'Email',
            placeholder: 'Enter your email'
          }
        },
        signUp: {
          username: {
            label: 'Email',
            placeholder: 'Enter your email'
          }
        }
      }}
    >
      {({ signOut, user }) => (
        <UserProvider cognitoUser={user} signOut={signOut}>
          <AppGate />
        </UserProvider>
      )}
    </Authenticator>
  );
}
export default App;
