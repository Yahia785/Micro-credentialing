import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { useEffect, useState } from 'react';
import { createUserProfile, getUserProfile } from "./api/users";
import { EditProfile } from './components/EditProfile';
import { Tabs } from './components/Tabs';
import { ProblemsTab } from './components/ProblemsTab';
import { AdminReviewsTab } from './components/AdminReviewsTab';
import './App.css';

function UserProfileLoader({ user, signOut }: any) {
  const [userProfile, setUserProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');
   const [refreshKey, setRefreshKey] = useState(0);

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
  }, [user, refreshKey]);

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

  const tabs = userProfile?.role === 'admin'
  ? [
    { id: 'profile', label: 'Profile' },
    { id: 'problems', label: 'Problems' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'credentials', label: 'Credentials' }
  ]
: [
        { id: 'profile', label: 'Profile' },
        { id: 'problems', label: 'Problems' },
        { id: 'credentials', label: 'Credentials' }
      ];

  if (loading) {
    return (
      <main>
        <h1>Micro-Credentialing Platform</h1>
        <p style={{ color: '#666' }}>Loading your profile...</p>
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
        <p style={{ color: '#666' }}>No user data available</p>
      </main>
    );
  }

  return (
    <main>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '30px'
      }}>
        <h1 style={{ margin: 0, color: '#333' }}>Micro-Credentialing Platform</h1>
        <button 
          onClick={signOut}
          style={{
            padding: '10px 20px',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          Sign out
        </button>
      </div>

      <div style={{
        background: '#fff',
        borderRadius: '8px',
        padding: '20px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}>
        <h2 style={{ color: '#333', marginTop: 0 }}>
          Welcome, {userProfile?.name || user.username}!
        </h2>

        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'profile' && (
          <>
            {userProfile && !isEditing && (
              <div style={{ marginTop: '20px' }}>
                <h3 style={{ color: '#333', marginBottom: '15px', fontSize: '24px' }}>
                  Profile
                </h3>
                <p style={{ color: '#333', marginBottom: '10px' }}>
                  <strong>Email:</strong> {userProfile.email}
                </p>
                <p style={{ color: '#333', marginBottom: '10px' }}>
                  <strong>Name:</strong> {userProfile.name}
                </p>
                <p style={{ color: '#333', marginBottom: '10px' }}>
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
          </>
        )}

        {activeTab === 'problems' && (
          <ProblemsTab 
            userProfile={userProfile} 
            onRefreshNeeded={() => setRefreshKey(prev => prev + 1)} />
        )}
        {/* NEW: Admin Reviews Tab */}
        {activeTab === 'reviews' && userProfile?.role === 'admin' && (
        <AdminReviewsTab />
       )}

        {activeTab === 'credentials' && (
          <div style={{ padding: '20px' }}>
            <h3 style={{ color: '#333', marginBottom: '15px' }}>Credentials & Progress</h3>
            <div style={{ marginBottom: '20px' }}>
              <p style={{ color: '#333', fontSize: '16px', marginBottom: '10px' }}>
                <strong>🏆 Credentials Earned: </strong>{userProfile?.credentialsCount || 0}
              </p>
              <p style={{ color: '#666', fontSize: '14px', fontStyle: 'italic' }}>
                Credentials are awarded for 100% test case completion
              </p>
            </div>
            <div>
              <p style={{ color: '#333', fontSize: '16px', marginBottom: '10px' }}>
                <strong>📝 Problems Attempted: </strong>{userProfile?.completedMilestones?.length || 0}
              </p>
              <p style={{ color: '#666', fontSize: '14px', fontStyle: 'italic' }}>
                Total number of problems you have submitted (one submission allowed per problem)
              </p>
            </div>
          </div>
        )}
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