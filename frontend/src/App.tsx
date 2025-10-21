import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { useEffect, useState } from 'react';
import { createUserProfile, getUserProfile } from "./api";
import { EditProfile } from './components/EditProfile';
import './App.css';

// Separate component to handle user profile logic
function UserProfileLoader({ user, signOut }: any) {
  const [userProfile, setUserProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    async function initializeUser() {
      if (!user) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        console.log('Checking for existing user profile...');
        
        const profile = await getUserProfile();
        
        if (profile.user) {
          console.log('User profile found:', profile.user);
          setUserProfile(profile.user);
        } else {
          console.log('No user profile found, creating...');
          const newProfile = await createUserProfile();
          setUserProfile(newProfile.user);
        }
        
        setLoading(false);
      } catch (err: any) {
        console.error('Error initializing user:', err);
        
        if (err.message.includes('404')) {
          try {
            console.log('User not found in DB, creating profile...');
            const newProfile = await createUserProfile();
            console.log('Profile created:', newProfile);
            setUserProfile(newProfile.user);
            setLoading(false);
          } catch (createErr) {
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
  }, [user]);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleUpdateSuccess = (updatedUser: any) => {
    setUserProfile(updatedUser);
    setIsEditing(false);
  };

  if (loading) {
    return (
      <main>
        <h1>Micro-Credentialing Platform</h1>
        <p style={{ color: '#ffffff' }}>Loading your profile...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main>
        <h1>Micro-Credentialing Platform</h1>
        <p style={{ color: 'red' }}>Error: {error}</p>
        <button onClick={signOut}>Sign out</button>
      </main>
    );
  }

  if (!user) {
    return (
      <main>
        <h1>Micro-Credentialing Platform</h1>
        <p style={{ color: '#ffffff' }}>No user data available</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Micro-Credentialing Platform</h1>
      <div>
        <h2 style={{ color: '#ffffff' }}>
          Welcome, {userProfile?.email || user.username}!
        </h2>
        
        {userProfile && !isEditing && (
          <div style={{ 
            marginTop: '20px'
          }}>
            <h3 style={{ color: '#ffffff', marginBottom: '15px', fontSize: '24px' }}>
              Your Profile
            </h3>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>Email:</strong> {userProfile.email}
            </p>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>Name:</strong> {userProfile.name}
            </p>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>User ID:</strong> {userProfile.userId}
            </p>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>Credentials Earned:</strong> {userProfile.credentialsCount}
            </p>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>Milestones Completed:</strong> {userProfile.milestonesCompleted}
            </p>
            <p style={{ color: '#ffffff', marginBottom: '10px' }}>
              <strong>Member Since:</strong> {new Date(userProfile.createdAt).toLocaleDateString()}
            </p>
            
            <button 
              onClick={handleEditClick}
              style={{ 
                marginTop: '15px',
                padding: '10px 20px',
                background: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              Edit Profile
            </button>
          </div>
        )}

        {userProfile && isEditing && (
          <EditProfile
            currentUser={userProfile}
            onUpdateSuccess={handleUpdateSuccess}
            onCancel={handleCancelEdit}
          />
        )}
        
        <button onClick={signOut} style={{ marginTop: '20px' }}>
          Sign out
        </button>
      </div>
    </main>
  );
}

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <UserProfileLoader user={user} signOut={signOut} />
      )}
    </Authenticator>
  );
}

export default App;